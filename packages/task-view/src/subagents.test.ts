import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { OpenCodeAdapter } from "@ostra/adapter-opencode";
import { createAcpDriver } from "@ostra/adapter-sdk";
import type { AgentAdapter, AgentIo, PermissionRequest } from "@ostra/adapter-sdk";
import { createScenarioBrain, FAKE_SUBAGENT_TREE, FakeAgentAdapter, fakeMarker, spawnAgentProcess, startStubModelServer, stubMarker } from "@ostra/adapter-sdk/testing";
import type { StubServer } from "@ostra/adapter-sdk/testing";
import { approvalIdSchema, clientMessageIdSchema, optionIdSchema, segmentIdSchema, subagentIdSchema, toolCallIdSchema, turnIdSchema } from "@ostra/protocol";
import type { StoredEvent, TaskEvent } from "@ostra/protocol";
import { fixtureIds } from "@ostra/protocol/testing";
import { afterAll, describe, expect, it } from "vitest";

import { foldTaskEvents } from "./fold.ts";
import { readRecordedRun, replayAgent } from "./testing/recorded-subagents.ts";
import { storeEvents } from "./testing/index.ts";
import type { SubagentNode, SubagentTree, TaskUIMessage } from "./ui-types.ts";

// F-138: an agent's subagents on the task page. The fold builds each turn's tree from the task's
// events: the main agent at the root, each subagent under the agent that started it, with its
// type, prompt, state, calls and answer, none of them in the thread. Proved here from events made
// by hand, from the scripted fake agent (with subagents, and without), from OpenCode 2.3.2's
// recorded child-session updates, and from a real OpenCode run against the stub model.

const roots: string[] = [];
const servers: StubServer[] = [];

afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));
});

const turn = turnIdSchema.parse("subagents-turn-1");
const sub = (id: string) => subagentIdSchema.parse(id);
const call = (id: string) => toolCallIdSchema.parse(id);
const seg = (id: string) => segmentIdSchema.parse(id);

const lastTurn = (messages: readonly TaskUIMessage[]): TaskUIMessage | undefined => messages.filter((message) => message.role === "assistant").at(-1);
const treeOf = (messages: readonly TaskUIMessage[]): SubagentTree | undefined => {
  const trees = messages.flatMap((message) => (message.metadata?.subagents === undefined ? [] : [message.metadata.subagents]));
  return trees.at(-1);
};
const nodeBy = (tree: SubagentTree | undefined, description: string): SubagentNode | undefined => tree?.nodes.find((node) => node.description === description);
const threadTexts = (messages: readonly TaskUIMessage[]): string[] =>
  messages.filter((message) => message.role === "assistant").flatMap((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])));
const threadCalls = (messages: readonly TaskUIMessage[]): string[] =>
  messages.flatMap((message) => message.parts.flatMap((part) => ("toolCallId" in part ? [part.toolCallId] : [])));

/** A turn with three subagents, one nested in another, as a minor-6 runner stores them. */
const treeEvents = (): TaskEvent[] => [
  { kind: "turn.started", turnId: turn },
  { kind: "agent.message", turnId: turn, segmentId: seg("s1"), text: "I'll have subagents look first." },
  { kind: "tool.called", turnId: turn, toolCallId: call("main-sub-a"), toolKind: "think", title: "subagent", input: { agent: "explore", description: "Find the version source", prompt: "Find where the version is read." } },
  { kind: "tool.completed", toolCallId: call("main-sub-a"), output: { metadata: { sessionID: "ses_a", status: "running" } } },
  { kind: "subagent.started", toolCallId: call("main-sub-a"), subagentId: sub("ses_a"), depth: 1, type: "explore", description: "Find the version source", prompt: "Find where the version is read." },
  { kind: "subagent.status", subagentId: sub("ses_a"), status: "running" },
  { kind: "tool.called", turnId: turn, toolCallId: call("main-sub-b"), toolKind: "think", title: "subagent", input: { agent: "general", description: "Write version row test", prompt: "Add a test for the version row." } },
  { kind: "tool.completed", toolCallId: call("main-sub-b"), output: { metadata: { sessionID: "ses_b", status: "running" } } },
  { kind: "subagent.started", toolCallId: call("main-sub-b"), subagentId: sub("ses_b"), depth: 1, type: "general", description: "Write version row test", prompt: "Add a test for the version row." },
  { kind: "subagent.status", subagentId: sub("ses_b"), status: "running" },
  { kind: "tool.called", turnId: turn, toolCallId: call("ses_a:read-1"), toolKind: "read", title: "read", input: { path: "src/settings/page.tsx" }, subagentId: sub("ses_a") },
  { kind: "tool.completed", toolCallId: call("ses_a:read-1"), output: { lineCount: 12 } },
  { kind: "agent.thought", turnId: turn, segmentId: seg("s2"), text: "The version is read at build time.", subagentId: sub("ses_a") },
  { kind: "agent.message", turnId: turn, segmentId: seg("s3"), text: "The version comes from package.json.", subagentId: sub("ses_a") },
  { kind: "subagent.status", subagentId: sub("ses_a"), status: "completed" },
  { kind: "tool.called", turnId: turn, toolCallId: call("ses_b:sub-c"), toolKind: "think", title: "subagent", input: { agent: "explore", description: "Find test helpers", prompt: "Find the render helpers." }, subagentId: sub("ses_b") },
  { kind: "tool.completed", toolCallId: call("ses_b:sub-c"), output: { metadata: { sessionID: "ses_c", status: "running" } } },
  { kind: "subagent.started", toolCallId: call("ses_b:sub-c"), subagentId: sub("ses_c"), parentSubagentId: sub("ses_b"), depth: 2, type: "explore", description: "Find test helpers", prompt: "Find the render helpers." },
  { kind: "tool.called", turnId: turn, toolCallId: call("ses_c:grep-1"), toolKind: "search", title: "grep", input: { pattern: "renderWithProviders" }, subagentId: sub("ses_c") },
  { kind: "tool.completed", toolCallId: call("ses_c:grep-1"), output: { matches: 4 } },
  { kind: "agent.message", turnId: turn, segmentId: seg("s4"), text: "renderWithProviders, in test/render.tsx.", subagentId: sub("ses_c") },
  { kind: "subagent.status", subagentId: sub("ses_c"), status: "completed" },
  { kind: "plan.updated", turnId: turn, entries: [{ content: "Write the test", priority: "high", status: "in_progress" }], subagentId: sub("ses_b") },
];

describe("the subagent tree, from events (F-138)", () => {
  it("F-138: a turn's subagents fold into a tree under the main agent: parents, depth, types, prompts, states, calls and answers", () => {
    const messages = foldTaskEvents(storeEvents(treeEvents()), []);
    const tree = treeOf(messages);
    expect(tree?.nodes.map((node) => [node.description, node.parentId, node.depth, node.type])).toEqual([
      ["Find the version source", null, 1, "explore"],
      ["Write version row test", null, 1, "general"],
      ["Find test helpers", "ses_b", 2, "explore"],
    ]);
    const explore = nodeBy(tree, "Find the version source");
    expect(explore).toMatchObject({ state: "done", startedBy: "main-sub-a", callCount: 1, orphan: false });
    expect(explore?.rounds[0]).toMatchObject({ prompt: "Find where the version is read.", answer: "The version comes from package.json." });
    expect(explore?.rounds[0]?.calls.map((part) => [part.type, part.state])).toEqual([["tool-read", "output-available"]]);
    expect(explore?.endedAt).not.toBeNull();
    expect(nodeBy(tree, "Write version row test")).toMatchObject({ state: "running", endedAt: null, children: ["ses_c"], callCount: 1 });
    expect(nodeBy(tree, "Find test helpers")).toMatchObject({ state: "done", rounds: [{ answer: "renderWithProviders, in test/render.tsx." }] });
    expect(tree?.counts).toEqual({ total: 3, running: 1, needsApproval: 0, failed: 0, stopped: 0, done: 2 });
    // The main agent's own: its two `subagent` calls and its message. Nothing of a subagent's.
    expect(tree?.rootCalls).toBe(2);
    expect(threadCalls(messages)).toEqual(["main-sub-a", "main-sub-b"]);
    expect(threadTexts(messages)).toEqual(["I'll have subagents look first."]);
    expect(lastTurn(messages)?.parts.some((part) => part.type === "reasoning" || part.type === "data-plan")).toBe(false);
  });

  it("F-138: a subagent's call that asks shows in the thread with its approval, its node needs approval, and one answer closes both", () => {
    const approvalId = approvalIdSchema.parse("0196f1a0-0000-7000-8000-0000000000a1");
    const asking: TaskEvent[] = [
      ...treeEvents(),
      { kind: "tool.called", turnId: turn, toolCallId: call("ses_b:run-1"), toolKind: "execute", title: "pnpm test settings", input: { command: "pnpm test settings" }, subagentId: sub("ses_b") },
      {
        kind: "approval.requested",
        turnId: turn,
        approvalId,
        toolCallId: call("ses_b:run-1"),
        options: [{ optionId: optionIdSchema.parse("once"), label: "Allow once", kind: "allow-once", decision: "allow_once" }],
        subagentId: sub("ses_b"),
      },
    ];
    const waiting = foldTaskEvents(storeEvents(asking), []);
    const asked = nodeBy(treeOf(waiting), "Write version row test");
    expect(asked?.state).toBe("needs-approval");
    expect(treeOf(waiting)?.counts.needsApproval).toBe(1);
    // In the thread, where it was asked, as the call it is; in the window, the same call.
    const inThread = lastTurn(waiting)?.parts.find((part) => "toolCallId" in part && part.toolCallId === "ses_b:run-1");
    expect(inThread?.type === "tool-execute" ? inThread.state : null).toBe("approval-requested");
    expect(asked?.rounds[0]?.calls.find((part) => part.toolCallId === "ses_b:run-1")?.state).toBe("approval-requested");
    // Not a call of the main agent's: the tree's root still counts two.
    expect(treeOf(waiting)?.rootCalls).toBe(2);
    const answered = foldTaskEvents(
      storeEvents([...asking, { kind: "approval.answered", approvalId, optionId: optionIdSchema.parse("once"), decision: "allow_once", memberId: fixtureIds.member }]),
      [],
    );
    expect(nodeBy(treeOf(answered), "Write version row test")?.state).toBe("running");
    const closed = lastTurn(answered)?.parts.find((part) => "toolCallId" in part && part.toolCallId === "ses_b:run-1");
    expect(closed?.type === "tool-execute" ? closed.state : null).toBe("approval-responded");
  });

  it("F-138: a failed subagent keeps its error, an interrupted one and one whose session ended are stopped, and one outlives its turn as running", () => {
    const failed = [...treeEvents(), { kind: "subagent.status", subagentId: sub("ses_b"), status: "failed", error: "the model endpoint returned 500" } satisfies TaskEvent];
    const afterTurn: TaskEvent[] = [...treeEvents(), { kind: "turn.ended", turnId: turn, stopReason: "end_turn" }];
    expect(nodeBy(treeOf(foldTaskEvents(storeEvents(failed), [])), "Write version row test")).toMatchObject({ state: "failed", error: "the model endpoint returned 500" });
    expect(treeOf(foldTaskEvents(storeEvents(failed), []))?.counts).toMatchObject({ failed: 1, running: 0 });
    // Past its turn's end it still runs, and the badge stays on the turn that started it.
    const outlived = foldTaskEvents(storeEvents(afterTurn), []);
    expect(nodeBy(treeOf(outlived), "Write version row test")?.state).toBe("running");
    expect(lastTurn(outlived)?.metadata?.subagents?.counts.running).toBe(1);
    const interrupted = [...afterTurn, { kind: "subagent.status", subagentId: sub("ses_b"), status: "interrupted" } satisfies TaskEvent];
    expect(nodeBy(treeOf(foldTaskEvents(storeEvents(interrupted), [])), "Write version row test")?.state).toBe("stopped");
    const boxGone = [...afterTurn, { kind: "session.crashed", error: "the box went away", cause: "box_lost" } satisfies TaskEvent];
    expect(nodeBy(treeOf(foldTaskEvents(storeEvents(boxGone), [])), "Write version row test")?.state).toBe("stopped");
  });

  it("F-138: without subagent events (a minor-5 runner, an agent without the capability) the calls fold flat, as before", () => {
    const flat = treeEvents().flatMap((event): TaskEvent[] => {
      if (event.kind === "subagent.started" || event.kind === "subagent.status") return [];
      if (event.kind === "agent.message" || event.kind === "agent.thought" || event.kind === "tool.called" || event.kind === "plan.updated") {
        const flatEvent = { ...event };
        Reflect.deleteProperty(flatEvent, "subagentId");
        return [flatEvent];
      }
      return [event];
    });
    const messages = foldTaskEvents(storeEvents(flat), []);
    expect(treeOf(messages)).toBeUndefined();
    expect(threadCalls(messages)).toEqual(["main-sub-a", "main-sub-b", "ses_a:read-1", "ses_b:sub-c", "ses_c:grep-1"]);
    expect(threadTexts(messages)).toContain("The version comes from package.json.");
  });

  it("F-138: a reload rebuilds the same tree: the whole log at once, again, or as it arrived with the previous fold", () => {
    const events = storeEvents(treeEvents());
    const once = foldTaskEvents(events, []);
    expect(foldTaskEvents(events, [])).toEqual(once);
    let previous: TaskUIMessage[] = [];
    for (let end = 1; end <= events.length; end += 1) {
      previous = foldTaskEvents(events.slice(0, end), [], { previous });
    }
    expect(previous).toEqual(once);
    expect(treeOf(previous)).toEqual(treeOf(once));
  });

  it("F-138: a subagent whose start never arrived stays under the main agent, marked, with what it did", () => {
    const events: TaskEvent[] = [
      { kind: "turn.started", turnId: turn },
      { kind: "subagent.status", subagentId: sub("ses_lost"), status: "running" },
      { kind: "tool.called", turnId: turn, toolCallId: call("ses_lost:read-1"), toolKind: "read", title: "read", input: { path: "README.md" }, subagentId: sub("ses_lost") },
    ];
    const tree = treeOf(foldTaskEvents(storeEvents(events), []));
    expect(tree?.nodes).toHaveLength(1);
    expect(tree?.nodes[0]).toMatchObject({ id: "ses_lost", parentId: null, orphan: true, type: null, state: "running", callCount: 1 });
  });
});

// ---- the agents ---------------------------------------------------------------------------

type Turn = { readonly stored: readonly StoredEvent[]; readonly permissions: readonly PermissionRequest[] };

/**
 * Runs one turn on an adapter, as the runner does: its events are stored as core stores them, and
 * an approval it asks for is written as the runner writes it (with its subagent) and allowed.
 */
const runTurn = async (adapter: AgentAdapter, prompt: string, io: AgentIo | "spawn", baseUrl = "http://127.0.0.1:9/v1"): Promise<Turn> => {
  const root = await mkdtemp(path.join(tmpdir(), "ostra-subagents-"));
  roots.push(root);
  const workspaceDir = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(path.join(agentDir, "tmp"), { recursive: true });
  await writeFile(path.join(workspaceDir, "README.md"), "# test1\n\nhello\n", "utf8");
  let stop = (): Promise<void> => Promise.resolve();
  let agentIo: AgentIo;
  if (io === "spawn") {
    const launch = await adapter.prepareLaunch({
      taskId: fixtureIds.task,
      sessionId: fixtureIds.session,
      workspaceDir,
      agentDir,
      model: { endpointModelId: "stub-model", apiFormat: "openai-compatible", baseUrl, placeholderKey: "ostra-fake-key-for-this-task" },
      mcp: { url: "http://127.0.0.1:9/mcp" },
      instructions: null,
      extraEnv: {},
    });
    if (!launch.ok) throw new Error(launch.error.message);
    const started = await spawnAgentProcess(launch.value);
    agentIo = started.io;
    stop = started.stop;
  } else {
    agentIo = io;
  }
  const events: TaskEvent[] = [{ kind: "user.message", memberId: fixtureIds.member, clientMessageId: clientMessageIdSchema.parse("subagents-1"), text: prompt, delivery: "immediate" }];
  const permissions: PermissionRequest[] = [];
  let approvals = 0;
  const session = await adapter.startSession({
    taskId: fixtureIds.task,
    sessionId: fixtureIds.session,
    io: agentIo,
    cwd: workspaceDir,
    mcpServers: [],
    onEvents: (batch) => {
      events.push(...batch);
    },
    onPermission: (_agentSessionId, request) => {
      permissions.push(request);
      approvals += 1;
      const approvalId = approvalIdSchema.parse(`0196f1a0-0000-7000-8000-${approvals.toString(16).padStart(12, "0")}`);
      const allow = request.options.find((option) => option.kind === "allow_once");
      if (allow === undefined) return Promise.resolve({ outcome: "cancelled" });
      // As the runner writes it: the approval names the subagent whose call asks.
      events.push({
        kind: "approval.requested",
        turnId: turn,
        approvalId,
        toolCallId: request.toolCallId,
        options: [{ optionId: allow.optionId, label: allow.name, kind: "allow-once", decision: "allow_once" }],
        ...(request.subagentId === undefined ? {} : { subagentId: request.subagentId }),
      });
      return Promise.resolve({ outcome: "selected", optionId: allow.optionId });
    },
    onQuestion: () => Promise.resolve({ outcome: "cancelled" }),
  });
  try {
    if (!session.ok) throw new Error(session.error.message);
    const result = await adapter.prompt(session.value, turn, prompt);
    expect(result).toEqual({ ok: true, value: { stopReason: "end_turn" } });
    await adapter.close(session.value);
  } finally {
    await stop();
  }
  return { stored: storeEvents(events), permissions };
};

describe("the subagent tree, from each agent (F-138)", () => {
  it("F-138: the fake agent with subagents: its three subagents, one nested under its parent, fold into the tree with their calls and answers", async () => {
    const { stored } = await runTurn(new FakeAgentAdapter("rich"), fakeMarker("subagent-tree"), "spawn");
    const messages = foldTaskEvents(stored, []);
    const tree = treeOf(messages);
    const t = FAKE_SUBAGENT_TREE;
    expect(tree?.nodes.map((node) => [node.description, node.depth, node.type, node.state])).toEqual([
      [t.explore.description, 1, "explore", "done"],
      [t.general.description, 1, "general", "done"],
      [t.nested.description, 2, "explore", "done"],
    ]);
    const general = nodeBy(tree, t.general.description);
    const nested = nodeBy(tree, t.nested.description);
    expect(nested?.parentId).toBe(general?.id);
    expect(general?.children).toEqual([nested?.id]);
    expect(general?.rounds[0]).toMatchObject({ prompt: t.general.prompt, answer: t.general.answer });
    expect(general?.rounds[0]?.calls.map((part) => part.type)).toEqual(["tool-read", "dynamic-tool", "tool-edit"]);
    expect(nodeBy(tree, t.explore.description)?.rounds[0]?.answer).toBe(t.explore.answer);
    // Each child's answer is its own message, never the main agent's.
    expect(threadTexts(messages)).toEqual(["I'll have subagents find the version source and write the test, then add the row.", t.mainAnswer]);
    expect(threadCalls(messages)).toEqual(["subagent-explore", "subagent-general"]);
    expect(stored.filter((item) => item.event.kind === "subagent.status" && item.event.status === "completed")).toHaveLength(3);
  }, 60_000);

  it("F-138: the same agent without the capability shows its subagents' calls flat, as today", async () => {
    const { stored } = await runTurn(new FakeAgentAdapter("plain"), fakeMarker("subagent-tree"), "spawn");
    const messages = foldTaskEvents(stored, []);
    expect(treeOf(messages)).toBeUndefined();
    expect(stored.some((item) => item.event.kind === "subagent.started" || item.event.kind === "subagent.status")).toBe(false);
    expect(stored.some((item) => "subagentId" in item.event)).toBe(false);
    // Every call in the thread, the children's too.
    expect(threadCalls(messages).length).toBeGreaterThan(2);
  }, 60_000);

  it("F-138: an approval inside a subagent names it: the request carries the subagent, the thread asks, and the window's node waits", async () => {
    const { stored, permissions } = await runTurn(new FakeAgentAdapter("rich"), fakeMarker("subagent-tree", "ask"), "spawn");
    const t = FAKE_SUBAGENT_TREE;
    const general = treeOf(foldTaskEvents(stored, []))?.nodes.find((node) => node.description === t.general.description);
    expect(permissions).toHaveLength(1);
    expect(permissions[0]?.subagentId).toBe(general?.id);
    // Folded up to the request: the thread holds the subagent's call with its approval, and the node needs approval.
    const upTo = stored.findIndex((item) => item.event.kind === "approval.requested") + 1;
    const waiting = foldTaskEvents(stored.slice(0, upTo), []);
    expect(treeOf(waiting)?.nodes.find((node) => node.id === general?.id)?.state).toBe("needs-approval");
    const asked = lastTurn(waiting)?.parts.find((part) => "toolCallId" in part && part.toolCallId === permissions[0]?.toolCallId);
    expect(asked?.type === "tool-execute" ? asked.state : null).toBe("approval-requested");
  }, 60_000);

  it("F-138: a failing subagent fails on the tree with its agent's error", async () => {
    const { stored } = await runTurn(new FakeAgentAdapter("rich"), fakeMarker("subagent-tree", "fail"), "spawn");
    const general = nodeBy(treeOf(foldTaskEvents(stored, [])), FAKE_SUBAGENT_TREE.general.description);
    expect(general).toMatchObject({ state: "failed", error: FAKE_SUBAGENT_TREE.error });
  }, 60_000);

  it("F-138: OpenCode's recorded child-session updates become the tree: two subagents with their parents, types, prompts, states, calls and answers (run B)", async () => {
    const run = await readRecordedRun("B");
    const replay = replayAgent(run);
    try {
      const { stored } = await runTurn(new OpenCodeAdapter({ driver: createAcpDriver({ treeSnapshotMs: 0, idlePollMs: 20, wakeGraceMs: 50 }) }), "[[stub:b-child-updates]]", replay.io);
      const messages = foldTaskEvents(stored, []);
      const tree = treeOf(messages);
      expect(tree?.nodes.map((node) => [node.id, node.parentId, node.depth, node.type, node.description, node.state, node.callCount])).toEqual([
        ["ses_e06a599a2ffe3roTxdrHlkdnL1", null, 1, "general", "inspect readme", "done", 2],
        ["ses_e06a599a1ffermAEZkQ7r0u902", null, 1, "explore", "find the version", "done", 2],
      ]);
      expect(nodeBy(tree, "inspect readme")?.rounds[0]).toMatchObject({ prompt: "[[stub:sa-child]] look at README.md", answer: "child answer: the README says hello", toolCallId: "toolu_1ad4175f_0" });
      expect(nodeBy(tree, "find the version")?.rounds[0]?.answer).toBe("explore answer: version is 1.0.0");
      // The thread: the main agent's two `subagent` calls, its shell call, and its own answer only.
      expect(threadCalls(messages)).toEqual(["toolu_1ad4175f_0", "toolu_1ad4175f_1", "toolu_c4d7eca0_0"]);
      expect(threadTexts(messages)).toEqual(["parent done at step 2"]);
    } finally {
      replay.close();
    }
  }, 60_000);

  it("F-138: OpenCode's recorded subagent that outlives its prompt keeps reporting into the tree until it's done, and the agent's wake-up stays its own (run D)", async () => {
    const run = await readRecordedRun("D");
    const replay = replayAgent(run);
    try {
      const { stored } = await runTurn(new OpenCodeAdapter({ driver: createAcpDriver({ treeSnapshotMs: 0, idlePollMs: 20, wakeGraceMs: 50 }) }), "[[stub:d-bg]]", replay.io);
      const messages = foldTaskEvents(stored, []);
      expect(treeOf(messages)?.nodes.map((node) => [node.description, node.state, node.callCount, node.rounds[0]?.answer])).toEqual([["slow child", "done", 1, "slow child done"]]);
      expect(threadTexts(messages)).toEqual(["launched a subagent, ending my turn", "parent woken at step 2"]);
    } finally {
      replay.close();
    }
  }, 60_000);

  it("F-138: OpenCode's recorded approval inside a subagent names it (run I, without the extension: by the child's own meta)", async () => {
    const run = await readRecordedRun("I");
    const replay = replayAgent(run);
    try {
      const { stored, permissions } = await runTurn(new OpenCodeAdapter({ driver: createAcpDriver({ treeSnapshotMs: 0, idlePollMs: 20, wakeGraceMs: 50 }) }), "[[stub:i-asks]]", replay.io);
      expect(permissions.map((request) => [request.toolCallId, request.subagentId ?? null])).toEqual([
        ["toolu_2b19817e_0", null],
        ["toolu_fca31dc8_0", null],
        ["ses_e06a1a9bdffe6pqynSO93G9xg9:toolu_d019a455_0", "ses_e06a1a9bdffe6pqynSO93G9xg9"],
      ]);
      const tree = treeOf(foldTaskEvents(stored, []));
      // OpenCode reports no state without the extension: once the turn is over, it answered, so it's done.
      expect(tree?.nodes.map((node) => [node.id, node.type, node.state, node.callCount])).toEqual([["ses_e06a1a9bdffe6pqynSO93G9xg9", "general", "done", 2]]);
    } finally {
      replay.close();
    }
  }, 60_000);

  it("F-138: OpenCode against the stub model: its explore and general subagents become the tree, with their calls and answers out of the thread", async () => {
    const brain = createScenarioBrain({
      "two-subagents": ({ step }) => {
        if (step === 0) {
          return {
            toolCalls: [
              { name: "subagent", arguments: { agent: "explore", description: "Find the version source", prompt: `${stubMarker("sub-explore")} Find where the version is read.` } },
              { name: "subagent", arguments: { agent: "general", description: "Check the shell", prompt: `${stubMarker("sub-general")} Run a command and say it ran.` } },
            ],
          };
        }
        return step === 1 ? { text: "Two subagents are on it." } : { text: "Both subagents reported back." };
      },
      "sub-explore": ({ step }) => (step === 0 ? { toolCalls: [{ name: "read", arguments: { path: "README.md" } }] } : step === 1 ? { text: "explore answer: the README says hello" } : undefined),
      "sub-general": ({ step }) =>
        step === 0 ? { toolCalls: [{ name: "shell", arguments: { command: `node -e "console.log('general-ok')"`, description: "say ok" } }] } : step === 1 ? { text: "general answer: it ran" } : undefined,
    });
    const stub = await startStubModelServer({ format: "openai-compatible", realKey: "ostra-fake-key-for-this-task", models: ["stub-model"], brain });
    servers.push(stub);
    const { stored } = await runTurn(new OpenCodeAdapter(), `${stubMarker("two-subagents")} have two subagents look`, "spawn", stub.baseUrl);
    const messages = foldTaskEvents(stored, []);
    const tree = treeOf(messages);
    expect(tree?.nodes.map((node) => [node.description, node.type, node.parentId, node.depth, node.state]).sort()).toEqual([
      ["Check the shell", "general", null, 1, "done"],
      ["Find the version source", "explore", null, 1, "done"],
    ]);
    const explore = nodeBy(tree, "Find the version source");
    const general = nodeBy(tree, "Check the shell");
    expect(explore?.rounds[0]?.prompt).toContain("Find where the version is read.");
    expect(explore?.rounds[0]?.calls.map((part) => part.type)).toEqual(["tool-read"]);
    expect(explore?.rounds[0]?.answer).toBe("explore answer: the README says hello");
    expect(general?.rounds[0]?.calls.map((part) => part.type)).toEqual(["tool-execute"]);
    expect(general?.rounds[0]?.answer).toBe("general answer: it ran");
    // The thread: the main agent's own two calls and its words; neither answer, neither call.
    const texts = threadTexts(messages);
    expect(texts).toContain("Two subagents are on it.");
    expect(texts.some((text) => text.includes("explore answer") || text.includes("general answer"))).toBe(false);
    expect(lastTurn(messages)?.parts.filter((part) => "toolCallId" in part)).toHaveLength(2);
  }, 180_000);
});
