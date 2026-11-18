// C2. `kill -9` on one of two replicas mid-job: the job resumes on the other, and a fake GitHub
// that counts idempotency keys sees no duplicate.
//
// Two replicas share one Postgres. Six jobs each create a pull request on the fake GitHub: look it up
// by its branch first (`GET /pulls?head=...`, the call the real adapter will make), create it if it
// is not there (POST with an Idempotency-Key), and record a `job_run` row at each step. The replica
// holding the most jobs is killed with SIGKILL. pg-boss's heartbeat and supervise pass free its jobs,
// the other replica runs them again, and the check-first handler decides what the retry does.
//
// Three kill points, each with its own run (and, where it shows something, a control):
//   C2   the kill comes after every effect landed and every handler recorded it, while the jobs keep
//        working. The control (a handler with no lookup) must duplicate, or nothing was proved.
//   C2b  the kill comes in the check-then-POST gap: the fake has accepted and counted the POST, and
//        holds the response (x-hold-ms), so the handler has not yet recorded `created`. The effect
//        exists and no one on the replica's side knows. The retry must find it by its branch.
//        The control must duplicate again.
//   C2c  the kill comes before the effect lands: the fake holds the request before counting it
//        (x-hold-before-ms) and drops it when the client dies. The retry must create the effect once.
//
// In every run: all six jobs end completed, and the fake counts six POSTs for six keys.

import { z } from "zod";
import { dbNowMs, fmtMs, openScenario } from "../kit.ts";
import type { CriterionResult, RunContext } from "../kit.ts";
import { waitUntil } from "../proc.ts";

export const id = "C2";
export const criterion =
  "`kill -9` on one of two replicas mid-job: the job resumes on the other, and a fake GitHub that counts idempotency keys sees no duplicate.";

const runRowSchema = z.object({
  job_id: z.string(),
  attempt: z.number(),
  replica_id: z.string(),
  phase: z.string(),
  at_ms: z.coerce.number(),
});

const jobRowSchema = z.object({
  id: z.string(),
  state: z.string(),
  retry_count: z.number(),
});

type Variant = {
  readonly label: string;
  /** The scenario database's name (the cluster adds the run's suffix). */
  readonly scenarioName: string;
  /** A handler with no lookup: the control. */
  readonly naive: boolean;
  /** How long a job keeps working after its effect landed (first attempt only). */
  readonly holdMs: number;
  /** The fake holds the request before counting it. */
  readonly beforeCountHoldMs: number;
  /** The fake counts the request, then holds the response. */
  readonly afterCountHoldMs: number;
  /** The moment the harness kills the victim. */
  readonly killWhen: "effects-recorded" | "posts-counted" | "requests-held";
};

type KillRun = {
  readonly victim: string;
  readonly survivor: string;
  readonly jobs: number;
  readonly jobsOnVictim: number;
  readonly resumedOnSurvivor: number;
  readonly survivorOwn: number;
  readonly survivorOwnRetried: number;
  readonly allCompleted: boolean;
  readonly duplicateKeys: readonly string[];
  readonly totalPosts: number;
  readonly postsAtKill: number;
  readonly heldAtKill: number;
  /** `created` rows the victim wrote before it died. */
  readonly victimRecordedCreated: number;
  /** Retried attempts that found the effect through the lookup and skipped the call. */
  readonly skipExisting: number;
  /** Retried attempts that created the effect. */
  readonly retryCreated: number;
  readonly resumeMs: number;
  readonly finishMs: number;
};

const JOBS = 6;

const variants = {
  main: {
    label: "C2",
    scenarioName: "c2_kill_mid_job",
    naive: false,
    holdMs: 30_000,
    beforeCountHoldMs: 0,
    afterCountHoldMs: 0,
    killWhen: "effects-recorded",
  },
  control: {
    label: "C2 control",
    scenarioName: "c2_control_naive",
    naive: true,
    holdMs: 30_000,
    beforeCountHoldMs: 0,
    afterCountHoldMs: 0,
    killWhen: "effects-recorded",
  },
  afterPost: {
    label: "C2b",
    scenarioName: "c2b_after_post",
    naive: false,
    holdMs: 0,
    beforeCountHoldMs: 0,
    afterCountHoldMs: 10_000,
    killWhen: "posts-counted",
  },
  afterPostControl: {
    label: "C2b control",
    scenarioName: "c2b_control_naive",
    naive: true,
    holdMs: 0,
    beforeCountHoldMs: 0,
    afterCountHoldMs: 10_000,
    killWhen: "posts-counted",
  },
  beforePost: {
    label: "C2c",
    scenarioName: "c2c_before_post",
    naive: false,
    holdMs: 0,
    beforeCountHoldMs: 10_000,
    afterCountHoldMs: 0,
    killWhen: "requests-held",
  },
} as const satisfies Record<string, Variant>;

const runKill = async (ctx: RunContext, variant: Variant): Promise<KillRun> => {
  const scenario = await openScenario(ctx, variant.scenarioName);
  const { db, github } = scenario;
  const queue = variant.naive ? "github-effect-naive" : "github-effect";
  const worker = variant.naive ? "effectNaive" : "effect";
  try {
    // Six slots each: the survivor must have a free worker for the freed jobs, or the measured
    // resume time would be the length of its own jobs and not pg-boss's recovery.
    const replicas = [
      await scenario.startReplica("replica-1", [worker], { localConcurrency: JOBS }),
      await scenario.startReplica("replica-2", [worker], { localConcurrency: JOBS }),
    ];
    const panel = await scenario.startPanel("panel-1");

    const keys = Array.from({ length: JOBS }, (_, index) => `effect-${String(index + 1)}`);
    await panel.call({
      type: "enqueue-effects",
      naive: variant.naive,
      jobs: keys.map((key) => ({
        key,
        holdMs: variant.holdMs,
        beforeCountHoldMs: variant.beforeCountHoldMs,
        afterCountHoldMs: variant.afterCountHoldMs,
      })),
    });

    // The moment the kill is for: see the variants above.
    await waitUntil(
      () => (variant.killWhen === "requests-held" ? github.heldBeforeCount() === JOBS : github.totalPosts() === JOBS),
      { timeoutMs: 60_000, intervalMs: variant.killWhen === "effects-recorded" ? 200 : 20, what: `the ${variant.killWhen} point` },
    );

    // Whoever holds the most jobs. Every handler records `start` before it makes its first call.
    const holders = await db.query(
      "SELECT replica_id, count(*)::int AS n FROM job_run WHERE queue = $1 AND phase = 'start' AND attempt = 0 GROUP BY replica_id ORDER BY n DESC",
      [queue],
      z.object({ replica_id: z.string(), n: z.number() }),
    );
    const victimId = holders[0]?.replica_id;
    const jobsOnVictim = holders[0]?.n ?? 0;
    const victim = replicas.find((replica) => replica.id === victimId);
    const survivor = replicas.find((replica) => replica.id !== victimId);
    if (victim === undefined || survivor === undefined || jobsOnVictim === 0) {
      throw new Error("no replica held a job at the kill point");
    }
    const postsAtKill = github.totalPosts();
    const heldAtKill = github.heldBeforeCount();
    ctx.note(
      `${variant.label}: killing ${victim.id} (holds ${String(jobsOnVictim)} of ${String(JOBS)} jobs; the fake has counted ${String(postsAtKill)} POSTs and holds ${String(heldAtKill)} requests) with SIGKILL`,
    );

    const killedAt = await dbNowMs(db);
    await victim.kill9();

    await waitUntil(
      async () => {
        const rows = await db.query("SELECT id, state, retry_count FROM pgboss.job WHERE name = $1", [queue], jobRowSchema);
        return rows.length === JOBS && rows.every((row) => row.state === "completed");
      },
      { timeoutMs: 180_000, intervalMs: 500, what: "all jobs to complete" },
    );

    const runs = await db.query(
      "SELECT job_id, attempt, replica_id, phase, (extract(epoch from at) * 1000)::float8 AS at_ms FROM job_run WHERE queue = $1 ORDER BY id",
      [queue],
      runRowSchema,
    );
    const jobs = await db.query("SELECT id, state, retry_count FROM pgboss.job WHERE name = $1", [queue], jobRowSchema);

    const victimJobIds = new Set(
      runs.filter((run) => run.phase === "start" && run.attempt === 0 && run.replica_id === victim.id).map((run) => run.job_id),
    );
    // A victim job counts as resumed if a later attempt ran to "done" on the survivor.
    const resumed = [...victimJobIds].filter((jobId) =>
      runs.some((run) => run.job_id === jobId && run.attempt >= 1 && run.phase === "done" && run.replica_id === survivor.id),
    );
    const survivorOwnIds = new Set(
      runs.filter((run) => run.phase === "start" && run.attempt === 0 && run.replica_id === survivor.id).map((run) => run.job_id),
    );
    const survivorOwnRetried = jobs.filter((job) => survivorOwnIds.has(job.id) && job.retry_count > 0).length;
    const retriedStarts = runs.filter((run) => run.phase === "start" && run.attempt >= 1).map((run) => run.at_ms);
    const lastDone = Math.max(...runs.filter((run) => run.phase === "done").map((run) => run.at_ms));

    return {
      victim: victim.id,
      survivor: survivor.id,
      jobs: jobs.length,
      jobsOnVictim,
      resumedOnSurvivor: resumed.length,
      survivorOwn: survivorOwnIds.size,
      survivorOwnRetried,
      allCompleted: jobs.every((job) => job.state === "completed"),
      duplicateKeys: github.duplicates(),
      totalPosts: github.totalPosts(),
      postsAtKill,
      heldAtKill,
      victimRecordedCreated: runs.filter((run) => run.phase === "created" && run.attempt === 0 && run.replica_id === victim.id).length,
      skipExisting: runs.filter((run) => run.phase === "skip-existing").length,
      retryCreated: runs.filter((run) => run.phase === "created" && run.attempt >= 1).length,
      resumeMs: retriedStarts.length > 0 ? Math.min(...retriedStarts) - killedAt : -1,
      finishMs: lastDone - killedAt,
    };
  } finally {
    await scenario.dispose();
  }
};

const dupText = (keys: readonly string[]): string => (keys.length === 0 ? "none" : keys.join(", "));

export const run = async (ctx: RunContext): Promise<CriterionResult> => {
  const main = await runKill(ctx, variants.main);
  const control = await runKill(ctx, variants.control);
  const afterPost = await runKill(ctx, variants.afterPost);
  const afterPostControl = await runKill(ctx, variants.afterPostControl);
  const beforePost = await runKill(ctx, variants.beforePost);

  const failures: string[] = [];
  const evidence: string[] = [];

  // Shared by every run: the jobs resumed, nothing else was disturbed, and no key was POSTed twice.
  const commonChecks = (label: string, result: KillRun): void => {
    if (!result.allCompleted) {
      failures.push(`${label}: not every job completed`);
    }
    if (result.resumedOnSurvivor !== result.jobsOnVictim) {
      failures.push(`${label}: ${String(result.resumedOnSurvivor)} of ${String(result.jobsOnVictim)} jobs the victim held were resumed on the survivor`);
    }
    if (result.survivorOwnRetried > 0) {
      failures.push(`${label}: ${String(result.survivorOwnRetried)} of the survivor's own jobs were retried`);
    }
    if (result.duplicateKeys.length > 0 || result.totalPosts !== JOBS) {
      failures.push(`${label}: fake GitHub saw ${String(result.totalPosts)} POSTs for ${String(JOBS)} keys; duplicated keys: ${dupText(result.duplicateKeys)}`);
    }
  };

  // C2: the kill after the effect landed and was recorded.
  commonChecks("C2", main);
  if (main.skipExisting < main.jobsOnVictim) {
    failures.push("C2: the lookup path did not run for every resumed job, so the run would be vacuous");
  }
  if (control.duplicateKeys.length === 0) {
    failures.push("C2 control: no duplicate, so the scenario did not prove that redelivery happens");
  }
  evidence.push(
    `C2: ${main.victim} was killed with SIGKILL after all ${String(JOBS)} effects had landed and while every job was still running; it held ${String(main.jobsOnVictim)} of them`,
    `C2: ${String(main.resumedOnSurvivor)} of ${String(main.jobsOnVictim)} jobs held by the victim were re-run to completion on ${main.survivor} (retryCount >= 1); all ${String(main.jobs)} jobs ended completed`,
    `C2: fake GitHub: ${String(main.totalPosts)} POSTs for ${String(JOBS)} idempotency keys, duplicated keys: ${dupText(main.duplicateKeys)}; the lookup by branch found the pull request ${String(main.skipExisting)} times and the retry skipped the call`,
    `C2: time from kill to the first retried attempt: ${fmtMs(main.resumeMs)}; to the last job done: ${fmtMs(main.finishMs)} (heartbeatSeconds 10 and monitor and supervise passes every 5 s; pg-boss's defaults for the passes are 60 s and were not measured)`,
    `C2 control (handler with no lookup, same kill): ${String(control.totalPosts)} POSTs for ${String(JOBS)} keys, ${String(control.duplicateKeys.length)} keys duplicated. At-least-once redelivery is real; the lookup is what prevents the duplicate`,
  );
  if (main.survivorOwn > 0) {
    evidence.push(`C2: the survivor's own ${String(main.survivorOwn)} jobs were not disturbed (no retries)`);
  }

  // C2b: the kill in the check-then-POST gap. The effect exists, the handler never recorded it.
  commonChecks("C2b", afterPost);
  if (afterPost.postsAtKill !== JOBS || afterPost.victimRecordedCreated !== 0) {
    failures.push(
      `C2b: the kill did not land in the gap (the fake had counted ${String(afterPost.postsAtKill)} POSTs, the victim had recorded ${String(afterPost.victimRecordedCreated)} created rows), so the run would be vacuous`,
    );
  }
  if (afterPost.skipExisting < afterPost.jobsOnVictim) {
    failures.push("C2b: the retry did not find the effect through the lookup by branch");
  }
  if (afterPostControl.duplicateKeys.length === 0) {
    failures.push("C2b control: no duplicate, so the gap was not a real window");
  }
  evidence.push(
    `C2b: the fake had accepted and counted all ${String(afterPost.postsAtKill)} POSTs and was holding the responses (10 s) when ${afterPost.victim} was killed; the victim had recorded ${String(afterPost.victimRecordedCreated)} created rows, so the effect existed and its handlers did not know (it held ${String(afterPost.jobsOnVictim)} jobs)`,
    `C2b: all ${String(afterPost.jobs)} jobs ended completed; the retried attempts found the pull requests by their branches (${String(afterPost.skipExisting)} lookups hit) and made no second call: fake GitHub ${String(afterPost.totalPosts)} POSTs for ${String(JOBS)} keys, duplicated keys: ${dupText(afterPost.duplicateKeys)}`,
    `C2b control (no lookup, same kill): ${String(afterPostControl.totalPosts)} POSTs for ${String(JOBS)} keys, ${String(afterPostControl.duplicateKeys.length)} keys duplicated: the gap is real, and the lookup is what closes it`,
  );

  // C2c: the kill before the effect lands. Nothing was counted; the retry must create it, once.
  commonChecks("C2c", beforePost);
  if (beforePost.postsAtKill !== 0 || beforePost.heldAtKill !== JOBS) {
    failures.push(
      `C2c: the kill did not land before the effect (the fake had counted ${String(beforePost.postsAtKill)} POSTs and held ${String(beforePost.heldAtKill)} requests), so the run would be vacuous`,
    );
  }
  if (beforePost.retryCreated < beforePost.jobsOnVictim) {
    failures.push("C2c: the retried attempts did not create the effect the victim never got to make");
  }
  evidence.push(
    `C2c: the fake was holding ${String(beforePost.heldAtKill)} requests it had not yet counted (${String(beforePost.postsAtKill)} POSTs counted) when ${beforePost.victim} was killed; its connections dropped and those requests were never counted`,
    `C2c: all ${String(beforePost.jobs)} jobs ended completed; the ${String(beforePost.jobsOnVictim)} victim jobs were retried on ${beforePost.survivor}, found nothing by branch and created the effect (${String(beforePost.retryCreated)} created on retry): fake GitHub ${String(beforePost.totalPosts)} POSTs for ${String(JOBS)} keys, duplicated keys: ${dupText(beforePost.duplicateKeys)}`,
    "not covered: a replica that is stalled but alive and wakes after its jobs were given away (job.signal aborts in that case, but there is no SIGSTOP on Windows); and a real GitHub: the lookup by branch is the call the real adapter will make, but only spike 4 can say how GitHub answers it just after a create",
  );

  return {
    id,
    criterion,
    verdict: failures.length === 0 ? "PASS" : "FAIL",
    summary:
      failures.length === 0
        ? "A killed replica's jobs were freed by the heartbeat and resumed on the other replica; killed after the effect, in the check-then-POST gap and before the effect, the lookup by branch left the fake GitHub with exactly one POST per key."
        : failures.join("; "),
    evidence,
  };
};
