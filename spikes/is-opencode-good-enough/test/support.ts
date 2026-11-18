import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RunIdSchema, RunRecordSchema, SetManifestSchema, type RunRecord, type SetManifest } from "../src/runner/schemas.ts";
import { ticketId } from "../src/tickets/schema.ts";

/** A complete, valid run record, with any field replaced. */
export const record = (overrides: Partial<RunRecord> = {}): RunRecord =>
  RunRecordSchema.parse({
    schema: 1,
    runId: "calc-1-r1",
    ticketId: "calc-1",
    kind: "bug",
    index: 1,
    label: "dry",
    mode: "dry",
    variant: "good",
    model: { id: "stub-coder", format: "openai" },
    agent: { name: "opencode", version: "2.3.2", sha256: "0".repeat(64) },
    startedAt: "2026-11-18T00:00:00.000Z",
    endedAt: "2026-11-18T00:00:01.000Z",
    outcome: "completed",
    stopReason: "end_turn",
    error: null,
    time: { wallMs: 1000, startupMs: 500 },
    turns: { prompts: 1, modelCalls: 5, auxiliaryCalls: 1, toolCalls: 4, questions: 0 },
    approvals: { policy: "p", requested: 0, allowed: 0, rejected: 0, byKind: {} },
    events: { total: 17, perMinute: 1020, byUpdate: { tool_call: 4 }, wireMessages: 19, wireBytes: 3000 },
    spend: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 120, turnTokens: 110, usd: 0.0006, pricing: "stub", callsWithoutUsage: 0, agentReportedTokens: 110 },
    modelErrors: { rateLimited: 0, serverErrors: 0, clientErrors: 0 },
    diff: { files: [{ path: "src/parser.ts", insertions: 2, deletions: 1 }], insertions: 2, deletions: 1 },
    checks: {
      ci: { tests: { total: 35, pass: 35, fail: 0, ran: true }, typecheck: { ok: true, errors: 0 }, green: true },
      acceptance: { kind: "behavior", passed: true, tests: { total: 7, pass: 7, fail: 0 }, detail: "" },
      touchedSource: false,
    },
    ...overrides,
  });

/** Every run the bar asks for, as a record on a real set: 10 tickets, three runs each. */
export const barRuns = (overrides: (ticketNumber: number, index: number) => Partial<RunRecord> = () => ({})): RunRecord[] =>
  Array.from({ length: 10 }, (_, t) => t + 1).flatMap((ticketNumber) =>
    [1, 2, 3].map((index) =>
      record({
        runId: RunIdSchema.parse(`calc-${String(ticketNumber)}-r${String(index)}`),
        ticketId: ticketId(`calc-${String(ticketNumber)}`),
        index,
        label: "model-x",
        mode: "real",
        model: { id: "model-x", format: "anthropic" },
        ...overrides(ticketNumber, index),
      }),
    ),
  );

/** A real set on disk: its manifest, and a folder with a run.json for each record. */
export const writeRealSet = async (runsDir: string, name: string, records: readonly RunRecord[], manifest: Partial<SetManifest> = {}): Promise<string> => {
  const dir = path.join(runsDir, name);
  const full: SetManifest = SetManifestSchema.parse({
    schema: 1,
    label: "model-x",
    mode: "real",
    createdAt: "2026-11-18T00:00:00.000Z",
    tickets: [...new Set(records.map((r) => r.ticketId))],
    runsPerTicket: 3,
    model: { id: "model-x", format: "anthropic" },
    pricing: "configured",
    policy: "p",
    limits: { timeoutMs: 1_200_000, maxTokens: 3_000_000, maxUsd: null },
    agent: { name: "opencode", version: "2.3.2", sha256: "0".repeat(64) },
    node: "v24.14.0",
    platform: "test",
    ...manifest,
  });
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "set.json"), JSON.stringify(full));
  for (const r of records) {
    const runDir = path.join(dir, "runs", r.runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "run.json"), JSON.stringify(r));
  }
  return dir;
};
