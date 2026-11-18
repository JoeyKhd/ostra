import { sessionIdSchema, taskIdSchema, turnIdSchema } from "@ostra/protocol";
import type { TaskEvent } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import type { AcpUpdate, MapContext } from "../base.ts";
import { createAcpMapper, toApprovalOptions } from "./map.ts";
import type { LiveTextDelta } from "./map.ts";

// One test per row of the table in `research/agent-ui-stream.md` that the mapping implements, and
// one for an update the table has no row for.

const context = (turn = "turn-1"): MapContext => ({
  taskId: taskIdSchema.parse("task-1"),
  sessionId: sessionIdSchema.parse("session-1"),
  turnId: turnIdSchema.parse(turn),
});

const run = (updates: readonly AcpUpdate[], options: Parameters<typeof createAcpMapper>[0] = {}): TaskEvent[] => {
  const mapper = createAcpMapper(options);
  const events: TaskEvent[] = [];
  for (const update of updates) {
    events.push(...mapper.map(update, context()));
  }
  events.push(...mapper.finishTurn(context()));
  return events;
};

const text = (kind: string, value: string, extra: Record<string, unknown> = {}): AcpUpdate => ({
  sessionUpdate: kind,
  content: { type: "text", text: value },
  ...extra,
});

describe("the ACP mapping", () => {
  it("row 2: drops user_message_chunk, because the server's user.message is authoritative", () => {
    expect(run([text("user_message_chunk", "hello")])).toEqual([]);
  });

  it("row 3: joins agent_message_chunk text into one segment, closed at the turn's end", () => {
    const events = run([text("agent_message_chunk", "Hel"), text("agent_message_chunk", "lo "), text("agent_message_chunk", "world")]);
    expect(events).toEqual([{ kind: "agent.message", turnId: "turn-1", segmentId: "turn-1-s1", text: "Hello world" }]);
  });

  it("row 3: closes the segment on a new messageId, and on any non-text update", () => {
    const events = run([
      text("agent_message_chunk", "one", { messageId: "m1" }),
      text("agent_message_chunk", "two", { messageId: "m2" }),
      { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read", kind: "read", status: "pending" },
      text("agent_message_chunk", "three", { messageId: "m2" }),
    ]);
    expect(events.map((event) => event.kind)).toEqual(["agent.message", "agent.message", "tool.called", "agent.message"]);
    expect(events.flatMap((event) => (event.kind === "agent.message" ? [[event.segmentId, event.text]] : []))).toEqual([
      ["turn-1-s1", "one"],
      ["turn-1-s2", "two"],
      ["turn-1-s3", "three"],
    ]);
  });

  it("row 3: reports the partial text as live deltas, with offsets, never as events", () => {
    const deltas: LiveTextDelta[] = [];
    run([text("agent_message_chunk", "ab"), text("agent_message_chunk", "cd")], { onLiveText: (delta) => deltas.push(delta) });
    expect(deltas.map((delta) => [delta.segmentId, delta.kind, delta.offset, delta.text])).toEqual([
      ["turn-1-s1", "message", 0, "ab"],
      ["turn-1-s1", "message", 2, "cd"],
    ]);
  });

  it("row 4: maps an image and a resource link to agent.content", () => {
    const events = run([
      { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "aGk=", mimeType: "image/png" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "resource_link", uri: "https://example.com/a", name: "A" } },
    ]);
    expect(events).toEqual([
      { kind: "agent.content", turnId: "turn-1", block: { type: "image", mediaType: "image/png", url: "data:image/png;base64,aGk=" } },
      { kind: "agent.content", turnId: "turn-1", block: { type: "resource_link", uri: "https://example.com/a", title: "A" } },
    ]);
  });

  it("row 5: maps agent_thought_chunk to agent.thought, apart from a message", () => {
    const events = run([text("agent_thought_chunk", "thinking"), text("agent_message_chunk", "answer")]);
    expect(events.map((event) => event.kind)).toEqual(["agent.thought", "agent.message"]);
  });

  it("row 6: maps tool_call to tool.called, normalising the kinds the panel draws itself", () => {
    const events = run([
      { sessionUpdate: "tool_call", toolCallId: "r", title: "Read a.ts", kind: "read", rawInput: { filePath: "a.ts" }, locations: [{ path: "a.ts" }] },
      { sessionUpdate: "tool_call", toolCallId: "e", title: "Edit", kind: "edit", locations: [{ path: "a.ts" }, { path: "b.ts" }] },
      { sessionUpdate: "tool_call", toolCallId: "x", title: "Run", kind: "execute", rawInput: { command: "npm test", workdir: "/w" } },
      { sessionUpdate: "tool_call", toolCallId: "s", title: "Search", kind: "search", rawInput: { query: "foo" } },
      { sessionUpdate: "tool_call", toolCallId: "o", title: "Odd", kind: "something-new", rawInput: { a: 1 } },
    ]);
    expect(events).toMatchObject([
      { kind: "tool.called", toolKind: "read", input: { path: "a.ts" } },
      { kind: "tool.called", toolKind: "edit", input: { paths: ["a.ts", "b.ts"] } },
      { kind: "tool.called", toolKind: "execute", input: { command: "npm test", cwd: "/w" } },
      { kind: "tool.called", toolKind: "search", input: { query: "foo" } },
      { kind: "tool.called", toolKind: "other", input: { a: 1 } },
    ]);
  });

  it("row 6: holds a pending shell call without its command until the update that brings it", () => {
    const events = run([
      { sessionUpdate: "tool_call", toolCallId: "x", title: "shell", kind: "execute", status: "pending", rawInput: {} },
      { sessionUpdate: "tool_call_update", toolCallId: "x", status: "in_progress", title: "git status", rawInput: { command: "git status", workdir: "/w" } },
      { sessionUpdate: "tool_call_update", toolCallId: "x", status: "completed", rawOutput: { output: "clean", metadata: { exit: 0 } } },
    ]);
    expect(events).toMatchObject([
      { kind: "tool.called", toolCallId: "x", toolKind: "execute", title: "git status", input: { command: "git status", cwd: "/w" } },
      { kind: "tool.completed", toolCallId: "x" },
    ]);
  });

  it("row 6: keeps two parallel shell calls held until each one's own update", () => {
    const events = run([
      { sessionUpdate: "tool_call", toolCallId: "a", title: "shell", kind: "execute", status: "pending", rawInput: {} },
      { sessionUpdate: "tool_call", toolCallId: "b", title: "shell", kind: "execute", status: "pending", rawInput: {} },
      { sessionUpdate: "tool_call_update", toolCallId: "b", status: "in_progress", rawInput: { command: "ls" } },
      { sessionUpdate: "tool_call_update", toolCallId: "a", status: "in_progress", rawInput: { command: "pwd" } },
    ]);
    expect(events).toMatchObject([
      { kind: "tool.called", toolCallId: "b", input: { command: "ls" } },
      { kind: "tool.called", toolCallId: "a", input: { command: "pwd" } },
    ]);
  });

  it("row 6: releases a held call as it stands at the next other update, or at the turn's end, never dropping it", () => {
    const released = run([
      { sessionUpdate: "tool_call", toolCallId: "x", title: "shell", kind: "execute", status: "pending", rawInput: {} },
      text("agent_message_chunk", "meanwhile"),
    ]);
    expect(released.map((event) => event.kind)).toEqual(["tool.called", "agent.message"]);
    const atEnd = run([{ sessionUpdate: "tool_call", toolCallId: "y", title: "shell", kind: "execute", status: "pending" }]);
    expect(atEnd).toMatchObject([{ kind: "tool.called", toolCallId: "y", title: "shell" }]);
  });

  it("row 7: maps an in_progress update with content to tool.progress, and one with none to nothing", () => {
    const events = run([
      { sessionUpdate: "tool_call", toolCallId: "x", title: "Run", kind: "execute", rawInput: { command: "ls" } },
      { sessionUpdate: "tool_call_update", toolCallId: "x", status: "in_progress" },
      { sessionUpdate: "tool_call_update", toolCallId: "x", status: "in_progress", content: [{ type: "content", content: { type: "text", text: "partial" } }] },
      { sessionUpdate: "tool_call", toolCallId: "t", title: "Think", kind: "think" },
      { sessionUpdate: "tool_call_update", toolCallId: "t", status: "in_progress", content: [{ type: "content", content: { type: "text", text: "hmm" } }] },
    ]);
    expect(events.filter((event) => event.kind === "tool.progress")).toMatchObject([
      { toolCallId: "x", output: { output: "partial", truncated: false, exitCode: null } },
      { toolCallId: "t", output: { text: "hmm" } },
    ]);
  });

  it("row 8: maps a completed update to tool.completed, per kind", () => {
    const events = run([
      { sessionUpdate: "tool_call", toolCallId: "e", title: "Edit", kind: "edit" },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "e",
        status: "completed",
        content: [{ type: "diff", path: "a.ts", oldText: "old", newText: "new1\nnew2" }],
      },
      { sessionUpdate: "tool_call", toolCallId: "x", title: "Run", kind: "execute" },
      { sessionUpdate: "tool_call_update", toolCallId: "x", status: "completed", content: [{ type: "content", content: { type: "text", text: "ok" } }] },
      { sessionUpdate: "tool_call", toolCallId: "f", title: "Fetch", kind: "fetch" },
      { sessionUpdate: "tool_call_update", toolCallId: "f", status: "completed", rawOutput: { status: 200 } },
    ]);
    expect(events.filter((event) => event.kind === "tool.completed")).toMatchObject([
      { toolCallId: "e", output: { files: [{ path: "a.ts", added: 2, removed: 1 }] } },
      { toolCallId: "x", output: { output: "ok", truncated: false, exitCode: 0 } },
      { toolCallId: "f", output: { status: 200 } },
    ]);
  });

  it("row 9: maps a failed update to tool.failed with its text", () => {
    const events = run([
      { sessionUpdate: "tool_call", toolCallId: "r", title: "Read", kind: "read" },
      { sessionUpdate: "tool_call_update", toolCallId: "r", status: "failed", content: [{ type: "content", content: { type: "text", text: "no such file" } }] },
    ]);
    expect(events.at(-1)).toEqual({ kind: "tool.failed", toolCallId: "r", error: "no such file" });
  });

  it("row 14: maps plan to plan.updated, defaulting a priority or status it doesn't know", () => {
    const events = run([
      {
        sessionUpdate: "plan",
        entries: [
          { content: "a", priority: "high", status: "completed" },
          { content: "b", priority: "urgent", status: "someday" },
        ],
      },
    ]);
    expect(events).toEqual([
      {
        kind: "plan.updated",
        turnId: "turn-1",
        entries: [
          { content: "a", priority: "high", status: "completed" },
          { content: "b", priority: "medium", status: "pending" },
        ],
      },
    ]);
  });

  it("rows 15, 17, 19: ignores available_commands_update, session_info_update and notice", () => {
    expect(
      run([
        { sessionUpdate: "available_commands_update", availableCommands: [] },
        { sessionUpdate: "session_info_update", title: "A title" },
        { sessionUpdate: "notice", severity: "info", title: "Heads up" },
      ]),
    ).toEqual([]);
  });

  it("row 16: maps current_mode_update and config_option_update to session.config_changed, once per change", () => {
    const events = run([
      { sessionUpdate: "current_mode_update", currentModeId: "build" },
      { sessionUpdate: "current_mode_update", currentModeId: "build" },
      { sessionUpdate: "config_option_update", configOptions: [{ id: "model", currentValue: "p/m1" }, { id: "effort", currentValue: "high" }] },
      { sessionUpdate: "config_option_update", configOptions: [{ id: "model", currentValue: "p/m1" }, { id: "effort", currentValue: "low" }] },
    ]);
    expect(events).toEqual([
      { kind: "session.config_changed", key: "mode", value: "build" },
      { kind: "session.config_changed", key: "model", value: "p/m1" },
      { kind: "session.config_changed", key: "effort", value: "high" },
      { kind: "session.config_changed", key: "effort", value: "low" },
    ]);
  });

  it("row 18: reports usage_update once per turn, with the last figure", () => {
    const mapper = createAcpMapper();
    expect(mapper.map({ sessionUpdate: "usage_update", used: 100, size: 1000 }, context())).toEqual([]);
    expect(mapper.map({ sessionUpdate: "usage_update", used: 250, size: 1000 }, context())).toEqual([]);
    expect(mapper.finishTurn(context())).toEqual([{ kind: "session.usage", contextUsed: 250, contextSize: 1000 }]);
    expect(mapper.finishTurn(context("turn-2"))).toEqual([]);
  });

  it("row 20: maps compaction_update to compaction.updated, with the summary on its end", () => {
    const events = run([
      { sessionUpdate: "compaction_update", compactionId: "c", status: "running" },
      { sessionUpdate: "compaction_summary_chunk", compactionId: "c", content: { type: "text", text: "Part one. " } },
      { sessionUpdate: "compaction_summary_chunk", compactionId: "c", content: { type: "text", text: "Part two." } },
      { sessionUpdate: "compaction_update", compactionId: "c", status: "completed" },
    ]);
    expect(events).toEqual([
      { kind: "compaction.updated", turnId: "turn-1", status: "running" },
      { kind: "compaction.updated", turnId: "turn-1", status: "done", summary: "Part one. Part two." },
    ]);
  });

  it("anything else: becomes agent.unknown, with its kind and its payload capped, never dropped", () => {
    const huge = "x".repeat(10_000);
    const events = run([text("agent_message_chunk", "before"), { sessionUpdate: "future_feature", payload: huge }, text("agent_message_chunk", "after")]);
    expect(events.map((event) => event.kind)).toEqual(["agent.message", "agent.unknown", "agent.message"]);
    const unknown = events[1];
    expect(unknown).toMatchObject({ kind: "agent.unknown", acpKind: "future_feature" });
    expect(unknown?.kind === "agent.unknown" && unknown.raw.length).toBe(4000);
  });

  it("makes a malformed update visible too, instead of throwing", () => {
    const events = run([{ sessionUpdate: "tool_call" }, { sessionUpdate: "plan", entries: "nope" }, { sessionUpdate: "agent_message_chunk", content: 7 }]);
    expect(events.map((event) => event.kind)).toEqual(["agent.unknown", "agent.unknown", "agent.unknown"]);
  });

  it("restarts segment numbering with each turn, so segment IDs stay unique", () => {
    const mapper = createAcpMapper();
    const first = [...mapper.map(text("agent_message_chunk", "a"), context("turn-1")), ...mapper.finishTurn(context("turn-1"))];
    const second = [...mapper.map(text("agent_message_chunk", "b"), context("turn-2")), ...mapper.finishTurn(context("turn-2"))];
    expect([first, second].map((events) => events[0])).toMatchObject([{ segmentId: "turn-1-s1" }, { segmentId: "turn-2-s1" }]);
  });
});

describe("approval options", () => {
  it("maps ACP's four kinds to ostra's decisions, and leaves out an option with no usable ID", () => {
    const options = toApprovalOptions({
      toolCallId: "t",
      title: "Edit",
      options: [
        { optionId: "a1", name: "Allow once", kind: "allow_once" },
        { optionId: "a2", name: "Allow for the task", kind: "allow_always" },
        { optionId: "r1", name: "Reject", kind: "reject_once" },
        { optionId: "r2", name: "Never", kind: "reject_always" },
        { optionId: "has space", name: "Broken", kind: "allow_once" },
      ],
    });
    expect(options.map((option) => [option.kind, option.decision])).toEqual([
      ["allow-once", "allow_once"],
      ["allow-always", "allow_task"],
      ["reject-once", "deny"],
      ["reject-always", "deny"],
    ]);
  });
});
