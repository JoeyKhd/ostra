import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { aggregateByTicket, formatRunTable } from "../src/harness/report-table.ts";
import { parseEnvFile } from "../src/harness/inputs.ts";
import { scanForSecrets } from "../src/harness/scan.ts";
import type { StubRequest } from "../src/lib/stub-models/types.ts";
import { countTypeErrors, parseTap } from "../src/runner/checks.ts";
import { exec } from "../src/runner/exec.ts";
import { STUB_PRICING, usdOf } from "../src/runner/pricing.ts";
import { buildPrompt } from "../src/runner/prompt.ts";
import { cleanWorkRoot, hostToolEnv } from "../src/runner/sandbox.ts";
import { RunIdSchema, RunRecordSchema } from "../src/runner/schemas.ts";
import { createSolveBrain, TEST_COMMAND } from "../src/runner/stub-brain.ts";
import { removeDir, parseNumstat } from "../src/runner/workspace.ts";
import type { Solution } from "../src/tickets/schema.ts";
import { ticketId } from "../src/tickets/schema.ts";
import { TICKETS } from "../src/tickets/tickets.ts";
import { record } from "./support.ts";

afterAll(async () => {
  await cleanWorkRoot();
});

describe("the run record", () => {
  it("accepts a complete record and rejects a field it doesn't know, because it is ostra's own format", () => {
    expect(record().runId).toBe("calc-1-r1");
    expect(() => RunRecordSchema.parse({ ...record(), surprise: true })).toThrow();
  });

  it("brands run IDs and refuses anything else", () => {
    expect(RunIdSchema.safeParse("calc-10-r3").success).toBe(true);
    expect(RunIdSchema.safeParse("calc-10").success).toBe(false);
    expect(RunIdSchema.safeParse("../calc-1-r1").success).toBe(false);
  });
});

describe("reading what the checkers print", () => {
  it("reads the totals off node:test's TAP output", () => {
    expect(parseTap("TAP version 13\n# Subtest: a\nok 1 - a\n1..1\n# tests 35\n# suites 5\n# pass 34\n# fail 1\n# cancelled 0\n")).toEqual({ total: 35, pass: 34, fail: 1 });
    expect(parseTap("nothing useful")).toEqual({ total: 0, pass: 0, fail: 0 });
  });

  it("counts tsc's errors", () => {
    expect(countTypeErrors("a.ts(1,2): error TS2322: x\nb.ts(3,4): error TS7006: y\n")).toBe(2);
    expect(countTypeErrors("")).toBe(0);
  });

  it("reads git's numstat, binary files included", () => {
    expect(parseNumstat("3\t1\tsrc/a.ts\n-\t-\tlogo.png\n")).toEqual([
      { path: "src/a.ts", insertions: 3, deletions: 1 },
      { path: "logo.png", insertions: 0, deletions: 0 },
    ]);
  });
});

describe("exec", () => {
  it("passes arguments as an array: shell metacharacters stay text", async () => {
    const result = await exec(process.execPath, ["-e", "console.log(process.argv[1])", "a; echo pwned && $(id)"], { cwd: os.tmpdir(), timeoutMs: 20_000, env: await hostToolEnv() });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("a; echo pwned && $(id)");
  });

  it("kills a process that outlives its limit", async () => {
    const result = await exec(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { cwd: os.tmpdir(), timeoutMs: 500, env: await hostToolEnv() });
    expect(result.timedOut).toBe(true);
    expect(result.ms).toBeLessThan(10_000);
  });
});

describe("the scripted model", () => {
  const solution: Solution = {
    steps: [
      { tool: "read", path: "src/a.ts" },
      { tool: "edit", path: "src/a.ts", oldString: "x", newString: "y" },
    ],
    summary: "Done.",
  };
  const request = (assistantMessages: number, tools: readonly string[] = ["edit"]): StubRequest => ({
    requestId: "r",
    format: "openai",
    path: "/v1/chat/completions",
    model: "m",
    stream: true,
    includeUsage: true,
    messages: [{ role: "user", text: "ticket", toolCalls: [], toolCallId: undefined, isError: false }, ...Array.from({ length: assistantMessages }, () => ({ role: "assistant" as const, text: "", toolCalls: [], toolCallId: undefined, isError: false }))],
    toolNames: tools,
    tools: [],
    signal: new AbortController().signal,
  });

  it("plays the steps, then runs the test suite, then ends with the summary", async () => {
    const brain = createSolveBrain(solution);
    expect((await brain(request(0))).toolCalls?.[0]?.name).toBe("read");
    expect((await brain(request(1))).toolCalls?.[0]).toEqual({ name: "edit", arguments: { path: "src/a.ts", oldString: "x", newString: "y" } });
    const tests = await brain(request(2));
    expect(tests.toolCalls?.[0]?.name).toBe("shell");
    expect(JSON.stringify(tests.toolCalls?.[0]?.arguments)).toContain(TEST_COMMAND.replaceAll('"', '\\"'));
    expect(await brain(request(3))).toEqual({ text: "Done." });
  });

  it("answers a call without tools (a title) with plain text, and can slow every step down", async () => {
    const brain = createSolveBrain(solution, { stepDelayMs: 400 });
    expect((await brain(request(0, []))).toolCalls).toBeUndefined();
    expect((await brain(request(0))).delayMs).toBe(400);
  });
});

describe("the prompt", () => {
  it("is the same frame for every ticket, and carries the ticket's text", () => {
    const first = TICKETS[0];
    if (first === undefined) throw new Error("no tickets");
    const prompt = buildPrompt(first, `ostra/${first.id}`);
    expect(prompt).toContain("CALC-1");
    expect(prompt).toContain(first.body);
    expect(prompt).toContain("Do not commit and do not push");
    expect(prompt).not.toContain("[[stub");
  });
});

describe("pricing", () => {
  it("prices tokens per million, cache reads and writes included", () => {
    const usd = usdOf({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, reasoning: 0 }, STUB_PRICING);
    expect(usd).toBeCloseTo(3 + 15 + 0.3 + 3.75, 9);
  });
});

describe("env files", () => {
  it("reads KEY=value lines, with export, quotes and comments", () => {
    expect(parseEnvFile('# c\nexport A=1\nB="two words"\nC=\'x\'\n\nD=a=b\n')).toEqual({ A: "1", B: "two words", C: "x", D: "a=b" });
  });
});

describe("the secret scan", () => {
  it("reports which files hold a needle, never the needle", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "scan-"));
    try {
      await mkdir(path.join(dir, "sub"), { recursive: true });
      await writeFile(path.join(dir, "clean.txt"), "nothing here");
      await writeFile(path.join(dir, "sub", "leak.txt"), "the key is stub-real-0123456789abcdef0123456789abcdef ok");
      const result = await scanForSecrets(dir, [/stub-real-[0-9a-f]{32}/, "never-present"]);
      expect(result.files).toBe(2);
      expect(result.hits).toEqual(["sub/leak.txt"]);
      expect(JSON.stringify(result)).not.toContain("stub-real-0123");
    } finally {
      await removeDir(dir);
    }
  });
});

describe("the per-run table", () => {
  it("aggregates by ticket and totals tokens, marking the stub's made-up prices", () => {
    const rows = [record(), record({ runId: RunIdSchema.parse("calc-1-r2"), index: 2 }), record({ runId: RunIdSchema.parse("calc-2-r1"), ticketId: ticketId("calc-2") })];
    const aggregates = aggregateByTicket(rows);
    expect(aggregates.map((a) => [a.ticketId, a.runs, a.acceptancePassed])).toEqual([
      ["calc-1", 2, 2],
      ["calc-2", 1, 1],
    ]);
    const table = formatRunTable(rows);
    expect(table).toContain("calc-1-r2");
    expect(table).toContain("total: 3 runs, 360 tokens");
    expect(table).toContain("made-up prices");
  });
});
