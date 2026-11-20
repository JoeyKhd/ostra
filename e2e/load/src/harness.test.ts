import { describe, expect, it } from "vitest";

import { drawRatePerMinute, eventMix, newScriptState, nextEvent, partialTextOn, pickKind, recordedRates } from "./mix.ts";
import { cpuCores, parseProcStat, parsePsTime, sampleProcess } from "./process-sampler.ts";
import { bucketPercentile, createSteerTimer, summarize } from "./stats.ts";
import { judgeRun, judgeStep, runResultsSchema, summaryMarkdown } from "./verdict.ts";
import type { StepResult } from "./verdict.ts";
import { taskIdSchema } from "@ostra/protocol";

// Ticket 34 (F-117): the load test's own parts, each against a known answer.

describe("the steer timer", () => {
  it("F-117: measures a steer against a known delay, and counts one that never arrives as lost", async () => {
    const timer = createSteerTimer();
    // Known delays, 1 to 100 ms, on recorded timestamps.
    for (let delay = 1; delay <= 100; delay += 1) {
      timer.sent(`m-${String(delay)}`, 1_000_000);
      timer.received(`m-${String(delay)}`, 1_000_000 + delay);
    }
    // A resend's second receipt doesn't move the first.
    timer.received("m-1", 1_000_000 + 9_999);
    let result = timer.result();
    expect(result).toMatchObject({ sent: 100, received: 100, lost: [] });
    expect(result.latencyMs).toEqual({ count: 100, p50: 50, p99: 99, max: 100 });

    // On the clock: a steer received 200 ms after it was sent reads about 200 ms.
    const live = createSteerTimer();
    live.sent("live", Date.now());
    await new Promise((resolve) => setTimeout(resolve, 200));
    live.received("live", Date.now());
    const p99 = live.result().latencyMs.p99 ?? 0;
    expect(p99).toBeGreaterThanOrEqual(195);
    expect(p99).toBeLessThan(1_000);

    timer.sent("never", 1_000_000);
    result = timer.result();
    expect(result.lost).toEqual(["never"]);
    expect(result.received).toBe(100);
  });

  it("F-117: reads percentiles of bucketed ingest times at the bucket's bound", () => {
    expect(bucketPercentile([5, 10, 25], [50, 49, 1, 0], 50)).toBe(5);
    expect(bucketPercentile([5, 10, 25], [50, 49, 1, 0], 99)).toBe(10);
    expect(bucketPercentile([5, 10, 25], [50, 49, 0, 1], 100)).toBeNull();
    expect(bucketPercentile([5], [0, 0], 50)).toBeNull();
    expect(summarize([])).toEqual({ count: 0, p50: null, p99: null, max: null });
  });
});

describe("the CPU sampler", () => {
  it("F-117: reads the test's own process's CPU and memory from the OS", async () => {
    const before = await sampleProcess(process.pid);
    const nodeBefore = process.cpuUsage();
    // Burn until Node itself counts 1.2 s of CPU, not for a wall-clock time: on a busy CI machine
    // the loop gets only part of a core (run 44660587098 got 0.75 s in 1.5 s).
    const giveUpAt = performance.now() + 30_000;
    let spin = 0;
    const nodeMs = (): number => {
      const delta = process.cpuUsage(nodeBefore);
      return (delta.user + delta.system) / 1000;
    };
    while (nodeMs() < 1_200 && performance.now() < giveUpAt) {
      for (let i = 0; i < 100_000; i += 1) spin += Math.sqrt(spin + 1);
    }
    const nodeUsed = nodeMs();
    const after = await sampleProcess(process.pid);
    expect(spin).toBeGreaterThan(0);
    expect(nodeUsed).toBeGreaterThanOrEqual(1_200);
    // The OS's count for this process agrees with Node's own, within the sampler's resolution; the
    // sampler's own reads and any idle child add a little.
    const used = after.cpuMs - before.cpuMs;
    expect(used).toBeGreaterThanOrEqual(nodeUsed - 300);
    expect(used).toBeLessThan((after.at - before.at) * 4 + 500);
    expect(cpuCores(before, after)).toBeGreaterThan(0);
    expect(after.rssBytes).toBeGreaterThan(10 * 1024 * 1024);
    expect(after.processes).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("F-117: parses Linux's /proc stat and ps's time", () => {
    // pid (comm with a space) state ppid ... utime=250 stime=50 ... rss=1000 pages
    const fields = ["S", "7", ...Array.from({ length: 9 }, () => "0"), "250", "50", ...Array.from({ length: 8 }, () => "0"), "1000"];
    expect(parseProcStat(`42 (postgres: writer) ${fields.join(" ")}`)).toEqual({ pid: 42, ppid: 7, cpuMs: 3_000, rssBytes: 1000 * 4096 });
    expect(parseProcStat("garbage")).toBeNull();
    expect(parsePsTime("01:02.50")).toBe(62_500);
    expect(parsePsTime("1-00:00:01")).toBe(86_401_000);
  });
});

describe("the event mix", () => {
  it("F-117: draws rates within spike 10's recorded range, half under its median, at its byte size", () => {
    let seed = 1;
    const random = (): number => {
      seed = (seed * 16_807) % 2_147_483_647;
      return seed / 2_147_483_647;
    };
    const rates = Array.from({ length: 10_000 }, () => drawRatePerMinute(random));
    expect(Math.min(...rates)).toBeGreaterThanOrEqual(recordedRates.minPerMinute);
    expect(Math.max(...rates)).toBeLessThanOrEqual(recordedRates.maxPerMinute);
    const below = rates.filter((rate) => rate < recordedRates.medianPerMinute).length / rates.length;
    expect(below).toBeGreaterThan(0.47);
    expect(below).toBeLessThan(0.53);

    const counts = new Map<string, number>();
    for (let i = 0; i < 20_000; i += 1) {
      const kind = pickKind(random);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    for (const entry of eventMix) expect(Math.abs((counts.get(entry.kind) ?? 0) / 20_000 - entry.share)).toBeLessThan(0.02);

    const state = newScriptState();
    const thought = nextEvent(state, "agent.thought");
    expect(Math.abs(Buffer.byteLength(JSON.stringify(thought)) - recordedRates.wireBytes)).toBeLessThan(8);
    // A tool update with no open call opens one first.
    expect(nextEvent(state, "tool.progress").kind).toBe("tool.called");
    expect(nextEvent(state, "tool.completed").kind).toBe("tool.completed");

    const tasks = Array.from({ length: 4_000 }, (_unused, index) => taskIdSchema.parse(`0198a3c4-0000-7000-8000-${String(index).padStart(12, "0")}`));
    const on = tasks.filter(partialTextOn).length / tasks.length;
    expect(on).toBeGreaterThan(0.2);
    expect(on).toBeLessThan(0.3);
  });
});

const step = (tasks: number, overrides: Partial<StepResult> = {}): StepResult => ({
  tasks,
  replicas: 3,
  generators: Math.ceil(tasks / 250),
  runners: tasks,
  startedAt: "2026-11-20T00:00:00.000Z",
  windowSeconds: 60,
  dispatched: tasks,
  steer: { sent: 100, received: 100, lost: 0, latencyMs: { count: 100, p50: 40, p99: 120, max: 180 } },
  events: { offered: tasks * 270, stored: tasks * 270, duplicates: 0, missing: 0, perTaskPerMinute: 270 },
  ackMs: { count: 1000, p50: 20, p99: 90, max: 200 },
  ingestMs: { frames: 1000, p50: 10, p99: 50, max: 80 },
  postgres: { samples: 12, meanCores: 1.2, maxCores: 2.1, source: "win32 Win32_Process" },
  replicaMemoryMiB: [210, 205, 199],
  storm: { runners: tasks, reconnected: tasks, seconds: 4.2 },
  browsers: { pages: 5, marks: 50, seen: 50, latencyMs: { count: 50, p50: 300, p99: 700, max: 750 } },
  error: null,
  ...overrides,
});

describe("the summary's verdict", () => {
  it("F-117: names the largest step that held every bar and how the next one failed", () => {
    const recorded = runResultsSchema.parse({
      machine: "test",
      steps: [
        step(100),
        step(250),
        step(500, { steer: { sent: 100, received: 99, lost: 1, latencyMs: { count: 99, p50: 220, p99: 640, max: 900 } } }),
        step(1000, { events: { offered: 100, stored: 98, duplicates: 1, missing: 3, perTaskPerMinute: 200 } }),
      ],
    });
    const verdict = judgeRun(recorded.steps);
    expect(verdict.largestHeld).toBe(250);
    expect(verdict.next?.tasks).toBe(500);
    expect(verdict.next?.failures).toEqual(["a steer took 640 ms at p99 (the bar is under 500 ms)", "1 of 100 steers never reached their runner"]);
    const markdown = summaryMarkdown(recorded);
    expect(markdown.split("\n")[0]).toBe("The largest step that held every bar: **250 tasks**.");
    expect(markdown).toContain("The next step, 500 tasks, failed: a steer took 640 ms at p99");

    // Each bar on its own.
    expect(judgeStep(step(100, { steer: { sent: 10, received: 10, lost: 0, latencyMs: { count: 10, p50: 100, p99: 500, max: 500 } } })).held).toBe(false);
    expect(judgeStep(step(100, { events: { offered: 10, stored: 10, duplicates: 1, missing: 0, perTaskPerMinute: 1 } })).failures).toEqual(["1 events were stored twice"]);
    expect(judgeStep(step(100, { events: { offered: 10, stored: 9, duplicates: 0, missing: 1, perTaskPerMinute: 1 } })).held).toBe(false);
    expect(judgeStep(step(100, { dispatched: 90 })).failures).toEqual(["10 of 100 tasks were never dispatched"]);
    expect(judgeStep(step(100, { storm: { runners: 100, reconnected: 97, seconds: null } })).held).toBe(false);
    expect(judgeStep(step(100, { error: "core exited" })).held).toBe(false);
    // A run where nothing held, and one where everything did.
    expect(judgeRun([step(100, { dispatched: 0 })]).largestHeld).toBeNull();
    expect(judgeRun([step(100), step(250)])).toMatchObject({ largestHeld: 250, next: null });
  });
});
