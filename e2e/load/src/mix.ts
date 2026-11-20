import { createHash, randomUUID } from "node:crypto";

import { segmentIdSchema, taskEventSchema, toolCallIdSchema, turnIdSchema } from "@ostra/protocol";
import type { SegmentId, TaskEvent, TaskId, ToolCallId, TurnId } from "@ostra/protocol";

// What a simulated agent sends (ticket 34, F-117): spike 10's recorded mix
// (context/research/spike-is-opencode-good-enough.md, section 2.3). Its 30 real OpenCode runs sent
// 5,175 driver events: 46% thought chunks, 14% tool calls, 33% tool call updates, 4% message
// chunks and 3% others; 189.5 to 415.0 events a minute a run, median 259.2; 793 bytes a wire
// message. The generator takes a mix of rates, as the research asks: each task draws its own rate
// between the recorded minimum and maximum, half of them below the median. Events go out at the
// driver's rate, before any coalescing, so the load is the busier side of what a real run sends.

export const recordedRates = {
  minPerMinute: 189.5,
  medianPerMinute: 259.2,
  maxPerMinute: 415,
  /** Bytes a wire message carried, on average. */
  wireBytes: 793,
} as const;

/** The kinds a simulated agent sends, with their shares of spike 10's driver events. */
export const eventMix = [
  { kind: "agent.thought", share: 0.46 },
  { kind: "tool.called", share: 0.14 },
  { kind: "tool.progress", share: 0.33 },
  { kind: "agent.message", share: 0.04 },
  { kind: "tool.completed", share: 0.03 },
] as const;

export type MixKind = (typeof eventMix)[number]["kind"];

/** A task's rate, in events a minute: half between the minimum and the median, half between the median and the maximum. */
export const drawRatePerMinute = (random: () => number): number => {
  const { minPerMinute, medianPerMinute, maxPerMinute } = recordedRates;
  const draw = random();
  return draw < 0.5 ? minPerMinute + (medianPerMinute - minPerMinute) * (draw / 0.5) : medianPerMinute + (maxPerMinute - medianPerMinute) * ((draw - 0.5) / 0.5);
};

export const pickKind = (random: () => number): MixKind => {
  let draw = random();
  for (const entry of eventMix) {
    if (draw < entry.share) return entry.kind;
    draw -= entry.share;
  }
  return "agent.thought";
};

/** Partial text is on for one task in four (ADR 0035, F-117), chosen by the task's ID so every process agrees. */
export const partialTextOn = (taskId: TaskId): boolean => (createHash("sha256").update(taskId).digest()[0] ?? 0) % 4 === 0;

/** What one task's script has going: its turn, the tool call it's in, the segment it's writing. */
export type ScriptState = { readonly turnId: TurnId; toolCallId: ToolCallId | null; segmentId: SegmentId };

export const newScriptState = (): ScriptState => ({ turnId: turnIdSchema.parse(randomUUID()), toolCallId: null, segmentId: segmentIdSchema.parse(randomUUID()) });

const filler = "The agent reads the module, follows the call into the store and checks how the cursor is kept. ";

/** Text that brings an event's JSON to about `recordedRates.wireBytes`. */
const pad = (event: TaskEvent, field: "text" | "output"): TaskEvent => {
  const size = Buffer.byteLength(JSON.stringify(event));
  const missing = Math.max(0, recordedRates.wireBytes - size);
  const text = filler.repeat(Math.ceil(missing / filler.length) + 1).slice(0, missing);
  return taskEventSchema.parse(field === "text" ? { ...event, text } : { ...event, output: { text } });
};

/** The next event of a script, and what changed in its state. A tool update with no open call opens one first. */
export const nextEvent = (state: ScriptState, kind: MixKind): TaskEvent => {
  switch (kind) {
    case "agent.thought":
      return pad({ kind: "agent.thought", turnId: state.turnId, segmentId: segmentIdSchema.parse(randomUUID()), text: "" }, "text");
    case "agent.message": {
      const event = pad({ kind: "agent.message", turnId: state.turnId, segmentId: state.segmentId, text: "" }, "text");
      state.segmentId = segmentIdSchema.parse(randomUUID());
      return event;
    }
    case "tool.called": {
      state.toolCallId = toolCallIdSchema.parse(`call_${randomUUID()}`);
      return taskEventSchema.parse({ kind: "tool.called", turnId: state.turnId, toolCallId: state.toolCallId, toolKind: "read", title: "Read src/store.ts", input: { path: "src/store.ts" } });
    }
    case "tool.progress":
    case "tool.completed": {
      if (state.toolCallId === null) return nextEvent(state, "tool.called");
      const event = pad({ kind, toolCallId: state.toolCallId, output: {} }, "output");
      if (kind === "tool.completed") state.toolCallId = null;
      return event;
    }
    default:
      return kind satisfies never;
  }
};
