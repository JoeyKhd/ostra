import type { CiLogRef, CiResults, Logger } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import { gitShaSchema, organizationIdSchema, projectIdSchema, repoIdSchema, sessionIdSchema, taskIdSchema, taskRepoIdSchema } from "@ostra/protocol";
import type { BlobId, GitSha, OrganizationId, ProjectId, TaskId, TaskRepoId } from "@ostra/protocol";
import { z } from "zod";

import type { ChangeNotices, Clock, JobQueue, ServerAdapters } from "../ports.ts";
import { moveTaskInTx } from "../use-cases/moves.ts";
import { repoAccessFor } from "../use-cases/repo-access.ts";
import { appendServerEvent } from "../use-cases/server-events.ts";
import { ciVerdict, DEFAULT_CI_WAITS, failingChecks } from "./ci-verdict.ts";
import type { CiVerdict, CiWaits, FailingCheck } from "./ci-verdict.ts";
import { enqueueCiEvaluationInTx, enterReviewLoopInTx, openTaskPrsInTx, reviewRoundsInTx } from "./loop.ts";
import { failReviewOnHeadMoveInTx } from "./review.ts";

// CI on a task's PRs (F-035, ADR 0058, Q222; milestone 6's ticket 16). `ci.evaluate`, keyed by the
// task repo and the head, reads the head's check runs and commit statuses through the code host,
// leaves out ostra's own App's (its slug from the App's connection row), and keeps the verdict in
// `CiRun` for the head: pending, then passed, failed, none or timed out, once. Only a change writes:
// a replayed webhook writes nothing new. A failed verdict stores up to `OSTRA_CI_LOG_CHECKS` log
// tails as blobs, never logged and never in an event. Two delayed evaluations, at the "no CI"
// deadline and the wait limit, make each verdict come without a webhook. Then the code task's
// sub-state follows the combined verdict over its open PRs: a failure is a CI round (ticket 18),
// every PR green (or with no CI, or timed out) the AI review (ticket 17) or "waiting for a reviewer".

/** The purpose a CI log tail's blob is stored under. */
export const CI_LOG_PURPOSE = "ci-log";

/** Stores one failing check's log tail as a blob of the task. Its text is never logged. `null`: not stored. */
export type CiLogStore = (
  owner: { readonly organizationId: OrganizationId; readonly projectId: ProjectId; readonly taskId: TaskId },
  log: { readonly text: string },
) => Promise<BlobId | null>;

export type CiSettings = {
  readonly ciWaits: CiWaits;
  /** `OSTRA_CI_LOG_TAIL_KIB`, in bytes. */
  readonly ciLogTailBytes: number;
  /** `OSTRA_CI_LOG_CHECKS`. */
  readonly ciLogChecks: number;
};

export const DEFAULT_CI_SETTINGS: CiSettings = { ciWaits: DEFAULT_CI_WAITS, ciLogTailBytes: 64 * 1024, ciLogChecks: 5 };

export type EvaluateCiDeps = {
  readonly db: Db;
  readonly jobs: JobQueue;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
  readonly adapters: Pick<ServerAdapters, "codeHost" | "secretStore">;
  readonly settings?: CiSettings;
  /** Where a failed verdict's log tails go. Without it, no log is kept (the round's prompt says so). */
  readonly logs?: CiLogStore;
  readonly logger?: Logger;
};

export type EvaluateCiInput = {
  readonly organizationId: OrganizationId;
  readonly taskRepoId: TaskRepoId;
  readonly headSha: GitSha;
};

export type EvaluateCiResult =
  | {
      readonly ok: true;
      readonly verdict: CiVerdict;
      /**
       * `changed`: the head's state moved (or its first row was written); `unchanged`: nothing new
       * was written; `stale-head`: the head isn't the task repo's now; `not-open`: the PR isn't
       * open; `unsupported`: the code host can't read CI.
       */
      readonly outcome: "changed" | "unchanged" | "stale-head" | "not-open" | "unsupported";
      /** What the code task did after it: a CI round asked for, the AI review asked for, waiting for a reviewer, or nothing. */
      readonly followed: CiFollow;
    }
  | { readonly ok: false; readonly error: "not-found"; readonly message: string };

export type CiFollow = "round" | "review" | "reviewer" | "none";

/** A check of a head, as `CiRun.checks` keeps it: its name, its conclusion word and the host's ID. Never a log. */
type StoredCheck = { readonly name: string; readonly conclusion: string; readonly externalId: string | null };

const storedChecksSchema = z.array(z.looseObject({ name: z.string(), conclusion: z.string(), externalId: z.string().nullable() }));

/** Every check but ostra's own, by name and its conclusion (or its status, while it runs). */
const checksOf = (results: CiResults, ownAppSlug: string | null): readonly StoredCheck[] => [
  ...results.checkRuns
    .filter((run) => ownAppSlug === null || run.appSlug !== ownAppSlug)
    .map((run) => ({ name: run.name.slice(0, 200), conclusion: run.conclusion ?? run.status, externalId: run.id })),
  ...results.statuses.map((status) => ({ name: status.context.slice(0, 200), conclusion: status.state, externalId: null })),
];

const sameChecks = (a: readonly StoredCheck[], b: readonly StoredCheck[]): boolean =>
  a.length === b.length && a.every((check, index) => check.name === b[index]?.name && check.conclusion === b[index].conclusion && check.externalId === b[index].externalId);

const failingName = (check: FailingCheck): { readonly name: string; readonly conclusion: string } =>
  check.kind === "check-run" ? { name: check.name.slice(0, 200), conclusion: check.conclusion } : { name: check.context.slice(0, 200), conclusion: check.state };

const logRefOf = (check: FailingCheck, headSha: string): CiLogRef =>
  check.kind === "check-run" ? { kind: "check-run", checkRunId: check.id } : { kind: "status", headSha, context: check.context };

/**
 * Evaluates one task PR's CI on one head, then lets the code task follow. A code host failure
 * throws, so the job retries; a host without `ciResults` reads nothing (an optional capability).
 */
export const evaluateCi = async (deps: EvaluateCiDeps, input: EvaluateCiInput): Promise<EvaluateCiResult> => {
  const { db } = deps;
  const settings = deps.settings ?? DEFAULT_CI_SETTINGS;
  const taskRepo = await db.taskRepo.findFirst({
    where: { id: input.taskRepoId, organizationId: input.organizationId },
    select: { id: true, taskId: true, projectId: true, repoId: true, state: true, prNumber: true, headSha: true, repo: { select: { connectionId: true, connection: { select: { slug: true } } } } },
  });
  if (taskRepo === null) {
    return { ok: false, error: "not-found", message: "no such task repo" };
  }
  const organizationId = organizationIdSchema.parse(input.organizationId);
  const projectId = projectIdSchema.parse(taskRepo.projectId);
  const taskId = taskIdSchema.parse(taskRepo.taskId);
  const follow = (): Promise<CiFollow> => db.$transaction((tx) => followCiInTx(deps, tx, organizationId, taskId));
  const prNumber = taskRepo.prNumber;
  if (taskRepo.state !== "pr_open" || prNumber === null) {
    return { ok: true, verdict: "pending", outcome: "not-open", followed: "none" };
  }
  if (taskRepo.headSha !== input.headSha) {
    // An older head's events: the task repo moved on, and its own head is evaluated on its own key.
    return { ok: true, verdict: "pending", outcome: "stale-head", followed: "none" };
  }
  const { codeHost } = deps.adapters;
  if (!codeHost.capabilities.ciResults) {
    return { ok: true, verdict: "pending", outcome: "unsupported", followed: "none" };
  }
  const existing = await db.ciRun.findUnique({ where: { taskRepoId_headSha: { taskRepoId: taskRepo.id, headSha: input.headSha } } });
  if (existing !== null && existing.state !== "pending") {
    // A verdict is final for its head: a replayed webhook, or a late timer, writes nothing.
    return { ok: true, verdict: existing.state, outcome: "unchanged", followed: await follow() };
  }
  const repoId = repoIdSchema.parse(taskRepo.repoId);
  const access = await repoAccessFor(db, deps.adapters.secretStore, organizationId, repoId);
  if (!access.ok) {
    throw new Error(`ci.evaluate: ${access.reason}`);
  }
  const listed = await codeHost.listCiResults(access.access, input.headSha);
  if (!listed.ok) {
    throw new Error(`ci.evaluate: the code host couldn't list the head's CI (${listed.error.code})`);
  }
  const ownAppSlug = taskRepo.repo.connection.slug;
  const now = deps.clock.now();
  const firstSeenAt = existing?.firstSeenAt.getTime() ?? now;
  const verdict = ciVerdict(listed.value, ownAppSlug, now, firstSeenAt, settings.ciWaits);
  const checks = checksOf(listed.value, ownAppSlug);
  const failing = verdict === "failed" ? failingChecks(listed.value, ownAppSlug, settings.ciLogChecks) : [];

  // A failed verdict's log tails, read before the write: each a blob of the task, never logged.
  const logBlobIds: { readonly name: string; readonly blobId: BlobId }[] = [];
  if (verdict === "failed" && deps.logs !== undefined && codeHost.capabilities.ciLogs) {
    for (const check of failing) {
      const log = await codeHost.getCiLog(access.access, logRefOf(check, input.headSha), settings.ciLogTailBytes);
      if (!log.ok || !log.value.found) {
        continue;
      }
      const blobId = await deps.logs({ organizationId, projectId, taskId }, { text: log.value.text });
      if (blobId !== null) {
        logBlobIds.push({ name: failingName(check).name, blobId });
      }
    }
  }

  const outcome = await db.$transaction(async (tx): Promise<"changed" | "unchanged"> => {
    if (existing === null) {
      const created = await tx.ciRun.createMany({
        data: [{ organizationId, projectId, taskRepoId: taskRepo.id, headSha: input.headSha, state: "pending", checks: [...checks], firstSeenAt: new Date(now) }],
        skipDuplicates: true,
      });
      if (created.count === 1) {
        // The timers that bring each verdict without a webhook: the "no CI" deadline and the wait limit.
        for (const [deadline, afterMs] of [["none", settings.ciWaits.noneMs], ["wait", settings.ciWaits.waitMs]] as const) {
          await deps.jobs.enqueueInTx(tx, "ci.evaluate", { organizationId, taskRepoId: taskRepoIdSchema.parse(taskRepo.id), headSha: input.headSha, deadline }, { startAfterMs: afterMs, group: { id: taskRepo.repo.connectionId } });
        }
      }
    }
    if (verdict === "pending") {
      if (existing !== null) {
        const stored = storedChecksSchema.safeParse(existing.checks);
        if (stored.success && sameChecks(stored.data, checks)) {
          return "unchanged";
        }
        await tx.ciRun.updateMany({ where: { id: existing.id, state: "pending" }, data: { checks: [...checks] } });
        return "unchanged";
      }
      await emitCiUpdatedInTx(deps, tx, { organizationId, projectId, taskId, repoId, prNumber, headSha: input.headSha, state: "pending", failing: [], at: now });
      return "changed";
    }
    // Pending to the verdict, once: a second evaluation racing this one finds it final.
    const moved = await tx.ciRun.updateMany({
      where: { taskRepoId: taskRepo.id, headSha: input.headSha, state: "pending" },
      data: { state: verdict, completedAt: new Date(now), checks: [...checks], logBlobIds: logBlobIds.map((entry) => ({ name: entry.name, blobId: entry.blobId })) },
    });
    if (moved.count === 0) {
      return "unchanged";
    }
    await emitCiUpdatedInTx(deps, tx, { organizationId, projectId, taskId, repoId, prNumber, headSha: input.headSha, state: verdict, failing: failing.map(failingName), at: now });
    return "changed";
  });
  deps.logger?.info("ci.evaluated", { taskId, taskRepoId: taskRepo.id, headSha: input.headSha, verdict, outcome, checks: checks.length, failing: failing.length, logs: logBlobIds.length });
  return { ok: true, verdict, outcome, followed: await follow() };
};

/** `ci.updated` in the task's thread, with the failing checks by name, never their logs. */
const emitCiUpdatedInTx = async (
  deps: Pick<EvaluateCiDeps, "notices">,
  tx: Tx,
  input: {
    readonly organizationId: OrganizationId;
    readonly projectId: ProjectId;
    readonly taskId: TaskId;
    readonly repoId: ReturnType<typeof repoIdSchema.parse>;
    readonly prNumber: number;
    readonly headSha: GitSha;
    readonly state: CiVerdict;
    readonly failing: readonly { readonly name: string; readonly conclusion: string }[];
    readonly at: number;
  },
): Promise<void> => {
  const session = await tx.session.findFirst({ where: { taskId: input.taskId }, orderBy: { startedAt: "desc" }, select: { id: true } });
  if (session !== null) {
    await appendServerEvent(tx, {
      organizationId: input.organizationId,
      projectId: input.projectId,
      taskId: input.taskId,
      sessionId: sessionIdSchema.parse(session.id),
      at: input.at,
      event: { kind: "ci.updated", repoId: input.repoId, prNumber: input.prNumber, headSha: input.headSha, state: input.state, failing: input.failing.slice(0, 50).map((check) => ({ name: check.name, conclusion: check.conclusion })) },
    });
  }
  await deps.notices.emitInTx(tx, { organizationId: input.organizationId, projectId: input.projectId, entity: "task", entityId: input.taskId });
};

/** The combined verdict over a code task's open PRs at their heads: `null` while any is still pending or unread. */
export const combinedCiVerdictInTx = async (tx: Pick<Tx, "taskRepo" | "ciRun">, taskId: string): Promise<{ readonly verdict: Exclude<CiVerdict, "pending">; readonly failingHead: string | null } | null> => {
  const prs = await openTaskPrsInTx(tx, taskId);
  if (prs.length === 0) {
    return null;
  }
  const runs = await tx.ciRun.findMany({
    where: { OR: prs.map((pr) => ({ taskRepoId: pr.taskRepoId, headSha: pr.headSha })) },
    select: { taskRepoId: true, headSha: true, state: true },
  });
  const states = prs.map((pr) => runs.find((run) => run.taskRepoId === pr.taskRepoId && run.headSha === pr.headSha));
  const failed = states.find((run) => run?.state === "failed");
  if (failed !== undefined) {
    return { verdict: "failed", failingHead: failed.headSha };
  }
  if (states.some((run) => run === undefined || run.state === "pending")) {
    return null;
  }
  return { verdict: states.some((run) => run?.state === "timed_out") ? "timed_out" : states.every((run) => run?.state === "none") ? "none" : "passed", failingHead: null };
};

/**
 * The code task follows its PRs' combined CI, in its lock, only while it's in "CI running": any
 * failure asks for a CI round (`round.start`, which applies the caps); all done otherwise moves it on
 * to the AI review, or to "waiting for a reviewer" with the AI review off. A task in any other
 * state is left alone, so a late or replayed evaluation changes nothing.
 */
export const followCiInTx = async (deps: Pick<EvaluateCiDeps, "jobs" | "notices" | "adapters" | "logger">, tx: Tx, organizationId: OrganizationId, taskId: TaskId): Promise<CiFollow> => {
  await tx.$queryRaw`SELECT 1 FROM "task" WHERE "id" = ${taskId} FOR UPDATE`;
  const task = await tx.task.findUnique({ where: { id: taskId }, select: { id: true, organizationId: true, projectId: true, kind: true, state: true, subState: true, needsYouReason: true, stoppedReason: true } });
  if (task?.kind !== "code" || task.state !== "in_review" || task.subState !== "ci_running") {
    return "none";
  }
  const combined = await combinedCiVerdictInTx(tx, task.id);
  if (combined === null) {
    return "none";
  }
  if (combined.verdict === "failed") {
    const head = gitShaSchema.parse(combined.failingHead);
    const number = (await tx.taskRound.count({ where: { taskId: task.id, kind: "ci" } })) + 1;
    await deps.jobs.enqueueInTx(tx, "round.start", { organizationId, taskId, kind: "ci", causeRef: `${head}.${String(number)}` });
    return "round";
  }
  const rounds = await reviewRoundsInTx(tx, task.projectId, deps.adapters.codeHost.capabilities);
  const row = { ...task, id: taskId, organizationId, projectId: projectIdSchema.parse(task.projectId) };
  const moved = await moveTaskInTx({ tx, notices: deps.notices, jobs: deps.jobs, ...(deps.logger === undefined ? {} : { logger: deps.logger }) }, row, { type: "ci_passed", rounds });
  if (!moved) {
    return "none";
  }
  return (await enterReviewLoopInTx(deps, tx, organizationId, taskId)) === "review" ? "review" : "reviewer";
};

/**
 * A task PR's head as the code host reports it (a `pull_request` opening or push, or the
 * reconcile), with CI read on the host (`ciResults`). A head the task repo doesn't hold yet (a
 * person pushed) is recorded; while the AI review reads the old head, that review is void and the
 * code task goes back to "CI running" (ADR 0058). Then the head's CI is evaluated unless its verdict
 * is in already, so the reconcile covers an App without the check events and costs nothing once
 * each head has its verdict. In the task's lock, in the caller's transaction.
 */
export const recordTaskPrHeadInTx = async (
  deps: Pick<EvaluateCiDeps, "jobs" | "notices" | "adapters" | "logger">,
  tx: Tx,
  input: { readonly organizationId: OrganizationId; readonly taskRepoId: string; readonly headSha: string },
): Promise<{ readonly moved: boolean; readonly enqueued: boolean }> => {
  const head = gitShaSchema.safeParse(input.headSha);
  if (!deps.adapters.codeHost.capabilities.ciResults || !head.success) {
    return { moved: false, enqueued: false };
  }
  const row = await tx.taskRepo.findFirst({
    where: { id: input.taskRepoId, organizationId: input.organizationId },
    select: { id: true, taskId: true, repoId: true, state: true, headSha: true, task: { select: { kind: true } }, repo: { select: { connectionId: true } } },
  });
  if (row?.state !== "pr_open" || row.task.kind !== "code") {
    return { moved: false, enqueued: false };
  }
  await tx.$queryRaw`SELECT 1 FROM "task" WHERE "id" = ${row.taskId} FOR UPDATE`;
  const taskId = taskIdSchema.parse(row.taskId);
  let moved = false;
  if (row.headSha !== head.data) {
    await tx.taskRepo.update({ where: { id: row.id }, data: { headSha: head.data } });
    moved = await failReviewOnHeadMoveInTx(deps, tx, { taskId, repoId: repoIdSchema.parse(row.repoId), headSha: head.data });
  }
  const verdict = await tx.ciRun.findUnique({ where: { taskRepoId_headSha: { taskRepoId: row.id, headSha: head.data } }, select: { state: true } });
  if (verdict !== null && verdict.state !== "pending") {
    return { moved, enqueued: false };
  }
  const enqueued = await enqueueCiEvaluationInTx(deps.jobs, tx, { organizationId: input.organizationId, taskRepoId: row.id, headSha: head.data, connectionId: row.repo.connectionId });
  return { moved, enqueued };
};

/**
 * A `check_run`, `check_suite` or `status` hint (ADR 0058): one `ci.evaluate` for each task PR open
 * on the repo at that head. ostra's own App's check runs change nothing, so they're no hint.
 */
export const enqueueCiForHintInTx = async (
  jobs: JobQueue,
  tx: Tx,
  input: { readonly organizationId: OrganizationId; readonly connectionId: string; readonly hostRepoId: string; readonly headSha: string; readonly appSlug: string | null },
): Promise<number> => {
  const connection = await tx.connection.findFirst({ where: { id: input.connectionId, organizationId: input.organizationId }, select: { slug: true } });
  if (connection === null || (input.appSlug !== null && input.appSlug === connection.slug)) {
    return 0;
  }
  const rows = await tx.taskRepo.findMany({
    where: { organizationId: input.organizationId, state: "pr_open", headSha: input.headSha, repo: { connectionId: input.connectionId, hostRepoId: input.hostRepoId }, task: { kind: "code" } },
    select: { id: true },
  });
  let enqueued = 0;
  for (const row of rows) {
    if (await enqueueCiEvaluationInTx(jobs, tx, { organizationId: input.organizationId, taskRepoId: row.id, headSha: input.headSha, connectionId: input.connectionId })) {
      enqueued += 1;
    }
  }
  return enqueued;
};
