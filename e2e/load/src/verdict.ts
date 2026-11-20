import { z } from "zod";

// The load test's bars and its verdict (ticket 34, F-117). A step holds when every bar holds:
// - a steer reaches its runner in under 500 ms at p99, from `packages/api`'s call to the runner's receipt
// - every event the runners offered is stored exactly once, checked after the drain
// - no command is lost: every steer sent reaches its runner, the reconnect storm's included
// - every task the step started was dispatched to a runner
// The summary names the largest step that held and how the next one failed. A results file is
// read back from disk, so it is parsed with its schema.

export const bars = { steerP99Ms: 500 } as const;

const summarySchema = z.strictObject({ count: z.number().int().nonnegative(), p50: z.number().nullable(), p99: z.number().nullable(), max: z.number().nullable() });

export const stepResultSchema = z.strictObject({
  tasks: z.number().int().positive(),
  replicas: z.number().int().positive(),
  generators: z.number().int().positive(),
  runners: z.number().int().positive(),
  startedAt: z.string(),
  /** Seconds the measured window ran with every task going. */
  windowSeconds: z.number().nonnegative(),
  /** How many of the step's tasks were dispatched to a runner. */
  dispatched: z.number().int().nonnegative(),
  steer: z.strictObject({ sent: z.number().int().nonnegative(), received: z.number().int().nonnegative(), lost: z.number().int().nonnegative(), latencyMs: summarySchema }),
  events: z.strictObject({
    offered: z.number().int().nonnegative(),
    stored: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
    /** Offered a minute a task over the window, as the rate check. */
    perTaskPerMinute: z.number().nonnegative(),
  }),
  ackMs: summarySchema,
  ingestMs: z.strictObject({ frames: z.number().int().nonnegative(), p50: z.number().nullable(), p99: z.number().nullable(), max: z.number().nullable() }),
  postgres: z.strictObject({ samples: z.number().int().nonnegative(), meanCores: z.number().nullable(), maxCores: z.number().nullable(), source: z.string() }),
  replicaMemoryMiB: z.array(z.number().nullable()),
  storm: z.strictObject({ runners: z.number().int().nonnegative(), reconnected: z.number().int().nonnegative(), seconds: z.number().nullable() }).nullable(),
  browsers: z.strictObject({ pages: z.number().int().nonnegative(), marks: z.number().int().nonnegative(), seen: z.number().int().nonnegative(), latencyMs: summarySchema }).nullable(),
  /** Set when the step stopped before its measurements: what went wrong. */
  error: z.string().nullable(),
});
export type StepResult = z.infer<typeof stepResultSchema>;

export const runResultsSchema = z.strictObject({ machine: z.string(), steps: z.array(stepResultSchema) });
export type RunResults = z.infer<typeof runResultsSchema>;

export type StepVerdict = { readonly tasks: number; readonly held: boolean; readonly failures: readonly string[] };

export const judgeStep = (step: StepResult): StepVerdict => {
  const failures: string[] = [];
  if (step.error !== null) failures.push(`it stopped: ${step.error}`);
  if (step.dispatched < step.tasks) failures.push(`${String(step.tasks - step.dispatched)} of ${String(step.tasks)} tasks were never dispatched`);
  const p99 = step.steer.latencyMs.p99;
  if (step.steer.sent === 0) failures.push("no steer was sent");
  else if (p99 === null || p99 >= bars.steerP99Ms) failures.push(`a steer took ${p99 === null ? "forever" : `${String(Math.round(p99))} ms`} at p99 (the bar is under ${String(bars.steerP99Ms)} ms)`);
  if (step.steer.lost > 0) failures.push(`${String(step.steer.lost)} of ${String(step.steer.sent)} steers never reached their runner`);
  if (step.events.offered === 0) failures.push("no event was offered");
  if (step.events.duplicates > 0) failures.push(`${String(step.events.duplicates)} events were stored twice`);
  if (step.events.missing > 0) failures.push(`${String(step.events.missing)} of ${String(step.events.offered)} offered events were never stored`);
  if (step.storm !== null && step.storm.reconnected < step.storm.runners) failures.push(`${String(step.storm.runners - step.storm.reconnected)} runners didn't come back after the reconnect storm`);
  return { tasks: step.tasks, held: failures.length === 0, failures };
};

export type RunVerdict = {
  /** The largest step that held every bar, `null` when none did. */
  readonly largestHeld: number | null;
  /** The first step past it, and why it failed; `null` when every step held. */
  readonly next: StepVerdict | null;
  readonly steps: readonly StepVerdict[];
};

/** Steps in the order they ran: the largest that held is the largest step at or below which every step held. */
export const judgeRun = (steps: readonly StepResult[]): RunVerdict => {
  const verdicts = [...steps].sort((a, b) => a.tasks - b.tasks).map(judgeStep);
  let largestHeld: number | null = null;
  let next: StepVerdict | null = null;
  for (const verdict of verdicts) {
    if (!verdict.held) {
      next = verdict;
      break;
    }
    largestHeld = verdict.tasks;
  }
  return { largestHeld, next, steps: verdicts };
};

const ms = (value: number | null): string => (value === null ? "-" : `${String(Math.round(value))} ms`);

/** The summary in Markdown: the verdict first, then one row per step. */
export const summaryMarkdown = (results: RunResults): string => {
  const verdict = judgeRun(results.steps);
  const head =
    verdict.largestHeld === null
      ? "No step held every bar."
      : `The largest step that held every bar: **${String(verdict.largestHeld)} tasks**.`;
  const next = verdict.next === null ? "Every step held." : `The next step, ${String(verdict.next.tasks)} tasks, failed: ${verdict.next.failures.join("; ")}.`;
  const rows = [...results.steps]
    .sort((a, b) => a.tasks - b.tasks)
    .map((step) => {
      const held = judgeStep(step).held ? "held" : "failed";
      const pg = step.postgres.meanCores === null ? "-" : `${step.postgres.meanCores.toFixed(2)} / ${(step.postgres.maxCores ?? 0).toFixed(2)}`;
      const memory = step.replicaMemoryMiB.map((value) => (value === null ? "-" : String(Math.round(value)))).join(", ");
      const storm = step.storm === null ? "-" : `${String(step.storm.reconnected)}/${String(step.storm.runners)} in ${step.storm.seconds === null ? "-" : `${step.storm.seconds.toFixed(1)} s`}`;
      const browsers = step.browsers === null ? "-" : `${String(step.browsers.seen)}/${String(step.browsers.marks)}, p50 ${ms(step.browsers.latencyMs.p50)}, p99 ${ms(step.browsers.latencyMs.p99)}`;
      return `| ${String(step.tasks)} | ${held} | ${String(step.dispatched)} | ${ms(step.steer.latencyMs.p50)} / ${ms(step.steer.latencyMs.p99)} | ${String(step.steer.received)}/${String(step.steer.sent)} | ${String(step.events.stored)}/${String(step.events.offered)} (dup ${String(step.events.duplicates)}) | ${step.events.perTaskPerMinute.toFixed(0)} | ${ms(step.ackMs.p50)} / ${ms(step.ackMs.p99)} | ${ms(step.ingestMs.p50)} / ${ms(step.ingestMs.p99)} | ${pg} | ${memory} | ${storm} | ${browsers} |`;
    });
  return [
    head,
    next,
    "",
    "| Tasks | Verdict | Dispatched | Steer p50 / p99 | Steers received | Events stored once / offered | Events a minute a task | Ack p50 / p99 | Ingest p50 / p99 | Postgres cores, mean / max | Core memory MiB | Reconnect storm | Browsers (seen, latency) |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
};
