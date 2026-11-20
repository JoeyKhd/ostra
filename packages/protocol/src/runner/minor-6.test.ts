import { describe, expect, it } from "vitest";

import {
  encodeEventForMinor,
  eventKindSupportedAt,
  minor5EventKinds,
  minor6EventKinds,
  readEventSchema,
  runnerEventSchema,
  serverOnlyKinds,
  subagentStatusSchema,
  taskEventKinds,
  taskEventSchema,
  taskEventSchemaV5,
} from "../events/agent-events.ts";
import type { TaskEvent, TaskEventKind } from "../events/agent-events.ts";
import { eventFixtures, fixtureIds as ids, minor6FieldFixtures, nestedSubagentStartFixture } from "../testing/fixtures.ts";
import { runnerLimits } from "./limits.ts";
import { downFrameCodec, encodeUpFrame, parseUpFrame, upFrameCodec } from "./messages.ts";
import type { UpFrame } from "./messages.ts";
import { minorWindow, negotiate, PROTOCOL_MAJOR, PROTOCOL_MINOR } from "./version.ts";

// Protocol minor 6 (milestone 7, ticket 39, F-138): an agent's subagents. Every addition
// round-trips; a minor-5 peer keeps working inside the window and never sees a subagent, so its
// calls show flat (ADR 0034's window); a minor-4 peer is outside it.

const added = ["subagent.started", "subagent.status"] as const satisfies readonly TaskEventKind[];
const grown = ["agent.message", "agent.thought", "tool.called", "plan.updated", "approval.requested"] as const satisfies readonly TaskEventKind[];

const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const eventsFrame = (event: TaskEvent): UpFrame => ({
  type: "events",
  events: [{ sessionId: ids.session, sessionSeq: 1, leaseEpoch: 1, at: 1_700_000_000_000, event }],
});

const eventOf = (frame: unknown): unknown => {
  const parsed = upFrameCodec.parseValue(frame, 5);
  if (!parsed.ok || parsed.frame.type !== "events") {
    throw new Error("not an events frame");
  }
  return parsed.frame.events[0]?.event;
};

describe("the version", () => {
  it("F-061, F-138: is minor 6; a minor-5 peer is inside the window and a minor-4 peer is outside it", () => {
    expect(PROTOCOL_MINOR).toBe(6);
    expect(minorWindow(PROTOCOL_MINOR)).toEqual({ min: 5, max: 7 });
    expect(negotiate(PROTOCOL_MINOR, PROTOCOL_MAJOR, 5)).toEqual({ ok: true, minor: 5 });
    expect(negotiate(PROTOCOL_MINOR, PROTOCOL_MAJOR, 6)).toEqual({ ok: true, minor: 6 });
    expect(negotiate(PROTOCOL_MINOR, PROTOCOL_MAJOR, 7)).toEqual({ ok: true, minor: 6 });
    expect(negotiate(PROTOCOL_MINOR, PROTOCOL_MAJOR, 4)).toEqual({ ok: false, reason: "minor", window: { min: 5, max: 7 } });
    // A minor-6 runner against a minor-5 server speaks minor 5.
    expect(negotiate(5, PROTOCOL_MAJOR, PROTOCOL_MINOR)).toEqual({ ok: true, minor: 5 });
    expect(upFrameCodec.minors).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(downFrameCodec.minors).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe("minor 6's events (F-138)", () => {
  it("F-138: adds subagent.started and subagent.status, each with a fixture that round-trips, neither readable below minor 6", () => {
    expect([...minor6EventKinds].sort()).toEqual([...added].sort());
    for (const kind of minor6EventKinds) {
      expect(taskEventKinds).toContain(kind);
      expect(eventKindSupportedAt(kind, 5)).toBe(false);
      expect(eventKindSupportedAt(kind, 6)).toBe(true);
      expect(taskEventSchema.parse(roundTrip(eventFixtures[kind]))).toEqual(eventFixtures[kind]);
      expect(readEventSchema.parse(eventFixtures[kind])).toEqual(eventFixtures[kind]);
      expect(taskEventSchemaV5.safeParse(eventFixtures[kind]).success).toBe(false);
      // A runner's, never the server's.
      expect(serverOnlyKinds.has(kind)).toBe(false);
      const sent = { sessionId: ids.session, sessionSeq: 1, leaseEpoch: 1, at: 1, event: eventFixtures[kind] };
      expect(runnerEventSchema.parse(sent)).toEqual(sent);
    }
    // A nested subagent's start names its parent and its depth.
    expect(taskEventSchema.parse(roundTrip(nestedSubagentStartFixture))).toEqual(nestedSubagentStartFixture);
    // Minor 5's kinds still parse at minor 5.
    for (const kind of minor5EventKinds) {
      expect(taskEventSchemaV5.parse(eventFixtures[kind])).toEqual(eventFixtures[kind]);
    }
  });

  it("F-138: a subagent's states are the five OpenCode reports", () => {
    expect(subagentStatusSchema.options).toEqual(["created", "running", "completed", "failed", "interrupted"]);
  });

  it("F-138: the new kinds travel at minor 6 and a minor-5 server refuses them", () => {
    for (const kind of added) {
      const frame = eventsFrame(eventFixtures[kind]);
      expect(parseUpFrame(encodeUpFrame(frame, 6), 6)).toEqual({ ok: true, frame });
      expect(parseUpFrame(JSON.stringify(frame), 5).ok).toBe(false);
    }
  });

  it("F-138: refuses an unknown field, a bad state, a depth below 1 and a prompt over its limit", () => {
    for (const kind of added) {
      expect(taskEventSchema.safeParse({ ...eventFixtures[kind], surprise: 1 }).success, kind).toBe(false);
    }
    expect(taskEventSchema.safeParse({ ...eventFixtures["subagent.status"], status: "paused" }).success).toBe(false);
    expect(taskEventSchema.safeParse({ ...eventFixtures["subagent.started"], depth: 0 }).success).toBe(false);
    expect(taskEventSchema.safeParse({ ...eventFixtures["subagent.started"], type: "" }).success).toBe(false);
    const long = "x".repeat(runnerLimits.subagentPromptMaxChars + 1);
    expect(taskEventSchema.safeParse({ ...eventFixtures["subagent.started"], prompt: long }).success).toBe(false);
    expect(taskEventSchema.safeParse({ ...eventFixtures["subagent.started"], prompt: long.slice(1) }).success).toBe(true);
  });
});

describe("the subagent on the agent's output (F-138)", () => {
  it("F-138: the agent's output and an approval's request carry their subagent at minor 6, and minor 5 refuses it", () => {
    for (const kind of grown) {
      const event = minor6FieldFixtures[kind];
      expect(taskEventSchema.parse(roundTrip(event))).toEqual(event);
      expect(taskEventSchemaV5.safeParse(event).success, kind).toBe(false);
      // Without it, the main agent's own: what every minor reads.
      expect(taskEventSchemaV5.parse(eventFixtures[kind])).toEqual(eventFixtures[kind]);
    }
  });

  it("F-138/c7: a minor-5 peer gets the call flat: its codec drops the subagent and keeps the rest", () => {
    for (const kind of grown) {
      const event = minor6FieldFixtures[kind];
      expect(encodeEventForMinor(event, 6)).toEqual(event);
      expect(encodeEventForMinor(event, 5)).toEqual(eventFixtures[kind]);
      const frame = eventsFrame(event);
      // Encoded down, the frame reads at minor 5 as the main agent's; sent as it is, minor 5 refuses it.
      expect(eventOf(JSON.parse(encodeUpFrame(frame, 5)))).toEqual(eventFixtures[kind]);
      expect(parseUpFrame(JSON.stringify(frame), 5).ok).toBe(false);
      expect(parseUpFrame(encodeUpFrame(frame, 6), 6)).toEqual({ ok: true, frame });
    }
    // An event without a subagent goes down to every minor as it was.
    expect(encodeEventForMinor(eventFixtures["tool.called"], 5)).toBe(eventFixtures["tool.called"]);
  });
});
