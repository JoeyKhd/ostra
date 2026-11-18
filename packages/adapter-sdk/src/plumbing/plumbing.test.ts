import { taskCredentialsFixture } from "@ostra/protocol/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { manualClock, memoryIdempotencyStore, memoryRateBudgetStore, recordingLogger } from "../testing/memory.ts";
import { idempotencyKey, withIdempotency } from "./idempotency.ts";
import { createLogger, REDACTED, redactTokens, sanitizeFields } from "./logger.ts";
import type { LogRecord } from "./logger.ts";
import { createRateBudget } from "./rate-budget.ts";
import { backoffDelay, parseRetryAfter, retry } from "./retry.ts";
import { parseVendor } from "./vendor.ts";

describe("the logger", () => {
  it("redacts strings that look like tokens, in the message and every field", () => {
    const records: LogRecord[] = [];
    const logger = createLogger((record) => {
      records.push(record);
    });
    logger.info("pushed with ghs_16C7e42F292c6912E7710c838347Ae178B4a", {
      taskId: "0196f1a0-0000-7000-8000-000000000004",
      header: "Bearer sk-live-abcdefghijklmnop",
      fake: "ostra-fake-0196f1a0abc",
      sha: "0123456789abcdef0123456789abcdef01234567",
      blob: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9w",
      count: 3,
      list: ["github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz", "plain"],
    });
    const [record] = records;
    expect(record?.message).toBe(`pushed with ${REDACTED}`);
    expect(record?.fields).toEqual({
      taskId: "0196f1a0-0000-7000-8000-000000000004",
      header: REDACTED,
      fake: REDACTED,
      sha: "0123456789abcdef0123456789abcdef01234567",
      blob: REDACTED,
      count: 3,
      list: [REDACTED, "plain"],
    });
  });

  it("refuses a TaskCredentials value by type, and drops any object at run time", () => {
    const logger = recordingLogger();
    // @ts-expect-error TaskCredentials is an object, and a log field is a primitive or a list of them.
    logger.info("never", { credentials: taskCredentialsFixture });
    // @ts-expect-error the same for any part of it that is an object.
    logger.info("never", { model: taskCredentialsFixture.model });
    expect(logger.records.map((record) => record.fields)).toEqual([
      { credentials: "[refused: not a primitive]" },
      { model: "[refused: not a primitive]" },
    ]);
    expect(JSON.stringify(logger.records)).not.toContain(taskCredentialsFixture.mcpToken);
  });

  it("carries a child's fields on every line", () => {
    const logger = recordingLogger();
    logger.child({ adapter: "github" }).warn("rate limited", { retryAfterMs: 1000 });
    expect(logger.records).toEqual([
      { level: "warn", message: "rate limited", fields: { adapter: "github", retryAfterMs: 1000 } },
    ]);
  });

  it("keeps IDs and ordinary words", () => {
    expect(redactTokens("task 0196f1a0-0000-7000-8000-000000000004 moved to running")).toBe(
      "task 0196f1a0-0000-7000-8000-000000000004 moved to running",
    );
    expect(redactTokens("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----")).toBe(REDACTED);
    expect(sanitizeFields({ gone: undefined, nested: { a: 1 } })).toEqual({ nested: "[refused: not a primitive]" });
  });
});

describe("retry", () => {
  const noSleep = (waits: number[]) => (ms: number) => {
    waits.push(ms);
    return Promise.resolve();
  };

  it("backs off with full jitter, capped", () => {
    expect(backoffDelay(0, 100, 10_000, () => 0.999)).toBe(99);
    expect(backoffDelay(3, 100, 10_000, () => 0.5)).toBe(400);
    expect(backoffDelay(20, 100, 10_000, () => 0.5)).toBe(5000);
    expect(backoffDelay(5, 100, 10_000, () => 0)).toBe(0);
  });

  it("retries a result until it's good, and honours Retry-After over the backoff", async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await retry(
      () => {
        calls += 1;
        return Promise.resolve(calls < 3 ? { status: 429 } : { status: 200 });
      },
      {
        attempts: 5,
        baseMs: 100,
        maxMs: 1000,
        random: () => 0.5,
        sleep: noSleep(waits),
        retryResult: (response) => (response.status === 429 ? { retry: true, afterMs: 2500 } : { retry: false }),
      },
    );
    expect(result).toEqual({ status: 200 });
    expect(waits).toEqual([2500, 2500]);
  });

  it("gives up after its attempts, returning the last result or rethrowing the last error", async () => {
    const waits: number[] = [];
    const last = await retry(() => Promise.resolve("busy"), {
      attempts: 3,
      baseMs: 100,
      maxMs: 1000,
      random: () => 0.5,
      sleep: noSleep(waits),
      retryResult: () => ({ retry: true }),
    });
    expect(last).toBe("busy");
    expect(waits).toEqual([50, 100]);
    await expect(
      retry(() => Promise.reject(new Error("down")), {
        attempts: 2,
        baseMs: 1,
        maxMs: 1,
        sleep: noSleep([]),
        retryError: () => ({ retry: true }),
      }),
    ).rejects.toThrow("down");
  });

  it("stops when its signal aborts", async () => {
    const controller = new AbortController();
    const pending = retry(() => Promise.resolve("busy"), {
      attempts: 10,
      baseMs: 60_000,
      maxMs: 60_000,
      random: () => 0.9,
      signal: controller.signal,
      retryResult: () => ({ retry: true }),
    });
    controller.abort(new Error("stopped"));
    await expect(pending).rejects.toThrow("stopped");
  });

  it("reads Retry-After as seconds or a date", () => {
    expect(parseRetryAfter("3", 0)).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4000)).toBe(6000);
    expect(parseRetryAfter("soon", 0)).toBeUndefined();
    expect(parseRetryAfter(null, 0)).toBeUndefined();
  });
});

describe("the rate budget", () => {
  it("lets calls go until the reserve, then waits until the reset", async () => {
    const clock = manualClock(1_000_000);
    const budget = createRateBudget({ store: memoryRateBudgetStore(), clock, reserve: 2 });
    expect(await budget.check("github:installation:1")).toEqual({ go: true });
    await budget.record("github:installation:1", { remaining: "5", limit: "5000", reset: "1030" });
    expect(await budget.check("github:installation:1")).toEqual({ go: true });
    await budget.record("github:installation:1", { remaining: "1", limit: "5000", reset: "1030" });
    expect(await budget.check("github:installation:1")).toEqual({ go: false, waitMs: 30_000 });
    expect(await budget.check("github:installation:2")).toEqual({ go: true });
    clock.set(1_030_000);
    expect(await budget.check("github:installation:1")).toEqual({ go: true });
  });

  it("ignores headers it can't read", async () => {
    const store = memoryRateBudgetStore();
    const budget = createRateBudget({ store, clock: manualClock() });
    await budget.record("k", { remaining: "lots", reset: null });
    expect(await store.get("k")).toBeUndefined();
  });
});

describe("idempotency", () => {
  it("runs a call once, replays its result, and reports a pending one as in doubt", async () => {
    const store = memoryIdempotencyStore();
    const clock = manualClock();
    const key = idempotencyKey("task", "t:1", "open-pr", 3);
    expect(key).toBe("task:t_1:open-pr:3");
    let calls = 0;
    const open = () => {
      calls += 1;
      return Promise.resolve({ number: 7 });
    };
    expect(await withIdempotency(store, clock, key, open)).toEqual({ kind: "ran", result: { number: 7 } });
    expect(await withIdempotency(store, clock, key, open)).toEqual({ kind: "replayed", result: { number: 7 } });
    expect(calls).toBe(1);

    await store.claim("crashed", 5);
    expect(await withIdempotency(store, clock, "crashed", open)).toEqual({ kind: "in-doubt", claimedAt: 5 });
  });

  it("releases its claim when the call throws, so a retry runs it", async () => {
    const store = memoryIdempotencyStore();
    const clock = manualClock();
    await expect(withIdempotency(store, clock, "k", () => Promise.reject(new Error("503")))).rejects.toThrow("503");
    expect(await withIdempotency(store, clock, "k", () => Promise.resolve(1))).toEqual({ kind: "ran", result: 1 });
  });
});

describe("parseVendor", () => {
  const schema = z.looseObject({ id: z.number(), login: z.string() });

  it("keeps unknown fields of a vendor's format and returns the parsed value", () => {
    expect(parseVendor(schema, { id: 1, login: "ostra", node_id: "x" }, "the user")).toEqual({
      ok: true,
      value: { id: 1, login: "ostra", node_id: "x" },
    });
  });

  it("answers invalid-response, naming paths and never values", () => {
    const result = parseVendor(schema, { id: "ghs_secretvalue123456789012", login: 4 }, "the user");
    expect(result).toMatchObject({ ok: false, error: { code: "invalid-response" } });
    expect(result.ok ? "" : result.error.message).not.toContain("ghs_secretvalue");
  });
});
