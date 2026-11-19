import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { AgentCommand, PrepareLaunchInput } from "@ostra/adapter-sdk";
import {
  createScenarioBrain,
  runAgentCommand,
  spawnAgentProcess,
  startStubModelServer,
  stubMarker,
} from "@ostra/adapter-sdk/testing";
import type { StubServer } from "@ostra/adapter-sdk/testing";
import { turnIdSchema } from "@ostra/protocol";
import type { TaskEvent } from "@ostra/protocol";
import { fixtureIds } from "@ostra/protocol/testing";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { importedSessionId, summarizeArchive } from "./archive.ts";
import { OpenCodeAdapter } from "./opencode-adapter.ts";
import { scenarios } from "./stub-scenarios.ts";

// F-033 on the pinned OpenCode (ticket 10, spike 2): a session exported from one box, imported into
// a fresh one bound to that box's workspace, and loaded there. The agent suite has the generic case
// (`ADR 0039: exports a session, imports it…`); these are OpenCode's own facts, so the ticket's
// comments can name them. A stub model stands where the key proxy would.

const exec = promisify(execFile);
const TASK_KEY = "ostra-fake-key-for-this-task";
const MODEL = "stub-model";
const FACT = "ospreyabc123";

const roots: string[] = [];
const servers: StubServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
  // A .node file the agent unpacked can stay locked a moment on Windows: the temp folder is the OS's to clear then.
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => undefined)));
});

type Box = { readonly input: PrepareLaunchInput };

const newBox = async (name: string, stub: StubServer): Promise<Box> => {
  const root = await mkdtemp(path.join(tmpdir(), `ostra-oc-${name}-`));
  roots.push(root);
  const workspaceDir = path.join(root, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(path.join(workspaceDir, "README.md"), "hello\n", "utf8");
  return {
    input: {
      taskId: fixtureIds.task,
      sessionId: fixtureIds.session,
      workspaceDir,
      agentDir: path.join(root, "agent"),
      model: { endpointModelId: MODEL, apiFormat: "openai-compatible", baseUrl: stub.baseUrl, placeholderKey: TASK_KEY },
      mcp: { url: "http://127.0.0.1:9/mcp" },
      instructions: null,
      extraEnv: {},
    },
  };
};

const startStub = async (): Promise<StubServer> => {
  const stub = await startStubModelServer({ format: "openai-compatible", realKey: TASK_KEY, models: [MODEL], brain: createScenarioBrain(scenarios) });
  servers.push(stub);
  return stub;
};

const turn = (n: number) => turnIdSchema.parse(`archive-turn-${String(n)}`);

type Ran = { readonly adapter: OpenCodeAdapter; readonly agentSessionId: string; readonly archivePath: string; readonly events: TaskEvent[] };

/** One box with one turn that states the fact, the session exported to a file, the agent stopped. */
const firstBox = async (stub: StubServer): Promise<{ readonly box: Box; readonly ran: Ran }> => {
  const box = await newBox("first", stub);
  const adapter = new OpenCodeAdapter();
  const launch = await adapter.prepareLaunch(box.input);
  if (!launch.ok) throw new Error(launch.error.message);
  const started = await spawnAgentProcess(launch.value);
  const events: TaskEvent[] = [];
  const session = await adapter.startSession({
    taskId: box.input.taskId,
    sessionId: box.input.sessionId,
    io: started.io,
    cwd: box.input.workspaceDir,
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
  const archivePath = path.join(path.dirname(box.input.workspaceDir), "session.json");
  try {
    expect(await adapter.prompt(session.value, turn(1), `${stubMarker("remember")} The project codename is ${FACT}.`)).toEqual({
      ok: true,
      value: { stopReason: "end_turn" },
    });
    // Exported beside the live agent, as the runner does after every turn.
    const exported = await adapter.exportSession({
      agentSessionId: session.value.agentSessionId,
      agentDir: box.input.agentDir,
      workspaceDir: box.input.workspaceDir,
      archivePath,
    });
    if (!exported.ok) throw new Error(exported.error.message);
    expect(await runAgentCommand(exported.value)).toEqual({ code: 0 });
    return { box, ran: { adapter, agentSessionId: session.value.agentSessionId, archivePath, events } };
  } finally {
    await adapter.close(session.value);
    await started.stop();
  }
};

/** An empty fresh box: another agent folder and workspace, the same task. */
const freshBox = async (stub: StubServer): Promise<Box> => newBox("fresh", stub);

const capture = async (command: AgentCommand): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> => {
  try {
    const result = await exec(command.command, [...command.args], { cwd: command.cwd, env: { ...command.env } });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = z.looseObject({ code: z.number().optional(), stdout: z.string().optional(), stderr: z.string().optional() }).parse(error);
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
};

describe("F-033 on the pinned OpenCode: a session moves to a fresh box", () => {
  it("exports a live session's turns beside the running agent, and names the old box's directory", async () => {
    const stub = await startStub();
    const { box, ran } = await firstBox(stub);
    const text = await readFile(ran.archivePath, "utf8");
    const summary = summarizeArchive(text);
    expect(summary.agentSessionId).toBe(ran.agentSessionId);
    expect(summary.types["user"]).toBe(1);
    expect(summary.types["assistant"]).toBeGreaterThanOrEqual(1);
    // The archive carries the old box's absolute path: why an import always says `--directory`.
    const parsed = z.looseObject({ info: z.looseObject({ location: z.looseObject({ directory: z.string() }) }) }).parse(JSON.parse(text));
    expect(path.resolve(parsed.info.location.directory).toLowerCase()).toBe(path.resolve(box.input.workspaceDir).toLowerCase());
    expect(text).toContain(FACT);
  }, 120_000);

  it("imports into the fresh box's workspace, prints the session's ID, and loads it there with its history replayed, none of it new", async () => {
    const stub = await startStub();
    const { ran } = await firstBox(stub);
    const fresh = await freshBox(stub);
    const imported = await ran.adapter.importSession({
      agentSessionId: ran.agentSessionId,
      agentDir: fresh.input.agentDir,
      workspaceDir: fresh.input.workspaceDir,
      archivePath: ran.archivePath,
    });
    if (!imported.ok) throw new Error(imported.error.message);
    expect(imported.value.args).toContain("--directory");
    const result = await capture(imported.value);
    expect(result.code).toBe(0);
    expect(importedSessionId(result.stdout)).toBe(ran.agentSessionId);

    const launch = await ran.adapter.prepareLaunch(fresh.input);
    if (!launch.ok) throw new Error(launch.error.message);
    const started = await spawnAgentProcess(launch.value);
    const events: TaskEvent[] = [];
    try {
      const resumed = await ran.adapter.startSession({
        taskId: fresh.input.taskId,
        sessionId: fresh.input.sessionId,
        io: started.io,
        cwd: fresh.input.workspaceDir,
        mcpServers: [],
        onEvents: (batch) => {
          events.push(...batch);
        },
        onPermission: () => Promise.resolve({ outcome: "cancelled" }),
        onQuestion: () => Promise.resolve({ outcome: "cancelled" }),
        resumeAgentSessionId: ran.agentSessionId,
      });
      if (!resumed.ok) throw new Error(resumed.error.message);
      // B1: the replayed updates are counted, and none became a new event (ADR 0035).
      expect(resumed.value.replayedUpdates).toBeGreaterThan(0);
      expect(events).toEqual([]);
      // The model is shown the earlier turn: the stub answers only from the messages it was sent.
      expect(await ran.adapter.prompt(resumed.value, turn(2), `${stubMarker("recall")} What was the codename?`)).toEqual({
        ok: true,
        value: { stopReason: "end_turn" },
      });
      expect(events.flatMap((event) => (event.kind === "agent.message" ? [event.text] : [])).join("")).toContain(FACT);
      await ran.adapter.close(resumed.value);
    } finally {
      await started.stop();
    }
  }, 120_000);

  it("B3: with no import, a fresh box can't load the session", async () => {
    const stub = await startStub();
    const { ran } = await firstBox(stub);
    const fresh = await freshBox(stub);
    const launch = await ran.adapter.prepareLaunch(fresh.input);
    if (!launch.ok) throw new Error(launch.error.message);
    const started = await spawnAgentProcess(launch.value);
    try {
      const resumed = await ran.adapter.startSession({
        taskId: fresh.input.taskId,
        sessionId: fresh.input.sessionId,
        io: started.io,
        cwd: fresh.input.workspaceDir,
        mcpServers: [],
        onEvents: () => undefined,
        onPermission: () => Promise.resolve({ outcome: "cancelled" }),
        onQuestion: () => Promise.resolve({ outcome: "cancelled" }),
        resumeAgentSessionId: ran.agentSessionId,
      });
      expect(resumed.ok).toBe(false);
    } finally {
      await started.stop();
    }
  }, 120_000);

  it("an archive already present imports as success: a second import exits 0 and says so on stderr", async () => {
    const stub = await startStub();
    const { ran } = await firstBox(stub);
    const fresh = await freshBox(stub);
    const imported = await ran.adapter.importSession({
      agentSessionId: ran.agentSessionId,
      agentDir: fresh.input.agentDir,
      workspaceDir: fresh.input.workspaceDir,
      archivePath: ran.archivePath,
    });
    if (!imported.ok) throw new Error(imported.error.message);
    const first = await capture(imported.value);
    const second = await capture(imported.value);
    expect(first.code).toBe(0);
    expect(importedSessionId(first.stdout)).toBe(ran.agentSessionId);
    // OpenCode's own answer to the 409: not a failure, and no second session.
    expect(second.code).toBe(0);
    expect(importedSessionId(second.stdout)).toBeUndefined();
    expect(second.stderr).toContain("Session already exists");
  }, 120_000);

  it("runs both commands with the task's own folders and no credential at all", async () => {
    const stub = await startStub();
    const { box, ran } = await firstBox(stub);
    const exported = await ran.adapter.exportSession({
      agentSessionId: ran.agentSessionId,
      agentDir: box.input.agentDir,
      workspaceDir: box.input.workspaceDir,
      archivePath: ran.archivePath,
    });
    const imported = await ran.adapter.importSession({
      agentSessionId: ran.agentSessionId,
      agentDir: box.input.agentDir,
      workspaceDir: box.input.workspaceDir,
      archivePath: ran.archivePath,
    });
    if (!exported.ok || !imported.ok) throw new Error("no command");
    for (const command of [exported.value, imported.value]) {
      expect(Object.keys(command.env)).not.toContain("OSTRA_MODEL_API_KEY");
      expect(JSON.stringify(command)).not.toContain(TASK_KEY);
      expect(command.env["HOME"]).toBe(path.join(box.input.agentDir, "home"));
      expect(command.env["XDG_DATA_HOME"]).toBe(path.join(box.input.agentDir, "xdg", "data"));
    }
  }, 120_000);
});

// ---------- session/resume after an import (ticket 10: tried once, the result recorded) ----------

const rpcSchema = z.looseObject({
  id: z.number().optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.number(), message: z.string() }).optional(),
  method: z.string().optional(),
  params: z.looseObject({ update: z.looseObject({ sessionUpdate: z.string(), content: z.looseObject({ text: z.string().optional() }).optional() }).optional() }).optional(),
});
type Rpc = z.infer<typeof rpcSchema>;

describe("session/resume after an import, on the pinned OpenCode", () => {
  it("is tried once and its result recorded (see the ticket's comments)", async () => {
    const stub = await startStub();
    const { ran } = await firstBox(stub);
    const fresh = await freshBox(stub);
    const imported = await ran.adapter.importSession({
      agentSessionId: ran.agentSessionId,
      agentDir: fresh.input.agentDir,
      workspaceDir: fresh.input.workspaceDir,
      archivePath: ran.archivePath,
    });
    if (!imported.ok) throw new Error(imported.error.message);
    expect((await capture(imported.value)).code).toBe(0);

    const launch = await ran.adapter.prepareLaunch(fresh.input);
    if (!launch.ok) throw new Error(launch.error.message);
    const started = await spawnAgentProcess(launch.value);
    const messages: Rpc[] = [];
    let pending = "";
    started.io.stdout.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
        const line = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        const parsed = rpcSchema.safeParse(line === "" ? null : JSON.parse(line));
        if (parsed.success) {
          messages.push(parsed.data);
        }
      }
    });
    const send = (id: number, method: string, params: unknown): void => {
      started.io.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    };
    const answerTo = async (id: number): Promise<Rpc> => {
      const until = Date.now() + 30_000;
      for (;;) {
        const hit = messages.find((message) => message.id === id && message.method === undefined);
        if (hit !== undefined) return hit;
        if (Date.now() > until) throw new Error(`no answer to request ${String(id)}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    try {
      send(1, "initialize", { protocolVersion: 1, clientCapabilities: {} });
      const init = await answerTo(1);
      const capabilities: unknown = Reflect.get(Object(Reflect.get(Object(init.result), "agentCapabilities")), "sessionCapabilities");
      const seenBefore = messages.length;
      send(2, "session/resume", { sessionId: ran.agentSessionId, cwd: fresh.input.workspaceDir, mcpServers: [] });
      const answer = await answerTo(2);
      const updates = messages.slice(seenBefore).filter((message) => message.method === "session/update");
      const kinds = updates.map((message) => message.params?.update?.sessionUpdate ?? "?");
      // Does the resumed session carry its history into the model? A prompt, answered from the earlier turn.
      send(3, "session/prompt", { sessionId: ran.agentSessionId, prompt: [{ type: "text", text: `${stubMarker("recall")} What was the codename?` }] });
      const prompted = await answerTo(3);
      const said = messages
        .filter((message) => message.method === "session/update" && message.params?.update?.sessionUpdate === "agent_message_chunk")
        .map((message) => message.params?.update?.content?.text ?? "")
        .join("");
      expect(prompted.error).toBeUndefined();
      expect(said).toContain(FACT);
      // The finding, in one line for the ticket: whether OpenCode 2.3.2 answers it, and whether it replays.
      process.stderr.write(
        `session/resume after import, OpenCode 2.3.2: ${answer.error === undefined ? "answered with a result" : `refused (${String(answer.error.code)})`}; ` +
          `${String(updates.length)} session/update before the answer (${kinds.join(",")}); a prompt after it recalled the earlier turn: ${String(said.includes(FACT))}; sessionCapabilities=${JSON.stringify(capabilities)}\n`,
      );
      expect(answer.error !== undefined || answer.result !== undefined).toBe(true);
    } finally {
      await started.stop();
    }
  }, 120_000);
});
