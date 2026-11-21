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
import {
  encodeTaskSpecForMinor,
  isTaskOfferable,
  taskNotOfferableWords,
  taskSpecMinMinor,
  taskSpecResponseSchemaFor,
  taskSpecSchema,
  taskSpecSchemaV5,
} from "../task/spec.ts";
import type { TaskSpec } from "../task/spec.ts";
import { eventFixtures, fixtureIds as ids, minor6FieldFixtures, nestedSubagentStartFixture, taskSpecFixture } from "../testing/fixtures.ts";
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
  it("F-061, F-138: a minor-6 server took minors 5 to 7, and minor 6 stays in the codecs after minor 7", () => {
    // Milestone 8 moved the build to minor 7 (`minor-7.test.ts`); a minor-6 build's window is as it was.
    expect(PROTOCOL_MINOR).toBe(8);
    expect(minorWindow(6)).toEqual({ min: 5, max: 7 });
    expect(negotiate(6, PROTOCOL_MAJOR, 5)).toEqual({ ok: true, minor: 5 });
    expect(negotiate(6, PROTOCOL_MAJOR, 6)).toEqual({ ok: true, minor: 6 });
    expect(negotiate(6, PROTOCOL_MAJOR, 7)).toEqual({ ok: true, minor: 6 });
    expect(negotiate(6, PROTOCOL_MAJOR, 4)).toEqual({ ok: false, reason: "minor", window: { min: 5, max: 7 } });
    // A minor-6 runner against a minor-5 server speaks minor 5, and against today's server minor 6.
    expect(negotiate(5, PROTOCOL_MAJOR, 6)).toEqual({ ok: true, minor: 5 });
    expect(negotiate(7, PROTOCOL_MAJOR, 6)).toEqual({ ok: true, minor: 6 });
    // Today's minor-8 server refuses it.
    expect(negotiate(PROTOCOL_MINOR, PROTOCOL_MAJOR, 6)).toEqual({ ok: false, reason: "minor", window: { min: 7, max: 9 } });
    expect(upFrameCodec.minors).toContain(6);
    expect(downFrameCodec.minors).toContain(6);
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

describe("minor 6's spec field (F-021, 2026-11-21)", () => {
  const off: TaskSpec = { ...taskSpecFixture, agent: { ...taskSpecFixture.agent, repoSkills: false } };
  const on: TaskSpec = { ...taskSpecFixture, agent: { ...taskSpecFixture.agent, repoSkills: true } };

  it("F-021/c9: agent.repoSkills round-trips at minor 6, a minor-5 runner is sent the spec without it, and a task with it off is offered only at minor 6", () => {
    expect(taskSpecSchema.parse(roundTrip(off))).toEqual(off);
    expect(taskSpecResponseSchemaFor(6).parse(roundTrip(off))).toEqual(off);
    // Minor 5's schema refuses the field; encoded down, the spec is minor 5's.
    expect(taskSpecSchemaV5.safeParse(off).success).toBe(false);
    expect(taskSpecResponseSchemaFor(5).safeParse(off).success).toBe(false);
    const down = encodeTaskSpecForMinor(off, 5);
    expect("repoSkills" in down.agent).toBe(false);
    expect(taskSpecResponseSchemaFor(5).parse(roundTrip(down))).toEqual({ ...off, agent: taskSpecFixture.agent });
    expect(encodeTaskSpecForMinor(off, 6)).toEqual(off);
    expect(encodeTaskSpecForMinor(off, 7)).toEqual(off);
    expect(encodeTaskSpecForMinor(off, 8)).toBe(off);
    expect("repoSkills" in encodeTaskSpecForMinor(on, 4).agent).toBe(false);
    // Off needs minor 6, with its own words; on, or missing, needs nothing new.
    expect(taskSpecMinMinor(off)).toBe(6);
    expect(isTaskOfferable(off, 5)).toEqual({ offerable: false, reason: "repo-skills-off", minMinor: 6 });
    expect(isTaskOfferable(off, 6)).toEqual({ offerable: true });
    expect(isTaskOfferable(on, 5)).toEqual({ offerable: true });
    expect(isTaskOfferable(taskSpecFixture, 5)).toEqual({ offerable: true });
    expect(taskNotOfferableWords("repo-skills-off", 6)).toBe("A project with the repos' own skills off needs a runner at protocol 1.6 or later: update the runner.");
    // A field ostra owns: anything but a boolean is refused.
    expect(taskSpecSchema.safeParse({ ...taskSpecFixture, agent: { ...taskSpecFixture.agent, repoSkills: "no" } }).success).toBe(false);
  });
});
