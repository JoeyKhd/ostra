import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { OpenCodeAdapter } from "@ostra/adapter-opencode";
import type { AgentAdapter } from "@ostra/adapter-sdk";
import { createScenarioBrain, FakeAgentAdapter, fakeMarker, spawnAgentProcess, startStubModelServer, stubMarker } from "@ostra/adapter-sdk/testing";
import type { StubServer } from "@ostra/adapter-sdk/testing";
import { clientMessageIdSchema, storedEventSchema, turnIdSchema } from "@ostra/protocol";
import type { StoredEvent, TaskEvent } from "@ostra/protocol";
import { fixtureIds } from "@ostra/protocol/testing";
import { afterAll, describe, expect, it } from "vitest";

import { foldTaskEvents } from "./fold.ts";
import type { TaskUIMessage } from "./ui-types.ts";

// F-023, "the same for every agent": the task page folds the stored events, whichever agent wrote
// them. Each agent here runs a turn with tool calls through its own adapter and ostra's ACP driver
// (the pinned OpenCode against a stub model, and both profiles of the scripted fake ACP agent), and
// the same fold gives the same kinds of rows: the agent's message, its reads, edits and commands,
// and each edit's files.

const TASK_KEY = "ostra-fake-key-for-this-task";
const MODEL = "stub-model";
const roots: string[] = [];
const servers: StubServer[] = [];

afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));
});

/** OpenCode's turn, from @ostra/adapter-opencode's stub scenarios: a read, an edit, a command, a failing read, then text. */
const openCodeTools = createScenarioBrain({
  tools: ({ step }) => {
    switch (step) {
      case 0:
        return { toolCalls: [{ name: "read", arguments: { path: "README.md" } }] };
      case 1:
        return { toolCalls: [{ name: "edit", arguments: { path: "README.md", oldString: "hello", newString: "hello, tools" } }] };
      case 2:
        return { toolCalls: [{ name: "shell", arguments: { command: `node -e "console.log('shell-ok')"`, description: "say ok" } }] };
      case 3:
        return { toolCalls: [{ name: "read", arguments: { path: "does-not-exist.txt" } }] };
      case 4:
        return { text: "tools done" };
      default:
        return undefined;
    }
  },
});

type Agent = {
  readonly name: string;
  readonly adapter: () => Promise<AgentAdapter>;
  readonly baseUrl: () => Promise<string>;
  readonly prompt: string;
  readonly editedPath: string;
};

const agents: readonly Agent[] = [
  {
    name: "OpenCode",
    adapter: () => Promise.resolve(new OpenCodeAdapter()),
    baseUrl: async () => {
      const stub = await startStubModelServer({ format: "openai-compatible", realKey: TASK_KEY, models: [MODEL], brain: openCodeTools });
      servers.push(stub);
      return stub.baseUrl;
    },
    prompt: `${stubMarker("tools")} work`,
    editedPath: "README.md",
  },
  ...(["rich", "plain"] as const).map((profile) => ({
    name: `the fake ACP agent, ${profile}`,
    adapter: () => Promise.resolve(new FakeAgentAdapter(profile)),
    baseUrl: () => Promise.resolve("http://127.0.0.1:9/v1"),
    prompt: fakeMarker("tools"),
    editedPath: "src/a.ts",
  })),
];

const turnId = turnIdSchema.parse("every-agent-turn-1");

/** Runs one turn on the agent, as the runner would, and stores its events as core does: numbered per task. */
const runTurn = async (agent: Agent): Promise<readonly StoredEvent[]> => {
  const root = await mkdtemp(path.join(tmpdir(), "ostra-every-agent-"));
  roots.push(root);
  const workspaceDir = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(path.join(agentDir, "tmp"), { recursive: true });
  await writeFile(path.join(workspaceDir, "README.md"), "hello\n", "utf8");
  const adapter = await agent.adapter();
  const launch = await adapter.prepareLaunch({
    taskId: fixtureIds.task,
    sessionId: fixtureIds.session,
    workspaceDir,
    agentDir,
    model: { endpointModelId: MODEL, apiFormat: "openai-compatible", baseUrl: await agent.baseUrl(), placeholderKey: TASK_KEY },
    mcp: { url: "http://127.0.0.1:9/mcp" },
    instructions: null,
    extraEnv: {},
  });
  if (!launch.ok) throw new Error(launch.error.message);
  const started = await spawnAgentProcess(launch.value);
  const events: TaskEvent[] = [
    { kind: "user.message", memberId: fixtureIds.member, clientMessageId: clientMessageIdSchema.parse("every-agent-1"), text: agent.prompt, delivery: "immediate" },
  ];
  const session = await adapter.startSession({
    taskId: fixtureIds.task,
    sessionId: fixtureIds.session,
    io: started.io,
    cwd: workspaceDir,
    mcpServers: [],
    onEvents: (batch) => {
      events.push(...batch);
    },
    onPermission: () => Promise.resolve({ outcome: "cancelled" }),
    onQuestion: () => Promise.resolve({ outcome: "cancelled" }),
  });
  try {
    if (!session.ok) throw new Error(session.error.message);
    const result = await adapter.prompt(session.value, turnId, agent.prompt);
    expect(result).toEqual({ ok: true, value: { stopReason: "end_turn" } });
    await adapter.close(session.value);
  } finally {
    await started.stop();
  }
  return events.map((event, i) =>
    storedEventSchema.parse({ taskId: fixtureIds.task, seq: i + 1, sessionId: fixtureIds.session, sessionSeq: event.kind === "user.message" ? null : i, at: 1_795_000_000_000 + i, event }),
  );
};

const partsOf = (messages: readonly TaskUIMessage[]) => messages.flatMap((message) => message.parts);

describe("the task page's fold, for every agent (F-023)", () => {
  it.each(agents)("F-023: $name's turn folds into the same rows: its message, its reads, edits and commands, and the edit's files", async (agent) => {
    const stored = await runTurn(agent);
    const parts = partsOf(foldTaskEvents(stored, []));
    const types = new Set(parts.map((part) => part.type));

    expect(parts.filter((part) => part.type === "data-problem")).toEqual([]);
    for (const type of ["text", "tool-read", "tool-edit", "tool-execute"] as const) {
      expect(types.has(type), `a ${type} row`).toBe(true);
    }
    // Every call the agent made has its row; nothing is dropped.
    const calls = stored.filter((item) => item.event.kind === "tool.called").length;
    expect(parts.filter((part) => part.type.startsWith("tool-") || part.type === "dynamic-tool")).toHaveLength(calls);
    // The member's prompt and the agent's own message are both in the thread.
    const texts = parts.flatMap((part) => (part.type === "text" ? [part.text] : []));
    expect(texts).toContain(agent.prompt);
    expect(texts.length).toBeGreaterThanOrEqual(2);
    // The file change: the edit, finished, naming the file it changed.
    const edit = parts.find((part) => part.type === "tool-edit");
    const files = edit?.type === "tool-edit" && edit.state === "output-available" ? edit.output.files.map((file) => file.path) : [];
    expect(files).toContain(agent.editedPath);
    // A failing read shows as an error row, not as a success.
    expect(parts.some((part) => part.type === "tool-read" && part.state === "output-error")).toBe(true);
  }, 120_000);
});
