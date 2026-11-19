import { describe, expect, it } from "vitest";

import { storedEventSchema } from "@ostra/protocol";
import type { StoredEvent } from "@ostra/protocol";

import { buildRows, durationText, isFailed } from "./event-log-words";

// F-073 (ticket 34): the event log's rows, from stored events, without a browser.

const TASK = "01937a40-0000-7000-8000-000000000001";
const SESSION = "01937a40-0000-7000-8000-000000000002";
const MEMBER = "01937a40-0000-7000-8000-000000000003";

const stored = (seq: number, at: number, event: object): StoredEvent => storedEventSchema.parse({ taskId: TASK, seq, sessionId: SESSION, sessionSeq: seq, at, event });

const names = new Map([[MEMBER, "Alex Kim"]]);
const folder = "/workspace/calc/packages/history/src/formatters/rounding/a-long-folder-that-must-not-be-cut";

const log: readonly StoredEvent[] = [
  stored(1, 1_000, { kind: "user.message", memberId: MEMBER, clientMessageId: "01937a40-0000-7000-8000-000000000009", text: "Fix the history view", delivery: "immediate" }),
  stored(2, 2_000, { kind: "turn.started", turnId: "turn-1" }),
  stored(3, 3_000, { kind: "tool.called", turnId: "turn-1", toolCallId: "read-1", toolKind: "read", title: "read", input: { path: "src/history.ts" } }),
  stored(4, 3_100, { kind: "tool.progress", toolCallId: "read-1", output: {} }),
  stored(5, 3_200, { kind: "tool.failed", toolCallId: "read-1", error: "ENOENT: no such file" }),
  stored(6, 4_000, { kind: "tool.called", turnId: "turn-1", toolCallId: "exec-1", toolKind: "execute", title: "pnpm test", input: { command: "pnpm test -- history", cwd: folder } }),
  stored(7, 5_500, { kind: "tool.completed", toolCallId: "exec-1", output: { exitCode: 1 } }),
  stored(8, 6_000, { kind: "tool.called", turnId: "turn-1", toolCallId: "exec-2", toolKind: "execute", title: "pnpm add json5", input: { command: "pnpm add json5", cwd: folder } }),
  stored(9, 6_100, { kind: "approval.requested", turnId: "turn-1", approvalId: "appr-1", toolCallId: "exec-2", options: [{ optionId: "deny", label: "Deny", kind: "reject-once", decision: "deny" }] }),
  stored(10, 7_000, { kind: "approval.answered", approvalId: "appr-1", optionId: "deny", decision: "deny", memberId: MEMBER }),
  stored(11, 7_100, { kind: "tool.failed", toolCallId: "exec-2", error: "The member declined the command" }),
  stored(12, 8_000, { kind: "agent.thought", turnId: "turn-1", segmentId: "s-1", text: "hmm" }),
  stored(13, 9_000, { kind: "agent.message", turnId: "turn-1", segmentId: "s-2", text: "Done." }),
  stored(14, 10_000, { kind: "turn.ended", turnId: "turn-1", stopReason: "end_turn" }),
];

describe("buildRows", () => {
  const rows = buildRows(log, names);

  it("F-073: one row per tool call, its completion folded in, with the full input as stored and the error of a failed call", () => {
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 6, 8, 9, 10, 13, 14]);
    const exec = rows.find((row) => row.seq === 6);
    expect(exec?.word).toBe("execute");
    expect(exec?.text.mono).toBe("pnpm test -- history");
    expect(exec?.status?.word).toBe("failed · exit 1");
    expect(exec?.endSeq).toBe(7);
    expect(exec?.durationMs).toBe(1_500);
    expect(exec?.body?.input).toContain(`"cwd": "${folder}"`);
    expect(exec?.body?.input).toContain('"command": "pnpm test -- history"');
    const read = rows.find((row) => row.seq === 3);
    expect(read?.status?.word).toBe("failed");
    expect(read?.icon).toBe("file-x");
    expect(read?.body?.error).toBe("ENOENT: no such file");
  });

  it("F-073: an approval keeps the command it was asked about, its answer says who, and the refused call reads refused", () => {
    expect(rows.find((row) => row.seq === 9)?.text).toEqual({ lead: "Asked to run", mono: "pnpm add json5" });
    expect(rows.find((row) => row.seq === 10)?.text.lead).toBe("Declined by Alex Kim");
    const refused = rows.find((row) => row.seq === 8);
    expect(refused?.status?.word).toBe("refused");
    expect(refused?.durationMs).toBeNull();
    expect(rows.filter(isFailed).map((row) => row.seq)).toEqual([3, 6, 8]);
  });

  it("F-073: rows know their turn, messages say who wrote them, and a call never answered reads running", () => {
    expect(rows.find((row) => row.seq === 1)?.turn).toBeNull();
    expect(rows.find((row) => row.seq === 13)?.turn).toBe(1);
    expect(rows.find((row) => row.seq === 1)?.text.strong).toBe("Alex Kim:");
    const open = buildRows(log.slice(0, 6), names).find((row) => row.seq === 6);
    expect(open?.status).toEqual({ word: "running", tone: "running" });
    expect(rows.find((row) => row.seq === 14)?.durationMs).toBe(8_000);
  });
});

describe("durationText", () => {
  it("writes seconds, then minutes, and an en dash for none", () => {
    expect(durationText(null)).toBe("–");
    expect(durationText(100)).toBe("0.1 s");
    expect(durationText(12_000)).toBe("12 s");
    expect(durationText(125_000)).toBe("2 min 5 s");
    expect(durationText(180_000)).toBe("3 min");
  });
});
