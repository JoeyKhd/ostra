import { z } from "zod";

import {
  approvalIdSchema,
  boxIdSchema,
  clientMessageIdSchema,
  commandIdSchema,
  sessionIdSchema,
  taskIdSchema,
} from "../ids.ts";
import { commandSeqSchema, epochMsSchema, leaseEpochSchema } from "../common.ts";
import { approvalDecisionSchema } from "../events/agent-events.ts";
import { runnerLimits } from "./limits.ts";

// Commands: numbered instructions from the server to a peer (ADR 0034). Each is a row in the
// outbox, numbered per runner under the runner row's lock, written in the same transaction as the
// change that caused it. The peer applies each once by its `id`, acks the highest contiguous
// `seq`, and rejects one past its `notAfter` (judged by the server's clock, from `welcome`).
//
// Commands carry references, never secrets: keys and tokens are fetched by
// `POST /runner/v1/tasks/:taskId/credentials` after the lease check.
//
// Ported from spikes/runner-transport/src/protocol/messages.ts, widened to the product's set.

/** `dispatch`: an offer of a task. The peer answers `accepted` or `rejected` within the offer timeout. */
export const dispatchBodySchema = z.strictObject({
  taskId: taskIdSchema,
  sessionId: sessionIdSchema,
  boxId: boxIdSchema,
  leaseEpoch: leaseEpochSchema,
});

/**
 * `steer`: a member's message for the running session (F-024, milestone 3). `queue` waits for the
 * turn to end; `interrupt` cancels the turn first. An agent that declares `steerMidTurn` may take a
 * queued message mid-turn.
 */
export const steerBodySchema = z.strictObject({
  sessionId: sessionIdSchema,
  clientMessageId: clientMessageIdSchema,
  text: z.string().min(1).max(runnerLimits.steerTextMaxChars),
  delivery: z.enum(["queue", "interrupt"]),
});

/** `interrupt`: cancel the session's current turn, keep the session. */
export const interruptBodySchema = z.strictObject({ sessionId: sessionIdSchema });

/** Why a task is stopped. */
export const stopCommandReasonSchema = z.enum([
  /** A member pressed Stop (F-025). */
  "requested",
  /** The task grace ran out; the peer learns it when it comes back (ADR 0034). */
  "grace-expired",
  /** The task reached its spend cap (F-068, later). */
  "spend-cap",
  /** Runaway protection stopped it (F-068, later). */
  "runaway",
]);
export type StopCommandReason = z.infer<typeof stopCommandReasonSchema>;

/** `stop`: end the session's agent, keep the workspace and push what's there to the hidden ref. */
export const stopBodySchema = z.strictObject({
  taskId: taskIdSchema,
  sessionId: sessionIdSchema,
  leaseEpoch: leaseEpochSchema,
  reason: stopCommandReasonSchema,
});

/** `approval-answer`: a member's or a rule's answer to an open approval (F-026, milestone 3). */
export const approvalAnswerBodySchema = z.strictObject({
  sessionId: sessionIdSchema,
  approvalId: approvalIdSchema,
  decision: approvalDecisionSchema,
});

/** `drain`: take no new tasks; let the running ones finish. */
export const drainBodySchema = z.strictObject({});

/** `update-hint`: a newer runner version is available for this server. */
export const updateHintBodySchema = z.strictObject({ version: z.string().min(1).max(64) });

/** Each command kind's body, for the outbox to validate a body by its kind. */
export const commandBodySchemas = {
  dispatch: dispatchBodySchema,
  steer: steerBodySchema,
  interrupt: interruptBodySchema,
  stop: stopBodySchema,
  "approval-answer": approvalAnswerBodySchema,
  drain: drainBodySchema,
  "update-hint": updateHintBodySchema,
} as const;

export const commandKindSchema = z.enum([
  "dispatch",
  "steer",
  "interrupt",
  "stop",
  "approval-answer",
  "drain",
  "update-hint",
]);
export type CommandKind = z.infer<typeof commandKindSchema>;
export type CommandBody<K extends CommandKind> = z.infer<(typeof commandBodySchemas)[K]>;

const envelope = {
  type: z.literal("command"),
  seq: commandSeqSchema,
  id: commandIdSchema,
  /** Server time, in ms since the epoch. Past it, the peer rejects the command and never applies it late. */
  notAfter: epochMsSchema,
};

export const commandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...envelope, kind: z.literal("dispatch"), body: dispatchBodySchema }),
  z.strictObject({ ...envelope, kind: z.literal("steer"), body: steerBodySchema }),
  z.strictObject({ ...envelope, kind: z.literal("interrupt"), body: interruptBodySchema }),
  z.strictObject({ ...envelope, kind: z.literal("stop"), body: stopBodySchema }),
  z.strictObject({ ...envelope, kind: z.literal("approval-answer"), body: approvalAnswerBodySchema }),
  z.strictObject({ ...envelope, kind: z.literal("drain"), body: drainBodySchema }),
  z.strictObject({ ...envelope, kind: z.literal("update-hint"), body: updateHintBodySchema }),
]);
export type Command = z.infer<typeof commandSchema>;
export type CommandOf<K extends CommandKind> = Extract<Command, { kind: K }>;

/** How a peer answers a command (ADR 0034). */
export const commandResultSchema = z.enum([
  /** Applied, or for a dispatch: the offer is taken. */
  "accepted",
  /** Refused: past `notAfter`, a stale epoch, no capacity, or an unknown session. */
  "rejected",
  /** Finished: the stop has ended the agent, the steer reached it. */
  "done",
  /** The peer crashed between starting and finishing it (a steer, mostly). The panel shows it. */
  "outcome-unknown",
]);
export type CommandResult = z.infer<typeof commandResultSchema>;
