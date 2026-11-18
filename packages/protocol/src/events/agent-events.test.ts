import { describe, expect, it } from "vitest";

import { eventFixtures, fixtureIds as ids } from "../testing/fixtures.ts";
import {
  readEventSchema,
  runnerEventSchema,
  serverOnlyKinds,
  storedEventSchema,
  taskEventKinds,
  taskEventSchema,
} from "./agent-events.ts";
import { liveTextFrameSchema } from "./live-text.ts";
import { typedToolSchemas } from "./tools.ts";

const fixtures = Object.values(eventFixtures);

describe("the event union", () => {
  it("has the 29 kinds of spike 7 and milestone 1's 8", () => {
    expect(taskEventKinds).toHaveLength(37);
    for (const kind of [
      "environment.setup_started",
      "environment.setup_output",
      "environment.setup_finished",
      "git.pushed",
      "pr.text_set",
      "session.ended",
      "usage.recorded",
      "session.usage",
    ]) {
      expect(taskEventKinds).toContain(kind);
    }
  });

  it("has a fixture for every kind", () => {
    expect(Object.keys(eventFixtures).sort()).toEqual([...taskEventKinds].sort());
  });

  it.each(fixtures.map((event) => [event.kind, event] as const))("%s parses and round-trips through JSON", (_kind, event) => {
    expect(taskEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
  });

  it.each(fixtures.map((event) => [event.kind, event] as const))("%s refuses an unknown field", (_kind, event) => {
    expect(taskEventSchema.safeParse({ ...event, surprise: 1 }).success).toBe(false);
    expect(readEventSchema.safeParse({ ...event, surprise: 1 }).success).toBe(false);
  });

  it("carries ACP's tool kind on a tool call", () => {
    expect(taskEventSchema.safeParse({ ...eventFixtures["tool.called"], toolKind: "bash" }).success).toBe(false);
    expect(typedToolSchemas.edit.input.parse(eventFixtures["tool.called"].input)).toEqual({ paths: ["CONTRIBUTING.md"] });
  });
});

describe("the read side", () => {
  it("reads an unknown kind as unsupported, keeping the raw kind", () => {
    expect(readEventSchema.parse({ kind: "review.posted", findings: 3 })).toEqual({
      kind: "unsupported",
      rawKind: "review.posted",
    });
  });

  it("reads a known kind as itself", () => {
    expect(readEventSchema.parse(eventFixtures["turn.ended"])).toEqual(eventFixtures["turn.ended"]);
  });

  it("refuses something with no kind at all", () => {
    expect(readEventSchema.safeParse({ text: "hi" }).success).toBe(false);
  });

  it("parses a stored event with both numbers, and a server-written one with no session number", () => {
    const stored = {
      taskId: ids.task,
      seq: 10,
      sessionId: ids.session,
      sessionSeq: 4,
      at: 1_700_000_000_000,
      event: eventFixtures["agent.message"],
    };
    expect(storedEventSchema.parse(stored)).toEqual(stored);
    expect(storedEventSchema.parse({ ...stored, sessionSeq: null, event: eventFixtures["pr.opened"] }).sessionSeq).toBeNull();
    expect(storedEventSchema.safeParse({ ...stored, extra: true }).success).toBe(false);
  });
});

describe("the runner's events", () => {
  it.each([...serverOnlyKinds].map((kind) => [kind] as const))("refuses %s, which only the server writes", (kind) => {
    const event = eventFixtures[kind];
    expect(runnerEventSchema.safeParse({ sessionId: ids.session, sessionSeq: 1, leaseEpoch: 1, at: 1, event }).success).toBe(
      false,
    );
  });

  it("accepts an agent's event", () => {
    const item = { sessionId: ids.session, sessionSeq: 1, leaseEpoch: 1, at: 1, event: eventFixtures["agent.message"] };
    expect(runnerEventSchema.parse(item)).toEqual(item);
  });
});

describe("live text", () => {
  it("parses a frame and refuses an unknown field", () => {
    const frame = {
      taskId: ids.task,
      sessionId: ids.session,
      turnId: ids.turn,
      segmentId: ids.segment,
      kind: "thought",
      offset: 12,
      text: "more",
    };
    expect(liveTextFrameSchema.parse(frame)).toEqual(frame);
    expect(liveTextFrameSchema.safeParse({ ...frame, seq: 1 }).success).toBe(false);
    expect(liveTextFrameSchema.safeParse({ ...frame, offset: -1 }).success).toBe(false);
  });
});
