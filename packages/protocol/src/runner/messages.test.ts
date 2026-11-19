import { describe, expect, it } from "vitest";

import { commandFixtures, eventFixtures, fixtureIds as ids } from "../testing/fixtures.ts";
import { commandKindSchema } from "./commands.ts";
import {
  closeCodes,
  encodeDownFrame,
  encodeUpFrame,
  parseDownFrame,
  parseUpFrame,
} from "./messages.ts";
import type { DownFrame, DownFrameType, UpFrame, UpFrameType } from "./messages.ts";
import { runnerLimits } from "./limits.ts";

const commands = commandFixtures;

const upFrames: { readonly [T in UpFrameType]: Extract<UpFrame, { type: T }> } = {
  hello: {
    type: "hello",
    protocolMajor: 1,
    protocolMinor: 0,
    runnerVersion: "0.1.0",
    peer: { kind: "runner", runnerId: ids.runner },
    carrier: "websocket",
    lastCommandSeq: 0,
    sessions: [{ taskId: ids.task, sessionId: ids.session, leaseEpoch: 1, nextSessionSeq: 4 }],
  },
  events: {
    type: "events",
    events: [
      { sessionId: ids.session, sessionSeq: 1, leaseEpoch: 1, at: 1_700_000_000_000, event: eventFixtures["turn.started"] },
      { sessionId: ids.session, sessionSeq: 2, leaseEpoch: 1, at: 1_700_000_000_001, event: eventFixtures["git.pushed"] },
    ],
  },
  "command-ack": {
    type: "command-ack",
    upTo: 2,
    results: [
      { id: ids.command, seq: 1, result: "accepted" },
      { id: ids.command, seq: 2, result: "rejected", reason: "past-not-after" },
    ],
  },
  status: {
    type: "status",
    executor: "host",
    capacity: 1,
    freeSlots: 0,
    labels: ["windows"],
    version: "0.1.0",
    running: [ids.session],
    spoolBytes: 512,
  },
  "live-text": {
    type: "live-text",
    frames: [
      {
        taskId: ids.task,
        sessionId: ids.session,
        turnId: ids.turn,
        segmentId: ids.segment,
        kind: "message",
        offset: 0,
        text: "Writ",
      },
    ],
  },
  "runner-event": { type: "runner-event", at: 1_700_000_000_002, event: eventFixtures["snapshot.built"] },
};

const downFrames: { readonly [T in Exclude<DownFrameType, "command">]: Extract<DownFrame, { type: T }> } = {
  welcome: {
    type: "welcome",
    minor: 0,
    serverTime: 1_700_000_000_000,
    connectionEpoch: 3,
    replicaId: ids.replica,
    pingMs: runnerLimits.pingMs,
    creditFrames: runnerLimits.creditFrames,
    creditBytes: runnerLimits.creditBytes,
    maxConnectionAgeMs: runnerLimits.maxConnectionAgeMs,
  },
  ack: { type: "ack", sessionId: ids.session, upTo: 2 },
  credit: { type: "credit", frames: 128, bytes: 1_048_576 },
  goaway: { type: "goaway", reconnectAfterMs: 500, reason: "draining" },
  error: { type: "error", code: "stale-lease", message: "the lease epoch is stale", sessionId: ids.session, currentEpoch: 2 },
  evict: { type: "evict", reason: "revoked" },
};

const allDown: readonly DownFrame[] = [...Object.values(downFrames), ...Object.values(commands)];
const allUp: readonly UpFrame[] = Object.values(upFrames);

describe("an event the database refused", () => {
  it("is an error frame that names the session and the number, and refuses an unknown field", () => {
    const frame: DownFrame = {
      type: "error",
      code: "event-rejected",
      message: "the database refused this event",
      sessionId: ids.session,
      sessionSeq: 4,
    };
    expect(parseDownFrame(encodeDownFrame(frame))).toEqual({ ok: true, frame });
    expect(parseDownFrame(JSON.stringify({ ...frame, surprise: true })).ok).toBe(false);
    expect(parseDownFrame(JSON.stringify({ ...frame, sessionSeq: 0 })).ok).toBe(false);
  });
});

describe("up frames", () => {
  it.each(allUp.map((frame) => [frame.type, frame] as const))("%s round-trips", (_type, frame) => {
    expect(parseUpFrame(encodeUpFrame(frame))).toEqual({ ok: true, frame });
  });

  it.each(allUp.filter((frame) => frame.type !== "hello").map((frame) => [frame.type, frame] as const))(
    "%s refuses an unknown field",
    (_type, frame) => {
      const parsed = parseUpFrame(JSON.stringify({ ...frame, surprise: true }));
      expect(parsed).toMatchObject({ ok: false, error: { reason: "invalid" } });
    },
  );

  it("hello tolerates unknown fields, at the top and inside", () => {
    const newer = {
      ...upFrames.hello,
      futureField: 1,
      peer: { ...upFrames.hello.peer, futurePeerField: "x" },
      sessions: [{ ...upFrames.hello.sessions[0], futureSessionField: [] }],
    };
    expect(parseUpFrame(JSON.stringify(newer)).ok).toBe(true);
  });

  it("hello still checks the fields it knows", () => {
    const parsed = parseUpFrame(JSON.stringify({ ...upFrames.hello, peer: { kind: "runner" } }));
    expect(parsed.ok).toBe(false);
  });

  it("accepts a sidecar peer", () => {
    const hello = {
      ...upFrames.hello,
      peer: { kind: "sidecar", taskId: ids.task, boxId: ids.box, leaseEpoch: 1 },
    };
    expect(parseUpFrame(JSON.stringify(hello)).ok).toBe(true);
  });

  it("refuses an event kind only the server writes", () => {
    const forged = {
      type: "events",
      events: [
        { sessionId: ids.session, sessionSeq: 1, leaseEpoch: 1, at: 1, event: eventFixtures["user.message"] },
      ],
    };
    expect(parseUpFrame(JSON.stringify(forged))).toMatchObject({ ok: false, error: { reason: "invalid" } });
  });

  it("refuses an empty batch and a zero session number", () => {
    expect(parseUpFrame(JSON.stringify({ type: "events", events: [] })).ok).toBe(false);
    const zero = {
      type: "events",
      events: [{ sessionId: ids.session, sessionSeq: 0, leaseEpoch: 1, at: 1, event: eventFixtures["turn.started"] }],
    };
    expect(parseUpFrame(JSON.stringify(zero)).ok).toBe(false);
  });
});

describe("down frames", () => {
  it.each(allDown.map((frame) => [frame.type === "command" ? `command ${frame.kind}` : frame.type, frame] as const))(
    "%s round-trips",
    (_name, frame) => {
      expect(parseDownFrame(encodeDownFrame(frame))).toEqual({ ok: true, frame });
    },
  );

  it.each(allDown.map((frame) => [frame.type === "command" ? `command ${frame.kind}` : frame.type, frame] as const))(
    "%s refuses an unknown field",
    (_name, frame) => {
      expect(parseDownFrame(JSON.stringify({ ...frame, surprise: true })).ok).toBe(false);
    },
  );

  it("covers every command kind", () => {
    expect(Object.keys(commands).sort()).toEqual([...commandKindSchema.options].sort());
  });

  it("refuses a command body with an unknown field, and a body of the wrong kind", () => {
    const extra = { ...commands.stop, body: { ...commands.stop.body, token: "x" } };
    expect(parseDownFrame(JSON.stringify(extra)).ok).toBe(false);
    const swapped = { ...commands.stop, body: commands.dispatch.body };
    expect(parseDownFrame(JSON.stringify(swapped)).ok).toBe(false);
  });

  it("refuses a steer longer than the limit", () => {
    const long = { ...commands.steer, body: { ...commands.steer.body, text: "x".repeat(runnerLimits.steerTextMaxChars + 1) } };
    expect(parseDownFrame(JSON.stringify(long)).ok).toBe(false);
  });
});

describe("bad frames", () => {
  it.each([
    ["not JSON", "{", "not-json"],
    ["a number", "42", "invalid"],
    ["an unknown type", JSON.stringify({ type: "telepathy" }), "invalid"],
    ["an array", "[]", "invalid"],
  ] as const)("%s gives an error result, not a throw", (_name, text, reason) => {
    expect(parseUpFrame(text)).toMatchObject({ ok: false, error: { reason } });
    expect(parseDownFrame(text)).toMatchObject({ ok: false, error: { reason } });
  });

  it("refuses a frame over the cap before parsing it", () => {
    const text = JSON.stringify({ type: "credit", frames: 1, bytes: 1, pad: "é".repeat(runnerLimits.frameMaxBytes / 2) });
    expect(parseDownFrame(text)).toMatchObject({ ok: false, error: { reason: "too-large" } });
  });

  it("never puts a value in the error detail", () => {
    const parsed = parseDownFrame(JSON.stringify({ ...downFrames.error, message: 7, secret: "ghs_abcdef" }));
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.error.detail).not.toContain("ghs_abcdef");
  });
});

describe("close codes", () => {
  it("keeps the codes the spike and ADR 0034 named", () => {
    expect(closeCodes.revoked).toBe(4403);
    expect(closeCodes.replaced).toBe(4409);
    expect(new Set(Object.values(closeCodes)).size).toBe(Object.values(closeCodes).length);
  });
});
