import { z } from "zod";

import { segmentIdSchema, sessionIdSchema, taskIdSchema, turnIdSchema } from "../ids.ts";

// Partial text (ADR 0035, Q23): what the agent is still writing. It isn't an event: it goes out
// at most every 250 ms (`runnerLimits.liveTextIntervalMs`), is never saved in the log, and nothing
// acts on it. The completed `agent.message` or `agent.thought` is what counts. Ported from
// spikes/live-stream-and-task-view/src/shared/events.ts (`liveTextFrame`, `liveFrame`).

export const liveTextKindSchema = z.enum(["message", "thought"]);
export type LiveTextKind = z.infer<typeof liveTextKindSchema>;

/** The longest text in one frame. A longer delta is split into several frames. */
export const LIVE_TEXT_MAX_CHARS = 32_768;

/**
 * One frame of partial text for one open segment. `offset` 0 is a snapshot that replaces the
 * segment's text; any other offset appends at that position, and a reader drops a frame whose
 * offset doesn't match what it holds, then waits for the next snapshot.
 */
export const liveTextFrameSchema = z.strictObject({
  taskId: taskIdSchema,
  sessionId: sessionIdSchema,
  turnId: turnIdSchema,
  segmentId: segmentIdSchema,
  kind: liveTextKindSchema,
  offset: z.number().int().nonnegative(),
  text: z.string().max(LIVE_TEXT_MAX_CHARS),
});
export type LiveTextFrame = z.infer<typeof liveTextFrameSchema>;
