import { createHash } from "node:crypto";
import type { EventItem } from "../protocol/messages.ts";

// The fake agent's events are a pure function of (session, seq), so the
// harness can check every stored row against what the agent produced.

export const eventHash = (sessionId: string, seq: number): string =>
  createHash("sha256").update(`${sessionId}:${String(seq)}`).digest("hex").slice(0, 16);

const kinds = ["text", "tool", "note"] as const;

/** An event of the fake agent. A steer it received becomes a `note` that names the steer. */
export const fakeEvent = (sessionId: string, seq: number, padBytes: number, steerId?: string): EventItem => ({
  kind: steerId === undefined ? (kinds[seq % 3] ?? "text") : "note",
  at: Date.now(),
  body:
    steerId === undefined
      ? { n: seq, h: eventHash(sessionId, seq), pad: "x".repeat(padBytes) }
      : { n: seq, h: eventHash(sessionId, seq), steer: steerId },
});
