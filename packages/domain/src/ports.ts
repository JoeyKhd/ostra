import type { CodeHostAdapter, ModelProviderAdapter, SecretStoreAdapter } from "@ostra/adapter-sdk";
import type { Tx } from "@ostra/db";
import type {
  AgentProfileId,
  ApprovalId,
  ChangeEntity,
  CommandBody,
  CommandId,
  CommandKind,
  CommandSeq,
  ConnectionId,
  EnvironmentId,
  JoinTokenId,
  MemberId,
  ModelId,
  OrganizationId,
  PoolId,
  ProjectId,
  ProviderId,
  RunnerId,
  TaskId,
} from "@ostra/protocol";

import type { JobName, JobPayload } from "./jobs.ts";

// The ports the use cases take (ticket 08). Each is written once on the server side (`packages/jobs`
// implements `JobQueue`, core implements the outbox) and in memory in tests. Every `…InTx` writes
// in the caller's transaction, so nothing is acted on before it's saved (ADR 0011).

export type EnqueueOptions = {
  /** Run no sooner than this many ms from now (a timer: the offer timeout, the task grace). */
  readonly startAfterMs?: number;
  /**
   * The group a throttled job counts against (`jobSending`'s `throttle`), such as its connection's
   * ID: the queue's `groupConcurrency` limits running jobs per group. A throttle, never a budget
   * (ADR 0037): two extra claims can briefly pass it.
   */
  readonly group?: { readonly id: string; readonly tier?: string };
};

/** The durable queue (ADR 0037). Sending a job with a key that exists returns the existing one. */
export type JobQueue = {
  readonly enqueueInTx: <N extends JobName>(tx: Tx, job: N, payload: JobPayload<N>, options?: EnqueueOptions) => Promise<void>;
};

/** A command for the outbox: references only, never a secret (ADR 0034). */
export type OutboxCommand<K extends CommandKind> = {
  readonly kind: K;
  readonly body: CommandBody<K>;
  /** Server time past which the peer must reject it. */
  readonly notAfter: number;
  /** The task it's about, for the panel and for cleanup. */
  readonly task: { readonly taskId: TaskId; readonly projectId: ProjectId } | null;
};

/**
 * The command outbox (ADR 0034). `enqueueInTx` takes the runner's counter under the runner row's
 * lock, so numbers are gap-free and in commit order, and sends the `NOTIFY` that commits with it.
 */
export type CommandOutbox = {
  readonly enqueueInTx: <K extends CommandKind>(
    tx: Tx,
    organizationId: OrganizationId,
    runnerId: RunnerId,
    command: OutboxCommand<K>,
  ) => Promise<{ readonly commandId: CommandId; readonly seq: CommandSeq }>;
};

/**
 * The ID of any record a change notice or an audit entry can name. A bare string is not one: the
 * caller holds the record's branded ID, or parses it with the ID's schema.
 */
export type EntityId =
  | AgentProfileId
  | ApprovalId
  | ConnectionId
  | EnvironmentId
  | JoinTokenId
  | MemberId
  | ModelId
  | OrganizationId
  | PoolId
  | ProjectId
  | ProviderId
  | RunnerId
  | TaskId;

/** A change to tell the panel's live views about: IDs only (ADR 0035). */
export type ChangeNoticeInput = {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId | null;
  /** The kind of record: `task`, `runner`, `project`, `model-provider`, … (the closed `ChangeEntity` union). */
  readonly entity: ChangeEntity;
  readonly entityId: EntityId;
};

export type ChangeNotices = {
  readonly emitInTx: (tx: Tx, notice: ChangeNoticeInput) => Promise<void>;
};

/** Who did what (F-073): IDs and settings only, never content or secrets. */
export type AuditInput = {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId | null;
  readonly actor: { readonly kind: "member" | "runner" | "system"; readonly id: string | null };
  readonly action: string;
  readonly entity: string | null;
  readonly entityId: EntityId | null;
  readonly data?: Readonly<Record<string, string | number | boolean | null>>;
};

export type AuditLog = {
  readonly recordInTx: (tx: Tx, entry: AuditInput) => Promise<void>;
};

export type Clock = { readonly now: () => number };

/** The adapter instances the server holds (ADR 0025). */
export type ServerAdapters = {
  readonly codeHost: CodeHostAdapter;
  readonly modelProvider: ModelProviderAdapter;
  readonly secretStore: SecretStoreAdapter;
};

/** Everything a use case may need beyond its transaction. */
export type Ports = {
  readonly jobs: JobQueue;
  readonly outbox: CommandOutbox;
  readonly notices: ChangeNotices;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly adapters: ServerAdapters;
};
