import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentSession, PrepareLaunchInput } from "@ostra/adapter-sdk";
import { runAgentCommand, spawnAgentProcess } from "@ostra/adapter-sdk/testing";
import type { TaskEvent } from "@ostra/protocol";
import { planTurnPrompt, turnIdSchema } from "@ostra/protocol";
import { fixtureIds } from "@ostra/protocol/testing";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { allowedEnvNames } from "./config.ts";
import { OpenCodeAdapter } from "./opencode-adapter.ts";

// Real turns on the development endpoint, through a stand-in for the key proxy: the agent holds
// the task's fake key, and the stand-in swaps in the real token on its way out. They run only with
// `model.env` loaded (`set -a; . ~/.config/ostra-dev/model.env; set +a`) and skip otherwise. They
// print neither the URL nor the token.

const env = z
  .object({
    OSTRA_DEV_MODEL_BASE_URL: z.url(),
    OSTRA_DEV_MODEL_API_KEY: z.string().min(1),
    OSTRA_DEV_MODEL_ID: z.string().min(1),
  })
  .safeParse(process.env);

const FAKE_KEY = "ostra-fake-key-live-test";

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
};

type Seen = { readonly path: string; readonly presented: string | undefined };

describe.skipIf(!env.success)("OpenCode on the development endpoint, live", () => {
  const roots: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterAll(async () => {
    await Promise.all(closers.map((close) => close()));
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => undefined)));
  });

  /** A loopback server that takes the task's fake key and forwards with the real token. */
  const startStandIn = async (): Promise<{ readonly baseUrl: string; readonly seen: Seen[] }> => {
    if (!env.success) {
      throw new Error("the live environment is not loaded");
    }
    const upstream = env.data.OSTRA_DEV_MODEL_BASE_URL.replace(/\/+$/, "");
    const token = env.data.OSTRA_DEV_MODEL_API_KEY;
    const seen: Seen[] = [];
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      void (async () => {
        const body = await readBody(request);
        const presented = request.headers.authorization;
        seen.push({ path: request.url ?? "", presented });
        if (presented !== `Bearer ${FAKE_KEY}`) {
          response.writeHead(401).end();
          return;
        }
        // The stand-in: the real token goes on here, never at the agent.
        const url = `${upstream}${(request.url ?? "").replace(/^\/v1/, "")}`;
        const answer = await fetch(url, {
          method: request.method ?? "GET",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          ...(request.method === "POST" ? { body } : {}),
        });
        response.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "application/json" });
        for await (const chunk of answer.body ?? []) {
          response.write(chunk);
        }
        response.end();
      })().catch(() => {
        if (!response.headersSent) {
          response.writeHead(502);
        }
        response.end();
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => {
            resolve();
          });
        }),
    );
    const address: AddressInfo | string | null = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    return { baseUrl: `http://127.0.0.1:${String(port)}/v1`, seen };
  };

  const newBox = async (baseUrl: string): Promise<PrepareLaunchInput> => {
    if (!env.success) {
      throw new Error("the live environment is not loaded");
    }
    const root = await mkdtemp(path.join(tmpdir(), "ostra-opencode-live-"));
    roots.push(root);
    const workspaceDir = path.join(root, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(path.join(workspaceDir, "README.md"), "hello\n", "utf8");
    return {
      taskId: fixtureIds.task,
      sessionId: fixtureIds.session,
      workspaceDir,
      agentDir: path.join(root, "agent"),
      model: { endpointModelId: env.data.OSTRA_DEV_MODEL_ID, apiFormat: "openai-compatible", baseUrl, placeholderKey: FAKE_KEY },
      mcp: { url: "http://127.0.0.1:9/mcp" },
      instructions: null,
      extraEnv: {},
    };
  };

  it("completes a turn, with the fake key at the agent and the real one only past the stand-in", async () => {
    if (!env.success) {
      return;
    }
    const { baseUrl, seen } = await startStandIn();
    const input = await newBox(baseUrl);
    const adapter = new OpenCodeAdapter();
    const prepared = await adapter.prepareLaunch(input);
    if (!prepared.ok) {
      throw new Error(`prepareLaunch failed: ${prepared.error.message}`);
    }
    // The suite's environment check: the agent's environment holds only the allowlist.
    const names = Object.keys(prepared.value.env);
    expect(names.filter((name) => !allowedEnvNames.includes(name))).toEqual([]);
    const everything = JSON.stringify(prepared.value);
    expect(everything).not.toContain(env.data.OSTRA_DEV_MODEL_API_KEY);

    const started = await spawnAgentProcess(prepared.value);
    closers.push(started.stop);
    const events: TaskEvent[] = [];
    const session = await adapter.startSession({
      taskId: fixtureIds.task,
      sessionId: fixtureIds.session,
      io: started.io,
      cwd: input.workspaceDir,
      mcpServers: [],
      onEvents: (batch) => {
        events.push(...batch);
      },
      onPermission: () => Promise.resolve({ outcome: "cancelled" }),
      onQuestion: () => Promise.resolve({ outcome: "cancelled" }),
    });
    if (!session.ok) {
      throw new Error(`startSession failed: ${session.error.message}`);
    }
    const result = await adapter.prompt(session.value, turnIdSchema.parse("live-turn-1"), "Reply with the single word pong, and use no tools.");
    await adapter.close(session.value);

    expect(result, "the live turn").toMatchObject({ ok: true, value: { stopReason: "end_turn" } });
    expect(events.some((event) => event.kind === "agent.message" && event.text.length > 0)).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "turn.ended", stopReason: "end_turn" });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((call) => call.presented === `Bearer ${FAKE_KEY}`)).toBe(true);
  }, 240_000);

  it("F-063: a plan turn on the real model, in OpenCode's plan agent, changes no file and yields a plan", async () => {
    if (!env.success) {
      return;
    }
    const { baseUrl } = await startStandIn();
    const input = { ...(await newBox(baseUrl)), mode: "plan" as const };
    const before = (await readdir(input.workspaceDir, { recursive: true })).sort();
    const readme = await readFile(path.join(input.workspaceDir, "README.md"), "utf8");
    const adapter = new OpenCodeAdapter();
    const prepared = await adapter.prepareLaunch(input);
    if (!prepared.ok) {
      throw new Error(`prepareLaunch failed: ${prepared.error.message}`);
    }
    const started = await spawnAgentProcess(prepared.value);
    closers.push(started.stop);
    const events: TaskEvent[] = [];
    const asked: string[] = [];
    const session = await adapter.startSession({
      taskId: fixtureIds.task,
      sessionId: fixtureIds.session,
      io: started.io,
      cwd: input.workspaceDir,
      mcpServers: [],
      onEvents: (batch) => {
        events.push(...batch);
      },
      // Nothing in a plan turn needs a person: the plan agent refuses what it may not do by itself.
      onPermission: (_agentSessionId, request) => {
        asked.push(request.toolKind ?? "unknown");
        return Promise.resolve({ outcome: "cancelled" });
      },
      onQuestion: () => Promise.resolve({ outcome: "cancelled" }),
    });
    if (!session.ok) {
      throw new Error(`startSession failed: ${session.error.message}`);
    }
    const result = await adapter.prompt(
      session.value,
      turnIdSchema.parse("live-plan-turn-1"),
      planTurnPrompt("Add a CONTRIBUTING.md that says how to run the tests, and link it from README.md."),
      { mode: "plan" },
    );
    await adapter.close(session.value);

    expect(result, "the live plan turn").toMatchObject({ ok: true, value: { stopReason: "end_turn" } });
    expect((await readdir(input.workspaceDir, { recursive: true })).sort()).toEqual(before);
    expect(await readFile(path.join(input.workspaceDir, "README.md"), "utf8")).toBe(readme);
    expect(asked).toEqual([]);
    // The plan: OpenCode's todo list, mapped to plan.updated, and the message that sums it up.
    const plans = events.flatMap((event) => (event.kind === "plan.updated" ? [event] : []));
    expect(plans.at(-1)?.entries.length ?? 0).toBeGreaterThan(0);
    expect(events.some((event) => event.kind === "agent.message" && event.text.trim().length > 0)).toBe(true);
    console.info(`live plan turn: ${String(plans.at(-1)?.entries.length ?? 0)} plan entries, ${String(events.filter((event) => event.kind === "tool.called").length)} tool calls, workspace unchanged`);
  }, 300_000);

  it("F-033: a real session exported after three turns, imported in a fresh directory, answers about its first turn", async () => {
    if (!env.success) {
      return;
    }
    const { baseUrl, seen } = await startStandIn();
    const adapter = new OpenCodeAdapter();
    const textOf = (events: readonly TaskEvent[]): string =>
      events.flatMap((event) => (event.kind === "agent.message" ? [event.text] : [])).join("");
    // A codename the model can't know, in a shape that is one token to copy.
    const codename = `osprey-${randomBytes(4).toString("hex")}`;

    // Box one: three turns, the first states the codename.
    const first = await newBox(baseUrl);
    const launch = await adapter.prepareLaunch(first);
    if (!launch.ok) {
      throw new Error(`prepareLaunch failed: ${launch.error.message}`);
    }
    const started = await spawnAgentProcess(launch.value);
    closers.push(started.stop);
    const firstEvents: TaskEvent[] = [];
    const running = await adapter.startSession({
      taskId: first.taskId,
      sessionId: first.sessionId,
      io: started.io,
      cwd: first.workspaceDir,
      mcpServers: [],
      onEvents: (batch) => {
        firstEvents.push(...batch);
      },
      onPermission: () => Promise.resolve({ outcome: "cancelled" }),
      onQuestion: () => Promise.resolve({ outcome: "cancelled" }),
    });
    if (!running.ok) {
      throw new Error(`startSession failed: ${running.error.message}`);
    }
    const turns = [
      `The codename of this project is ${codename}. Remember it. Reply with just "noted", and use no tools.`,
      "What is 17 plus 25? Reply with just the number, and use no tools.",
      "Reply with the single word pong, and use no tools.",
    ];
    for (const [index, prompt] of turns.entries()) {
      const done = await adapter.prompt(running.value, turnIdSchema.parse(`live-archive-turn-${String(index + 1)}`), prompt);
      expect(done, `turn ${String(index + 1)}`).toMatchObject({ ok: true, value: { stopReason: "end_turn" } });
    }
    const archivePath = path.join(path.dirname(first.workspaceDir), "session.json");
    const exported = await adapter.exportSession({
      agentSessionId: running.value.agentSessionId,
      agentDir: first.agentDir,
      workspaceDir: first.workspaceDir,
      archivePath,
    });
    if (!exported.ok) {
      throw new Error(exported.error.message);
    }
    expect(await runAgentCommand(exported.value)).toEqual({ code: 0 });
    const agentSessionId = running.value.agentSessionId;
    await adapter.close(running.value);
    await started.stop();

    // Box two: a fresh directory. The import binds the session to it, then the agent loads it.
    const second = await newBox(baseUrl);
    const imported = await adapter.importSession({ agentSessionId, agentDir: second.agentDir, workspaceDir: second.workspaceDir, archivePath });
    if (!imported.ok) {
      throw new Error(imported.error.message);
    }
    expect(await runAgentCommand(imported.value)).toEqual({ code: 0 });
    const relaunch = await adapter.prepareLaunch(second);
    if (!relaunch.ok) {
      throw new Error(`prepareLaunch failed: ${relaunch.error.message}`);
    }
    const restarted = await spawnAgentProcess(relaunch.value);
    closers.push(restarted.stop);
    const secondEvents: TaskEvent[] = [];
    let loaded: AgentSession | undefined;
    try {
      const resumed = await adapter.startSession({
        taskId: second.taskId,
        sessionId: second.sessionId,
        io: restarted.io,
        cwd: second.workspaceDir,
        mcpServers: [],
        onEvents: (batch) => {
          secondEvents.push(...batch);
        },
        onPermission: () => Promise.resolve({ outcome: "cancelled" }),
        onQuestion: () => Promise.resolve({ outcome: "cancelled" }),
        resumeAgentSessionId: agentSessionId,
      });
      if (!resumed.ok) {
        throw new Error(`loading the imported session failed: ${resumed.error.message}`);
      }
      loaded = resumed.value;
      expect(loaded.replayedUpdates).toBeGreaterThan(0);
      expect(secondEvents, "a replayed update became a new event").toEqual([]);
      const answered = await adapter.prompt(
        loaded,
        turnIdSchema.parse("live-archive-turn-4"),
        "What codename did I give you in my first message? Reply with only the codename, and use no tools.",
      );
      expect(answered).toMatchObject({ ok: true, value: { stopReason: "end_turn" } });
      expect(textOf(secondEvents)).toContain(codename);
    } finally {
      if (loaded !== undefined) {
        await adapter.close(loaded);
      }
      await restarted.stop();
    }
    // Both boxes held the fake key only.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((call) => call.presented === `Bearer ${FAKE_KEY}`)).toBe(true);
  }, 480_000);
});
