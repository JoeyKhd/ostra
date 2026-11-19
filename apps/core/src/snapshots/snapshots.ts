import type { CodeHostAdapter, CodeHostWebhookEvent, Logger, SecretStoreAdapter } from "@ostra/adapter-sdk";
import { secretRefSchema } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import {
  pickSnapshotRunner,
  recordSnapshotResult,
  returnSnapshotBuildInTx,
  scheduleSnapshot,
  sweepSnapshotBuilds,
  touchesLockfile,
} from "@ostra/domain";
import type { ChangeNotices, Clock, CommandOutbox, SnapshotReason } from "@ostra/domain";
import type { JobHandler, Jobs } from "@ostra/jobs";
import { organizationIdSchema, poolIdSchema, projectIdSchema, repoFullNameSchema, snapshotBuildBodySchema } from "@ostra/protocol";
import type { ConnectionId, OrganizationId, ProjectId, RunnerEventFrame } from "@ostra/protocol";

import type { AckedCommand, RunnerRef } from "../gateway/context.ts";
import { installationStateSelect, installationUsable } from "@ostra/domain";

// Core's side of snapshots (F-051, ADR 0038 as amended; milestone 3's ticket 26):
//
// - the triggers: `snapshot.schedule` (an environment's change and Rebuild, enqueued by the panel; a
//   push to a default branch that touches a lockfile, from the App's webhook), and
//   `snapshot.nightly` at OSTRA_SNAPSHOT_NIGHTLY_HOUR for the projects whose default branch moved;
// - the build's results: `snapshot.built` and `snapshot.failed` in a `runner-event` frame, applied
//   for the runner the build went to only; a refused `snapshot-build` goes back to the queue;
// - the sweep: builds lost with their runner go back to the queue, and queued builds are sent once
//   a `docker` runner of the project's pools is online.
//
// Logs carry IDs and outcomes, never a variable, a script or a secret.

export type SnapshotDeps = {
  readonly db: Db;
  readonly jobs: Jobs;
  readonly outbox: CommandOutbox;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
  readonly codeHost: CodeHostAdapter;
  readonly secretStore: SecretStoreAdapter;
  readonly logger: Logger;
};

const ports = (deps: SnapshotDeps) => ({
  db: deps.db,
  outbox: deps.outbox,
  notices: deps.notices,
  clock: deps.clock,
  adapters: { codeHost: deps.codeHost, secretStore: deps.secretStore },
});

/** `snapshot.schedule`: one build of the project, joined by every trigger within the minute. */
export const snapshotScheduleHandler =
  (deps: SnapshotDeps): JobHandler<"snapshot.schedule"> =>
  async (context) => {
    const { organizationId, projectId, reason } = context.payload;
    // The job names its organization: a project of another one is never touched.
    const project = await deps.db.project.findFirst({ where: { id: projectId, organizationId }, select: { id: true } });
    if (project === null) {
      context.logger.info("snapshot.schedule-skipped", { projectId, reason: "not-found" });
      return;
    }
    const result = await scheduleSnapshot(ports(deps), { projectId, reason });
    context.logger.info("snapshot.scheduled", {
      projectId,
      reason,
      outcome: result.ok ? (result.snapshotId === null ? "nothing-to-build" : "building") : result.error,
      ...(result.ok && result.snapshotId !== null ? { snapshotId: result.snapshotId } : {}),
    });
  };

/** Enqueues a build in the caller's transaction: the job's key and the one-a-minute rule make repeats one. */
export const enqueueSnapshotInTx = (
  jobs: Pick<Jobs, "enqueueInTx">,
  tx: Tx,
  project: { readonly organizationId: OrganizationId; readonly projectId: ProjectId },
  reason: SnapshotReason,
): Promise<void> => jobs.enqueueInTx(tx, "snapshot.schedule", { organizationId: project.organizationId, projectId: project.projectId, reason });

/**
 * `snapshot.nightly`: a `snapshot.schedule` with reason `nightly` for every project with a repo whose
 * pools have a `docker` runner. The build itself is skipped when nothing moved since the ready
 * snapshot (`scheduleSnapshot` compares the inputs, the default branches' heads among them).
 */
export const snapshotNightlyHandler =
  (deps: Pick<SnapshotDeps, "db" | "jobs">): JobHandler<"snapshot.nightly"> =>
  async (context) => {
    const projects = await nightlyProjects(deps.db);
    for (const project of projects) {
      await deps.db.$transaction((tx) => enqueueSnapshotInTx(deps.jobs, tx, project, "nightly"));
    }
    context.logger.info("snapshot.nightly", { projects: projects.length });
  };

/** The projects the nightly looks at: with a repo, and a `docker` runner (online or not) in their pools. */
export const nightlyProjects = async (db: Db): Promise<readonly { readonly organizationId: OrganizationId; readonly projectId: ProjectId }[]> => {
  const docker = await db.runner.findMany({
    where: { kind: "pool", executor: "docker", revokedAt: null, poolId: { not: null } },
    select: { poolId: true },
    distinct: ["poolId"],
  });
  const dockerPools = new Set(docker.flatMap((runner) => (runner.poolId === null ? [] : [runner.poolId])));
  if (dockerPools.size === 0) {
    return [];
  }
  const projects = await db.project.findMany({
    where: { repos: { some: {} }, environment: { isNot: null } },
    select: { id: true, organizationId: true, pools: { select: { poolId: true } } },
    orderBy: { createdAt: "asc" },
    take: 5_000,
  });
  const defaults = await db.runnerPool.findMany({ where: { isDefault: true }, select: { id: true, organizationId: true } });
  return projects
    .filter((project) => {
      const pools =
        project.pools.length > 0
          ? project.pools.map((row) => row.poolId)
          : defaults.filter((pool) => pool.organizationId === project.organizationId).map((pool) => pool.id);
      return pools.some((pool) => dockerPools.has(poolIdSchema.parse(pool)));
    })
    .map((project) => ({ organizationId: organizationIdSchema.parse(project.organizationId), projectId: projectIdSchema.parse(project.id) }));
};

/** The nightly's schedule, at the hour the setting names (UTC). */
export const ensureSnapshotNightlySchedule = (jobs: Pick<Jobs, "schedule">, hour: number): Promise<void> =>
  jobs.schedule("snapshot.nightly", "nightly", `0 ${String(hour)} * * *`, {});

/**
 * A push to a repo's default branch that touches a lockfile rebuilds its project's snapshot. The
 * paths come from the code host's hint; without them, from a compare of the push's two heads.
 */
export const snapshotsOnPush = async (
  deps: Pick<SnapshotDeps, "db" | "jobs" | "codeHost" | "secretStore">,
  input: { readonly organizationId: OrganizationId; readonly connectionId: ConnectionId; readonly event: Extract<CodeHostWebhookEvent, { kind: "push" }> },
): Promise<"rebuilding" | "no-lockfile" | "not-a-default-branch" | "unknown-repo" | "unreadable"> => {
  const { event } = input;
  const repos = await deps.db.repo.findMany({
    where: { organizationId: input.organizationId, connectionId: input.connectionId, hostRepoId: event.hostRepoId },
    select: { projectId: true, fullName: true, installationId: true, defaultBranch: true, connection: { select: { appId: true, privateKeySecretRef: true } }, ...installationStateSelect },
  });
  if (repos.length === 0) {
    return "unknown-repo";
  }
  const onDefault = repos.filter((repo) => event.ref === `refs/heads/${repo.defaultBranch}`);
  const [first] = onDefault;
  if (first === undefined) {
    return "not-a-default-branch";
  }
  let paths = event.changedPaths;
  if (paths === null) {
    // Milestone 4 (F-136, ADR 0065): nothing is minted through an installation that isn't linked.
    if (!installationUsable(first.installation)) {
      return "unreadable";
    }
    const ref = secretRefSchema.safeParse(first.connection.privateKeySecretRef);
    const key = ref.success ? await deps.secretStore.get(input.organizationId, ref.data) : null;
    if (key?.ok !== true) {
      return "unreadable";
    }
    const compared = await deps.codeHost.compare(
      { app: { appId: first.connection.appId, privateKey: key.value }, installationId: first.installationId, repo: repoFullNameSchema.parse(first.fullName) },
      event.before,
      event.after,
    );
    if (!compared.ok) {
      return "unreadable";
    }
    paths = compared.value.files.flatMap((file) => (file.previousPath === null ? [file.path] : [file.path, file.previousPath]));
  }
  if (!touchesLockfile(paths)) {
    return "no-lockfile";
  }
  await deps.db.$transaction(async (tx) => {
    for (const projectId of new Set(onDefault.map((repo) => repo.projectId))) {
      await enqueueSnapshotInTx(deps.jobs, tx, { organizationId: input.organizationId, projectId: projectIdSchema.parse(projectId) }, "lockfile-changed");
    }
  });
  return "rebuilding";
};

/** A runner's own event (minor 2): a snapshot build's result, for the runner the build went to only. */
export const applySnapshotRunnerEvent = async (deps: Pick<SnapshotDeps, "db" | "notices" | "clock" | "logger">, runner: RunnerRef, frame: RunnerEventFrame): Promise<void> => {
  const { event } = frame;
  if (event.kind !== "snapshot.built" && event.kind !== "snapshot.failed") {
    deps.logger.info("snapshot.runner-event-ignored", { runnerId: runner.runnerId, kind: event.kind });
    return;
  }
  const owned = await deps.db.snapshot.findFirst({
    where: { id: event.snapshotId, organizationId: runner.organizationId, runnerId: runner.runnerId },
    select: { id: true },
  });
  if (owned === null) {
    // Another runner's build, another organization's, or one taken back: never applied.
    deps.logger.info("snapshot.result-ignored", { runnerId: runner.runnerId, snapshotId: event.snapshotId, reason: "not-this-runners-build" });
    return;
  }
  const result =
    event.kind === "snapshot.built"
      ? await recordSnapshotResult(deps, { snapshotId: event.snapshotId, outcome: "built", imageDigest: event.imageDigest, durationMs: event.durationMs, runnerId: runner.runnerId })
      : await recordSnapshotResult(deps, { snapshotId: event.snapshotId, outcome: "failed", reason: event.reason, detail: event.detail });
  deps.logger.info("snapshot.result", {
    runnerId: runner.runnerId,
    snapshotId: event.snapshotId,
    kind: event.kind,
    outcome: result.ok ? "applied" : result.error,
    ...(event.kind === "snapshot.failed" ? { reason: event.reason } : {}),
  });
};

/** A `snapshot-build` its runner refused, or lost in a crash: the build goes back to the queue. */
export const applySnapshotCommandResultsInTx = async (
  deps: Pick<SnapshotDeps, "notices" | "logger">,
  tx: Tx,
  runner: RunnerRef,
  results: readonly AckedCommand[],
): Promise<void> => {
  for (const result of results) {
    if (result.kind !== "snapshot-build" || (result.result !== "rejected" && result.result !== "outcome-unknown")) {
      continue;
    }
    const body = snapshotBuildBodySchema.safeParse(result.body);
    if (!body.success) {
      continue;
    }
    const returned = await returnSnapshotBuildInTx(deps, tx, { snapshotId: body.data.snapshotId, runnerId: runner.runnerId, organizationId: runner.organizationId });
    deps.logger.info("snapshot.build-returned", { runnerId: runner.runnerId, snapshotId: body.data.snapshotId, result: result.result, returned });
  }
};

/**
 * The sweep: builds lost with their runner go back to the queue, and each project's queued build is
 * sent once a `docker` runner of its pools is online. A project with no such runner costs one query.
 */
export const requeueSnapshots = async (deps: SnapshotDeps, limit = 100): Promise<{ readonly sent: number }> => {
  await sweepSnapshotBuilds(deps);
  const queued = await deps.db.snapshot.findMany({
    where: { state: "queued" },
    select: { projectId: true, organizationId: true, reason: true },
    distinct: ["projectId"],
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  let sent = 0;
  for (const row of queued) {
    const project = { organizationId: organizationIdSchema.parse(row.organizationId), projectId: projectIdSchema.parse(row.projectId) };
    const runner = await deps.db.$transaction((tx) => pickSnapshotRunner(tx, project, deps.clock.now()));
    if (runner === null) {
      continue;
    }
    const reason = snapshotReasonOf(row.reason);
    const result = await scheduleSnapshot(ports(deps), { projectId: project.projectId, reason });
    if (result.ok && result.snapshotId !== null) {
      sent += 1;
    }
  }
  return { sent };
};

const snapshotReasons: readonly SnapshotReason[] = ["environment-changed", "lockfile-changed", "nightly", "rebuild"];

/** A stored reason, read back; anything else reads as an environment change. */
const snapshotReasonOf = (value: string): SnapshotReason => snapshotReasons.find((reason) => reason === value) ?? "environment-changed";

