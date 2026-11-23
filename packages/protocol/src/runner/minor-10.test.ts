import { describe, expect, it } from "vitest";

import { egressBlockedReasonSchema, encodeEventForMinor, eventKindMinMinor, runnerEventSchema, taskEventSchema } from "../events/agent-events.ts";
import type { TaskSpec } from "../task/spec.ts";
import {
  encodeTaskSpecForMinor,
  isTaskOfferable,
  taskNotOfferableWords,
  taskSpecMinMinor,
  taskSpecNeedsMinor10,
  taskSpecResponseSchemaFor,
  taskSpecSchema,
  taskSpecSchemaV9,
} from "../task/spec.ts";
import { eventFixtures, fixtureIds as ids, taskSpecNetworkRulesFixture } from "../testing/fixtures.ts";
import { downFrameCodec, httpDownFrameCodec, upFrameCodec } from "./messages.ts";
import type { UpFrame } from "./messages.ts";
import { minorWindow, negotiate, PROTOCOL_MAJOR, PROTOCOL_MINOR } from "./version.ts";

// Protocol minor 10 (post-v1, F-052, ADR 0073): the environment's network rules in the task spec
// and the runner's `egress.blocked`. Additive: a minor-9 peer never receives the rules, is never
// offered a task whose environment has any, and its codec refuses the event.

const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const eventFrame = (): UpFrame => ({
  type: "events",
  events: [{ sessionId: ids.session, sessionSeq: 1, leaseEpoch: 1, at: 1_900_000_000_000, event: eventFixtures["egress.blocked"] }],
});

describe("the version", () => {
  it("F-052/c6: is minor 10; a minor-9 peer is inside the window and a minor-8 peer is outside it", () => {
    expect(PROTOCOL_MINOR).toBe(10);
    expect(minorWindow(PROTOCOL_MINOR)).toEqual({ min: 9, max: 11 });
    expect(negotiate(PROTOCOL_MINOR, PROTOCOL_MAJOR, 9)).toEqual({ ok: true, minor: 9 });
    expect(negotiate(PROTOCOL_MINOR, PROTOCOL_MAJOR, 10)).toEqual({ ok: true, minor: 10 });
    expect(negotiate(PROTOCOL_MINOR, PROTOCOL_MAJOR, 11)).toEqual({ ok: true, minor: 10 });
    expect(negotiate(PROTOCOL_MINOR, PROTOCOL_MAJOR, 8)).toEqual({ ok: false, reason: "minor", window: { min: 9, max: 11 } });
    // A minor-10 runner against a minor-9 server speaks minor 9.
    expect(negotiate(9, PROTOCOL_MAJOR, PROTOCOL_MINOR)).toEqual({ ok: true, minor: 9 });
    expect(upFrameCodec.minors).toContain(10);
    expect(downFrameCodec.minors).toContain(10);
    expect(httpDownFrameCodec.minors).toContain(10);
  });
});

describe("the spec at minor 10 and 9 (F-052/c6)", () => {
  it("F-052/c6: a spec with rules round-trips at minor 10 and is stripped at minor 9", () => {
    const spec = taskSpecNetworkRulesFixture;
    expect(spec.environment.networkRules).toHaveLength(2);
    expect(taskSpecSchema.parse(roundTrip(spec))).toEqual(spec);
    expect(encodeTaskSpecForMinor(spec, 10)).toEqual(spec);
    expect(encodeTaskSpecForMinor(spec, 11)).toEqual(spec);

    const at9 = encodeTaskSpecForMinor(spec, 9);
    expect(at9.environment.setupScript).toBe(spec.environment.setupScript);
    expect("networkRules" in at9.environment).toBe(false);
    // A minor-9 runner's own schema reads it, and refuses the rules.
    expect(taskSpecSchemaV9.parse(roundTrip(at9))).toEqual(at9);
    expect(taskSpecSchemaV9.safeParse(roundTrip(spec)).success).toBe(false);
    expect(taskSpecResponseSchemaFor(9)).toBe(taskSpecSchemaV9);
    expect(taskSpecResponseSchemaFor(10)).toBe(taskSpecSchema);
    expect(taskSpecSchemaV9.safeParse(roundTrip(encodeTaskSpecForMinor(spec, 8))).success).toBe(true);
  });

  it("F-052/c6: refuses it for a minor-9 peer with network-rules and its words, and an empty list changes nothing at minor 9", () => {
    const spec = taskSpecNetworkRulesFixture;
    expect(taskSpecNeedsMinor10(spec)).toBe(true);
    expect(taskSpecMinMinor(spec)).toBe(10);
    expect(isTaskOfferable(spec, 9)).toEqual({ offerable: false, reason: "network-rules", minMinor: 10 });
    expect(taskNotOfferableWords("network-rules", 10)).toBe("This environment limits which hosts its agent may reach, and this runner needs upgrading.");
    expect(isTaskOfferable(spec, 10)).toEqual({ offerable: true });

    // A missing or an empty list is today's behaviour: offerable to a minor-9 peer, and stripped as nothing.
    const empty = taskSpecSchema.parse(roundTrip({ ...spec, environment: { ...spec.environment, networkRules: [] } }));
    const missing: TaskSpec = encodeTaskSpecForMinor(spec, 9);
    expect(taskSpecMinMinor(empty)).not.toBe(10);
    expect(taskSpecMinMinor(missing)).not.toBe(10);
    expect(isTaskOfferable(empty, 9)).toEqual({ offerable: true });
    expect(isTaskOfferable(missing, 9)).toEqual({ offerable: true });
    expect("networkRules" in encodeTaskSpecForMinor(empty, 9).environment).toBe(false);
  });
});

describe("egress.blocked (F-052/c1)", () => {
  it("F-052/c1: its shape is the protocol's and strict, its reasons are the three, and the runner may send it", () => {
    const event = eventFixtures["egress.blocked"];
    expect(taskEventSchema.parse(roundTrip(event))).toEqual(event);
    expect(egressBlockedReasonSchema.options).toEqual(["not-listed", "baseline", "unresolvable"]);
    for (const reason of egressBlockedReasonSchema.options) {
      expect(taskEventSchema.safeParse({ kind: "egress.blocked", host: "example.com", port: 443, reason }).success, reason).toBe(true);
    }
    // No path, query, header or client address: an unknown field is refused.
    expect(taskEventSchema.safeParse({ ...event, path: "/api", client: "10.0.0.2" }).success).toBe(false);
    expect(taskEventSchema.safeParse({ ...event, reason: "allowed" }).success).toBe(false);
    expect(taskEventSchema.safeParse({ ...event, port: 0 }).success).toBe(false);
    expect(taskEventSchema.safeParse({ ...event, port: 65_536 }).success).toBe(false);
    // The runner sends it: it isn't a server-only kind.
    const item = { sessionId: ids.session, sessionSeq: 1, leaseEpoch: 1, at: 1, event };
    expect(runnerEventSchema.parse(item)).toEqual(item);
  });

  it("F-052/c1: it has no code at minor 9: a minor-9 frame refuses it, and a minor-10 one reads it", () => {
    expect(eventKindMinMinor("egress.blocked")).toBe(10);
    expect(upFrameCodec.parse(JSON.stringify(eventFrame()), 10)).toEqual({ ok: true, frame: eventFrame() });
    expect(upFrameCodec.parse(JSON.stringify(eventFrame()), 9).ok).toBe(false);
    // A new kind is never encoded down: the sender checks `eventKindMinMinor` first.
    expect(encodeEventForMinor(eventFixtures["egress.blocked"], 9)).toEqual(eventFixtures["egress.blocked"]);
  });
});
