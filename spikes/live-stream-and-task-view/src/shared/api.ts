import { z } from "zod";
import { approvalDecision, delivery, storedEventSchema } from "./events.ts";
import { ClientMessageId, MemberId, OptionId, TaskId } from "./ids.ts";

// The page <-> server API, written once. The server builds each body typed (and checked) against
// these schemas before it sends; the page, the producer and the harness parse replies with the same
// ones. They are ostra-owned, so every object rejects unknown fields (AGENTS.md).

export const memberRole = z.enum(["member", "viewer"]);
export type MemberRole = z.infer<typeof memberRole>;

// ---- errors ------------------------------------------------------------------------------

export const errorCode = z.enum(["BAD_REQUEST", "UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "INTERNAL"]);
export type ErrorCode = z.infer<typeof errorCode>;

export const errorStatus = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL: 500,
} as const satisfies Record<ErrorCode, number>;

export const failureDetails = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

export const apiError = z.strictObject({
  error: z.strictObject({ code: errorCode, message: z.string(), details: failureDetails }),
});
export type ApiError = z.infer<typeof apiError>;

// ---- requests and replies ----------------------------------------------------------------

export const okBody = z.strictObject({ ok: z.literal(true) });

export const loginRequest = z.strictObject({ memberId: MemberId });
export const loginResponse = okBody;

export const meResponse = z.strictObject({ memberId: MemberId, role: memberRole });

export const taskInfo = z.strictObject({
  task: z.strictObject({ taskId: TaskId, driverMemberId: MemberId.nullable(), driverVersion: z.number().int() }),
  me: meResponse,
  headSeq: z.number().int().nonnegative(),
});
export type TaskInfo = z.infer<typeof taskInfo>;

export const historyPage = z.strictObject({
  events: z.array(storedEventSchema),
  hasEarlier: z.boolean(),
  oldestSeq: z.number().int().positive(),
  headSeq: z.number().int().nonnegative(),
});
export type HistoryPage = z.infer<typeof historyPage>;

export const sendRequest = z.strictObject({
  text: z.string().min(1).max(20_000),
  clientMessageId: ClientMessageId,
  interruptFirst: z.boolean().optional(),
});
export const sendResponse = z.strictObject({
  ok: z.literal(true),
  duplicate: z.boolean(),
  delivery,
  seq: z.number().int().nonnegative(),
});

// Mutations accept JSON only, and a body that carries nothing is still an (empty, strict) object.
export const interruptRequest = z.strictObject({});
export const interruptResponse = okBody;

export const takeOverRequest = z.strictObject({ expectedVersion: z.number().int() });
export const takeOverResponse = z.strictObject({ ok: z.literal(true), driverVersion: z.number().int() });

export const answerRequest = z.strictObject({ optionId: OptionId });
export const answerResponse = z.strictObject({ ok: z.literal(true), decision: approvalDecision });

export const healthResponse = okBody;

// ---- runner commands ---------------------------------------------------------------------

export const commandsQuery = z.strictObject({
  taskId: TaskId,
  after: z.coerce.number().int().nonnegative().default(0),
});

export const runnerCommand = z.strictObject({
  id: z.number().int(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type RunnerCommand = z.infer<typeof runnerCommand>;
export const commandsResponse = z.strictObject({ commands: z.array(runnerCommand) });

// ---- metrics (runner token required) -----------------------------------------------------

export const appenderMetrics = z.strictObject({
  flushes: z.number(),
  eventsCommitted: z.number(),
  flushMsTotal: z.number(),
  flushMsMax: z.number(),
  maxBatchEvents: z.number(),
  failures: z.number(),
  // partial-text rows upserted into the UNLOGGED table, and their text bytes (ADR 0035's fallback question)
  liveUpserts: z.number(),
  liveBytes: z.number(),
  // the JSON bytes of every committed event's payload
  payloadBytes: z.number(),
});
export type AppenderMetrics = z.infer<typeof appenderMetrics>;

export const tailerMetrics = z.strictObject({
  ticks: z.number(),
  eventQueries: z.number(),
  liveQueries: z.number(),
  eventRows: z.number(),
  wakes: z.number(),
  polls: z.number(),
  maxSubscribers: z.number(),
  subscribers: z.number(),
  groups: z.number(),
});
export type TailerMetrics = z.infer<typeof tailerMetrics>;
export type TailerCounters = Omit<TailerMetrics, "subscribers" | "groups">;

export const sseMetrics = z.strictObject({
  opened: z.number(),
  closed: z.number(),
  active: z.number(),
  slowDisconnects: z.number(),
  framesWritten: z.number(),
});
export type SseMetrics = z.infer<typeof sseMetrics>;

export const metricsResponse = z.strictObject({
  replica: z.string(),
  appender: appenderMetrics,
  tailer: tailerMetrics,
  sse: sseMetrics,
  notifiesSent: z.number(),
  notifiesReceived: z.number(),
  memory: z.number(),
});
export type MetricsResponse = z.infer<typeof metricsResponse>;
