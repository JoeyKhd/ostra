import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realRatingChecks, realRecordingChecks, realRunChecks } from "../src/harness/real-criteria.ts";
import { findRealSets, findRealSheet, REQUIRED_RUN_IDS, type RealSet } from "../src/harness/real-sets.ts";
import { statusOf } from "../src/harness/report.ts";
import { RunIdSchema } from "../src/runner/schemas.ts";
import { barRuns, record, writeRealSet } from "./support.ts";

let runsDir = "";

beforeEach(async () => {
  runsDir = await mkdtemp(path.join(os.tmpdir(), "real-sets-"));
});

afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

const only = async (): Promise<RealSet> => {
  const sets = await findRealSets(runsDir);
  const first = sets[0];
  if (first === undefined) throw new Error("no set found");
  return first;
};

/** A sheet's key for the runs of a set, as `pnpm sheet` writes it. */
const writeSheet = async (name: string, set: RealSet, createdAt: string, runIds: readonly string[] = set.runs.map((run) => run.record.runId)): Promise<void> => {
  const dir = path.join(runsDir, name);
  await mkdir(path.join(dir, "ratings"), { recursive: true });
  const entries = runIds.map((runId, i) => ({ id: `R-${i.toString(16).padStart(6, "0")}`, runId, ticketId: runId.replace(/-r\d+$/, ""), setDir: set.rel }));
  await writeFile(path.join(dir, "key.json"), JSON.stringify({ schema: 1, seed: 1, createdAt, entries }));
  const rows = entries.map((entry) => `${entry.id},merge-as-is,`);
  await writeFile(path.join(dir, "ratings", "reviewer.csv"), `id,rating,notes\n${rows.join("\n")}\n`);
};

describe("a set of one run is not the bar's runs", () => {
  it("is not complete, however its own manifest reads", async () => {
    await writeRealSet(runsDir, "real-model-x", [record({ mode: "real", label: "model-x" })], { tickets: [], runsPerTicket: 1 });
    const set = await only();
    expect(set.manifest.runsPerTicket).toBe(1);
    expect(set.expected).toBe(30);
    expect(set.recorded).toBe(1);
    expect(set.complete).toBe(false);
  });

  it("is complete only with every one of the 30 runs: 10 tickets, three each", async () => {
    expect(REQUIRED_RUN_IDS).toHaveLength(30);
    const runs = barRuns();
    await writeRealSet(runsDir, "real-model-x", runs.slice(0, 29));
    expect((await only()).complete).toBe(false);
    await writeRealSet(runsDir, "real-model-x", runs);
    const set = await only();
    expect(set.recorded).toBe(30);
    expect(set.complete).toBe(true);
  });

  it("reports B1 SKIPPED with the count, not PASS", async () => {
    await writeRealSet(runsDir, "real-model-x", [record({ mode: "real", label: "model-x" })]);
    const checks = realRunChecks([await only()]);
    expect(statusOf(checks)).toBe("SKIPPED");
    expect(checks[0]?.note).toContain("1 of 30 runs recorded");
  });

  it("reports B2 and B3 SKIPPED even when a sheet of that one run is rated merge-as-is", async () => {
    await writeRealSet(runsDir, "real-model-x", [record({ mode: "real", label: "model-x" })]);
    const set = await only();
    await writeSheet("rating-2026-11-18T10-00-00-aaaa", set, "2026-11-18T10:00:00.000Z");
    const search = await findRealSheet([set], runsDir);
    expect(search.sheet).toBeUndefined();
    expect(search.stale).toBe(1);
    expect(statusOf(realRatingChecks([set], search))).toBe("SKIPPED");
    const recording = realRecordingChecks([set], undefined);
    expect(statusOf(recording)).toBe("SKIPPED");
    expect(recording[0]?.note).toContain("1 of 30 runs recorded");
  });
});

describe("a complete set", () => {
  it("passes B1, and B3 once every run is priced and the proxy's count matches OpenCode's", async () => {
    await writeRealSet(runsDir, "real-model-x", barRuns());
    const set = await only();
    expect(statusOf(realRunChecks([set]))).toBe("PASS");
    expect(statusOf(realRecordingChecks([set], []))).toBe("PASS");
  });

  it("leaves B3 SKIPPED when the runs have no dollars (no prices set)", async () => {
    await writeRealSet(runsDir, "real-model-x", barRuns(() => ({ spend: { ...record().spend, usd: null, pricing: "none" } })));
    const checks = realRecordingChecks([await only()], []);
    expect(statusOf(checks)).toBe("SKIPPED");
    expect(checks[0]?.note).toContain("OSTRA_SPIKE_PRICE_INPUT");
  });

  it("fails B3 when the proxy's count is not within 2% of OpenCode's own turn usage on a completed run", async () => {
    await writeRealSet(runsDir, "real-model-x", barRuns((t, i) => (t === 3 && i === 2 ? { spend: { ...record().spend, turnTokens: 200, agentReportedTokens: 110 } } : {})));
    const checks = realRecordingChecks([await only()], []);
    expect(statusOf(checks)).toBe("FAIL");
    expect(checks[0]?.note).toContain("calc-3-r2");
  });

  it("fails B3 whatever the state of the set when a real key is in a record", async () => {
    await writeRealSet(runsDir, "real-model-x", [record({ mode: "real", label: "model-x" })]);
    const set = await only();
    const checks = realRecordingChecks([set], [{ rel: set.rel, files: 3, hits: ["runs/calc-1-r1/proxy-log.jsonl"] }]);
    expect(statusOf(checks)).toBe("FAIL");
  });
});

describe("infrastructure failures", () => {
  it("keep B1, B2 and B3 SKIPPED until they are redone", async () => {
    await writeRealSet(runsDir, "real-model-x", barRuns((t, i) => (t === 4 && i === 1 ? { outcome: "error", error: "the turn failed" } : t === 5 && i === 1 ? { outcome: "timeout", modelErrors: { rateLimited: 3, serverErrors: 0, clientErrors: 0 } } : {})));
    const set = await only();
    expect(set.complete).toBe(true);
    expect(set.needRetry).toEqual(["calc-4-r1", "calc-5-r1"]);
    for (const checks of [realRunChecks([set]), realRatingChecks([set], { sheet: undefined, stale: 0 }), realRecordingChecks([set], [])]) {
      expect(statusOf(checks)).toBe("SKIPPED");
      expect(checks[0]?.note).toContain("--retry-failed");
    }
  });

  it("do not count a completed run that merely saw a retried 429", async () => {
    await writeRealSet(runsDir, "real-model-x", barRuns((t, i) => (t === 1 && i === 1 ? { modelErrors: { rateLimited: 2, serverErrors: 0, clientErrors: 0 } } : {})));
    expect((await only()).needRetry).toEqual([]);
  });
});

describe("which sheet is the set's rating", () => {
  it("is the one that shows exactly the 30 runs, made after the last of them ended", async () => {
    await writeRealSet(runsDir, "real-model-x", barRuns());
    const set = await only();
    await writeSheet("rating-2026-11-18T12-00-00-aaaa", set, "2026-11-18T12:00:00.000Z");
    const search = await findRealSheet([set], runsDir);
    expect(search.stale).toBe(0);
    expect(search.sheet?.verdicts[0]?.verdict.status).toBe("PASS");
    expect(statusOf(realRatingChecks([set], search))).toBe("PASS");
  });

  it("is not a sheet made when only some runs existed, nor one that leaves a run out", async () => {
    await writeRealSet(runsDir, "real-model-x", barRuns());
    const set = await only();
    await writeSheet("rating-2026-11-18T12-00-00-aaaa", set, "2026-11-18T12:00:00.000Z", set.runs.slice(0, 12).map((run) => run.record.runId));
    const search = await findRealSheet([set], runsDir);
    expect(search.sheet).toBeUndefined();
    expect(search.stale).toBe(1);
  });

  it("is not a sheet made before a run was redone", async () => {
    await writeRealSet(runsDir, "real-model-x", barRuns((t, i) => (t === 2 && i === 2 ? { endedAt: "2026-11-18T13:00:00.000Z" } : {})));
    const set = await only();
    await writeSheet("rating-2026-11-18T12-00-00-aaaa", set, "2026-11-18T12:00:00.000Z");
    const search = await findRealSheet([set], runsDir);
    expect(search.sheet).toBeUndefined();
    expect(search.stale).toBe(1);
  });

  it("ignores a sheet of runs that are not a real set's (the dry-run's)", async () => {
    await writeRealSet(runsDir, "real-model-x", barRuns());
    const set = await only();
    await writeSheet("rating-2026-11-18T12-00-00-aaaa", { ...set, rel: ".runs/dry-something" }, "2026-11-18T12:00:00.000Z");
    const search = await findRealSheet([set], runsDir);
    expect(search.sheet).toBeUndefined();
    expect(search.stale).toBe(0);
  });

  it("run IDs are branded: only a well-formed one is a run", () => {
    expect(RunIdSchema.safeParse(REQUIRED_RUN_IDS[0]).success).toBe(true);
  });
});
