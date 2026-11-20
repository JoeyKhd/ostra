import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseEnvText, setEnvValue, writeEnvValue } from "./env-files.ts";
import { bulletOutcome, judgeDelegations, judgeInstall, judgeKeepAlive, judgeStop, pollIntervalMs } from "./judge.ts";
import type { DelegationSample } from "./judge.ts";
import { harnessSettings } from "./settings.ts";

// Ticket 38 (F-012): the harness's own parts. The skip with no app token, the rotated refresh token
// written back in place, and the judges of spike 5's four bullets, fed spike 5's figures from its
// real run on Linear (`context/research/spike-linear-agent-mode.md`, REAL [1] to [4]) and the
// breaks each one must catch.

const here = path.dirname(fileURLToPath(import.meta.url));
let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ostra-lam-unit-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("without the app token (ticket 38)", () => {
  it("F-012: the harness says skipped: no app token, ends 0, and calls nothing", async () => {
    const config = path.join(dir, "skip");
    await rm(config, { recursive: true, force: true });
    await import("node:fs/promises").then((fs) => fs.mkdir(config, { recursive: true }));
    // linear.env as it is today: everything but the app's refresh token.
    await writeFile(path.join(config, "linear.env"), "LINEAR_API_KEY=lin_api_x\nLINEAR_CLIENT_ID=c\nLINEAR_CLIENT_SECRET=s\nLINEAR_WEBHOOK_SECRET=w\nLINEAR_TEST_TEAM_ID=t\n");
    await writeFile(path.join(config, "tunnel.env"), "OSTRA_DEV_PUBLIC_URL=https://tunnel.example\n");
    // Anything the harness asked Linear would land here: its API and token endpoint point at it.
    const asked: string[] = [];
    const trap = createServer((request: IncomingMessage, response) => {
      asked.push(request.url ?? "");
      response.end("{}");
    });
    await new Promise<void>((resolve) => trap.listen(0, "127.0.0.1", resolve));
    const address = trap.address();
    const trapUrl = `http://127.0.0.1:${String(address !== null && typeof address === "object" ? address.port : 0)}`;
    const run = await new Promise<{ readonly code: number | null; readonly out: string }>((resolve) => {
      const child = spawn(process.execPath, [path.join(here, "harness.ts")], {
        env: { ...process.env, OSTRA_DEV_CONFIG_DIR: config, LINEAR_REFRESH_TOKEN: "", OSTRA_HARNESS_LINEAR_API_URL: `${trapUrl}/graphql`, OSTRA_HARNESS_LINEAR_TOKEN_URL: `${trapUrl}/oauth/token` },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
      });
      child.once("exit", (code) => {
        resolve({ code, out });
      });
    });
    await new Promise<void>((resolve) => trap.close(() => { resolve(); }));
    expect(run.out.trim()).toBe("skipped: no app token");
    expect(run.code).toBe(0);
    expect(asked).toEqual([]);
    expect(await harnessSettings({ OSTRA_DEV_CONFIG_DIR: config })).toEqual({ kind: "skip", reason: "no app token" });
  });

  it("F-012: with the token but not the rest, it names what's missing and starts nothing", async () => {
    const config = path.join(dir, "incomplete");
    await import("node:fs/promises").then((fs) => fs.mkdir(config, { recursive: true }));
    await writeFile(path.join(config, "linear.env"), "LINEAR_REFRESH_TOKEN=lin_refresh_x\nLINEAR_API_KEY=lin_api_x\n");
    const settings = await harnessSettings({ OSTRA_DEV_CONFIG_DIR: config });
    expect(settings.kind).toBe("incomplete");
    expect(settings.kind === "incomplete" ? settings.missing : []).toEqual(expect.arrayContaining(["LINEAR_CLIENT_ID", "OSTRA_DEV_PUBLIC_URL", "LINEAR_APP_CONNECTION_ID"]));
  });
});

describe("the rotated refresh token (ticket 38)", () => {
  it("F-012: is written back in place: the old token gone, every other line kept, nothing printed", async () => {
    const file = path.join(dir, "linear.env");
    const before = "# the test workspace\r\nLINEAR_API_KEY=lin_api_x\r\nLINEAR_REFRESH_TOKEN=old-token\r\nexport LINEAR_TEST_TEAM_KEY='OST'\r\n";
    await writeFile(file, before);
    const printed: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      printed.push(String(chunk));
      return true;
    };
    try {
      await writeEnvValue(file, "LINEAR_REFRESH_TOKEN", "new-token");
    } finally {
      process.stdout.write = write;
    }
    const after = await readFile(file, "utf8");
    expect(after).toBe("# the test workspace\r\nLINEAR_API_KEY=lin_api_x\r\nLINEAR_REFRESH_TOKEN=new-token\r\nexport LINEAR_TEST_TEAM_KEY='OST'\r\n");
    expect(printed.join("")).not.toContain("token");
    expect(parseEnvText(after)).toEqual({ LINEAR_API_KEY: "lin_api_x", LINEAR_REFRESH_TOKEN: "new-token", LINEAR_TEST_TEAM_KEY: "OST" });
    // A file without the line gets it at the end; a second line setting it is dropped.
    expect(setEnvValue("A=1\n", "LINEAR_REFRESH_TOKEN", "t")).toBe("A=1\nLINEAR_REFRESH_TOKEN=t\n");
    expect(setEnvValue("LINEAR_REFRESH_TOKEN=a\nB=2\nLINEAR_REFRESH_TOKEN=b\n", "LINEAR_REFRESH_TOKEN", "t")).toBe("LINEAR_REFRESH_TOKEN=t\nB=2\n");
    expect(() => setEnvValue("", "LINEAR_REFRESH_TOKEN", "a\nB=evil")).toThrow();
  });
});

describe("the four bullets' judges (ticket 38)", () => {
  it("F-012: the install passes the app's own user with the agent scopes, and fails a person's token or missing scopes", () => {
    // REAL [1]: "The app installed as its own user, with the scopes app:assignable, app:mentionable, read and write, and it's a different user from the admin."
    const real = { viewerIsApp: true, appUserId: "app-user", adminUserId: "admin", scopes: ["app:assignable", "app:mentionable", "read", "write"] };
    expect(bulletOutcome(judgeInstall(real))).toBe("pass");
    expect(bulletOutcome(judgeInstall({ ...real, viewerIsApp: false }))).toBe("fail");
    expect(bulletOutcome(judgeInstall({ ...real, appUserId: "admin" }))).toBe("fail");
    expect(bulletOutcome(judgeInstall({ ...real, scopes: ["read", "write"] }))).toBe("fail");
  });

  it("F-012: 50 delegations pass at spike 5's real figures, and fail a slow 200, a slow first thought, a runner online or a stale session", () => {
    // REAL [2]: server-side acks p50 1.1 ms, max 5.8 ms; first thoughts p50 90 ms, p95 227 ms, max 463 ms; all 50 active.
    const at = 1_800_000_000_000;
    const real: DelegationSample[] = Array.from({ length: 50 }, (_unused, index) => ({
      createdAt: at + index * 250,
      ackedAt: at + index * 250 + (index === 49 ? 5.8 : 1.1),
      firstThoughtAt: at + index * 250 + (index === 49 ? 463 : index > 46 ? 227 : 90),
      linearStatus: "active",
    }));
    const judge = (samples: readonly DelegationSample[], runnersOnline = 0) => bulletOutcome(judgeDelegations({ expected: 50, samples, runnersOnline }));
    expect(judge(real)).toBe("pass");
    const one = (change: Partial<DelegationSample>): DelegationSample[] => real.map((sample, index) => (index === 7 ? { ...sample, ...change } : sample));
    expect(judge(one({ ackedAt: at + 7 * 250 + 5_000 }))).toBe("fail");
    expect(judge(one({ firstThoughtAt: (real[7]?.ackedAt ?? 0) + 10_000 }))).toBe("fail");
    expect(judge(one({ ackedAt: null }))).toBe("fail");
    expect(judge(one({ linearStatus: "stale" }))).toBe("fail");
    expect(judge(real.slice(1))).toBe("fail");
    expect(judge(real, 1)).toBe("fail");
    // A webhook that came before the create call answered waited for nothing.
    expect(judge(one({ ackedAt: at + 7 * 250 - 40 }))).toBe("pass");
  });

  it("F-012: the stop passes one final response after signal: stop, and without a person's press is not run, never passed", () => {
    const pressed = { pressed: true as const, signalStop: true, turnStopped: true, finalResponses: 1, postsAfterFinal: 0, taskState: "stopped" };
    expect(bulletOutcome(judgeStop(pressed))).toBe("pass");
    expect(bulletOutcome(judgeStop({ ...pressed, postsAfterFinal: 1 }))).toBe("fail");
    expect(bulletOutcome(judgeStop({ ...pressed, finalResponses: 2 }))).toBe("fail");
    expect(bulletOutcome(judgeStop({ ...pressed, signalStop: false }))).toBe("fail");
    expect(bulletOutcome(judgeStop({ ...pressed, taskState: "running", turnStopped: false }))).toBe("fail");
    expect(bulletOutcome(judgeStop({ pressed: false, waitedMinutes: 30 }))).toBe("not-run");
  });

  it("F-012: 35 silent minutes pass at spike 5's real run, and fail a stale read, no heartbeat, a slow watch or a short turn", () => {
    // REAL [4]: 35.1 minutes, 0 stale episodes, one ephemeral heartbeat (at minute 20), ended complete.
    const polls: { atMs: number; status: string }[] = [];
    for (let atMs = 0; atMs < 35 * 60_000; atMs += pollIntervalMs(atMs)) polls.push({ atMs, status: "active" });
    const real = { polls, posts: [{ atMs: 20 * 60_000, kind: "heartbeat" as const }], elapsedMs: 35.1 * 60_000, finalStatus: "complete" };
    expect(bulletOutcome(judgeKeepAlive(real))).toBe("pass");
    expect(polls.filter((poll) => poll.atMs >= 28 * 60_000).length).toBeGreaterThanOrEqual(40);
    expect(bulletOutcome(judgeKeepAlive({ ...real, polls: polls.map((poll, index) => (index === 33 ? { ...poll, status: "stale" } : poll)) }))).toBe("fail");
    expect(bulletOutcome(judgeKeepAlive({ ...real, posts: [] }))).toBe("fail");
    expect(bulletOutcome(judgeKeepAlive({ ...real, posts: [...real.posts, { atMs: 25 * 60_000, kind: "other" as const }] }))).toBe("fail");
    expect(bulletOutcome(judgeKeepAlive({ ...real, polls: polls.filter((poll) => poll.atMs < 28 * 60_000 || poll.atMs % 60_000 === 0) }))).toBe("fail");
    expect(bulletOutcome(judgeKeepAlive({ ...real, elapsedMs: 30 * 60_000 }))).toBe("fail");
    expect(bulletOutcome(judgeKeepAlive({ ...real, finalStatus: "active" }))).toBe("fail");
  });
});
