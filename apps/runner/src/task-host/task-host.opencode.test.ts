import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HostExecutor } from "@ostra/adapter-executor-host";
import { createLogger, silentLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { createScenarioBrain, startAnthropicStub, startGitUpstream, stubMarker } from "@ostra/adapter-sdk/testing";
import type { GitUpstream, StubServer } from "@ostra/adapter-sdk/testing";
import { boxIdSchema, runnerIdSchema, sessionIdSchema, taskCredentialsSchema, taskIdSchema } from "@ostra/protocol";
import type { RunnerEvent, TaskEvent, TaskSpec } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { startConnection } from "../connection/peer.ts";
import type { RunnerConnection } from "../connection/peer.ts";
import { makeCommand, startFakeGateway } from "../testing/fake-gateway.ts";
import type { FakeGateway } from "../testing/fake-gateway.ts";
import { startFakeServer } from "../testing/fake-server.ts";
import type { FakeServer } from "../testing/fake-server.ts";
import { defaultAgents } from "./agents.ts";
import { runnerServerLink } from "./server-link.ts";
import { createTaskHost } from "./task-host.ts";
import type { TaskHost } from "./task-host.ts";

// The task host with OpenCode instead of the fake agent (ticket 21): the real, pinned binary, with
// a stub model behind the real key proxy, editing a repo checked out through the real git proxy.
// And, with `model.env` loaded, one real turn on the development endpoint (gated).

const runnerId = runnerIdSchema.parse("runner-opencode");
const ACCESS_TOKEN = "ostra-runner-opencode-access-token";
const GIT_TOKEN = "ghs_realGitTokenForTheOpenCodeTaskHostTest01";
const MCP_TOKEN = "ostra-mcp-real-runner-mcp-token-opencode-01";
const STUB_TOKEN = "sk-real-model-token-for-the-opencode-run";

const liveEnv = z
  .object({ OSTRA_DEV_MODEL_BASE_URL: z.url(), OSTRA_DEV_MODEL_API_KEY: z.string().min(1), OSTRA_DEV_MODEL_ID: z.string().min(1) })
  .safeParse(process.env);

type Harness = {
  readonly server: FakeServer;
  readonly gateway: FakeGateway;
  readonly host: TaskHost;
  readonly connection: RunnerConnection;
  readonly logs: LogRecord[];
  readonly close: () => Promise<void>;
};

let root = "";
let upstream: GitUpstream;
let stub: StubServer;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ostra-task-host-opencode-"));
  upstream = await startGitUpstream(path.join(root, "upstream"));
  await upstream.createRepo("ostra-test/test1", { "README.md": "# test1\n\nhello\n" });
  upstream.tokens.set(GIT_TOKEN, Date.now() + 3_600_000);
  stub = await startAnthropicStub({
    realKey: STUB_TOKEN,
    models: ["stub-model"],
    brain: createScenarioBrain({
      // An edit of the repo's README, then text.
      "edit-readme": ({ step }) => {
        if (step === 0) {
          return { toolCalls: [{ name: "edit", arguments: { path: "README.md", oldString: "hello", newString: "hello, from OpenCode" } }] };
        }
        return step === 1 ? { text: "The README is edited." } : undefined;
      },
      // A subagent (OpenCode's `subagent` tool, which always runs it in the background), then a
      // wait long enough for it to report back, then text.
      "with-subagent": ({ step }) => {
        if (step === 0) {
          return { toolCalls: [{ name: "subagent", arguments: { agent: "general", description: "read the readme", prompt: `${stubMarker("subagent-reads")} Read README.md.` } }] };
        }
        if (step === 1) {
          return { toolCalls: [{ name: "shell", arguments: { command: `node -e "setTimeout(()=>{},8000)"`, timeout: 60_000, description: "wait for the subagent" } }] };
        }
        return step === 2 ? { text: "The subagent read the README." } : undefined;
      },
      // The subagent's own calls: a read, then its answer.
      "subagent-reads": ({ step }) => {
        if (step === 0) {
          return { toolCalls: [{ name: "read", arguments: { path: "README.md" } }] };
        }
        return step === 1 ? { text: "The README says hello." } : undefined;
      },
      // Subagents (2026-11-20): a subagent, then the turn ended as OpenCode tells the agent to;
      // the subagent's report wakes the agent, which gives its real answer.
      "bg-subagent": ({ step, args }) => {
        if (step === 0) {
          const child = args === "hang" ? stubMarker("loop-child") : stubMarker("bg-child");
          return { toolCalls: [{ name: "subagent", arguments: { agent: "general", description: "read the readme", prompt: `${child} Read README.md.` } }] };
        }
        if (step === 1) {
          return { text: "launched a subagent, ending my turn" };
        }
        return step === 2 ? { text: "the final answer, after the subagent" } : undefined;
      },
      // A subagent's work, a few seconds long, then its answer.
      "bg-child": ({ step }) => {
        if (step === 0) {
          return { toolCalls: [{ name: "shell", arguments: { command: `node -e "setTimeout(()=>{},4000)"`, timeout: 60_000, description: "work" } }] };
        }
        return step === 1 ? { text: "child answer: the README says hello" } : undefined;
      },
      // A subagent that never ends: a short wait at every step, each one a model call.
      "loop-child": ({ step }) => ({ toolCalls: [{ name: "shell", arguments: { command: `node -e "setTimeout(()=>{},1500)"`, timeout: 60_000, description: `wait ${String(step)}` } }] }),
      // OpenCode's read-only explore subagent, which tries to change the repo.
      "explore-subagent": ({ step }) => {
        if (step === 0) {
          return { toolCalls: [{ name: "subagent", arguments: { agent: "explore", description: "look around", prompt: `${stubMarker("explore-tries")} Look at README.md.` } }] };
        }
        if (step === 1) {
          return { text: "launched explore, ending my turn" };
        }
        return step === 2 ? { text: "explore reported back" } : undefined;
      },
      // Explore's own calls: an edit of the README, then a file written through the shell, then what each did.
      "explore-tries": ({ step, since }) => {
        if (step === 0) {
          return { toolCalls: [{ name: "edit", arguments: { path: "README.md", oldString: "hello", newString: "changed by explore" } }] };
        }
        if (step === 1) {
          return { toolCalls: [{ name: "shell", arguments: { command: `node -e "require('fs').writeFileSync('explore-wrote.txt','x')"`, timeout: 60_000, description: "write a file" } }] };
        }
        if (step === 2) {
          const results = since.filter((message) => message.role === "tool");
          return { text: `explore results: ${results.map((result) => (result.isError ? "error" : "ok")).join(",")}` };
        }
        return undefined;
      },
    }),
  });
}, 60_000);

afterAll(async () => {
  await stub.close();
  await upstream.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const harness = async (name: string, options: { readonly subagentWaitMs?: number } = {}): Promise<Harness> => {
  const dataDir = path.join(root, `runner-${name}`);
  const server = await startFakeServer();
  server.accessTokens.set(ACCESS_TOKEN, runnerId);
  const gateway = startFakeGateway(server);
  const tokens = { get: () => Promise.resolve({ ok: true as const, token: ACCESS_TOKEN, expiresAt: Date.now() + 600_000 }), invalidate: () => undefined };
  const holder: { connection: RunnerConnection | undefined } = { connection: undefined };
  const logs: LogRecord[] = [];
  const logger = createLogger((record) => logs.push(record));
  const host = createTaskHost({
    link: runnerServerLink({
      serverUrl: server.url,
      tokens,
      connection: {
        openSession: (ref) => {
          if (holder.connection === undefined) {
            throw new Error("not connected");
          }
          return holder.connection.openSession(ref);
        },
        statusChanged: () => {
          holder.connection?.statusChanged();
        },
      },
    }),
    executor: new HostExecutor({ dataDir }, { logger, clock: { now: () => Date.now() } }),
    // What the runner ships (ADR 0032): OpenCode, over ostra's ACP driver.
    agents: defaultAgents(),
    logger,
    listenHost: "127.0.0.1",
    stopGraceMs: 2_000,
    ...(options.subagentWaitMs === undefined ? {} : { subagentWaitMs: options.subagentWaitMs }),
    capacity: 1,
    executorKind: "host",
    labels: [],
    gitUpstreamUrl: (cloneUrl) => cloneUrl.replace("https://github.com", upstream.origin),
  });
  const connection = await startConnection({
    serverUrl: server.url,
    peer: { kind: "runner", runnerId },
    tokens,
    dataDir,
    handlers: host.handlers,
    status: host.status,
    logger: silentLogger,
    timers: { backoffMinMs: 5, backoffMaxMs: 20, checkMs: 10, liveTextIntervalMs: 50 },
  });
  holder.connection = connection;
  await gateway.waitFor(() => gateway.connected());
  return {
    server,
    gateway,
    host,
    connection,
    logs,
    close: async () => {
      await host.shutdown();
      await connection.stop();
      await gateway.close();
      await server.close();
    },
  };
};

const dispatchTask = (h: Harness, name: string, prompt: string, model: { readonly baseUrl: string; readonly token: string; readonly endpointModelId: string }): TaskSpec => {
  const taskId = taskIdSchema.parse(`0196f1a0-opencode-${name}-${String(Date.now())}`);
  const spec: TaskSpec = {
    ...taskSpecFixture,
    taskId,
    sessionId: sessionIdSchema.parse(`session-opencode-${name}-${String(Date.now())}`),
    branchName: `ostra/opencode-${name}`,
    prompt,
    title: "Edit the README",
    agent: { ...taskSpecFixture.agent, adapter: "opencode", apiFormat: "anthropic-messages", endpointModelId: model.endpointModelId },
    environment: { ...taskSpecFixture.environment, setupScript: null },
    limits: { turnMaxMinutes: 5 },
  };
  h.server.tasks.set(taskId, {
    spec,
    credentials: taskCredentialsSchema.parse({
      taskId,
      leaseEpoch: spec.leaseEpoch,
      model: { baseUrl: model.baseUrl, apiFormat: "anthropic-messages", authScheme: "x-api-key", token: model.token },
      repos: spec.repos.map((repo) => ({ repoId: repo.repoId, gitToken: GIT_TOKEN, expiresAt: Date.now() + 3_600_000 })),
      secrets: [],
      mcpToken: MCP_TOKEN,
    }),
  });
  h.gateway.sendCommand(
    makeCommand({
      seq: 1,
      id: `dispatch-${name}`,
      notAfter: Date.now() + 120_000,
      kind: "dispatch",
      body: { taskId, sessionId: spec.sessionId, boxId: boxIdSchema.parse(`box-${name}`), leaseEpoch: spec.leaseEpoch },
    }),
  );
  return spec;
};

const eventsOf = (h: Harness, spec: TaskSpec): readonly RunnerEvent[] =>
  [...(h.gateway.stored.get(spec.sessionId)?.values() ?? [])].sort((a, b) => a.sessionSeq - b.sessionSeq);
const kindsOf = (h: Harness, spec: TaskSpec): readonly TaskEvent["kind"][] => eventsOf(h, spec).map((item) => item.event.kind);

/** The stub's calls made by a subagent: OpenCode opens each subagent's conversation with this line. */
const subagentCallsOf = (calls: StubServer["calls"]): StubServer["calls"] =>
  calls.filter((call) => call.messages.some((message) => message.role === "user" && message.text.includes("You are a subagent spawned by another session.")));

/** Each `agent.message`'s text, with the event's place among the session's events. */
const messagesOf = (h: Harness, spec: TaskSpec): readonly { readonly seq: number; readonly turnId: string; readonly text: string }[] =>
  eventsOf(h, spec).flatMap((item) => (item.event.kind === "agent.message" ? [{ seq: item.sessionSeq, turnId: item.event.turnId, text: item.event.text }] : []));

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe("the task host with OpenCode", () => {
  it("F-019/c1: runs a task on OpenCode, the agent the runner ships, over ostra's ACP driver: it edits the repo through the proxies and leaves a PR-ready branch, counting the model's tokens", async () => {
    const h = await harness("stub");
    try {
      const spec = dispatchTask(h, "stub", `${stubMarker("edit-readme")} Edit the README.`, { baseUrl: stub.baseUrl, token: STUB_TOKEN, endpointModelId: "stub-model" });
      await h.gateway.waitFor(() => kindsOf(h, spec).includes("session.ended") || kindsOf(h, spec).includes("session.crashed"), 150_000);
      const kinds = kindsOf(h, spec);
      expect(kinds, JSON.stringify(eventsOf(h, spec).filter((item) => item.event.kind === "session.crashed"))).toContain("session.ended");
      expect(kinds).toContain("tool.called");
      expect(kinds).toContain("usage.recorded");
      const ended = eventsOf(h, spec).find((item) => item.event.kind === "session.ended")?.event;
      expect(ended).toMatchObject({ outcome: "with-changes" });
      expect(await upstream.fileAt("ostra-test/test1", `refs/heads/${spec.branchName}`, "README.md")).toContain("hello, from OpenCode");
      const usage = eventsOf(h, spec).flatMap((item) => (item.event.kind === "usage.recorded" ? [item.event] : []));
      const billed = stub.calls.flatMap((call) => (call.billed === undefined ? [] : [call.billed]));
      expect(usage.reduce((sum, event) => sum + event.inputTokens + event.cacheReadTokens, 0)).toBe(
        billed.reduce((sum, item) => sum + item.inputTokens + item.cacheReadTokens, 0),
      );
      const everything = JSON.stringify([eventsOf(h, spec), h.logs]);
      for (const secret of [STUB_TOKEN, GIT_TOKEN, MCP_TOKEN]) {
        expect(everything.includes(secret)).toBe(false);
      }
    } finally {
      await h.close();
    }
  }, 180_000);

  it("F-089/c7, F-084/c1: a subagent's model calls go through the key proxy, and each one is counted", async () => {
    const h = await harness("subagent");
    const before = stub.calls.length;
    try {
      const spec = dispatchTask(h, "subagent", `${stubMarker("with-subagent")} Have a subagent read the README.`, { baseUrl: stub.baseUrl, token: STUB_TOKEN, endpointModelId: "stub-model" });
      await h.gateway.waitFor(() => kindsOf(h, spec).includes("session.ended") || kindsOf(h, spec).includes("session.crashed"), 150_000);
      expect(kindsOf(h, spec)).toContain("session.ended");
      const calls = stub.calls.slice(before);
      // OpenCode starts a subagent with its own first message; its calls are told apart by it.
      const subagentCalls = calls.filter((call) => call.messages.some((message) => message.role === "user" && message.text.includes("You are a subagent spawned by another session.")));
      expect(subagentCalls.length, "the subagent's read and its answer").toBeGreaterThanOrEqual(2);
      expect(subagentCalls.every((call) => call.authOk && call.billed !== undefined), "each answered with the real key, past the proxy").toBe(true);
      // The subagent's work reached the task's events: its read, under the call ID OpenCode prefixes with its session.
      const called = eventsOf(h, spec).flatMap((item) => (item.event.kind === "tool.called" ? [item.event] : []));
      expect(called.some((event) => event.toolCallId.includes(":") && event.toolKind === "read")).toBe(true);
      // Every billed call, the subagent's included, has its `usage.recorded`, and the counts add up.
      const usage = eventsOf(h, spec).flatMap((item) => (item.event.kind === "usage.recorded" ? [item.event] : []));
      const billed = calls.flatMap((call) => (call.billed === undefined ? [] : [call.billed]));
      expect(usage).toHaveLength(billed.length);
      expect(usage.reduce((sum, event) => sum + event.inputTokens + event.cacheReadTokens, 0)).toBe(billed.reduce((sum, item) => sum + item.inputTokens + item.cacheReadTokens, 0));
      expect(usage.reduce((sum, event) => sum + event.outputTokens, 0)).toBe(billed.reduce((sum, item) => sum + item.outputTokens, 0));
      const subagentBilled = subagentCalls.reduce((sum, call) => sum + (call.billed?.inputTokens ?? 0) + (call.billed?.cacheReadTokens ?? 0), 0);
      expect(subagentBilled).toBeGreaterThan(0);
    } finally {
      await h.close();
    }
  }, 180_000);
});

// Subagents (2026-11-20, `research/opencode-subagents.md`): OpenCode 2.3.2 runs each subagent in the
// background and tells the agent to end its turn; the subagent's report wakes the agent later.
describe("the task host with OpenCode's subagents", () => {
  it("F-023/c1, F-138/c5: a task doesn't end while its agent's subagent runs: the agent's answer, woken by the subagent's report, is the turn's", async () => {
    const h = await harness("bg-subagent");
    try {
      const spec = dispatchTask(h, "bg-subagent", `${stubMarker("bg-subagent")} Have a subagent read the README.`, { baseUrl: stub.baseUrl, token: STUB_TOKEN, endpointModelId: "stub-model" });
      await h.gateway.waitFor(() => kindsOf(h, spec).includes("session.ended") || kindsOf(h, spec).includes("session.crashed"), 150_000);
      expect(kindsOf(h, spec), JSON.stringify(eventsOf(h, spec).filter((item) => item.event.kind === "session.crashed"))).toContain("session.ended");
      const events = eventsOf(h, spec);
      const started = events.find((item) => item.event.kind === "turn.started");
      const ended = events.filter((item) => item.event.kind === "turn.ended");
      expect(ended).toHaveLength(1);
      expect(ended[0]?.event).toMatchObject({ kind: "turn.ended", stopReason: "end_turn" });
      const endSeq = ended[0]?.sessionSeq ?? 0;
      const turnId = started?.event.kind === "turn.started" ? started.event.turnId : undefined;
      const messages = messagesOf(h, spec);
      const final = messages.find((message) => message.text.includes("the final answer, after the subagent"));
      // The real answer came, in the turn, before its end; and so did the subagent's own.
      expect(final, JSON.stringify(messages)).toBeDefined();
      expect(final?.turnId).toBe(turnId);
      expect(final?.seq ?? Infinity).toBeLessThan(endSeq);
      const child = messages.find((message) => message.text.includes("child answer: the README says hello"));
      expect(child?.seq ?? Infinity).toBeLessThan(endSeq);
      // Nothing of the turn's comes after its end, and the session ends after it.
      expect(events.filter((item) => item.sessionSeq > endSeq && (item.event.kind === "agent.message" || item.event.kind === "tool.called"))).toEqual([]);
      const sessionEnded = events.find((item) => item.event.kind === "session.ended");
      expect(sessionEnded?.sessionSeq ?? 0).toBeGreaterThan(endSeq);
    } finally {
      await h.close();
    }
  }, 180_000);

  it("F-023/c1: a subagent that never ends ends its turn at the wait's bound: its starting call fails, and the runner logs the bound with IDs only", async () => {
    const waitMs = 6_000;
    const h = await harness("hung-subagent", { subagentWaitMs: waitMs });
    const before = stub.calls.length;
    try {
      const spec = dispatchTask(h, "hung-subagent", `${stubMarker("bg-subagent", "hang")} Have a subagent work.`, { baseUrl: stub.baseUrl, token: STUB_TOKEN, endpointModelId: "stub-model" });
      await h.gateway.waitFor(() => kindsOf(h, spec).includes("session.ended") || kindsOf(h, spec).includes("session.crashed"), 150_000);
      expect(kindsOf(h, spec)).toContain("session.ended");
      const events = eventsOf(h, spec);
      const subagentCall = events.find((item) => item.event.kind === "tool.called" && item.event.title === "subagent");
      const callId = subagentCall?.event.kind === "tool.called" ? subagentCall.event.toolCallId : undefined;
      expect(callId).toBeDefined();
      // The clear event: the call that started the subagent fails, saying why, before the turn's end.
      const failed = events.find((item) => item.event.kind === "tool.failed" && item.event.toolCallId === callId);
      expect(failed?.event).toMatchObject({ kind: "tool.failed", error: "the subagent still ran 6 seconds after its agent's turn was answered, so ostra stopped it" });
      const ended = events.find((item) => item.event.kind === "turn.ended");
      expect(ended?.event).toMatchObject({ stopReason: "end_turn" });
      expect(failed?.sessionSeq ?? Infinity).toBeLessThan(ended?.sessionSeq ?? 0);
      // The bound, logged with the task's IDs and numbers only: no prompt, no answer.
      const logged = h.logs.find((record) => record.message.includes("subagents ran past their wait"));
      expect(logged?.fields).toMatchObject({ subagentWaitMs: waitMs, subagents: 1 });
      expect(JSON.stringify(logged)).not.toMatch(/README|subagent spawned|wait \d/);
      // The subagent was stopped with the turn: it calls the model no more.
      const calls = subagentCallsOf(stub.calls.slice(before)).length;
      expect(calls).toBeGreaterThan(0);
      await pause(4_000);
      expect(subagentCallsOf(stub.calls.slice(before)).length).toBe(calls);
    } finally {
      await h.close();
    }
  }, 180_000);

  it("F-025/c1: a stop while the agent's subagent runs stops both: the turn ends cancelled at once, and the subagent calls the model no more", async () => {
    const h = await harness("stop-subagent");
    const before = stub.calls.length;
    try {
      const spec = dispatchTask(h, "stop-subagent", `${stubMarker("bg-subagent", "hang")} Have a subagent work.`, { baseUrl: stub.baseUrl, token: STUB_TOKEN, endpointModelId: "stub-model" });
      // The prompt is answered, and the turn waits on its working subagent.
      await h.gateway.waitFor(() => messagesOf(h, spec).some((message) => message.text.includes("launched a subagent")), 150_000);
      await h.gateway.waitFor(() => subagentCallsOf(stub.calls.slice(before)).length >= 2, 60_000);
      expect(kindsOf(h, spec)).not.toContain("turn.ended");
      const at = Date.now();
      h.gateway.sendCommand(
        makeCommand({
          seq: 2,
          id: "stop-subagent",
          notAfter: Date.now() + 120_000,
          kind: "stop",
          body: { taskId: spec.taskId, sessionId: spec.sessionId, leaseEpoch: spec.leaseEpoch, reason: "requested" },
        }),
      );
      await h.gateway.waitFor(() => kindsOf(h, spec).includes("turn.ended"), 60_000);
      expect(Date.now() - at).toBeLessThan(8_000);
      expect(eventsOf(h, spec).find((item) => item.event.kind === "turn.ended")?.event).toMatchObject({ stopReason: "cancelled" });
      await h.gateway.waitFor(() => h.gateway.acks.some((ack) => ack.results.some((item) => item.id === "stop-subagent")), 60_000);
      // Both stopped: the subagent calls the model no more, and its report wakes no turn.
      await pause(500);
      const calls = subagentCallsOf(stub.calls.slice(before)).length;
      await pause(4_000);
      expect(subagentCallsOf(stub.calls.slice(before)).length).toBe(calls);
      expect(messagesOf(h, spec).some((message) => message.text.includes("the final answer"))).toBe(false);
    } finally {
      await h.close();
    }
  }, 180_000);

  it("F-026/c7: OpenCode's explore subagent stays read-only: its edit and its shell write are refused, and the repo is unchanged", async () => {
    const h = await harness("explore");
    const before = stub.calls.length;
    try {
      const spec = dispatchTask(h, "explore", `${stubMarker("explore-subagent")} Have explore look around.`, { baseUrl: stub.baseUrl, token: STUB_TOKEN, endpointModelId: "stub-model" });
      await h.gateway.waitFor(() => kindsOf(h, spec).includes("session.ended") || kindsOf(h, spec).includes("session.crashed"), 150_000);
      expect(kindsOf(h, spec)).toContain("session.ended");
      // Explore isn't even offered a tool that edits; its edit and its write through the shell both fail.
      const exploreCalls = subagentCallsOf(stub.calls.slice(before));
      expect(exploreCalls.length).toBeGreaterThan(0);
      for (const call of exploreCalls) {
        expect(call.toolNames, "explore's tools").not.toContain("edit");
        expect(call.toolNames, "explore's tools").not.toContain("write");
      }
      expect(messagesOf(h, spec).map((message) => message.text).join("\n")).toContain("explore results: error,error");
      const ended = eventsOf(h, spec).find((item) => item.event.kind === "session.ended")?.event;
      expect(ended).toMatchObject({ outcome: "without-changes" });
      const readme = await upstream.fileAt("ostra-test/test1", `refs/heads/${spec.branchName}`, "README.md").catch(() => null);
      expect((readme ?? "").includes("changed by explore")).toBe(false);
      expect(await upstream.fileAt("ostra-test/test1", `refs/heads/${spec.branchName}`, "explore-wrote.txt").catch(() => null)).toBeNull();
    } finally {
      await h.close();
    }
  }, 180_000);
});

describe.skipIf(!liveEnv.success)("the task host with OpenCode, live on the development endpoint", () => {
  it("completes a real turn", async () => {
    if (!liveEnv.success) {
      return;
    }
    const h = await harness("live");
    try {
      const spec = dispatchTask(h, "live", "Reply with one short sentence that says hello. Don't change any file.", {
        baseUrl: liveEnv.data.OSTRA_DEV_MODEL_BASE_URL,
        token: liveEnv.data.OSTRA_DEV_MODEL_API_KEY,
        endpointModelId: liveEnv.data.OSTRA_DEV_MODEL_ID,
      });
      await h.gateway.waitFor(() => kindsOf(h, spec).includes("session.ended") || kindsOf(h, spec).includes("session.crashed"), 280_000);
      const kinds = kindsOf(h, spec);
      expect(kinds, "the session ended, not crashed").toContain("session.ended");
      expect(kinds).toContain("turn.ended");
      expect(kinds).toContain("agent.message");
      expect(kinds).toContain("usage.recorded");
      const everything = JSON.stringify([eventsOf(h, spec), h.logs]);
      expect(everything.includes(liveEnv.data.OSTRA_DEV_MODEL_API_KEY)).toBe(false);
    } finally {
      await h.close();
    }
  }, 300_000);
});
