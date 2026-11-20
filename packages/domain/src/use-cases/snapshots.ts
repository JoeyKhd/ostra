import { createHash } from "node:crypto";

import { secretRefSchema } from "@ostra/adapter-sdk";
import type { CodeHostAdapter, CodeHostAppCredentials, SecretStoreAdapter } from "@ostra/adapter-sdk";
import type { Db, Snapshot, Tx } from "@ostra/db";
import {
  environmentIdSchema,
  organizationIdSchema,
  poolIdSchema,
  projectIdSchema,
  repoFullNameSchema,
  repoIdSchema,
  runnerIdSchema,
  runnerLimits,
  snapshotBuildEnvironmentSchema,
  snapshotCredentialsSchema,
  snapshotFailureReasonSchema,
  snapshotIdSchema,
} from "@ostra/protocol";
import type {
  EnvironmentId,
  ExecutorKind,
  OrganizationId,
  ProjectId,
  RepoId,
  RepoSecret,
  RunnerId,
  SnapshotBuildEnvironment,
  SnapshotBuilder,
  SnapshotCredentials,
  SnapshotFailureReason,
  SnapshotId,
} from "@ostra/protocol";

import { lockfilePaths } from "../environment/detect.ts";
import type { JobPayload } from "../jobs.ts";
import { snapshotScheduleSingletonSeconds } from "../jobs.ts";
import { snapshotFromColumns, snapshotToColumns } from "../lifecycles/mapping.ts";
import { transitionSnapshot } from "../lifecycles/snapshot.ts";
import type { SnapshotInput } from "../lifecycles/snapshot.ts";
import type { AuditLog, ChangeNotices, Clock, CommandOutbox, ServerAdapters } from "../ports.ts";
import type { RecordSnapshotResult, ScheduleSnapshot } from "./m3-signatures.ts";
import { registryImageRef } from "../fleet/registry.ts";
import { registryHostOf } from "./registry.ts";
import { INSTALLATION_NOT_LINKED, installationStateSelect, installationUsable } from "../code-host/installations.ts";

// Snapshots (F-051, ADR 0038 as amended; milestone 3's ticket 26). A project's snapshot is built by
// a runner of its pools, which keeps the image itself or, with the organization's registry set,
// pushes it there (F-120, milestone 5's ticket 17, `planSnapshotBuild`):
//
// - `scheduleSnapshot` makes the build: a `queued` row, then a `snapshot-build` command to an online
//   `docker` runner of the project's pools at minor 2 (the one that ran the project's last task
//   first), and the row moves to `building`. Two triggers within a minute make one build. With no
//   such runner the row stays `queued`, and core's sweep sends it when one comes online.
// - `issueSnapshotCredentials` answers `POST /runner/v1/snapshots/:id/credentials`: the repos' read
//   tokens and the setup secrets, for the runner the build went to while it builds. Never logged.
// - `recordSnapshotResult` applies `snapshot.built` and `snapshot.failed`, idempotently by ID. A
//   built snapshot replaces the previous ready one; a failed build leaves it in use.
//
// A runner never waits for a snapshot: the task spec names the ready one only when the chosen
// runner holds it (core's task spec), and a `host` runner gets its dependency cache's key instead.

export type SnapshotReason = JobPayload<"snapshot.schedule">["reason"];

/** Within this window a new trigger joins the build already made (spec section 5.4: one a minute). */
export const SNAPSHOT_COALESCE_MS = snapshotScheduleSingletonSeconds * 1000;

/** A `snapshot-build` command not delivered by then is refused by the runner, and the build goes back to the queue. */
export const SNAPSHOT_BUILD_NOT_AFTER_MS = 15 * 60_000;

/** A build that reports nothing for this long failed (a runner that crashed mid-build and came back). Working value. */
export const SNAPSHOT_BUILD_MAX_MS = 2 * 3_600_000;

/** The image's name in the runner's own Docker (ticket 14): the runner tags it so, and keeps it. */
export const snapshotImageRef = (projectId: ProjectId, snapshotId: SnapshotId): string => `ostra-snapshot/${projectId}:${snapshotId}`;

/** The key of a project's repo mirrors and dependency cache on a `host` runner (ADR 0038 amended, Q185). */
export const hostCacheKeyFor = (projectId: ProjectId): string => `project-${projectId}`;

/**
 * What a runner keeps for a box to start from, by its `hello`: its executor and minor. This mirrors
 * each executor's `snapshots` capability, which a runner doesn't send: `docker` builds and keeps
 * images, `host` keeps a dependency cache, and `kubernetes` gets snapshots with F-093. The spec's
 * snapshot section is a minor-2 field.
 */
export const runnerSnapshotKind = (runner: { readonly executor: ExecutorKind; readonly minor: number }): "image" | "host-cache" | "none" => {
  if (runner.minor < 2) {
    return "none";
  }
  switch (runner.executor) {
    case "docker":
      return "image";
    case "host":
      return "host-cache";
    case "kubernetes":
      return "none";
    default:
      return runner.executor satisfies never;
  }
};

/** The lockfiles whose change on a default branch rebuilds the snapshot: the detection's, and a few more. */
export const snapshotLockfiles: ReadonlySet<string> = new Set<string>([
  ...lockfilePaths,
  "bun.lockb",
  "Pipfile.lock",
  "composer.lock",
  "mix.lock",
  "pubspec.lock",
  "Podfile.lock",
  "packages.lock.json",
  "gradle.lockfile",
  "flake.lock",
]);

/** Whether a push's paths touch a lockfile, in any folder of the repo. */
export const touchesLockfile = (paths: readonly string[]): boolean => paths.some((path) => snapshotLockfiles.has(path.split("/").at(-1) ?? ""));

/** `Snapshot.failedReason` holds the reason's code on its first line, and the runner's words after it. */
export const snapshotFailureColumn = (reason: SnapshotFailureReason, detail: string): string => `${reason}\n${detail}`;

/** A failed snapshot's reason and detail, from its row; an unreadable column reads as a build failure. */
export const snapshotFailureFromDb = (column: string | null): { readonly reason: SnapshotFailureReason; readonly detail: string } | null => {
  if (column === null) {
    return null;
  }
  const [first = "", ...rest] = column.split("\n");
  const parsed = snapshotFailureReasonSchema.safeParse(first);
  return parsed.success ? { reason: parsed.data, detail: rest.join("\n") } : { reason: "build-failed", detail: column };
};

type SnapshotPorts = {
  readonly db: Db;
  readonly outbox: CommandOutbox;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
  readonly adapters: Pick<ServerAdapters, "codeHost" | "secretStore">;
};

const appCredentials = async (
  secretStore: SecretStoreAdapter,
  organizationId: OrganizationId,
  connection: { readonly appId: string; readonly privateKeySecretRef: string | null },
): Promise<CodeHostAppCredentials | null> => {
  const ref = secretRefSchema.safeParse(connection.privateKeySecretRef);
  if (!ref.success) {
    return null;
  }
  const key = await secretStore.get(organizationId, ref.data);
  return key.ok ? { appId: connection.appId, privateKey: key.value } : null;
};

/**
 * A branch's head, through the shared interface: a compare of the branch with itself, whose merge
 * base is its head. `null` when the code host can't compare (its `compare` capability), so the
 * nightly can't tell whether the branch moved.
 */
const branchHead = async (codeHost: CodeHostAdapter, access: Parameters<CodeHostAdapter["compare"]>[0], branch: string): Promise<string | null> => {
  const compared = await codeHost.compare(access, branch, branch);
  return compared.ok ? compared.value.mergeBase : null;
};

/** A snapshot build's inputs, as the command carries them, and whether every repo's head was read. */
export type SnapshotBuildInputs = {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly environment: SnapshotBuildEnvironment;
  readonly headsKnown: boolean;
};

/**
 * Reads what a build of the project's environment needs: the base image, the setup script and each
 * repo with its clone URL, its non-secret variables and files, and its setup secrets by name. The
 * inputs hash covers all of it and the default branches' heads. Throws when the code host can't
 * be read, so the job retries.
 */
export const readSnapshotBuildInputs = async (
  deps: { readonly db: Tx; readonly adapters: Pick<ServerAdapters, "codeHost" | "secretStore"> },
  projectId: ProjectId,
): Promise<SnapshotBuildInputs | "not-found" | "no-repos"> => {
  const { db } = deps;
  const project = await db.project.findFirst({ where: { id: projectId }, select: { id: true, organizationId: true } });
  const environment = project === null ? null : await db.environment.findFirst({ where: { projectId, organizationId: project.organizationId } });
  if (project === null || environment === null) {
    return "not-found";
  }
  const organizationId = organizationIdSchema.parse(project.organizationId);
  const repos = await db.repo.findMany({ where: { projectId, organizationId }, include: { connection: true, ...installationStateSelect }, orderBy: { createdAt: "asc" } });
  if (repos.length === 0) {
    return "no-repos";
  }
  const entries = await db.environmentEntry.findMany({ where: { environmentId: environment.id }, orderBy: { createdAt: "asc" } });
  const built: Record<string, unknown>[] = [];
  const heads: (string | null)[] = [];
  for (const repo of repos) {
    // Milestone 4 (F-136, ADR 0065): nothing is minted through an installation that isn't linked.
    if (!installationUsable(repo.installation)) {
      throw new Error(INSTALLATION_NOT_LINKED);
    }
    const app = await appCredentials(deps.adapters.secretStore, organizationId, repo.connection);
    if (app === null) {
      throw new Error("the repo's App credentials couldn't be read");
    }
    const listed = await deps.adapters.codeHost.listRepos(app, repo.installationId);
    const hostRepo = listed.ok ? listed.value.find((candidate) => candidate.hostRepoId === repo.hostRepoId) : undefined;
    if (hostRepo === undefined) {
      throw new Error("the code host doesn't list the repo for this installation");
    }
    heads.push(await branchHead(deps.adapters.codeHost, { app, installationId: repo.installationId, repo: repoFullNameSchema.parse(repo.fullName) }, repo.defaultBranch));
    const own = entries.filter((entry) => entry.repoId === repo.id);
    const setupSecrets = own.filter((entry) => entry.kind === "secret" && entry.availableDuringSetup);
    built.push({
      repoId: repo.id,
      fullName: repo.fullName,
      cloneUrl: hostRepo.cloneUrl,
      defaultBranch: repo.defaultBranch,
      checkoutDir: repo.checkoutDir,
      variables: own
        .filter((entry) => entry.kind === "variable" && entry.name !== null)
        .map((entry) => ({ name: entry.name, value: entry.value ?? "", availableDuringSetup: entry.availableDuringSetup })),
      files: own.filter((entry) => entry.kind === "file" && entry.path !== null).map((entry) => ({ path: entry.path, content: entry.value ?? "" })),
      envFile: repo.envFile,
      setupSecrets: {
        variables: setupSecrets.flatMap((entry) => (entry.path === null && entry.name !== null ? [entry.name] : [])),
        files: setupSecrets.flatMap((entry) => (entry.path === null ? [] : [entry.path])),
      },
    });
  }
  const parts = { baseImage: environment.baseImage, setupScript: environment.setupScript, repos: built };
  const inputsHash = createHash("sha256").update(JSON.stringify({ ...parts, heads })).digest("hex");
  return {
    organizationId,
    projectId: projectIdSchema.parse(project.id),
    environmentId: environmentIdSchema.parse(environment.id),
    environment: snapshotBuildEnvironmentSchema.parse({ ...parts, inputsHash }),
    headsKnown: heads.every((head) => head !== null),
  };
};

/** The project's pools: the ones it lists, or the organization's default pools when it lists none (as the dispatch reads them). */
const projectPoolIds = async (tx: Tx, organizationId: OrganizationId, projectId: ProjectId) => {
  const listed = await tx.projectPool.findMany({ where: { projectId, organizationId }, select: { poolId: true } });
  if (listed.length > 0) {
    return listed.map((row) => poolIdSchema.parse(row.poolId));
  }
  const defaults = await tx.runnerPool.findMany({ where: { organizationId, isDefault: true }, select: { id: true } });
  return defaults.map((row) => poolIdSchema.parse(row.id));
};

/** Where a build goes and how it's built: by a runner's Docker or a rootless BuildKit pod, kept or pushed. */
export type SnapshotBuildPlan = {
  readonly runnerId: RunnerId;
  readonly builder: SnapshotBuilder;
  /** The registry the build pushes to (minor 4), or `null`: the runner keeps it (milestone 3). */
  readonly registry: { readonly id: string; readonly url: string; readonly repositoryPrefix: string } | null;
};

/** The minor that carries a build's `push` and `builder` (protocol minor 4). */
const PUSH_MINOR = 4;

/**
 * Where a build goes (F-051, F-120, ADR 0038, ADR 0060). With a registry set, a `kubernetes`
 * runner of the project's pools builds with rootless BuildKit and pushes, else a `docker` runner at
 * minor 4 pushes, so every host of the pools can pull. A `kubernetes` runner never builds without
 * a registry: its pool's tasks wait with `needs-registry` (ticket 14). Without a registry, an online
 * `docker` runner at minor 2 builds and keeps the image (milestone 3). Among several, the one that
 * ran the project's most recent task first, so its next boxes start from what it built.
 */
export const planSnapshotBuild = async (
  tx: Tx,
  project: { readonly organizationId: OrganizationId; readonly projectId: ProjectId },
  now: number,
): Promise<SnapshotBuildPlan | null> => {
  const poolIds = await projectPoolIds(tx, project.organizationId, project.projectId);
  if (poolIds.length === 0) {
    return null;
  }
  const registry = await tx.registry.findUnique({ where: { organizationId: project.organizationId }, select: { id: true, url: true, repositoryPrefix: true } });
  const online = await tx.runner.findMany({
    where: {
      organizationId: project.organizationId,
      kind: "pool",
      poolId: { in: poolIds },
      state: "online",
      revokedAt: null,
      executor: { in: ["docker", "kubernetes"] },
      presence: { is: { disconnectedAt: null, lastSeenAt: { gt: new Date(now - runnerLimits.offlineMs) } } },
    },
    select: { id: true, executor: true, presence: { select: { minor: true } } },
    orderBy: { name: "asc" },
  });
  const minorOf = (runner: (typeof online)[number]): number => runner.presence?.minor ?? 0;
  const preferLast = async (ids: readonly string[]): Promise<RunnerId | null> => {
    if (ids.length === 0) {
      return null;
    }
    const last = await tx.lease.findFirst({
      where: { organizationId: project.organizationId, projectId: project.projectId, runnerId: { in: [...ids] } },
      orderBy: { grantedAt: "desc" },
      select: { runnerId: true },
    });
    return runnerIdSchema.parse(last?.runnerId ?? ids[0]);
  };
  if (registry !== null) {
    const kubernetes = await preferLast(online.filter((runner) => runner.executor === "kubernetes" && minorOf(runner) >= PUSH_MINOR).map((runner) => runner.id));
    if (kubernetes !== null) {
      return { runnerId: kubernetes, builder: "buildkit", registry };
    }
    const pushing = await preferLast(online.filter((runner) => runner.executor === "docker" && minorOf(runner) >= PUSH_MINOR).map((runner) => runner.id));
    if (pushing !== null) {
      return { runnerId: pushing, builder: "docker", registry };
    }
  }
  const keeping = await preferLast(online.filter((runner) => runnerSnapshotKind({ executor: runner.executor, minor: minorOf(runner) }) === "image").map((runner) => runner.id));
  return keeping === null ? null : { runnerId: keeping, builder: "docker", registry: null };
};

/** The runner a build would go to now (`planSnapshotBuild`'s), or `null`. */
export const pickSnapshotRunner = async (tx: Tx, project: { readonly organizationId: OrganizationId; readonly projectId: ProjectId }, now: number): Promise<RunnerId | null> =>
  (await planSnapshotBuild(tx, project, now))?.runnerId ?? null;

/** Moves a snapshot by its lifecycle; a refused move is a bug in the caller, which checked the state. */
const moved = (row: Pick<Snapshot, "state" | "failedReason">, input: SnapshotInput) => {
  const current = snapshotFromColumns(row);
  if (!current.ok) {
    throw new Error("a snapshot's state couldn't be read");
  }
  const next = transitionSnapshot(current.value, input);
  if (!next.ok) {
    throw new Error(next.reason);
  }
  return snapshotToColumns(next.state);
};

const environmentNotice = (deps: Pick<SnapshotPorts, "notices">, tx: Tx, row: Pick<Snapshot, "organizationId" | "projectId" | "environmentId">) =>
  deps.notices.emitInTx(tx, {
    organizationId: organizationIdSchema.parse(row.organizationId),
    projectId: projectIdSchema.parse(row.projectId),
    entity: "environment",
    entityId: environmentIdSchema.parse(row.environmentId),
  });

/** Sends a queued build to `runnerId`: the command, and the row to `building` on that runner. */
const startBuildInTx = async (
  deps: Pick<SnapshotPorts, "outbox" | "notices" | "clock">,
  tx: Tx,
  row: Snapshot,
  plan: SnapshotBuildPlan,
  environment: SnapshotBuildEnvironment,
): Promise<void> => {
  const { runnerId } = plan;
  const snapshotId = snapshotIdSchema.parse(row.id);
  const organizationId = organizationIdSchema.parse(row.organizationId);
  const projectId = projectIdSchema.parse(row.projectId);
  // Minor 4: where to push, and the builder. The push credential is fetched for this build, never sent here.
  const push = plan.registry === null ? null : { ref: registryImageRef({ url: registryHostOf(plan.registry.url), repositoryPrefix: plan.registry.repositoryPrefix }, projectId, snapshotId) };
  await deps.outbox.enqueueInTx(tx, organizationId, runnerId, {
    kind: "snapshot-build",
    body: { snapshotId, projectId, environment, push, builder: plan.builder },
    notAfter: deps.clock.now() + SNAPSHOT_BUILD_NOT_AFTER_MS,
    task: null,
  });
  await tx.snapshot.update({
    where: { id: row.id },
    data: { ...moved(row, { type: "build_started" }), runnerId, buildInputsHash: environment.inputsHash, builder: plan.builder, registryId: plan.registry?.id ?? null },
  });
  await environmentNotice(deps, tx, row);
};

/**
 * `snapshot.schedule`'s use case. `ok` with the build's ID, new or the one a trigger within the
 * minute joined, or `null` when there's nothing to build (no repos; the nightly when nothing moved).
 * `no-docker-runner`: the build is made and stays `queued` until a `docker` runner of the project's
 * pools is online; the environment page says so.
 */
export const scheduleSnapshot = (async (deps: SnapshotPorts, input) => {
  const inputs = await readSnapshotBuildInputs({ db: deps.db, adapters: deps.adapters }, input.projectId);
  if (inputs === "not-found") {
    return { ok: false, error: "not-found", message: "no such project, or it has no environment" };
  }
  if (inputs === "no-repos") {
    return { ok: true, snapshotId: null };
  }
  return deps.db.$transaction(
    async (tx) => {
      // One schedule of a project at a time: two triggers at once make one build.
      await tx.$queryRaw`SELECT 1 FROM "environment" WHERE "id" = ${inputs.environmentId} FOR UPDATE`;
      const now = deps.clock.now();
      const scope = { organizationId: inputs.organizationId, projectId: inputs.projectId };
      const open = await tx.snapshot.findFirst({
        where: { ...scope, OR: [{ state: "queued" }, { state: "building", createdAt: { gt: new Date(now - SNAPSHOT_COALESCE_MS) } }] },
        orderBy: { createdAt: "desc" },
      });
      if (open === null && input.reason === "nightly" && inputs.headsKnown) {
        const ready = await tx.snapshot.findFirst({ where: { ...scope, state: "ready" }, orderBy: { readyAt: "desc" } });
        if (ready?.buildInputsHash === inputs.environment.inputsHash) {
          return { ok: true, snapshotId: null } as const;
        }
      }
      const row =
        open ??
        (await tx.snapshot.create({
          data: { ...scope, environmentId: inputs.environmentId, reason: input.reason, state: "queued", buildInputsHash: inputs.environment.inputsHash },
        }));
      const snapshotId = snapshotIdSchema.parse(row.id);
      if (open === null) {
        await environmentNotice(deps, tx, row);
      }
      if (row.state !== "queued") {
        return { ok: true, snapshotId } as const;
      }
      const plan = await planSnapshotBuild(tx, scope, now);
      if (plan === null) {
        return { ok: false, error: "no-docker-runner", message: "no docker runner of the project's pools is online; the build waits for one" } as const;
      }
      await startBuildInTx(deps, tx, row, plan, inputs.environment);
      return { ok: true, snapshotId } as const;
    },
    { timeout: 30_000 },
  );
}) satisfies (deps: SnapshotPorts, input: Parameters<ScheduleSnapshot>[1]) => ReturnType<ScheduleSnapshot>;

/**
 * Applies `snapshot.built` or `snapshot.failed`. The caller checked that the reporting runner is
 * the one the build went to. A repeat of the result already applied is `ok` and changes nothing.
 */
export const recordSnapshotResult = (async (deps: Pick<SnapshotPorts, "db" | "notices" | "clock">, input) =>
  deps.db.$transaction(async (tx) => {
    const found = await tx.snapshot.findUnique({ where: { id: input.snapshotId } });
    if (found === null) {
      return { ok: false, error: "not-found", message: "no such snapshot" } as const;
    }
    // The project's snapshots change one at a time: a build finishing replaces the ready one.
    await tx.$queryRaw`SELECT 1 FROM "environment" WHERE "id" = ${found.environmentId} FOR UPDATE`;
    const row = await tx.snapshot.findUniqueOrThrow({ where: { id: input.snapshotId } });
    const snapshotId = snapshotIdSchema.parse(row.id);
    const now = new Date(deps.clock.now());
    if (input.outcome === "built") {
      if ((row.state === "ready" || row.state === "replaced") && row.digest === input.imageDigest) {
        return { ok: true, snapshotId } as const;
      }
      if (row.state !== "building") {
        return { ok: false, error: "not-building", message: `the snapshot is ${row.state}` } as const;
      }
      const scope = { organizationId: row.organizationId, projectId: row.projectId };
      // A build made after this one finished first: this one is replaced at once.
      const newer = await tx.snapshot.findFirst({ where: { ...scope, state: "ready", createdAt: { gt: row.createdAt } }, select: { id: true } });
      if (newer === null) {
        await tx.snapshot.updateMany({ where: { ...scope, state: "ready", id: { not: row.id } }, data: { state: "replaced" } });
      }
      const ready = moved(row, { type: "build_finished" });
      // A pushed build is named as the registry holds it, with when it got there; a kept one as its runner's Docker names it.
      const registry = row.registryId === null ? null : await tx.registry.findUnique({ where: { id: row.registryId }, select: { url: true, repositoryPrefix: true } });
      const projectId = projectIdSchema.parse(row.projectId);
      await tx.snapshot.update({
        where: { id: row.id },
        data: {
          ...(newer === null ? ready : moved({ ...row, ...ready }, { type: "newer_ready" })),
          runnerId: runnerIdSchema.parse(input.runnerId),
          imageRef:
            registry === null
              ? snapshotImageRef(projectId, snapshotId)
              : registryImageRef({ url: registryHostOf(registry.url), repositoryPrefix: registry.repositoryPrefix }, projectId, snapshotId),
          pushedAt: registry === null ? null : now,
          digest: input.imageDigest,
          buildDurationMs: input.durationMs,
          // The runner reports `built` only after the image passed the scan for every setup secret.
          secretScan: "passed",
          readyAt: now,
        },
      });
    } else {
      if (row.state === "failed") {
        return { ok: true, snapshotId } as const;
      }
      if (row.state !== "building") {
        return { ok: false, error: "not-building", message: `the snapshot is ${row.state}` } as const;
      }
      await tx.snapshot.update({
        where: { id: row.id },
        data: {
          ...moved(row, { type: "build_failed", reason: snapshotFailureColumn(input.reason, input.detail) }),
          ...(input.reason === "secret-found" ? { secretScan: "failed" as const } : {}),
        },
      });
    }
    await environmentNotice(deps, tx, row);
    return { ok: true, snapshotId } as const;
  })) satisfies (deps: Pick<SnapshotPorts, "db" | "notices" | "clock">, input: Parameters<RecordSnapshotResult>[1]) => ReturnType<RecordSnapshotResult>;

/** A build its runner refused (past `notAfter`, no Docker): back to `queued`, for the sweep to send again. */
export const returnSnapshotBuildInTx = async (
  deps: Pick<SnapshotPorts, "notices">,
  tx: Tx,
  input: { readonly snapshotId: SnapshotId; readonly runnerId: RunnerId; readonly organizationId: OrganizationId },
): Promise<boolean> => {
  const row = await tx.snapshot.findFirst({ where: { id: input.snapshotId, organizationId: input.organizationId, runnerId: input.runnerId, state: "building" } });
  if (row === null) {
    return false;
  }
  await tx.snapshot.update({ where: { id: row.id }, data: { ...moved(row, { type: "build_returned" }), runnerId: null } });
  await environmentNotice(deps, tx, row);
  return true;
};

/**
 * The builds lost in flight: one whose runner went offline goes back to `queued`, and one that
 * reported nothing for `SNAPSHOT_BUILD_MAX_MS` failed. Returns how many of each.
 */
export const sweepSnapshotBuilds = async (deps: Pick<SnapshotPorts, "db" | "notices" | "clock">): Promise<{ readonly returned: number; readonly failed: number }> => {
  const now = deps.clock.now();
  const building = await deps.db.snapshot.findMany({
    where: { state: "building" },
    select: { id: true, organizationId: true, createdAt: true, runner: { select: { id: true, state: true, revokedAt: true, presence: { select: { disconnectedAt: true, lastSeenAt: true } } } } },
    take: 500,
  });
  let returned = 0;
  let failed = 0;
  for (const row of building) {
    const presence = row.runner?.presence ?? null;
    const online =
      row.runner !== null &&
      row.runner.state === "online" &&
      row.runner.revokedAt === null &&
      presence !== null &&
      presence.disconnectedAt === null &&
      presence.lastSeenAt.getTime() > now - runnerLimits.offlineMs;
    await deps.db.$transaction(async (tx) => {
      const fresh = await tx.snapshot.findFirst({ where: { id: row.id, state: "building" } });
      if (fresh === null) {
        return;
      }
      if (!online) {
        await tx.snapshot.update({ where: { id: fresh.id }, data: { ...moved(fresh, { type: "build_returned" }), runnerId: null } });
        returned += 1;
      } else if (row.createdAt.getTime() < now - SNAPSHOT_BUILD_MAX_MS) {
        const reason = snapshotFailureColumn("build-failed", "The runner didn't report the build's result within 2 hours.");
        await tx.snapshot.update({ where: { id: fresh.id }, data: moved(fresh, { type: "build_failed", reason }) });
        failed += 1;
      } else {
        return;
      }
      await environmentNotice(deps, tx, fresh);
    });
  }
  return { returned, failed };
};

/** Not a `UseCaseResult`, as the task's credentials: a refusal is a `409` for the runner. */
export type IssueSnapshotCredentialsResult =
  | { readonly ok: true; readonly credentials: SnapshotCredentials }
  | { readonly ok: false; readonly error: "conflict" | "token-mint-failed"; readonly message: string };

/** The snapshot build's git token: read the repo, never push (ADR 0030). */
const SNAPSHOT_GIT_PERMISSIONS = { contents: "read", metadata: "read" } as const;

/**
 * `POST /runner/v1/snapshots/:snapshotId/credentials`: for the runner the build went to, while it
 * builds. A read-only git token per repo and the secrets marked available during setup, which the
 * build mounts for its setup step only. Each issue is an audit entry; nothing here is logged.
 */
export const issueSnapshotCredentials = async (
  deps: { readonly tx: Tx; readonly audit: AuditLog; readonly adapters: Pick<ServerAdapters, "codeHost" | "secretStore"> },
  input: { readonly snapshotId: SnapshotId; readonly runnerId: RunnerId },
): Promise<IssueSnapshotCredentialsResult> => {
  const { tx } = deps;
  const runner = await tx.runner.findUnique({ where: { id: input.runnerId }, select: { organizationId: true } });
  const row =
    runner === null ? null : await tx.snapshot.findFirst({ where: { id: input.snapshotId, organizationId: runner.organizationId, runnerId: input.runnerId, state: "building" } });
  if (row === null) {
    return { ok: false, error: "conflict", message: "this runner isn't building that snapshot" };
  }
  const organizationId = organizationIdSchema.parse(row.organizationId);
  const failed = (message: string) => ({ ok: false, error: "token-mint-failed", message }) as const;
  const repos = await tx.repo.findMany({ where: { projectId: row.projectId, organizationId }, include: { connection: true, ...installationStateSelect }, orderBy: { createdAt: "asc" } });
  // Milestone 4 (F-136, ADR 0065): no token through an installation that isn't linked, for any repo.
  if (repos.some((repo) => !installationUsable(repo.installation))) {
    return failed(INSTALLATION_NOT_LINKED);
  }
  const tokens: { repoId: RepoId; gitToken: string; expiresAt: number }[] = [];
  for (const repo of repos) {
    const app = await appCredentials(deps.adapters.secretStore, organizationId, repo.connection);
    if (app === null) {
      return failed("the App's private key couldn't be read from the secret store");
    }
    const minted = await deps.adapters.codeHost.mintRepoToken(
      { app, installationId: repo.installationId, repo: repoFullNameSchema.parse(repo.fullName) },
      SNAPSHOT_GIT_PERMISSIONS,
    );
    if (!minted.ok) {
      return failed(`the code host refused a token for a repo (${minted.error.code})`);
    }
    tokens.push({ repoId: repoIdSchema.parse(repo.id), gitToken: minted.value.token, expiresAt: minted.value.expiresAt });
  }
  const entries = await tx.environmentEntry.findMany({ where: { environmentId: row.environmentId, kind: "secret", availableDuringSetup: true } });
  const secrets: { repoId: RepoId; entries: RepoSecret[] }[] = repos.map((repo) => ({ repoId: repoIdSchema.parse(repo.id), entries: [] }));
  for (const entry of entries) {
    const ref = secretRefSchema.safeParse(entry.secretRef);
    if (!ref.success) {
      continue;
    }
    const value = await deps.adapters.secretStore.get(organizationId, ref.data);
    if (!value.ok) {
      return failed("a setup secret couldn't be read from the secret store");
    }
    const target = secrets.find((group) => group.repoId === entry.repoId);
    if (entry.path !== null) {
      target?.entries.push({ kind: "file", path: entry.path, content: value.value, availableDuringSetup: true });
    } else if (entry.name !== null) {
      target?.entries.push({ kind: "variable", name: entry.name, value: value.value, availableDuringSetup: true });
    }
  }
  const credentials = snapshotCredentialsSchema.parse({ snapshotId: input.snapshotId, repos: tokens, secrets });
  await deps.audit.recordInTx(tx, {
    organizationId,
    projectId: projectIdSchema.parse(row.projectId),
    actor: { kind: "runner", id: input.runnerId },
    action: "snapshot.credentials-issued",
    entity: "environment",
    entityId: environmentIdSchema.parse(row.environmentId),
    data: { snapshotId: input.snapshotId, repos: tokens.length, setupSecrets: entries.length },
  });
  return { ok: true, credentials };
};
