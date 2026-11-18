import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createAcpMapper, sumOf } from "../producer/acp-map.ts";
import { parseRecording } from "../producer/replay.ts";
import { buildAllKindsEvents, buildLongSession } from "../producer/scenarios.ts";
import { storedEventSchema, taskEventKinds, type StoredEvent, type TaskEvent } from "./events.ts";
import { deriveTaskState, foldCoverage, foldTaskEvents } from "./fold.ts";
import { ApprovalId, ClientMessageId, MemberId, OptionId, SegmentId, ToolCallId } from "./ids.ts";
import type { TaskUIMessage, TaskUIPart } from "./ui-types.ts";

const stored = (events: readonly TaskEvent[]): StoredEvent[] =>
  events.map((event, i) => storedEventSchema.parse({ seq: i + 1, at: 1000 + i, event }));

const partsOf = (messages: readonly TaskUIMessage[]): TaskUIPart[] => messages.flatMap((m) => m.parts);

describe("foldTaskEvents", () => {
  const { events, pendingApprovalId } = buildAllKindsEvents("t");
  const messages = foldTaskEvents(stored(events), []);

  it("lists every event kind in the coverage table", () => {
    expect(Object.keys(foldCoverage).sort()).toEqual([...taskEventKinds].sort());
  });

  it("renders text, reasoning, tools, plan, question, compaction and system rows", () => {
    const types = new Set(partsOf(messages).map((p) => p.type));
    for (const expected of [
      "text",
      "reasoning",
      "tool-read",
      "tool-edit",
      "tool-execute",
      "dynamic-tool",
      "data-plan",
      "data-question",
      "data-compaction",
      "data-system",
      "data-unsupported",
      "file",
      "source-url",
      "step-start",
    ]) {
      expect(types).toContain(expected);
    }
  });

  it("never shows a problem row for a coherent session", () => {
    expect(partsOf(messages).filter((p) => p.type === "data-problem")).toEqual([]);
  });

  it("walks a tool through the AI SDK's states", () => {
    const tools = partsOf(messages).flatMap((p) => (p.type === "tool-execute" ? [p] : []));
    expect(tools.map((p) => p.state)).toEqual(expect.arrayContaining(["output-available", "approval-requested"]));
    const pending = tools.find((p) => p.title === "git push origin main");
    expect(pending?.approval?.id).toBe(pendingApprovalId);
  });

  it("settles approvals as receipts: auto-answered and expired", () => {
    const tools = partsOf(messages).flatMap((p) => (p.type === "tool-execute" ? [p] : []));
    const auto = tools.find((p) => p.title === "ls");
    expect(auto?.state).toBe("output-available");
    expect(auto?.approval?.approved).toBe(true);
    const expired = tools.find((p) => p.title === "rm -rf build");
    expect(expired?.state).toBe("output-error");
  });

  it("turns an answer into approval-responded, then output-denied for a denial", () => {
    const upToRequest = events.slice(0, events.findIndex((e) => e.kind === "approval.requested") + 1);
    const answer = (decision: "allow_once" | "deny"): TaskEvent => ({
      kind: "approval.answered",
      approvalId: ApprovalId.parse(pendingApprovalId),
      optionId: OptionId.parse(decision === "deny" ? "deny" : "once"),
      decision,
      memberId: MemberId.parse("alex"),
    });
    const stateOf = (list: readonly TaskEvent[]): string | undefined => {
      const tool = partsOf(foldTaskEvents(stored(list), [])).find((p) => p.type === "tool-execute" && p.title === "git push origin main");
      return tool !== undefined && "state" in tool ? tool.state : undefined;
    };
    expect(stateOf(upToRequest)).toBe("approval-requested");
    expect(stateOf([...upToRequest, answer("allow_once")])).toBe("approval-responded");
    expect(stateOf([...upToRequest, answer("deny")])).toBe("output-denied");
    const done: TaskEvent = {
      kind: "tool.completed",
      toolCallId: ToolCallId.parse("t-call-6"),
      output: { output: "ok", truncated: false, exitCode: 0 },
    };
    expect(stateOf([...upToRequest, answer("allow_once"), done])).toBe("output-available");
  });

  it("keeps object identity for messages that did not change", () => {
    const first = foldTaskEvents(stored(events), []);
    const second = foldTaskEvents(stored(events), [], { previous: first });
    first.forEach((m, i) => {
      expect(second[i]).toBe(m);
    });
  });

  it("shows a kind this build does not know as an unsupported row", () => {
    const future = storedEventSchema.parse({ seq: 1, at: 1, event: { kind: "agent.from_the_future", x: 1 } });
    const result = foldTaskEvents([future], []);
    expect(result[0]?.parts[0]?.type).toBe("data-unsupported");
  });

  it("drops live text whose segment already has its completed message", () => {
    const turn = stored(events)
      .filter((e) => e.event.kind === "turn.started" || e.event.kind === "agent.message")
      .slice(0, 2);
    const message = turn[1]?.event;
    const started = turn[0]?.event;
    if (message?.kind !== "agent.message" || started?.kind !== "turn.started") throw new Error("fixture changed");
    const live = (segmentId: string) => [{ segmentId: SegmentId.parse(segmentId), turnId: started.turnId, part: "message" as const, text: "partial" }];
    const streaming = (list: readonly TaskUIMessage[]) => partsOf(list).filter((p) => p.type === "text" && p.state === "streaming");
    expect(streaming(foldTaskEvents(turn, live(message.segmentId)))).toEqual([]);
    expect(streaming(foldTaskEvents(turn, live("other")))).toHaveLength(1);
  });

  it("replaces an optimistic message with the committed one (same id)", () => {
    const optimistic = [{ clientMessageId: ClientMessageId.parse("c1"), memberId: MemberId.parse("alex"), text: "hi", delivery: "immediate" as const }];
    const before = foldTaskEvents([], [], { optimistic });
    expect(before[0]?.id).toBe("user:c1");
    expect(before[0]?.metadata?.optimistic).toBe(true);
    const committed = storedEventSchema.parse({
      seq: 1,
      at: 1,
      event: { kind: "user.message", memberId: "alex", clientMessageId: "c1", text: "hi", delivery: "immediate" },
    });
    const after = foldTaskEvents([committed], [], { optimistic });
    expect(after).toHaveLength(1);
    expect(after[0]?.metadata?.optimistic).toBeUndefined();
  });

  it("reports an update for an unknown tool call instead of dropping it", () => {
    const orphan = stored([{ kind: "tool.completed", toolCallId: ToolCallId.parse("nope"), output: {} }]);
    expect(partsOf(foldTaskEvents(orphan, []))[0]?.type).toBe("data-problem");
  });

  it("derives the driver and running state from the same events", () => {
    const state = deriveTaskState(stored(buildLongSession("x", 2)), MemberId.parse("alex"));
    expect(state.driverMemberId).toBe("alex");
    expect(state.turnRunning).toBe(false);
    expect(state.headSeq).toBeGreaterThan(50);
  });

  it("folds a 5,000 event session", () => {
    const long = stored(buildLongSession("long", 100));
    expect(long.length).toBeGreaterThanOrEqual(5000);
    const start = performance.now();
    const result = foldTaskEvents(long, []);
    const ms = performance.now() - start;
    expect(result.length).toBe(100);
    expect(ms).toBeLessThan(500);
  });
});

describe("ACP recording replay", () => {
  it("maps a hand-written ACP v1 trace and reports what it ignored or did not know", async () => {
    const file = new URL("../producer/fixtures/acp-session.jsonl", import.meta.url);
    const result = parseRecording("fixture", await readFile(file, "utf8"));
    const kinds = result.events.map((e) => e.kind);
    for (const expected of ["turn.started", "agent.thought", "agent.message", "approval.requested", "tool.completed", "turn.ended", "agent.unknown"]) {
      expect(kinds).toContain(expected);
    }
    // consecutive chunks coalesce into one segment
    expect(result.events.filter((e) => e.kind === "agent.message")).toHaveLength(1);
    expect(result.report.ignoredByDesign.get("usage_update")).toBe(1);
    expect(result.report.unknown.get("some_future_update")).toBe(1);
    const messages = foldTaskEvents(stored(result.events), []);
    expect(partsOf(messages).filter((p) => p.type === "data-problem")).toEqual([]);
  });
});

// Every line is accounted for: it bumps exactly one counter, and an unknown is also an agent.unknown event.
const accounted = (result: ReturnType<typeof parseRecording>): boolean =>
  result.lines === sumOf(result.report.mapped) + sumOf(result.report.ignoredByDesign) + sumOf(result.report.unknown) + result.rejectedLines &&
  sumOf(result.report.unknown) === result.events.filter((e) => e.kind === "agent.unknown").length;

const update = (body: Record<string, unknown>): unknown => ({ method: "session/update", params: { sessionId: "s", update: body } });

describe("the ACP mapper drops nothing silently and never throws on vendor data", () => {
  it("counts a line with neither method nor id, instead of losing it", () => {
    const text = [
      JSON.stringify({ hello: "world" }),
      JSON.stringify({ kind: "something_else", sessionId: "s" }),
      JSON.stringify(update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } })),
      JSON.stringify(update({ sessionUpdate: "usage_update" })),
    ].join("\n");
    const result = parseRecording("odd", text);
    expect(result.lines).toBe(4);
    expect(result.report.unknown.get("no-method-no-id")).toBe(2);
    expect(result.events.filter((e) => e.kind === "agent.unknown")).toHaveLength(2);
    expect(accounted(result)).toBe(true);
    const rows = partsOf(foldTaskEvents(stored(result.events), [])).filter((p) => p.type === "data-unsupported");
    expect(rows).toHaveLength(2);
  });

  it("does not throw on an empty or over-long tool call id, an empty permission id or a non-string compaction status", () => {
    const mapper = createAcpMapper("odd");
    const lines: unknown[] = [
      update({ sessionUpdate: "tool_call", toolCallId: "", kind: "read" }),
      update({ sessionUpdate: "tool_call", toolCallId: "x".repeat(201), kind: "read" }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "", status: "completed" }),
      { method: "session/request_permission", params: { toolCall: { toolCallId: "" }, options: [{ optionId: "o", name: "Allow", kind: "allow_once" }] } },
      { method: "session/request_permission", params: { toolCall: { toolCallId: "t" }, options: [{ optionId: "", name: "Allow", kind: "allow_once" }] } },
      update({ sessionUpdate: "compaction_update", status: 5 }),
      update({ sessionUpdate: "agent_message_chunk", content: { type: "image" } }),
      { id: 7, result: { stopReason: "something_new" } },
    ];
    const events = lines.flatMap((line) => {
      let mapped: ReturnType<typeof mapper.map> = [];
      expect(() => {
        mapped = mapper.map(line);
      }).not.toThrow();
      return mapped;
    });
    expect(sumOf(mapper.report.unknown)).toBe(lines.length);
    expect(sumOf(mapper.report.mapped)).toBe(0);
    // each unknown is an agent.unknown event (the unrecognized stop reason also closes the turn)
    expect(events.filter((e) => e.kind === "agent.unknown")).toHaveLength(lines.length);
    expect(events.filter((e) => e.kind === "turn.ended")).toHaveLength(1);
  });

  it("does not let one odd line abort the replay of the rest", () => {
    const text = [
      JSON.stringify(update({ sessionUpdate: "tool_call", toolCallId: "", kind: "read" })),
      JSON.stringify(update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "still here" } })),
      "not json at all",
    ].join("\n");
    const result = parseRecording("odd", text);
    expect(result.rejectedLines).toBe(1);
    expect(result.events.some((e) => e.kind === "agent.message" && e.text === "still here")).toBe(true);
    expect(accounted(result)).toBe(true);
  });

  it("reads spike 1's capture format (a JSON array of session_update and prompt_finished records)", () => {
    const capture = [
      { kind: "session_update", sessionId: "ses_1", update: { availableCommands: [], sessionUpdate: "available_commands_update" }, seq: 1, at: 1, taskId: "probe" },
      { kind: "session_update", sessionId: "ses_1", update: { content: { text: "hello from the stub", type: "text" }, messageId: "msg_1", sessionUpdate: "agent_message_chunk" }, seq: 2, at: 2, taskId: "probe" },
      { kind: "session_update", sessionId: "ses_1", update: { used: 1, size: 2, sessionUpdate: "usage_update" }, seq: 3, at: 3, taskId: "probe" },
      { kind: "prompt_finished", sessionId: "ses_1", response: { stopReason: "end_turn", usage: {}, _meta: {} }, seq: 4, at: 4, taskId: "probe" },
    ];
    const result = parseRecording("probe/events.json", JSON.stringify(capture));
    expect(result.lines).toBe(4);
    expect(result.report.mapped.get("agent_message_chunk")).toBe(1);
    expect(result.report.mapped.get("stopReason")).toBe(1);
    expect(result.report.ignoredByDesign.get("available_commands_update")).toBe(1);
    expect(result.report.ignoredByDesign.get("usage_update")).toBe(1);
    expect(sumOf(result.report.unknown)).toBe(0);
    expect(result.events.map((e) => e.kind)).toEqual(["turn.started", "agent.message", "turn.ended"]);
    expect(accounted(result)).toBe(true);
  });
});
