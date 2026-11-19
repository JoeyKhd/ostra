import {
  boardIdSchema,
  boxIdSchema,
  boxReleaseReasonSchema,
  connectionIdSchema,
  leaseEpochSchema,
  organizationIdSchema,
  providerIdSchema,
  sessionIdSchema,
  taskIdSchema,
  taskSeqSchema,
  ticketWriteIdSchema,
  webhookDeliveryIdSchema,
} from "@ostra/protocol";
import { z } from "zod";

// The job catalogue (ticket 08, ADR 0037): every background job's name, its payload (IDs only,
// never content) and its key. A key is fixed by what the job does, such as
// `task:<TaskId>:<transition>:<seq>`, so sending a job twice returns the existing one.
// `packages/jobs` implements the queue on pg-boss (ticket 23).

const taskScope = { organizationId: organizationIdSchema, taskId: taskIdSchema };

/** Every job's name. `jobPayloadSchemas` must hold exactly these: the compiler refuses a missing or an extra one. */
export const jobNames = [
  "task.dispatch",
  "task.offer-timeout",
  "task.grace",
  "task.session-ended",
  "task.open-pull-requests",
  "provider.refresh-models",
  "catalog.refresh",
  // ---- milestone 2 ----
  "webhook.process",
  "tracker.poll-board",
  "github.reconcile-prs",
  "linear.refresh-token",
  "ticket.fetch-context",
  "ticket.sync",
  "session.max-duration",
  "session.stall-sweep",
  "box.release",
  "box.release-after-idle",
  "retention.sweep",
  "blob.gc",
] as const;

export type JobName = (typeof jobNames)[number];

/** Each job's payload. */
export const jobPayloadSchemas = {
  /** Lease the task to a runner and send the `dispatch` command (ticket 26). Keyed by the epoch it grants. */
  "task.dispatch": z.strictObject({ ...taskScope, sessionId: sessionIdSchema, leaseEpoch: leaseEpochSchema }),
  /** A dispatch not accepted within the offer timeout goes back to the queue (ADR 0034). */
  "task.offer-timeout": z.strictObject({ ...taskScope, leaseEpoch: leaseEpochSchema }),
  /** The peer was gone for the whole task grace: stop the task cleanly, refuse later writes (F-045). */
  "task.grace": z.strictObject({ ...taskScope, leaseEpoch: leaseEpochSchema }),
  /** React to a stored `session.ended` (ticket 27). Keyed by that event's task seq. */
  "task.session-ended": z.strictObject({ ...taskScope, sessionId: sessionIdSchema, eventSeq: taskSeqSchema }),
  /** Open one PR per changed repo, idempotent per task repo (F-030, ticket 27). */
  "task.open-pull-requests": z.strictObject({ ...taskScope, sessionId: sessionIdSchema, eventSeq: taskSeqSchema }),
  /** Refresh a provider's model list from its endpoint (F-088, ticket 28). */
  "provider.refresh-models": z.strictObject({ organizationId: organizationIdSchema, providerId: providerIdSchema }),
  /** The daily models.dev catalog fetch, unless `OSTRA_CATALOG_FETCH` is off (F-088, ticket 28). */
  "catalog.refresh": z.strictObject({}),

  // ---- milestone 2 ----
  /**
   * Act on a webhook the inbox saved (ticket 13): the delivery row, found by its connection and
   * the vendor's delivery ID. The body stays in the row; the payload holds IDs only.
   */
  "webhook.process": z.strictObject({
    organizationId: organizationIdSchema,
    connectionId: connectionIdSchema,
    deliveryId: webhookDeliveryIdSchema,
  }),
  /** One poll of a board's tickets updated since its cursor (F-042, ticket 14). An idempotent pass: a schedule. */
  "tracker.poll-board": z.strictObject({ organizationId: organizationIdSchema, boardId: boardIdSchema }),
  /** The PR states of a GitHub connection's task repos with an open PR (F-044, ticket 16). An idempotent pass. */
  "github.reconcile-prs": z.strictObject({ organizationId: organizationIdSchema, connectionId: connectionIdSchema }),
  /** Refresh a Linear connection's access token before it expires (F-005, ticket 08). */
  "linear.refresh-token": z.strictObject({ organizationId: organizationIdSchema, connectionId: connectionIdSchema }),
  /** Read a ticket task's context, copy its images, render its prompt, then dispatch (F-064, ticket 18). */
  "ticket.fetch-context": z.strictObject({ ...taskScope, sessionId: sessionIdSchema }),
  /** Apply one `TicketWrite` through the tracker adapter (F-031, ticket 15). */
  "ticket.sync": z.strictObject({ organizationId: organizationIdSchema, ticketWriteId: ticketWriteIdSchema }),
  /** A session's longest life (F-068, ticket 19): one delayed job per session, cancelled when it ends. */
  "session.max-duration": z.strictObject({ ...taskScope, sessionId: sessionIdSchema }),
  /** Once a minute: stop the running sessions with no agent event for the stall time (F-068, ticket 19). */
  "session.stall-sweep": z.strictObject({}),
  /** Send a box's runner the `release` command, and delete the task's hidden refs (F-079, ticket 20). */
  "box.release": z.strictObject({ ...taskScope, boxId: boxIdSchema, reason: boxReleaseReasonSchema }),
  /** A stopped box released after `OSTRA_BOX_RELEASE_IDLE_DAYS` (F-079, ticket 20): one delayed job per box. */
  "box.release-after-idle": z.strictObject({ ...taskScope, boxId: boxIdSchema }),
  /** Delete what the retention in effect no longer keeps (F-079, ticket 20). */
  "retention.sweep": z.strictObject({}),
  /** Delete blobs no task or session refers to any more (F-114, ticket 12). */
  "blob.gc": z.strictObject({}),
} as const satisfies Record<JobName, z.ZodType>;

export type JobPayload<N extends JobName> = z.infer<(typeof jobPayloadSchemas)[N]>;

/** Each job's key rule. */
const jobKeys: { readonly [N in JobName]: (payload: JobPayload<N>) => string } = {
  "task.dispatch": (payload) => `task:${payload.taskId}:dispatch:${String(payload.leaseEpoch)}`,
  "task.offer-timeout": (payload) => `task:${payload.taskId}:offer-timeout:${String(payload.leaseEpoch)}`,
  "task.grace": (payload) => `task:${payload.taskId}:grace:${String(payload.leaseEpoch)}`,
  "task.session-ended": (payload) => `task:${payload.taskId}:session-ended:${String(payload.eventSeq)}`,
  "task.open-pull-requests": (payload) => `task:${payload.taskId}:open-pull-requests:${String(payload.eventSeq)}`,
  "provider.refresh-models": (payload) => `provider:${payload.providerId}:refresh-models`,
  "catalog.refresh": () => "catalog:refresh",
  "webhook.process": (payload) => `webhook:${payload.connectionId}:${payload.deliveryId}`,
  "tracker.poll-board": (payload) => `board:${payload.boardId}:poll`,
  "github.reconcile-prs": (payload) => `connection:${payload.connectionId}:reconcile-prs`,
  "linear.refresh-token": (payload) => `connection:${payload.connectionId}:refresh-token`,
  "ticket.fetch-context": (payload) => `task:${payload.taskId}:fetch-context:${payload.sessionId}`,
  "ticket.sync": (payload) => `ticket:${payload.ticketWriteId}:sync`,
  "session.max-duration": (payload) => `session:${payload.sessionId}:max-duration`,
  "session.stall-sweep": () => "sessions:stall-sweep",
  "box.release": (payload) => `box:${payload.boxId}:release`,
  "box.release-after-idle": (payload) => `box:${payload.boxId}:release-after-idle`,
  "retention.sweep": () => "retention:sweep",
  "blob.gc": () => "blob:gc",
};

/** How a job is sent (ADR 0037, as amended after spike 8). */
export type JobSending = {
  /**
   * `event`: sent in the transaction of what caused it. `schedule`: an idempotent pass a pg-boss
   * schedule may send, with `singletonSeconds` so a tick isn't sent twice. `timer`: one delayed
   * job per key, cancelled when its subject ends.
   */
  readonly kind: "event" | "schedule" | "timer";
  /** The group a job's concurrency is throttled by, per connection: a throttle, never a budget. */
  readonly throttle?: "connection";
};

export const jobSending: Readonly<Record<JobName, JobSending>> = {
  "task.dispatch": { kind: "event" },
  "task.offer-timeout": { kind: "timer" },
  "task.grace": { kind: "timer" },
  "task.session-ended": { kind: "event" },
  "task.open-pull-requests": { kind: "event" },
  "provider.refresh-models": { kind: "event" },
  "catalog.refresh": { kind: "schedule" },
  "webhook.process": { kind: "event" },
  "tracker.poll-board": { kind: "schedule", throttle: "connection" },
  "github.reconcile-prs": { kind: "schedule", throttle: "connection" },
  "linear.refresh-token": { kind: "timer" },
  "ticket.fetch-context": { kind: "event" },
  "ticket.sync": { kind: "event", throttle: "connection" },
  "session.max-duration": { kind: "timer" },
  "session.stall-sweep": { kind: "schedule" },
  "box.release": { kind: "event" },
  "box.release-after-idle": { kind: "timer" },
  "retention.sweep": { kind: "schedule" },
  "blob.gc": { kind: "schedule" },
};

const typedSchemas: { readonly [N in JobName]: z.ZodType<JobPayload<N>> } = jobPayloadSchemas;

/** A job's key, from its payload. */
export const jobKey = <N extends JobName>(job: N, payload: JobPayload<N>): string => jobKeys[job](payload);

/** Parses a job's payload as it comes off the queue (external data: storage). */
export const parseJobPayload = <N extends JobName>(
  job: N,
  payload: unknown,
): { readonly ok: true; readonly payload: JobPayload<N> } | { readonly ok: false } => {
  const parsed = typedSchemas[job].safeParse(payload);
  return parsed.success ? { ok: true, payload: parsed.data } : { ok: false };
};
