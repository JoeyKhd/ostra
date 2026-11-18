import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { spawnAgentProcess } from "@ostra/adapter-sdk/testing";
import type { TaskEvent } from "@ostra/protocol";
import { turnIdSchema } from "@ostra/protocol";
import { fixtureIds } from "@ostra/protocol/testing";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { allowedEnvNames } from "./config.ts";
import { OpenCodeAdapter } from "./opencode-adapter.ts";

// One real turn on the development endpoint, through a stand-in for the key proxy: the agent holds
// the task's fake key, and the stand-in swaps in the real token on its way out. It runs only with
// `model.env` loaded (`set -a; . ~/.config/ostra-dev/model.env; set +a`) and skips otherwise. It
// prints neither the URL nor the token.

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

describe.skipIf(!env.success)("OpenCode on the development endpoint, live", () => {
  const roots: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterAll(async () => {
    await Promise.all(closers.map((close) => close()));
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  it("completes a turn, with the fake key at the agent and the real one only past the stand-in", async () => {
    if (!env.success) {
      return;
    }
    const upstream = env.data.OSTRA_DEV_MODEL_BASE_URL.replace(/\/+$/, "");
    const seen: { readonly path: string; readonly presented: string | undefined }[] = [];
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
          headers: { "content-type": "application/json", authorization: `Bearer ${env.data.OSTRA_DEV_MODEL_API_KEY}` },
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

    const root = await mkdtemp(path.join(tmpdir(), "ostra-opencode-live-"));
    roots.push(root);
    const workspaceDir = path.join(root, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(path.join(workspaceDir, "README.md"), "hello\n", "utf8");

    const adapter = new OpenCodeAdapter();
    const prepared = await adapter.prepareLaunch({
      taskId: fixtureIds.task,
      sessionId: fixtureIds.session,
      workspaceDir,
      agentDir: path.join(root, "agent"),
      model: {
        endpointModelId: env.data.OSTRA_DEV_MODEL_ID,
        apiFormat: "openai-compatible",
        baseUrl: `http://127.0.0.1:${String(port)}/v1`,
        placeholderKey: FAKE_KEY,
      },
      mcp: { url: "http://127.0.0.1:9/mcp" },
      instructions: null,
      extraEnv: {},
    });
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
      cwd: workspaceDir,
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
});
