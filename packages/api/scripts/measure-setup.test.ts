import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { appRouter, createContext } from "@ostra/api";
import { ensureFirstAdmin } from "@ostra/api/auth";
import { setupTimelineOutputSchema } from "@ostra/api/setup-timeline";
import { createBareHarness, TEST_PASSWORD } from "@ostra/api/testing";
import type { BareHarness } from "@ostra/api/testing";

// F-076, milestone 7 ticket 24: `pnpm measure:setup` run for real, as a child process, against the
// panel's own auth and tRPC handlers served over HTTP on embedded Postgres. The password goes in on
// standard input. Its output and its timeline.json hold the timeline, and no password, no session
// token and no address but the panel's.

const script = fileURLToPath(new URL("./measure-setup.ts", import.meta.url));
const minute = 60_000;
const start = Date.UTC(2026, 10, 20, 9, 0, 0);

let harness: BareHarness;
let server: Server;
let panel: string;
let workDir: string;
/** Every cookie value the panel set: none may show in the script's output. */
const cookieValues: string[] = [];

const toRequest = async (incoming: IncomingMessage, origin: string): Promise<Request> => {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) {
    if (Buffer.isBuffer(chunk)) chunks.push(chunk);
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === "string") headers.set(name, value);
  }
  const body = chunks.length === 0 ? null : Buffer.concat(chunks);
  return new Request(new URL(incoming.url ?? "/", origin), { method: incoming.method ?? "GET", headers, ...(body === null ? {} : { body }) });
};

const send = async (response: Response, out: ServerResponse): Promise<void> => {
  for (const cookie of response.headers.getSetCookie()) {
    const value = cookie.split(";")[0]?.split("=").slice(1).join("=") ?? "";
    if (value !== "") cookieValues.push(decodeURIComponent(value));
  }
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") headers[name] = value;
  });
  headers["set-cookie"] = response.headers.getSetCookie();
  out.writeHead(response.status, headers);
  out.end(Buffer.from(await response.arrayBuffer()));
};

beforeAll(async () => {
  harness = await createBareHarness();
  const seeded = await ensureFirstAdmin({
    db: harness.test.db,
    settings: { firstAdmin: { email: "measure@example.com", username: "measurer", password: TEST_PASSWORD, organizationName: "Measure Co" } },
    hashPassword: harness.deps.hashPassword,
    ports: harness.deps.ports,
    logger: harness.deps.logger,
  });
  if (seeded === null) throw new Error("the install already had an account");
  // The steps' entries, as the panel's use cases write them; no PR yet, and Linear left out.
  const marks: readonly (readonly [string, number])[] = [
    ["password.changed", 1],
    ["provider.added", 3],
    ["github.connected", 6],
    ["project.created", 9],
    ["runner.registered", 12],
    ["task.created", 14],
  ];
  await harness.test.db.auditEntry.createMany({
    data: marks.map(([action, minutes]) => ({ organizationId: seeded.organizationId, actorKind: "member" as const, action, createdAt: new Date(start + minutes * minute) })),
  });

  server = createServer((incoming, out) => {
    void (async () => {
      const request = await toRequest(incoming, panel);
      const url = new URL(request.url);
      const response = url.pathname.startsWith("/api/auth/")
        ? await harness.auth.handler(request)
        : url.pathname.startsWith("/api/trpc/")
          ? await fetchRequestHandler({
              endpoint: "/api/trpc",
              req: request,
              router: appRouter,
              createContext: ({ resHeaders }) => createContext(harness.deps, { headers: request.headers, resHeaders }),
            })
          : new Response("not found", { status: 404 });
      await send(response, out);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the panel's server has no port");
  panel = `http://127.0.0.1:${String(address.port)}`;
  workDir = await mkdtemp(path.join(tmpdir(), "ostra-measure-"));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => { resolve(); }));
  await harness.dispose();
  await rm(workDir, { recursive: true, force: true });
});

const run = (args: readonly string[], password: string) =>
  new Promise<{ readonly code: number; readonly out: string }>((resolve) => {
    const child = execFile(process.execPath, [script, ...args], { cwd: workDir, env: { PATH: process.env["PATH"] ?? "", SystemRoot: process.env["SystemRoot"] ?? "" } }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, out: `${stdout}${stderr}` });
    });
    child.stdin?.end(`${password}\n`);
  });

describe("pnpm measure:setup (F-076)", () => {
  it("F-076: prints each step's time since --start and writes timeline.json, with no token, password or address but the panel's", async () => {
    const { code, out } = await run(["--url", panel, "--start", new Date(start).toISOString(), "--username", "measurer"], TEST_PASSWORD);
    expect(code, out).toBe(0);
    expect(out).toContain("Model provider added          +3m 00s");
    expect(out).toContain("Runner connected              +12m 00s");
    expect(out).toContain("Linear connected (optional)   skipped");
    expect(out).toContain("First PR opened               missing");
    expect(out).toContain("Total: not complete (missing: first-pr)");

    const written = await readFile(path.join(workDir, "timeline.json"), "utf8");
    // The record is the panel's timeline, as setup.timeline answers it, with the panel and the start.
    const record = setupTimelineOutputSchema.extend({ panel: z.string(), startedAt: z.string() }).parse(JSON.parse(written));
    expect(record).toMatchObject({ panel, startedAt: new Date(start).toISOString(), start, missing: ["first-pr"], totalMs: null });

    expect(cookieValues.length).toBeGreaterThan(0);
    for (const text of [out, written]) {
      expect(text).not.toContain(TEST_PASSWORD);
      for (const value of cookieValues) {
        expect(text).not.toContain(value);
        // The signed token's own part, before its signature.
        expect(text).not.toContain(value.split(".")[0] ?? value);
      }
      const addresses = [...text.matchAll(/https?:\/\/[^\s"]+/g)].map((match) => match[0]);
      expect(new Set(addresses)).toEqual(new Set([panel]));
    }
  });

  it("refuses a wrong password in words that hold neither password", async () => {
    const wrong = "not-the-measurers-password";
    const { code, out } = await run(["--url", panel, "--start", new Date(start).toISOString(), "--username", "measurer"], wrong);
    expect(code).toBe(1);
    expect(out).toContain("The panel refused the sign-in");
    expect(out).not.toContain(wrong);
    expect(out).not.toContain(TEST_PASSWORD);
  });

  it("takes the password from the prompt, never an argument", async () => {
    const { code, out } = await run(["--url", panel, "--start", new Date(start).toISOString(), "--password", TEST_PASSWORD], "");
    expect(code).toBe(2);
    expect(out).toContain("Usage: pnpm measure:setup");
    expect(out).not.toContain(TEST_PASSWORD);
  });
});
