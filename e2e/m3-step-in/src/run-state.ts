import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

// The demo's own state (ticket 50), so a later run picks up where the last one stopped: each step
// that happened is skipped. IDs, numbers and timings only: never a secret.

const ticketSchema = z.object({ id: z.string(), identifier: z.string(), url: z.string() });

export const runStateSchema = z.object({
  projectHref: z.string().nullable().default(null),
  otherProjectHref: z.string().nullable().default(null),
  runnerApproved: z.boolean().default(false),
  profileDone: z.boolean().default(false),
  emailOn: z.boolean().default(false),
  checksDone: z.boolean().default(false),
  ticket: ticketSchema.nullable().default(null),
  taskId: z.string().nullable().default(null),
  pr: z.object({ number: z.number(), url: z.string() }).nullable().default(null),
  done: z.array(z.string()).default([]),
  timings: z.record(z.string(), z.number()).default({}),
  notes: z.record(z.string(), z.string()).default({}),
});

export type RunState = z.infer<typeof runStateSchema>;

export const loadRunState = async (file: string): Promise<RunState> => {
  try {
    return runStateSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return runStateSchema.parse({});
  }
};

export const saveRunState = async (file: string, state: RunState): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state, null, 2));
};

const fixturesSchema = z.object({
  pid: z.number(),
  smtp: z.object({ host: z.string(), port: z.number(), user: z.string(), pass: z.string() }),
  mcp: z.object({ url: z.string(), token: z.string() }),
});

export type Fixtures = z.infer<typeof fixturesSchema>;

export const loadFixtures = async (stateDir: string): Promise<Fixtures> => fixturesSchema.parse(JSON.parse(await readFile(path.join(stateDir, "fixtures.json"), "utf8")));

const mailSchema = z.object({ at: z.number(), from: z.string(), to: z.array(z.string()), subject: z.string(), user: z.string().nullable(), data: z.string() });
export type Mail = z.infer<typeof mailSchema>;

/** The mails the fixtures' server took, oldest first. */
export const readMail = async (stateDir: string): Promise<readonly Mail[]> => {
  const text = await readFile(path.join(stateDir, "mail.jsonl"), "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => mailSchema.parse(JSON.parse(line)));
};

const mcpSchema = z.object({ at: z.number(), path: z.string(), method: z.string(), authorized: z.boolean(), rpc: z.string().nullable() });
export type McpRequest = z.infer<typeof mcpSchema>;

export const readMcp = async (stateDir: string): Promise<readonly McpRequest[]> => {
  const text = await readFile(path.join(stateDir, "mcp.jsonl"), "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => mcpSchema.parse(JSON.parse(line)));
};

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `read` until it answers non-null, or throws `what` after `timeoutMs`. */
export const waitFor = async <T,>(what: string, timeoutMs: number, read: () => Promise<T | null>, everyMs = 1000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
};

export const seconds = (ms: number): number => Math.round(ms / 100) / 10;
