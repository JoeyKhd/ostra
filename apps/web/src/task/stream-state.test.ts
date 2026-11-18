import { describe, expect, it } from "vitest";

import { segmentIdSchema } from "@ostra/protocol";
import { eventFixtures, fixtureIds } from "@ostra/protocol/testing";
import { storeEvents } from "@ostra/task-view/testing";

import { initialStreamState, mergeEvents, streamReducer } from "./stream-state";

const f = eventFixtures;
const events = storeEvents([f["user.message"], f["turn.started"], f["agent.thought"], f["agent.message"], f["turn.ended"]]);

const frame = (offset: number, text: string, segment = "seg-live") => ({
  taskId: fixtureIds.task,
  sessionId: fixtureIds.session,
  turnId: fixtureIds.turn,
  segmentId: segmentIdSchema.parse(segment),
  kind: "message" as const,
  offset,
  text,
});

describe("mergeEvents", () => {
  it("appends the live tail and drops a seq it already holds", () => {
    const held = events.slice(0, 3);
    const merged = mergeEvents(held, events.slice(2));
    expect(merged.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("merges an older page in order, and returns the same array when nothing is new", () => {
    const held = events.slice(3);
    const merged = mergeEvents(held, events.slice(0, 4));
    expect(merged.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(mergeEvents(merged, events.slice(1, 2))).toBe(merged);
  });
});

describe("streamReducer", () => {
  it("loads the first page, then the tail, with no gap and no duplicate", () => {
    let state = streamReducer(initialStreamState, { type: "first-page", events: events.slice(0, 2), olderBefore: null });
    state = streamReducer(state, { type: "events", events: events.slice(1) });
    expect(state.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(state.headSeq).toBe(5);
    expect(state.loaded).toBe(true);
  });

  it("keeps partial text until its message is committed", () => {
    let state = streamReducer(initialStreamState, { type: "first-page", events: events.slice(0, 2), olderBefore: null });
    state = streamReducer(state, { type: "live", frame: frame(0, "Do", "seg-1") });
    state = streamReducer(state, { type: "live", frame: frame(2, "ne", "seg-1") });
    expect(state.live.get(segmentIdSchema.parse("seg-1"))?.text).toBe("Done");
    state = streamReducer(state, { type: "events", events: events.slice(2, 4) });
    expect(state.live.size).toBe(0);
    // A late frame for the committed segment is ignored.
    expect(streamReducer(state, { type: "live", frame: frame(0, "Do", "seg-1") })).toBe(state);
  });

  it("drops a segment on live-end and records the connection", () => {
    let state = streamReducer(initialStreamState, { type: "live", frame: frame(0, "partial") });
    state = streamReducer(state, { type: "live-end", segmentId: segmentIdSchema.parse("seg-live") });
    expect(state.live.size).toBe(0);
    state = streamReducer(state, { type: "connection", connection: "live" });
    expect(state.connection).toBe("live");
  });
});
