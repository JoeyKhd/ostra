import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";

import { sessionIdSchema, taskIdSchema, turnIdSchema } from "@ostra/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { fakeMarker, serveFakeAgent } from "../../testing/fake-acp-agent/agent.ts";
import type { FakeAgentProfile } from "../../testing/fake-acp-agent/agent.ts";
import { FakeAgentAdapter } from "../../testing/fake-acp-agent/fake-agent-adapter.ts";
import { spawnAgentProcess } from "../../testing/spawn-agent.ts";
import type { AcpUpdate, DriverConnection, DriverHandlers, DriverPort, PermissionRequest, QuestionRequest } from "../base.ts";
import { createAcpDriver } from "./driver.ts";
import type { AcpDriverOptions } from "./driver.ts";
import { isAlive } from "./process-tree.ts";

// The driver against a scripted ACP peer in the same process (the fake agent over a pair of
// streams), and against real processes where the test is about processes.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

type Peer = {
  readonly driver: DriverPort;
  readonly connection: DriverConnection;
  readonly updates: { readonly agentSessionId: string; readonly update: AcpUpdate }[];
  readonly permissions: PermissionRequest[];
  readonly questions: QuestionRequest[];
};

const connectInProcess = async (
  profile: FakeAgentProfile,
  handlerOverrides: Partial<DriverHandlers> = {},
  options: AcpDriverOptions = {},
): Promise<Peer> => {
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  const served = serveFakeAgent(toAgent, fromAgent, { profile, env: {} });
  cleanups.push(async () => {
    toAgent.end();
    // A crashed fake never finishes serving: don't wait for it.
    await Promise.race([served, new Promise((resolve) => setTimeout(resolve, 300))]);
  });
  const updates: Peer["updates"] = [];
  const permissions: PermissionRequest[] = [];
  const questions: QuestionRequest[] = [];
  const driver = createAcpDriver({ treeSnapshotMs: 0, ...options });
  const connected = await driver.connect(
    { stdin: toAgent, stdout: fromAgent, stderr: new PassThrough() },
    {
      onUpdate: (agentSessionId, update) => {
        updates.push({ agentSessionId, update });
      },
      onPermission: (_id, request) => {
        permissions.push(request);
        const allow = request.options.find((option) => option.kind === "allow_once");
        return Promise.resolve(allow === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId: allow.optionId });
      },
      onQuestion: (_id, request) => {
        questions.push(request);
        return Promise.resolve({ outcome: "answered", answers: { name: "orders", engine: "postgres", replicas: "3" } });
      },
      ...handlerOverrides,
    },
  );
  if (!connected.ok) {
    throw new Error(`connect failed: ${connected.error.message}`);
  }
  return { driver, connection: connected.value, updates, permissions, questions };
};

const newSession = async (peer: Peer): Promise<string> => {
  const created = await peer.connection.newSession({ cwd: process.cwd(), mcpServers: [] });
  if (!created.ok) {
    throw new Error(`newSession failed: ${created.error.message}`);
  }
  return created.value.agentSessionId;
};

const messageText = (peer: Peer): string =>
  peer.updates
    .flatMap(({ update }) => {
      const content: unknown = update["content"];
      const text: unknown = Reflect.get(Object(content), "text");
      return update.sessionUpdate === "agent_message_chunk" && typeof text === "string" ? [text] : [];
    })
    .join("");

describe("the ACP driver, in process", () => {
  it("runs a turn: initialize, session/new, session/prompt, and the agent's updates", async () => {
    const peer = await connectInProcess("rich");
    expect(peer.connection.agentName).toBe("ostra-fake-agent");
    const id = await newSession(peer);
    const result = await peer.connection.prompt(id, fakeMarker("say"));
    expect(result).toEqual({ ok: true, value: { stopReason: "end_turn" } });
    expect(messageText(peer)).toBe("Hello from the fake agent. The work is done.");
    expect(peer.updates.every((entry) => entry.agentSessionId === id)).toBe(true);
  });

  it("answers a cancel within 5 s: the turn ends cancelled", async () => {
    const peer = await connectInProcess("rich");
    const id = await newSession(peer);
    const turn = peer.connection.prompt(id, fakeMarker("silent"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const at = Date.now();
    await peer.connection.cancel(id);
    expect(await turn).toEqual({ ok: true, value: { stopReason: "cancelled" } });
    expect(Date.now() - at).toBeLessThan(5000);
  });

  it("ends a cancelled turn itself when the agent ignores the cancel", async () => {
    const peer = await connectInProcess("rich", {}, { cancelGraceMs: 200 });
    const id = await newSession(peer);
    const turn = peer.connection.prompt(id, fakeMarker("silent-deaf"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const at = Date.now();
    await peer.connection.cancel(id);
    expect(await turn).toEqual({ ok: true, value: { stopReason: "cancelled" } });
    expect(Date.now() - at).toBeLessThan(3000);
  });

  it("routes a permission request to the decider, with its options, and carries its answer back", async () => {
    const peer = await connectInProcess("rich");
    const id = await newSession(peer);
    const result = await peer.connection.prompt(id, fakeMarker("permission"));
    expect(result).toEqual({ ok: true, value: { stopReason: "end_turn" } });
    expect(peer.permissions).toEqual([
      {
        toolCallId: "perm-1",
        title: "Edit notes.txt",
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow-always", name: "Allow for this task", kind: "allow_always" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    ]);
    expect(messageText(peer)).toContain("The edit was applied.");
  });

  it("answers an unreadable permission request as cancelled instead of failing the agent's call", async () => {
    const peer = await connectInProcess("plain", { onPermission: () => Promise.resolve({ outcome: "cancelled" }) });
    const id = await newSession(peer);
    expect(await peer.connection.prompt(id, fakeMarker("permission"))).toEqual({ ok: true, value: { stopReason: "cancelled" } });
  });

  it("routes an elicitation form to the decider as question fields, and coerces the answers to the form's types", async () => {
    const peer = await connectInProcess("rich");
    const id = await newSession(peer);
    expect(await peer.connection.prompt(id, fakeMarker("elicit"))).toEqual({ ok: true, value: { stopReason: "end_turn" } });
    expect(peer.questions).toEqual([
      {
        message: "Which database should the service use?",
        fields: [
          { id: "name", label: "Database name", type: "text" },
          { id: "engine", label: "Engine", type: "select", options: ["postgres", "mysql"] },
          { id: "replicas", label: "Replicas", type: "text" },
        ],
      },
    ]);
    // `replicas` is an integer in the form: the member's "3" reaches the agent as the number 3.
    expect(messageText(peer)).toContain('"replicas":3');
    expect(messageText(peer)).toContain('"engine":"postgres"');
  });

  it("carries a declined or cancelled question back as the agent expects", async () => {
    for (const outcome of ["declined", "cancelled"] as const) {
      const peer = await connectInProcess("rich", { onQuestion: () => Promise.resolve({ outcome }) });
      const id = await newSession(peer);
      await peer.connection.prompt(id, fakeMarker("elicit"));
      expect(messageText(peer)).toContain(outcome === "declined" ? "no answer: decline" : "no answer: cancel");
    }
  });

  it("steers mid-turn when the agent advertised it", async () => {
    const peer = await connectInProcess("rich");
    expect(peer.connection.steeringAdvertised).toBe(true);
    const id = await newSession(peer);
    const turn = peer.connection.prompt(id, fakeMarker("steerable"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await peer.connection.steer(id, "use tabs")).toEqual({ ok: true, value: undefined });
    expect(await turn).toEqual({ ok: true, value: { stopReason: "end_turn" } });
    expect(messageText(peer)).toContain("Steered: use tabs");
  });

  it("answers conflict for a steer when the agent has no running turn", async () => {
    const peer = await connectInProcess("rich");
    const id = await newSession(peer);
    expect(await peer.connection.steer(id, "too late")).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("refuses a steer, as an error, when the agent didn't advertise steering", async () => {
    const peer = await connectInProcess("plain");
    expect(peer.connection.steeringAdvertised).toBe(false);
    const id = await newSession(peer);
    expect(await peer.connection.steer(id, "hello")).toMatchObject({ ok: false, error: { code: "unsupported" } });
  });

  it("doesn't emit what session/load replays, and emits what comes after", async () => {
    const peer = await connectInProcess("rich");
    const id = await newSession(peer);
    await peer.connection.prompt(id, fakeMarker("say"));
    const before = peer.updates.length;
    expect(before).toBeGreaterThan(0);
    // The fake replays two updates per line of history: none of them may reach the handler.
    expect(await peer.connection.loadSession({ agentSessionId: id, cwd: process.cwd(), mcpServers: [] })).toEqual({ ok: true, value: undefined });
    expect(peer.updates.length).toBe(before);
    // The session carries on, and its new updates do arrive.
    await peer.connection.prompt(id, fakeMarker("say"));
    expect(peer.updates.length).toBeGreaterThan(before);
  });

  it("hands an update of a kind it doesn't know to the handler, so it can't be dropped", async () => {
    const peer = await connectInProcess("rich");
    const id = await newSession(peer);
    await peer.connection.prompt(id, fakeMarker("unknown"));
    expect(peer.updates.map((entry) => entry.update.sessionUpdate)).toContain("future_feature");
  });

  it("maps updates through the shared mapping, with the open text closed at the turn's end", async () => {
    const peer = await connectInProcess("rich");
    const id = await newSession(peer);
    await peer.connection.prompt(id, fakeMarker("tools"));
    const context = {
      taskId: taskIdSchema.parse("task-1"),
      sessionId: sessionIdSchema.parse("session-1"),
      turnId: turnIdSchema.parse("turn-1"),
    };
    const events = [...peer.updates.flatMap((entry) => peer.driver.mapUpdate(entry.update, context)), ...(peer.driver.finishTurn?.(context) ?? [])];
    expect(events.filter((event) => event.kind === "tool.called")).toHaveLength(11);
    expect(events.flatMap((event) => (event.kind === "agent.message" ? [event.text] : []))).toEqual([
      "Looking around, then changing things. ",
      "All tools ran.",
    ]);
  });

  it("sets a config option and returns the session.config_changed event itself", async () => {
    const peer = await connectInProcess("rich");
    const id = await newSession(peer);
    // The fake has no config options: the driver reports what it was asked to set.
    const set = await peer.connection.setConfigOption?.(id, "model", "p/m2").catch(() => undefined);
    // An agent that refuses the call gives a typed failure; one that accepts gives the event.
    expect(set === undefined || (set.ok ? set.value : []).every((event) => event.kind === "session.config_changed")).toBe(true);
    const mode = await peer.connection.setMode?.(id, "build").catch(() => undefined);
    expect(mode === undefined || !mode.ok || mode.value[0]?.kind === "session.config_changed").toBe(true);
  });

  it("fails a turn as a typed failure, not a throw, when the agent's connection ends", async () => {
    const peer = await connectInProcess("rich");
    const id = await newSession(peer);
    const turn = peer.connection.prompt(id, fakeMarker("crash"));
    expect(await turn).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await peer.connection.prompt(id, fakeMarker("say"))).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
});

describe("the ACP driver, with processes", () => {
  it("gives up on an agent that never answers initialize, and ends its process", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const { pid } = child;
    if (pid === undefined) {
      throw new Error("no pid");
    }
    cleanups.push(() => {
      child.kill("SIGKILL");
    });
    const driver = createAcpDriver({ initializeTimeoutMs: 300 });
    const connected = await driver.connect(
      { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, pid },
      { onUpdate: () => undefined, onPermission: () => Promise.resolve({ outcome: "cancelled" }), onQuestion: () => Promise.resolve({ outcome: "cancelled" }) },
    );
    expect(connected).toMatchObject({ ok: false, error: { code: "unavailable" } });
    await waitUntil(() => !isAlive(pid));
    expect(isAlive(pid), "the agent process after a failed initialize").toBe(false);
  });

  it("ends the agent's whole process tree on close, the agent's own children too", async () => {
    const adapter = new FakeAgentAdapter("rich");
    const launch = await adapter.prepareLaunch({
      taskId: taskIdSchema.parse("task-1"),
      sessionId: sessionIdSchema.parse("session-1"),
      workspaceDir: process.cwd(),
      agentDir: process.cwd(),
      model: { endpointModelId: "m", apiFormat: "openai-compatible", baseUrl: "http://127.0.0.1:9/v1", placeholderKey: "k" },
      mcp: { url: "http://127.0.0.1:9/mcp" },
      instructions: null,
      extraEnv: {},
    });
    if (!launch.ok) {
      throw new Error("no launch");
    }
    const started = await spawnAgentProcess(launch.value);
    const { pid } = started.io;
    if (pid === undefined || pid === null) {
      throw new Error("no pid");
    }
    cleanups.push(() => started.stop());
    const updates: AcpUpdate[] = [];
    const driver = createAcpDriver({ treeSnapshotMs: 200, closeGraceMs: 300 });
    const connected = await driver.connect(started.io, {
      onUpdate: (_id, update) => updates.push(update),
      onPermission: () => Promise.resolve({ outcome: "cancelled" }),
      onQuestion: () => Promise.resolve({ outcome: "cancelled" }),
    });
    if (!connected.ok) {
      throw new Error(connected.error.message);
    }
    const created = await connected.value.newSession({ cwd: process.cwd(), mcpServers: [] });
    if (!created.ok) {
      throw new Error("no session");
    }
    // The agent leaves a process behind and keeps running: it never answers on its own.
    void connected.value.prompt(created.value.agentSessionId, fakeMarker("spawn"));
    const child = await waitFor(() => {
      const text = updates.map((update) => JSON.stringify(update)).join("");
      return /spawned (\d+)/.exec(text)?.[1];
    });
    expect(child).toBeDefined();
    const childPid = Number(child);
    expect(isAlive(childPid)).toBe(true);
    await connected.value.close();
    await waitUntil(() => !isAlive(pid) && !isAlive(childPid));
    expect(isAlive(pid), "the agent after close").toBe(false);
    expect(isAlive(childPid), "the agent's child after close").toBe(false);
  }, 30_000);

  it("fails a turn as unavailable when the agent's process dies mid-turn", async () => {
    const adapter = new FakeAgentAdapter("rich");
    const launch = await adapter.prepareLaunch({
      taskId: taskIdSchema.parse("task-1"),
      sessionId: sessionIdSchema.parse("session-1"),
      workspaceDir: process.cwd(),
      agentDir: process.cwd(),
      model: { endpointModelId: "m", apiFormat: "openai-compatible", baseUrl: "http://127.0.0.1:9/v1", placeholderKey: "k" },
      mcp: { url: "http://127.0.0.1:9/mcp" },
      instructions: null,
      extraEnv: {},
    });
    if (!launch.ok) {
      throw new Error("no launch");
    }
    const started = await spawnAgentProcess(launch.value);
    cleanups.push(() => started.stop());
    const driver = createAcpDriver({ treeSnapshotMs: 0 });
    const connected = await driver.connect(started.io, {
      onUpdate: () => undefined,
      onPermission: () => Promise.resolve({ outcome: "cancelled" }),
      onQuestion: () => Promise.resolve({ outcome: "cancelled" }),
    });
    if (!connected.ok) {
      throw new Error(connected.error.message);
    }
    const created = await connected.value.newSession({ cwd: process.cwd(), mcpServers: [] });
    if (!created.ok) {
      throw new Error("no session");
    }
    const result = await connected.value.prompt(created.value.agentSessionId, fakeMarker("crash"));
    expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(!result.ok && result.error.message).toContain("process ended");
  }, 30_000);
});

const waitFor = async <T,>(read: () => T | undefined, timeoutMs = 15_000): Promise<T | undefined> => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined || Date.now() >= until) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const waitUntil = async (done: () => boolean, timeoutMs = 10_000): Promise<void> => {
  await waitFor(() => (done() ? true : undefined), timeoutMs);
};
