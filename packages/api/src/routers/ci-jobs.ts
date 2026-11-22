import type { CiCheckRunStatus, CiStatusState } from "@ostra/adapter-sdk";
import { CI_FAILING_CONCLUSIONS } from "@ostra/domain";
import { z } from "zod";

// Milestone 10 (F-151/c6, the targets' choice 7 and content fix 12, ticket 08): the code host's CI
// counted in jobs. Each of a head's check runs (and commit statuses) is a job: done once it has a
// conclusion, running before. `ci.evaluate` keeps them in `CiRun.checks` in the order the code host
// lists them, each with its conclusion, or its status while it runs (`queued`, `in_progress`, …),
// and never a log. Names only: a job's name is the host's, shown as data.

/** A head's CI in jobs: how many have a conclusion, of how many. */
export type CiJobs = { readonly done: number; readonly total: number };

/** No CI on the head, or none read yet. */
export const NO_CI_JOBS: CiJobs = { done: 0, total: 0 };

/** The words `CiRun.checks` keeps for a job that has no conclusion yet: a check run's status, or a commit status's `pending`. */
const runningWords: ReadonlySet<string> = new Set(["queued", "in_progress", "waiting", "requested", "pending"] satisfies readonly (Exclude<CiCheckRunStatus, "completed"> | Extract<CiStatusState, "pending">)[]);

/** A CI run's checks as `ci.evaluate` stores them: the name and the conclusion (its status while it runs). */
const storedChecksSchema = z.array(z.looseObject({ name: z.string(), conclusion: z.string().nullable().optional() }));

/** A head's jobs counted, and every failing job's name in the order the code host lists them. */
export const ciJobsOf = (checks: unknown): { readonly jobs: CiJobs; readonly failingJobs: readonly string[] } => {
  const parsed = storedChecksSchema.safeParse(checks);
  const stored = parsed.success ? parsed.data : [];
  const done = stored.filter((check) => check.conclusion !== null && check.conclusion !== undefined && !runningWords.has(check.conclusion)).length;
  const failingJobs = stored.flatMap((check) => (check.conclusion !== null && check.conclusion !== undefined && CI_FAILING_CONCLUSIONS.has(check.conclusion) ? [check.name] : []));
  return { jobs: { done, total: stored.length }, failingJobs };
};

/** The `CiRun` columns a head's CI is read from. */
export type CiRunRow = { readonly state: "pending" | "passed" | "failed" | "none" | "timed_out"; readonly checks: unknown };

/** A head's CI on `tasks.get`'s repos. */
export type HeadCi = {
  readonly state: "running" | "passed" | "failed" | "none";
  /** The first failing job's name when CI failed (milestone 6's Code group); `null` otherwise. */
  readonly failing: string | null;
  readonly jobs: CiJobs;
  /** Every failing job's name, in the order the code host lists them. */
  readonly failingJobs: readonly string[];
};

/**
 * A head's CI as the Code group and the PR card say it: running, passed, failed or none, with its
 * jobs counted (`CI on GitHub: running, 2 of 4 jobs done`) and every failing job by name
 * (`failingJobs`). `failing`, the first failing job's name when CI failed, stays for the readers
 * of milestone 6's Code group until they read `failingJobs`. `none` counts no jobs.
 */
export const ciOfHead = (run: CiRunRow | null): HeadCi => {
  if (run === null || run.state === "none") return { state: "none", failing: null, jobs: NO_CI_JOBS, failingJobs: [] };
  const { jobs, failingJobs } = ciJobsOf(run.checks);
  switch (run.state) {
    case "pending":
      return { state: "running", failing: null, jobs, failingJobs };
    case "passed":
      return { state: "passed", failing: null, jobs, failingJobs };
    case "failed":
    case "timed_out":
      return { state: "failed", failing: failingJobs[0] ?? null, jobs, failingJobs };
    default:
      return run.state satisfies never;
  }
};

/** The jobs of several heads (a task's PRs), added up: what Home's board counts for a task in CI. */
export const sumCiJobs = (heads: readonly CiJobs[]): CiJobs => heads.reduce((sum, head) => ({ done: sum.done + head.done, total: sum.total + head.total }), NO_CI_JOBS);
