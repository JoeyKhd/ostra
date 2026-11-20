import type { Db, Tx } from "@ostra/db";
import type {
  BoxSizeName,
  ExecutorKind,
  JoinTokenId,
  LeaseEpoch,
  OrganizationId,
  PoolId,
  ProjectId,
  RegistryCredential,
  RegistryId,
  RunnerCapabilities,
  RunnerId,
  RunnerInstall,
  RunnerOs,
  RunnerResources,
  SnapshotId,
  TaskId,
} from "@ostra/protocol";

import type { MemberScope } from "../access.ts";
import type { DispatchWait } from "../dispatch-wait.ts";
import type { Resources } from "../fleet/capacity.ts";
import type { RegistryCheckResult } from "../fleet/registry.ts";
import type { RunnerVersionState } from "../fleet/versions.ts";
import type { Ports } from "../ports.ts";
import type { UseCaseResult } from "./common.ts";

// Milestone 5's use cases (spec section 5.4, ADR 0059, ADR 0060): each one's input, result and
// signature, with its ports. The signature is the contract the routers, core's workers and the
// tests are written against; the bodies come with tickets 12 to 17. `chooseRunner` is pure and
// has its body in `../fleet/choose.ts`; `approveRunner` and `rejectRunner` are milestone 1's
// (`runner-approval.ts`). Every write is one transaction with its change notice, its audit entry
// and the jobs it enqueues (ADR 0011, ADR 0037).

/** What a milestone 5 use case takes: the database and the ports. */
export type M5Deps = { readonly db: Db } & Ports;

// ---------- pools and join tokens (F-091; ticket 12) ----------

/** A pool's settings as an admin sets them. */
export type PoolSettings = {
  readonly name: string;
  readonly requiresApproval: boolean;
  /** The pool's cap on boxes at once; `null` for none. */
  readonly maxBoxes: number | null;
  /** A new join token's lifetime in days: `null` for the setting's, `0` for none. */
  readonly joinTokenDays: number | null;
};

/** A join token as its creation answers it: shown once, stored hashed. */
export type NewJoinToken = { readonly joinTokenId: JoinTokenId; /** Shown once. Never logged. */ readonly token: string; readonly expiresAt: number | null };

/** Makes the pool and its first join token in one transaction (spec section 4, "A pool and its tokens"). */
export type CreatePool = (
  deps: M5Deps,
  scope: MemberScope,
  input: PoolSettings & {
    /** Projects that use the pool from now, each at the end of its list (F-086); an unknown one is `invalid-input`. */
    readonly projectIds?: readonly ProjectId[];
  },
) => Promise<UseCaseResult<{ readonly poolId: PoolId; readonly joinToken: NewJoinToken }, "forbidden" | "name-taken" | "invalid-input">>;

export type UpdatePool = (
  deps: M5Deps,
  scope: MemberScope,
  input: { readonly poolId: PoolId } & Partial<PoolSettings>,
) => Promise<UseCaseResult<{ readonly poolId: PoolId }, "forbidden" | "not-found" | "name-taken" | "invalid-input">>;

/** A new join token: shown once, stored hashed. `token` is never logged or stored. */
export type CreateJoinToken = (
  deps: M5Deps,
  scope: MemberScope,
  input: {
    readonly poolId: PoolId;
    readonly label: string | null;
    /** The admin's lifetime in days: `null` for none; left out for the pool's (or `OSTRA_JOIN_TOKEN_DAYS`). */
    readonly days?: number | null;
  },
) => Promise<UseCaseResult<NewJoinToken, "forbidden" | "not-found">>;

/** Revokes a token: no new runner joins with it; the runners that joined stay (rotation disconnects nobody). */
export type RevokeJoinToken = (
  deps: M5Deps,
  scope: MemberScope,
  input: { readonly joinTokenId: JoinTokenId },
) => Promise<UseCaseResult<{ readonly revokedAt: number }, "forbidden" | "not-found" | "already-revoked">>;

/** What a runner says when it joins a pool with a token (milestone 1's register, grown). */
export type PoolRunnerJoin = {
  /** Never logged; checked by its hash. */
  readonly token: string;
  readonly name: string;
  readonly publicKey: string;
  readonly executor: ExecutorKind;
  readonly version: string;
  readonly install: RunnerInstall | null;
  readonly labels: readonly string[];
  /** Milestone 1's register request's slots; 1 when left out. */
  readonly capacity?: number;
  /** Milestone 1's register request's system; `null` when left out. */
  readonly os?: RunnerOs;
};

export type RegisterPoolRunner = (
  deps: M5Deps,
  input: PoolRunnerJoin,
) => Promise<
  UseCaseResult<
    { readonly runnerId: RunnerId; readonly poolId: PoolId; readonly organizationId: OrganizationId; readonly awaitsApproval: boolean },
    "token-unknown" | "token-expired" | "token-revoked" | "name-taken" | "key-taken" | "invalid-input"
  >
>;

// ---------- the fleet: drain, resume and what a runner reports (F-092, F-061, F-067; tickets 13, 15, 16) ----------

export type DrainRunner = (
  deps: M5Deps,
  scope: MemberScope,
  input: { readonly runnerId: RunnerId },
) => Promise<UseCaseResult<{ readonly state: "draining" }, "forbidden" | "not-found" | "not-allowed-in-state">>;

/** Lifts a drain. A runner below minor 4 gets no `resume` command, and takes tasks after it restarts. */
export type ResumeRunner = (
  deps: M5Deps,
  scope: MemberScope,
  input: { readonly runnerId: RunnerId },
) => Promise<UseCaseResult<{ readonly state: "online" | "offline"; readonly commandSent: boolean }, "forbidden" | "not-found" | "not-draining">>;

/** What a runner's `hello` or `status` reports, as core keeps it. */
export type RunnerReport = {
  readonly runnerId: RunnerId;
  readonly organizationId: OrganizationId;
  readonly minor: number;
  readonly version: string;
  readonly slots: number;
  readonly resources: RunnerResources | null;
  readonly capabilities: RunnerCapabilities | null;
  readonly install: RunnerInstall | null;
  /** As the runner set them; a reserved one is dropped (`runnerLabels`). */
  readonly labels: readonly string[];
  readonly os: string | null;
  readonly arch: string | null;
};

export type RecordRunnerReport = (
  deps: { readonly tx: Tx } & Pick<Ports, "clock" | "notices" | "jobs">,
  report: RunnerReport,
) => Promise<
  UseCaseResult<{ readonly labels: readonly string[]; readonly droppedLabels: readonly string[]; readonly versionState: RunnerVersionState }, "not-found">
>;

// ---------- sizes, project pools and labels (F-095, F-069, F-086; ticket 27) ----------

export type SetBoxSizes = (
  deps: M5Deps,
  scope: MemberScope,
  /** The sizes to change; a name left out keeps its limits (ticket 27's `boxSizes.update` sets one). */
  input: { readonly sizes: Readonly<Partial<Record<BoxSizeName, Resources>>> },
) => Promise<UseCaseResult<{ readonly changedAt: number }, "forbidden" | "invalid-input">>;

/** A project's pools in order, each with its share in boxes (`null`: none), and its default size. */
export type SetProjectPools = (
  deps: M5Deps,
  scope: MemberScope,
  input: {
    readonly projectId: ProjectId;
    /** In the project's order. Left out: kept (ticket 27's `projects.setDefaultBoxSize` sets the size alone). */
    readonly pools?: readonly { readonly poolId: PoolId; readonly maxBoxes: number | null }[];
    /** Left out: kept. `null`: none, slots only. */
    readonly defaultBoxSize?: BoxSizeName | null;
  },
) => Promise<UseCaseResult<{ readonly changedAt: number }, "forbidden" | "not-found" | "invalid-input">>;

export type SetProfileLabels = (
  deps: M5Deps,
  scope: MemberScope,
  input: { readonly profileId: string; readonly labels: readonly string[] },
) => Promise<UseCaseResult<{ readonly changedAt: number }, "forbidden" | "not-found" | "invalid-input">>;

// ---------- the queue (F-067; ticket 13) ----------

/**
 * Puts a task in the queue: a new task, a reopen or a requeue. Sets `queuePriority` from its
 * ticket, `requiredLabels` from its profile, and `queuedAt` unless the task keeps its first.
 */
export type QueueTask = (
  deps: { readonly tx: Tx } & Pick<Ports, "clock" | "jobs">,
  input: { readonly organizationId: OrganizationId; readonly taskId: TaskId; readonly keepPlace: boolean },
) => Promise<UseCaseResult<{ readonly queuePriority: number; readonly poolIds: readonly PoolId[] }, "not-found" | "not-queued">>;

/** One pass of a pool's admission (`queue.admit`): what it admitted and why the rest wait. */
export type AdmitQueued = (
  deps: M5Deps,
  input: { readonly organizationId: OrganizationId; readonly poolId: PoolId },
) => Promise<{
  readonly admitted: readonly { readonly taskId: TaskId; readonly runnerId: RunnerId; readonly leaseEpoch: LeaseEpoch }[];
  readonly waiting: readonly { readonly taskId: TaskId; readonly reason: DispatchWait }[];
}>;

/** Cancels a queued task: an admin any, a member their own. It stops as `cancelled`. */
export type CancelQueuedTask = (
  deps: M5Deps,
  scope: MemberScope,
  input: { readonly taskId: TaskId },
) => Promise<UseCaseResult<{ readonly state: "stopped" }, "forbidden" | "not-found" | "not-queued">>;

// ---------- the registry (F-120; ticket 17) ----------

/** A credential as an admin enters it: stored in the secret store, never in a row. */
export type RegistryCredentialInput = { readonly username: string; /** Never logged. */ readonly token: string };

export type SetRegistry = (
  deps: M5Deps,
  scope: MemberScope,
  input: {
    readonly url: string;
    readonly repositoryPrefix: string;
    readonly auth: "basic" | "node";
    /** Left out: the stored one is kept. */
    readonly push?: RegistryCredentialInput;
    readonly pull?: RegistryCredentialInput;
  },
) => Promise<UseCaseResult<{ readonly registryId: RegistryId }, "forbidden" | "invalid-input">>;

/** The `registry.check` job's work: core's own calls to the registry, nothing pushed. */
export type CheckRegistry = (
  deps: M5Deps,
  input: { readonly organizationId: OrganizationId; readonly registryId: RegistryId },
) => Promise<UseCaseResult<{ readonly result: RegistryCheckResult; readonly checkedAt: number }, "not-found">>;

/** A pull credential for the lease's image, for the runner that holds the lease at this epoch. */
export type IssuePullCredential = (
  deps: M5Deps,
  input: { readonly organizationId: OrganizationId; readonly runnerId: RunnerId; readonly taskId: TaskId; readonly leaseEpoch: LeaseEpoch },
) => Promise<UseCaseResult<{ readonly credential: RegistryCredential }, "not-found" | "no-image" | "stale-lease">>;

/** A push credential for a snapshot build, for the runner the build was given to, while it's building. */
export type IssuePushCredential = (
  deps: M5Deps,
  input: { readonly organizationId: OrganizationId; readonly runnerId: RunnerId; readonly snapshotId: SnapshotId },
) => Promise<UseCaseResult<{ readonly credential: RegistryCredential }, "not-found" | "not-the-builder">>;
