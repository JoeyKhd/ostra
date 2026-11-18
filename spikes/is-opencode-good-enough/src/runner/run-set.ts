// A set of runs: every ticket, a number of times each, in one folder. A set is
// resumable: a run that already has its record is kept, whatever its outcome,
// so an interrupted set carries on without paying for the same run twice. A
// run that ended in an error or a crash, or hit a rate limit or a server error,
// has a record too, and stays: `retryFailed` (--retry-failed) deletes those
// first, so they run again, and the manifest counts how many were redone.
// Runs are queued run by run across the tickets (every ticket's first run,
// then every ticket's second), so a set cut short still covers them all.

import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenCodeBinary } from "../lib/opencode.ts";
import type { Ticket } from "../tickets/schema.ts";
import { POLICY_NAME } from "./policy.ts";
import { executeRun, type ModelTarget, type RunLimits, type RunLogger } from "./run-ticket.ts";
import type { RunRecord, SetManifest } from "./schemas.ts";
import { needsRetry } from "./retry.ts";
import { loadRuns, readManifest, runsDirOf } from "./set-io.ts";
import { removeDir } from "./workspace.ts";

export type SetOptions = {
  readonly setDir: string;
  readonly label: string;
  readonly mode: "dry" | "real";
  readonly tickets: readonly Ticket[];
  readonly runsPerTicket: number;
  readonly concurrency: number;
  readonly limits: RunLimits;
  readonly modelFor: (ticket: Ticket, index: number) => ModelTarget;
  /** What goes in the manifest: the model's ID and API format, and how spend is priced. Never a key or an address. */
  readonly modelInfo: SetManifest["model"];
  readonly pricing: SetManifest["pricing"];
  readonly binary: OpenCodeBinary;
  readonly log: RunLogger;
  /** Called as each run finishes, for progress lines. */
  readonly onRecord?: (record: RunRecord) => void;
  /** Stops queueing new runs once this returns true (an interrupt). */
  readonly stopRequested?: () => boolean;
  /** Deletes the recorded runs that ended in an error or a crash, or hit model errors, so this call runs them again. */
  readonly retryFailed?: boolean;
};

export type SetResult = {
  readonly records: readonly RunRecord[];
  /** Runs that were already recorded and so were not run again. */
  readonly reused: readonly string[];
  /** Runs that threw: no record was written, so a resume tries them again. */
  readonly failed: readonly { readonly runId: string; readonly message: string }[];
  /** Recorded runs deleted by `retryFailed` and queued again. */
  readonly retried: readonly string[];
};

export const runSet = async (options: SetOptions): Promise<SetResult> => {
  const runsDir = runsDirOf(options.setDir);
  await mkdir(runsDir, { recursive: true });

  const existing = await readManifest(options.setDir);
  if (existing !== undefined && (existing.label !== options.label || existing.mode !== options.mode || existing.model.id !== options.modelInfo.id)) {
    throw new Error(`${options.setDir} holds a set of another model or mode (${existing.mode} ${existing.label}); use another --set or --fresh`);
  }
  const retried: string[] = [];
  if (options.retryFailed === true) {
    for (const run of await loadRuns(options.setDir)) {
      if (!needsRetry(run.record)) continue;
      await removeDir(run.dir);
      retried.push(run.record.runId);
    }
  }
  const manifest: SetManifest = {
    schema: 1,
    label: options.label,
    mode: options.mode,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    tickets: options.tickets.map((ticket) => ticket.id),
    runsPerTicket: options.runsPerTicket,
    retriedRuns: (existing?.retriedRuns ?? 0) + retried.length,
    model: options.modelInfo,
    pricing: options.pricing,
    policy: POLICY_NAME,
    limits: { timeoutMs: options.limits.timeoutMs, maxTokens: options.limits.maxTokens, maxUsd: options.limits.maxUsd ?? null },
    agent: { name: "opencode", version: options.binary.packageVersion, sha256: options.binary.sha256 },
    node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
  };
  await writeFile(path.join(options.setDir, "set.json"), JSON.stringify(manifest, null, 2));

  const done = new Map<string, RunRecord>((await loadRuns(options.setDir)).map((run) => [run.record.runId, run.record]));
  const queue: { ticket: Ticket; index: number }[] = [];
  const reused: string[] = [];
  for (let index = 1; index <= options.runsPerTicket; index += 1) {
    for (const ticket of options.tickets) {
      const id = `${ticket.id}-r${String(index)}`;
      if (done.has(id)) reused.push(id);
      else queue.push({ ticket, index });
    }
  }

  const records: RunRecord[] = [...done.values()];
  const failed: { runId: string; message: string }[] = [];
  const next = (): { ticket: Ticket; index: number } | undefined => (options.stopRequested?.() === true ? undefined : queue.shift());
  const worker = async (): Promise<void> => {
    for (let item = next(); item !== undefined; item = next()) {
      try {
        const record = await executeRun(
          { runsDir, label: options.label, ticket: item.ticket, index: item.index, model: options.modelFor(item.ticket, item.index), limits: options.limits, binary: options.binary },
          options.log,
        );
        records.push(record);
        options.onRecord?.(record);
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 300) : "the run failed";
        failed.push({ runId: `${item.ticket.id}-r${String(item.index)}`, message });
        options.log({ event: "run.failed", runId: `${item.ticket.id}-r${String(item.index)}` });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, async () => worker()));
  return { records, reused, failed, retried };
};
