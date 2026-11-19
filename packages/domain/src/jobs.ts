import {
  leaseEpochSchema,
  organizationIdSchema,
  providerIdSchema,
  sessionIdSchema,
  taskIdSchema,
  taskSeqSchema,
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
