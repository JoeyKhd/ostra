import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentSession, PrepareLaunchInput } from "@ostra/adapter-sdk";
import {
  createScenarioBrain,
  defineAgentContractSuite,
  FakeAgentAdapter,
  fakeMarker,
  runAgentCommand,
  spawnAgentProcess,
  startStubModelServer,
  stubMarker,
} from "@ostra/adapter-sdk/testing";
import type { AgentFixture, StubServer } from "@ostra/adapter-sdk/testing";
import { turnIdSchema } from "@ostra/protocol";
import type { ApiFormat, TaskEvent } from "@ostra/protocol";
import { fixtureIds } from "@ostra/protocol/testing";
import { afterAll, describe, expect, it } from "vitest";

import { OpenCodeAdapter } from "./opencode-adapter.ts";
import { scenarios } from "./stub-scenarios.ts";

// The agent contract suite against the real OpenCode binary, once per API format, with a stub
// model standing where the key proxy would. The stub takes the task's own key.

const TASK_KEY = "ostra-fake-key-for-this-task";
const MODEL = "stub-model";

const roots: string[] = [];
const servers: StubServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const fixtureFor = async (format: ApiFormat): Promise<AgentFixture> => {
  const stub = await startStubModelServer({
    format,
    realKey: TASK_KEY,
    models: [MODEL],
    brain: createScenarioBrain(scenarios),
  });
  servers.push(stub);
  const root = await mkdtemp(path.join(tmpdir(), "ostra-opencode-"));
  roots.push(root);
  const workspaceDir = path.join(root, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(path.join(workspaceDir, "README.md"), "hello\n", "utf8");
  const launchInput = {
    taskId: fixtureIds.task,
    sessionId: fixtureIds.session,
    workspaceDir,
    agentDir: path.join(root, "agent"),
    model: { endpointModelId: MODEL, apiFormat: format, baseUrl: stub.baseUrl, placeholderKey: TASK_KEY },
    mcp: { url: "http://127.0.0.1:9/mcp" },
    instructions: null,
    extraEnv: {},
  } satisfies PrepareLaunchInput;
  let boxes = 0;
  return {
    launchInput,
    secrets: ["the-real-model-token", "the-real-git-token", "ghs_realtokenvalue0123456789"],
    start: spawnAgentProcess,
    simplePrompt: `${stubMarker("hello")} say hello`,
    longPrompt: `${stubMarker("long")} wait`,
    // ADR 0039: the session moves to a fresh box (a new agent folder and workspace), as the runner does it.
    archive: {
      run: runAgentCommand,
      freshBox: async () => {
        boxes += 1;
        const box = path.join(root, `fresh-${String(boxes)}`);
        const freshWorkspace = path.join(box, "workspace");
        await mkdir(freshWorkspace, { recursive: true });
        await writeFile(path.join(freshWorkspace, "README.md"), "hello\n", "utf8");
        return { ...launchInput, agentDir: path.join(box, "agent"), workspaceDir: freshWorkspace };
      },
      archivePath: path.join(root, "session-archive.json"),
      remember: {
        prompt: `${stubMarker("remember")} The project codename is ospreyabc123.`,
        recall: `${stubMarker("recall")} What was the codename?`,
        fact: "ospreyabc123",
      },
    },
    probes: {
      tools: { prompt: `${stubMarker("tools")} work`, kinds: ["read", "edit", "execute"], expectFailure: true },
      // OpenCode plans through its todo tool, without declaring a native plan.
      plan: { prompt: `${stubMarker("todo")} plan`, expectPlan: true },
      steerable: {
        prompt: `${stubMarker("steer")} wait`,
        waitFor: "never appears",
        steerText: "STEER-TOKEN: also mention the colour blue",
        expectMessage: "steer seen mid-turn",
      },
    },
  };
};

describe.each(["openai-compatible", "anthropic-messages"] as const)("OpenCode, %s stub", (format) => {
  defineAgentContractSuite({
    name: `opencode against a ${format} stub`,
    create: async () => ({ adapter: new OpenCodeAdapter(), fixture: await fixtureFor(format) }),
  });
});

// F-019's own cases, against the pinned binary: what the contract suite checks for every agent,
// said for OpenCode, so the proof ledger (context/proof/F-019.md) can name them.

const turnOf = (n: number) => turnIdSchema.parse(`f019-turn-${String(n)}`);

type Opened = {
  readonly adapter: OpenCodeAdapter;
  readonly session: AgentSession;
  readonly events: TaskEvent[];
  readonly stop: () => Promise<void>;
};

/** Starts a session on the pinned OpenCode against a stub, the way the runner does. */
const openOpenCode = async (format: ApiFormat): Promise<Opened> => {
  const adapter = new OpenCodeAdapter();
  const fixture = await fixtureFor(format);
  const launch = await adapter.prepareLaunch(fixture.launchInput);
  if (!launch.ok) throw new Error(launch.error.message);
  const started = await fixture.start(launch.value);
  const events: TaskEvent[] = [];
  const session = await adapter.startSession({
    taskId: fixture.launchInput.taskId,
    sessionId: fixture.launchInput.sessionId,
    io: started.io,
    cwd: fixture.launchInput.workspaceDir,
    mcpServers: [],
    onEvents: (batch) => {
      events.push(...batch);
    },
    onPermission: () => Promise.resolve({ outcome: "cancelled" }),
    onQuestion: () => Promise.resolve({ outcome: "cancelled" }),
  });
  if (!session.ok) {
    await started.stop();
    throw new Error(session.error.message);
  }
  return {
    adapter,
    session: session.value,
    events,
    stop: async () => {
      await adapter.close(session.value);
      await started.stop();
    },
  };
};

const messageText = (events: readonly TaskEvent[]): string =>
  events.flatMap((event) => (event.kind === "agent.message" ? [event.text] : [])).join("");

describe("F-019 on the pinned OpenCode", () => {
  it("F-019: OpenCode runs a turn over ostra's ACP driver, and its initialize advertises steering, so a steer mid-turn reaches its next model call", async () => {
    const opened = await openOpenCode("anthropic-messages");
    try {
      expect(opened.adapter.name).toBe("opencode");
      expect(opened.session.connection.steeringAdvertised).toBe(true);
      const turn = opened.adapter.prompt(opened.session, turnOf(1), `${stubMarker("steer")} wait`);
      // The steer goes in while the long shell step runs.
      const until = Date.now() + 60_000;
      while (!opened.events.some((event) => event.kind === "tool.called") && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await opened.adapter.steer(opened.session, "STEER-TOKEN: also mention the colour blue")).toEqual({ ok: true, value: undefined });
      expect(await turn).toEqual({ ok: true, value: { stopReason: "end_turn" } });
      expect(messageText(opened.events)).toContain("steer seen mid-turn");
      expect(opened.events[0]).toEqual({ kind: "turn.started", turnId: turnOf(1) });
      expect(opened.events.at(-1)).toEqual({ kind: "turn.ended", turnId: turnOf(1), stopReason: "end_turn" });
    } finally {
      await opened.stop();
    }
  }, 120_000);

  it("F-019: the OpenCode adapter refuses a steer, as unsupported, on an agent whose initialize doesn't advertise steering", async () => {
    // The plain fake ACP agent answers `initialize` without `_meta.steering`; OpenCode's adapter
    // drives it, so the check that refuses is the one OpenCode's sessions go through.
    const root = await mkdtemp(path.join(tmpdir(), "ostra-opencode-plain-"));
    roots.push(root);
    const input = {
      taskId: fixtureIds.task,
      sessionId: fixtureIds.session,
      workspaceDir: path.join(root, "workspace"),
      agentDir: path.join(root, "agent"),
      model: { endpointModelId: MODEL, apiFormat: "openai-compatible" as const, baseUrl: "http://127.0.0.1:9/v1", placeholderKey: TASK_KEY },
      mcp: { url: "http://127.0.0.1:9/mcp" },
      instructions: null,
      extraEnv: {},
    };
    await mkdir(input.workspaceDir, { recursive: true });
    await mkdir(path.join(input.agentDir, "tmp"), { recursive: true });
    const launch = await new FakeAgentAdapter("plain").prepareLaunch(input);
    if (!launch.ok) throw new Error(launch.error.message);
    const started = await spawnAgentProcess(launch.value);
    const adapter = new OpenCodeAdapter();
    const session = await adapter.startSession({
      taskId: input.taskId,
      sessionId: input.sessionId,
      io: started.io,
      cwd: input.workspaceDir,
      mcpServers: [],
      onEvents: () => undefined,
      onPermission: () => Promise.resolve({ outcome: "cancelled" }),
      onQuestion: () => Promise.resolve({ outcome: "cancelled" }),
    });
    try {
      if (!session.ok) throw new Error(session.error.message);
      expect(adapter.capabilities.steerMidTurn).toBe(true);
      expect(session.value.connection.steeringAdvertised).toBe(false);
      const turn = adapter.prompt(session.value, turnOf(2), fakeMarker("silent"));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await adapter.steer(session.value, "use tabs")).toMatchObject({ ok: false, error: { code: "unsupported" } });
      await adapter.cancel(session.value);
      expect(await turn).toEqual({ ok: true, value: { stopReason: "cancelled" } });
    } finally {
      if (session.ok) await adapter.close(session.value);
      await started.stop();
    }
  }, 60_000);

  it("F-019: OpenCode's todowrite call reaches ostra as plan.updated, mapped inside the adapter, and never as a tool row", async () => {
    const opened = await openOpenCode("openai-compatible");
    try {
      expect(opened.adapter.capabilities.nativePlan).toBe(false);
      expect(await opened.adapter.prompt(opened.session, turnOf(3), `${stubMarker("todo")} plan`)).toEqual({ ok: true, value: { stopReason: "end_turn" } });
      const plans = opened.events.flatMap((event) => (event.kind === "plan.updated" ? [event] : []));
      expect(plans.length).toBeGreaterThanOrEqual(1);
      expect(plans[0]?.entries).toEqual([
        { content: "Read README.md", priority: "medium", status: "in_progress" },
        { content: "Edit README.md", priority: "medium", status: "pending" },
      ]);
      const calls = opened.events.flatMap((event) => (event.kind === "tool.called" ? [event] : []));
      expect(calls.filter((call) => call.title.toLowerCase().includes("todo"))).toEqual([]);
      expect(messageText(opened.events)).toContain("todo written");
    } finally {
      await opened.stop();
    }
  }, 60_000);
});
