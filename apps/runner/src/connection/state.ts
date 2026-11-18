import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { commandIdSchema, commandKindSchema, commandSeqSchema, leaseEpochSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import { z } from "zod";

// The runner's own durable state (ADR 0034): the commands it applied, the one it was in the middle
// of, and the sessions it holds with their lease epochs. It's what lets a restarted runner apply
// each command once, report `outcome-unknown` for one a crash cut off, and resend every unacked
// event. Ported from spikes/runner-transport/src/runner/state.ts.

/** How many applied command IDs are remembered, to apply a resent command once. */
export const APPLIED_IDS_KEPT = 1_000;

export const sessionStateSchema = z.enum([
  /** A producer is writing events for it. */
  "open",
  /** Nothing more will be written: removed once every event is acked. */
  "closing",
  /** The server refused its lease epoch: its spool is discarded (Q111). */
  "stale",
]);
export type SessionState = z.infer<typeof sessionStateSchema>;

export const runnerStateSchema = z.strictObject({
  /** The highest seq such that every command up to it was applied. */
  lastContiguousSeq: z.number().int().nonnegative(),
  /** Applied seqs above `lastContiguousSeq` (a gap below them). */
  appliedAbove: z.array(commandSeqSchema),
  /** The IDs of recent applied commands. */
  applied: z.array(commandIdSchema).max(APPLIED_IDS_KEPT),
  /** The command being applied: set before it starts, cleared after it finishes. */
  inflight: z.strictObject({ id: commandIdSchema, seq: commandSeqSchema, kind: commandKindSchema }).nullable(),
  sessions: z.array(
    z.strictObject({ sessionId: sessionIdSchema, taskId: taskIdSchema, leaseEpoch: leaseEpochSchema, state: sessionStateSchema }),
  ),
});
export type RunnerState = z.infer<typeof runnerStateSchema>;

export type StateStore = {
  readonly load: () => Promise<RunnerState>;
  readonly save: (state: RunnerState) => Promise<void>;
};

export const emptyRunnerState = (): RunnerState => ({
  lastContiguousSeq: 0,
  appliedAbove: [],
  applied: [],
  inflight: null,
  sessions: [],
});

export const fileStateStore = (file: string): StateStore => {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    load: async () => {
      await mkdir(path.dirname(file), { recursive: true });
      try {
        const parsed = runnerStateSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
        return parsed.success ? parsed.data : emptyRunnerState();
      } catch {
        return emptyRunnerState();
      }
    },
    save: (state) => {
      const text = JSON.stringify(state);
      const next = chain.then(async () => {
        const temporary = `${file}.tmp`;
        await writeFile(temporary, text);
        await rename(temporary, file);
      });
      chain = next.catch(() => undefined);
      return next;
    },
  };
};

/** Records `seq` as applied and moves the contiguous mark over any run it completes. */
export const markApplied = (state: RunnerState, seq: number, id: RunnerState["applied"][number]): RunnerState => {
  const above = new Set(state.appliedAbove);
  if (seq > state.lastContiguousSeq) {
    above.add(seq);
  }
  let contiguous = state.lastContiguousSeq;
  while (above.has(contiguous + 1)) {
    contiguous += 1;
    above.delete(contiguous);
  }
  return {
    ...state,
    lastContiguousSeq: contiguous,
    appliedAbove: [...above].sort((a, b) => a - b),
    applied: [...state.applied, id].slice(-APPLIED_IDS_KEPT),
  };
};

/** Whether a command was applied before, by its ID or its seq. */
export const wasApplied = (state: RunnerState, seq: number, id: RunnerState["applied"][number]): boolean =>
  seq <= state.lastContiguousSeq || state.appliedAbove.includes(seq) || state.applied.includes(id);
