// OpenCode's own HTTP API (`opencode serve`), for the probes that compare it
// with ACP: steering (pass-bar bullet 5) and the fallback the pass bar names
// for a failed capability. Loopback only, a random password per server, the
// task's own environment (fake key only) and config.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { z } from "zod";
import { killTree } from "../lib/process-tree.ts";
import { trackPid, untrackPid, type Task } from "./fixture.ts";

export const freePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });

export const until = async (what: string, ms: number, test: () => boolean | Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!(await test())) {
    if (Date.now() > deadline) throw new Error(`${what}: not within ${String(ms)} ms`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};

export type ServeResponse = { readonly status: number; readonly body: unknown };

export type Serve = {
  readonly base: string;
  readonly headers: Readonly<Record<string, string>>;
  /** One JSON call. A body that isn't JSON comes back as undefined. */
  readonly call: (method: "GET" | "POST" | "PATCH" | "DELETE", pathName: string, body?: unknown) => Promise<ServeResponse>;
  readonly close: () => Promise<void>;
};

const created = z.looseObject({ data: z.looseObject({ id: z.string() }) });

export const startServe = async (task: Task): Promise<Serve> => {
  const port = await freePort();
  const password = randomBytes(18).toString("base64url");
  const child = spawn(task.binary.path, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: task.dirs.workspace,
    env: { ...task.env, OPENCODE_SERVER_PASSWORD: password },
    stdio: ["ignore", "ignore", "ignore"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const pid = child.pid;
  if (pid !== undefined) {
    trackPid(pid);
    child.once("exit", () => {
      untrackPid(pid);
    });
  }
  const base = `http://127.0.0.1:${String(port)}`;
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" };
  const call = async (method: "GET" | "POST" | "PATCH" | "DELETE", pathName: string, body?: unknown): Promise<ServeResponse> => {
    const response = await fetch(`${base}${pathName}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === "" ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return { status: response.status, body: parsed };
  };
  const close = async (): Promise<void> => {
    if (pid !== undefined) await killTree(pid);
  };
  try {
    await until("opencode serve", 60_000, async () => (await call("GET", "/api/session").catch(() => undefined))?.status === 200);
  } catch (error) {
    await close();
    throw error;
  }
  return { base, headers, call, close };
};

/** Creates a session in the task's workspace and returns its ID. */
export const createServeSession = async (serve: Serve, task: Task): Promise<string> => {
  const response = await serve.call("POST", "/api/session", { location: { directory: task.dirs.workspace } });
  return created.parse(response.body).data.id;
};

const activeSessions = z.looseObject({ data: z.record(z.string(), z.unknown()) });

/** Whether the session is still working (listed by `GET /api/session/active`). */
export const isSessionActive = async (serve: Serve, sessionId: string): Promise<boolean> => {
  const response = await serve.call("GET", "/api/session/active");
  const parsed = activeSessions.safeParse(response.body);
  return parsed.success && sessionId in parsed.data.data;
};
