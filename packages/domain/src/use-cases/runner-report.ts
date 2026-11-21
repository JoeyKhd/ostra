import type { Logger } from "@ostra/adapter-sdk";
import { Prisma, processContainmentToDb } from "@ostra/db";
import type { Tx } from "@ostra/db";
import { PROTOCOL_MINOR } from "@ostra/protocol";
import { previewSupportSchema } from "@ostra/protocol";
import type { ExecutorKind, PreviewSupport, ProcessContainment } from "@ostra/protocol";
import { z } from "zod";

import { runnerLabels } from "../fleet/labels.ts";
import { runnerVersionState } from "../fleet/versions.ts";
import type { RunnerVersionState, VersionFacts } from "../fleet/versions.ts";
import { enqueueRunnerAdmissionInTx } from "./admission.ts";
import type { Ports } from "../ports.ts";
import type { RecordRunnerReport, RunnerReport } from "./m5-signatures.ts";

// What a runner reports (F-067, F-069, F-061, ADR 0059; ticket 13): every `hello` and `status`
// carries its slots, what it offers, its capabilities, its labels, how it was installed, its
// version and minor. Core keeps them on the runner's row, which capacity and the choice read.
//
// - A runner can't set a reserved label (`executor:`, `os:`, `arch:`): one it tries to set is
//   dropped, with a log line naming the runner and how many, never the labels. The built-in ones
//   come from what core knows: its executor, and the system its registration named.
// - The row is written only when something changed, so a heartbeat writes nothing.
// - More room (more slots, CPU or memory, or the runner's first report) sends its pool's admission.

/** The system a runner's registration named, as its row keeps it. */
const registeredOsSchema = z.looseObject({ platform: z.string().min(1).max(64).optional(), arch: z.string().min(1).max(64).optional() });

/** What core's report writer needs beyond the signature's ports. */
export type RecordRunnerReportDeps = Omit<Parameters<RecordRunnerReport>[0], "jobs"> & {
  /** Sends the runner's pool's admission when it has more room; without it, the queue's sweep does. */
  readonly jobs?: Parameters<RecordRunnerReport>[0]["jobs"];
  readonly logger?: Logger;
  /** The server's own version, for the version state; this build's minor and no release without it. */
  readonly server?: VersionFacts;
};

/**
 * A report, with what a `status` also says: how the runner contains a task's processes (minor 1),
 * and its executor and capacity (milestone 1's), which change the row when they differ.
 */
export type RunnerReportWithContainment = RunnerReport & {
  readonly processContainment?: ProcessContainment;
  readonly executor?: ExecutorKind;
  readonly capacity?: number;
  /**
   * Milestone 8 (protocol minor 7, F-141): what it can show of a preview, as `hello` or `status`
   * said. Missing or `null`: it said nothing, and `isPreviewable` gives it no view.
   */
  readonly preview?: PreviewSupport | null;
};

/** A flat JSON object's text with its keys sorted: Postgres's `jsonb` keeps its own key order. */
const canonical = (value: unknown): string | null =>
  value === null || typeof value !== "object" ? null : JSON.stringify(value, Object.keys(value).sort());

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((value, index) => value === b[index]);

export const recordRunnerReport = async (
  deps: RecordRunnerReportDeps,
  report: RunnerReportWithContainment,
): ReturnType<RecordRunnerReport> => {
  const { tx } = deps;
  const row = await tx.runner.findFirst({
    where: { id: report.runnerId, organizationId: report.organizationId },
    select: {
      executor: true,
      os: true,
      labels: true,
      version: true,
      minor: true,
      install: true,
      capacity: true,
      slots: true,
      cpuMillis: true,
      memoryMiB: true,
      capabilities: true,
      processContainment: true,
      preview: true,
    },
  });
  if (row === null) {
    return { ok: false, error: "not-found", message: "No such runner" };
  }
  const registered = registeredOsSchema.safeParse(row.os);
  const executor = report.executor ?? row.executor;
  const capacity = report.capacity ?? row.capacity;
  const { labels, dropped } = runnerLabels(report.labels, {
    executor,
    os: report.os ?? (registered.success ? (registered.data.platform ?? null) : null),
    arch: report.arch ?? (registered.success ? (registered.data.arch ?? null) : null),
  });
  if (dropped.length > 0) {
    deps.logger?.warn("runner.reserved-labels-dropped", { runnerId: report.runnerId, dropped: dropped.length });
  }
  // What it runs at once: its offer's slots, or (`host`, an older runner) its capacity.
  const slots = report.resources?.slots ?? report.slots;
  const cpuMillis = report.resources?.cpuMillis ?? null;
  const memoryMiB = report.resources?.memoryMiB ?? null;
  const containment = report.processContainment === undefined ? row.processContainment : processContainmentToDb[report.processContainment];
  const capabilities = canonical(report.capabilities);
  const capabilitiesChanged = canonical(row.capabilities) !== capabilities;
  // Minor 7: a runner below it can show nothing, whatever an older row says.
  const preview = report.minor >= 7 ? (report.preview ?? null) : null;
  const kept = previewSupportSchema.safeParse(row.preview);
  const previewChanged = canonical(kept.success ? kept.data : null) !== canonical(preview);
  const changed =
    row.executor !== executor ||
    row.capacity !== capacity ||
    !sameList(row.labels, labels) ||
    row.version !== report.version ||
    row.minor !== report.minor ||
    row.install !== report.install ||
    row.slots !== slots ||
    row.cpuMillis !== cpuMillis ||
    row.memoryMiB !== memoryMiB ||
    row.processContainment !== containment ||
    capabilitiesChanged ||
    previewChanged;
  const versionState = runnerVersionState(deps.server ?? { minor: PROTOCOL_MINOR, version: null }, { minor: report.minor, version: report.version });
  if (!changed) {
    return { ok: true, labels, droppedLabels: dropped, versionState };
  }
  await tx.runner.update({
    where: { id: report.runnerId },
    data: {
      executor,
      capacity,
      labels: [...labels],
      version: report.version,
      minor: report.minor,
      install: report.install,
      slots,
      cpuMillis,
      memoryMiB,
      processContainment: containment,
      capabilities: report.capabilities ?? Prisma.DbNull,
      preview: preview ?? Prisma.DbNull,
    },
  });
  const grew =
    row.minor === null ||
    slots > (row.slots ?? row.capacity) ||
    (cpuMillis ?? 0) > (row.cpuMillis ?? 0) ||
    (memoryMiB ?? 0) > (row.memoryMiB ?? 0) ||
    !sameList(row.labels, labels) ||
    capabilitiesChanged;
  if (grew && deps.jobs !== undefined) {
    await enqueueRunnerAdmissionInTx({ jobs: deps.jobs }, tx, report.organizationId, report.runnerId);
  }
  await deps.notices.emitInTx(tx, { organizationId: report.organizationId, projectId: null, entity: "runner", entityId: report.runnerId });
  return { ok: true, labels, droppedLabels: dropped, versionState };
};

/** What a refused `hello` said of the runner (F-061): the build it runs, and the minor it speaks. */
export type RefusedHello = {
  readonly runnerId: RunnerReport["runnerId"];
  readonly organizationId: RunnerReport["organizationId"];
  readonly minor: number;
  readonly version: string;
};

/**
 * A runner refused at `hello` for its version (F-061, ticket 16): its row keeps the version and
 * minor it spoke and when (`lastSeenAt`), so the fleet view lists it as outdated (its version
 * state is `outside`) without a row of its own. Recorded once: a runner that retries with the same
 * build writes nothing again. `true` when it wrote.
 */
export const recordRefusedRunner = async (
  deps: Pick<Ports, "clock" | "notices"> & { readonly tx: Tx; readonly logger?: Logger },
  refused: RefusedHello,
): Promise<boolean> => {
  const { tx } = deps;
  const row = await tx.runner.findFirst({ where: { id: refused.runnerId, organizationId: refused.organizationId }, select: { minor: true, version: true } });
  if (row === null || (row.minor === refused.minor && row.version === refused.version)) {
    return false;
  }
  await tx.runner.update({
    where: { id: refused.runnerId },
    data: { minor: refused.minor, version: refused.version, lastSeenAt: new Date(deps.clock.now()) },
  });
  await deps.notices.emitInTx(tx, { organizationId: refused.organizationId, projectId: null, entity: "runner", entityId: refused.runnerId });
  deps.logger?.warn("runner.version-refused", { runnerId: refused.runnerId, minor: refused.minor });
  return true;
};

/**
 * A runner row's version state for the panel (F-061): its last minor and version against the
 * server's. A runner that has never spoken a minor is read as `current` until it does.
 */
export const runnerRowVersionState = (
  server: VersionFacts,
  row: { readonly minor: number | null; readonly version: string },
): RunnerVersionState => (row.minor === null ? "current" : runnerVersionState(server, { minor: row.minor, version: row.version }));
