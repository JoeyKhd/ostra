import { createHash } from "node:crypto";

import { checkRunStatusFromDb, checkRunStatusToDb, mapCheckRun } from "@ostra/db";
import type { Db, Tx } from "@ostra/db";
import { checkIdSchema, checkStatusSchema, clientMessageIdSchema, projectIdSchema } from "@ostra/protocol";
import type { BlobId, CheckId, CheckStatus, RepoId, SessionId, TaskId } from "@ostra/protocol";
import { z } from "zod";

import { requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import { isFailingCheck } from "../checks/pr-checks.ts";
import type { PrCheck } from "../checks/pr-checks.ts";
import { fixChecksPrompt } from "../prompts/index.ts";
import type { FailedCheckForPrompt } from "../prompts/index.ts";
import type { UseCaseResult } from "./common.ts";
import type { M3Deps, RecordChecksRun } from "./m3-signatures.ts";
import { sendMemberMessageInTx } from "./member-message.ts";
import type { MemberMessageDelivery, SendMemberMessageDeps, SendMemberMessageResult } from "./member-message.ts";

// Checks before the PR (F-054, ADR 0052; ticket 23). After a turn with changes the runner runs the
// environment's checks and reports `check.started` and `check.finished`; each becomes a `CheckRun`
// of its session and turn, with the full output as a blob. The PR opener reads each PR's latest
// results into its body and its draft state, and "Ask the agent to fix" sends the failing checks'
// commands and output tails to the agent. A check's output is never logged.

/** The turn a check ran after: the session's latest, since checks run after the turn's end. */
const currentTurnOrdinal = async (tx: Tx, sessionId: string): Promise<number> => {
  const turn = await tx.turn.findFirst({ where: { sessionId }, orderBy: { ordinal: "desc" }, select: { ordinal: true } });
  return turn?.ordinal ?? 1;
};

type TaskRef = { readonly id: TaskId; readonly organizationId: string; readonly projectId: string };

/** `check.started`: the run's row, `running`, in the repo the runner named. */
export const recordCheckStartedInTx = async (
  tx: Tx,
  task: TaskRef,
  input: { readonly sessionId: SessionId; readonly checkId: CheckId; readonly repoId: RepoId | null; readonly name: string; readonly at: number },
): Promise<void> => {
  const turnOrdinal = await currentTurnOrdinal(tx, input.sessionId);
  await tx.checkRun.upsert({
    where: { sessionId_turnOrdinal_checkId: { sessionId: input.sessionId, turnOrdinal, checkId: input.checkId } },
    create: {
      organizationId: task.organizationId,
      projectId: task.projectId,
      taskId: task.id,
      sessionId: input.sessionId,
      turnOrdinal,
      checkId: input.checkId,
      name: input.name,
      repoId: input.repoId,
      status: "running",
      startedAt: new Date(input.at),
    },
    update: { name: input.name, repoId: input.repoId, status: "running", exitCode: null, durationMs: null, finishedAt: null, startedAt: new Date(input.at) },
  });
};

type RecordChecksRunInput = Parameters<RecordChecksRun>[2];

/**
 * `check.finished`, one or more: each check's result on its run's row, made if `check.started`
 * was lost (with the environment's name and repo for it). A blob that isn't this task's is dropped.
 */
export const recordChecksRunInTx = async (tx: Tx, input: RecordChecksRunInput & { readonly at?: number }): Promise<UseCaseResult<{ readonly failed: number }, "not-found">> => {
  const task = await tx.task.findUnique({ where: { id: input.taskId }, select: { id: true, organizationId: true, projectId: true } });
  if (task === null) {
    return { ok: false, error: "not-found", message: "no such task" };
  }
  const finishedAt = new Date(input.at ?? Date.now());
  let failed = 0;
  for (const check of input.checks) {
    const blob =
      check.outputBlobId === null
        ? null
        : await tx.blob.findFirst({ where: { id: check.outputBlobId, organizationId: task.organizationId, taskId: task.id }, select: { id: true } });
    const known = await tx.check.findFirst({ where: { id: check.checkId, projectId: task.projectId }, select: { name: true, repoId: true } });
    const result = {
      status: checkRunStatusToDb[check.status],
      exitCode: check.exitCode,
      durationMs: check.durationMs,
      outputBlobId: blob?.id ?? null,
      finishedAt,
    };
    await tx.checkRun.upsert({
      where: { sessionId_turnOrdinal_checkId: { sessionId: input.sessionId, turnOrdinal: input.turnOrdinal, checkId: check.checkId } },
      create: {
        organizationId: task.organizationId,
        projectId: task.projectId,
        taskId: task.id,
        sessionId: input.sessionId,
        turnOrdinal: input.turnOrdinal,
        checkId: check.checkId,
        name: known?.name ?? "check",
        repoId: known?.repoId ?? null,
        startedAt: new Date(finishedAt.getTime() - check.durationMs),
        ...result,
      },
      update: result,
    });
    if (isFailingCheck(check.status)) {
      failed += 1;
    }
  }
  return { ok: true, failed };
};

/** `check.finished` as ingest records it: the run of the session's latest turn. */
export const recordCheckFinishedInTx = async (
  tx: Tx,
  input: {
    readonly taskId: TaskId;
    readonly sessionId: SessionId;
    readonly checkId: CheckId;
    readonly status: CheckStatus;
    readonly exitCode: number | null;
    readonly durationMs: number;
    readonly outputBlobId: BlobId | null;
    readonly at: number;
  },
): Promise<void> => {
  const turnOrdinal = await currentTurnOrdinal(tx, input.sessionId);
  await recordChecksRunInTx(tx, {
    taskId: input.taskId,
    sessionId: input.sessionId,
    turnOrdinal,
    at: input.at,
    checks: [{ checkId: input.checkId, status: input.status, exitCode: input.exitCode, durationMs: input.durationMs, outputBlobId: input.outputBlobId }],
  });
};

export const recordChecksRun: RecordChecksRun = (_deps, tx, input) => recordChecksRunInTx(tx, input);

// ---------- the latest results ----------

/** A check's latest finished run on a task, with its output's end from its `check.finished`. */
export type LatestCheckRun = {
  readonly checkId: CheckId;
  readonly name: string;
  readonly repoId: string | null;
  readonly status: CheckStatus;
  readonly turnOrdinal: number;
  readonly outputTail: string | null;
};

const finishedTailSchema = z.looseObject({ kind: z.literal("check.finished"), checkId: z.string(), outputTail: z.string() });

/**
 * Each check's latest finished run on the task, in the environment's order (a deleted check's runs
 * last, by name). A repo's PR reads the ones that ran in it and the repo-less ones (Q188).
 */
export const latestCheckRunsInTx = async (db: Db | Tx, taskId: TaskId): Promise<readonly LatestCheckRun[]> => {
  const runs = await db.checkRun.findMany({ where: { taskId, status: { not: "running" } }, orderBy: [{ finishedAt: "desc" }, { id: "desc" }] });
  const latest = new Map<string, (typeof runs)[number]>();
  for (const run of runs) {
    if (!latest.has(run.checkId)) {
      latest.set(run.checkId, run);
    }
  }
  if (latest.size === 0) {
    return [];
  }
  const checks = await db.check.findMany({ where: { id: { in: [...latest.keys()] } }, select: { id: true, position: true } });
  const position = new Map(checks.map((check) => [check.id, check.position]));
  const ordered = [...latest.values()].sort(
    (a, b) => (position.get(a.checkId) ?? Number.MAX_SAFE_INTEGER) - (position.get(b.checkId) ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name),
  );
  const out: LatestCheckRun[] = [];
  for (const run of ordered) {
    const status = checkRunStatusFromDb[run.status];
    const parsedStatus = checkStatusSchema.safeParse(status);
    if (!parsedStatus.success) {
      continue;
    }
    let outputTail: string | null = null;
    if (isFailingCheck(parsedStatus.data)) {
      const event = await db.event.findFirst({
        where: { taskId, sessionId: run.sessionId, kind: "check.finished", payload: { path: ["checkId"], equals: run.checkId } },
        orderBy: { seq: "desc" },
        select: { payload: true },
      });
      const tail = finishedTailSchema.safeParse(event?.payload);
      outputTail = tail.success ? tail.data.outputTail : null;
    }
    out.push({ checkId: checkIdSchema.parse(run.checkId), name: run.name, repoId: run.repoId, status: parsedStatus.data, turnOrdinal: run.turnOrdinal, outputTail });
  }
  return out;
};

/** The checks that apply to one repo's PR: its own and the repo-less ones, at their latest run. */
export const prChecksFor = (latest: readonly LatestCheckRun[], repoId: string): readonly PrCheck[] =>
  latest.filter((run) => run.repoId === null || run.repoId === repoId).map((run) => ({ name: run.name, status: run.status, outputTail: run.outputTail }));

/** A check run as a member reads it (the Checks tab, ticket 39). Never its output: that's the blob. */
export type CheckRunView = ReturnType<typeof mapCheckRun>;

/** Every check run of a task, newest turn first, for a member who can open its project; `null` otherwise. */
export const checkRunsForMember = async (db: Db, scope: MemberScope, input: { readonly taskId: TaskId }): Promise<readonly CheckRunView[] | null> => {
  const task = await db.task.findFirst({ where: { id: input.taskId, organizationId: scope.organizationId }, select: { id: true, projectId: true } });
  const project = task === null ? null : await db.project.findFirst({ where: { id: task.projectId, organizationId: scope.organizationId }, select: { id: true, access: true } });
  if (task === null || project === null || !requireProjectAccess(scope, { id: projectIdSchema.parse(project.id), organizationId: scope.organizationId, access: project.access }, "read").ok) {
    return null;
  }
  const rows = await db.checkRun.findMany({
    where: { taskId: task.id, organizationId: scope.organizationId },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
  });
  return rows.map(mapCheckRun);
};

// ---------- Ask the agent to fix ----------

export type AskAgentToFixChecksResult = UseCaseResult<
  { readonly checks: number; readonly delivery: MemberMessageDelivery },
  "not-found" | "nothing-failing" | Exclude<SendMemberMessageResult, { readonly ok: true }>["error"]
>;

/**
 * "Ask the agent to fix" (F-054): one member message (`intent: "fix-checks"`) with each failing
 * check's command and output's end, as data, sent as the composer sends. The same failures asked
 * about twice are one message.
 */
export const askAgentToFixChecks = (
  deps: M3Deps,
  extras: Pick<SendMemberMessageDeps, "spendCap" | "timers">,
  scope: MemberScope,
  input: { readonly taskId: TaskId },
): Promise<AskAgentToFixChecksResult> =>
  deps.db.$transaction(
    async (tx) => {
      const task = await tx.task.findFirst({ where: { id: input.taskId, organizationId: scope.organizationId }, select: { id: true, projectId: true, project: { select: { access: true } } } });
      if (task === null || !requireProjectAccess(scope, { id: projectIdSchema.parse(task.projectId), organizationId: scope.organizationId, access: task.project.access }, "read").ok) {
        return { ok: false, error: "not-found", message: "No such task" };
      }
      const latest = await latestCheckRunsInTx(tx, input.taskId);
      const failing = latest.filter((run) => isFailingCheck(run.status));
      const commands = await tx.check.findMany({ where: { id: { in: failing.map((run) => run.checkId) }, projectId: task.projectId }, select: { id: true, command: true } });
      const commandOf = new Map(commands.map((check) => [check.id, check.command]));
      const forPrompt: FailedCheckForPrompt[] = failing.flatMap((run) => {
        const command = commandOf.get(run.checkId);
        return command === undefined || run.status === "passed" ? [] : [{ name: run.name, command, status: run.status, outputTail: run.outputTail ?? "" }];
      });
      if (forPrompt.length === 0) {
        return { ok: false, error: "nothing-failing", message: "No check is failing" };
      }
      const key = failing.map((run) => `${run.checkId}@${String(run.turnOrdinal)}`).join(",");
      const clientMessageId = clientMessageIdSchema.parse(`fix-checks:${createHash("sha256").update(key).digest("hex").slice(0, 32)}`);
      const sent = await sendMemberMessageInTx({ ...deps, ...extras }, tx, scope, {
        taskId: input.taskId,
        clientMessageId,
        text: fixChecksPrompt(forPrompt),
        intent: "fix-checks",
        sender: "driver",
      });
      if (!sent.ok) {
        return sent;
      }
      if (!sent.duplicate) {
        await deps.audit.recordInTx(tx, {
          organizationId: scope.organizationId,
          projectId: projectIdSchema.parse(task.projectId),
          actor: { kind: "member", id: scope.memberId },
          action: "checks.fix-asked",
          entity: "task",
          entityId: input.taskId,
          data: { checks: forPrompt.length, delivery: sent.delivery },
        });
      }
      return { ok: true, checks: forPrompt.length, delivery: sent.delivery };
    },
    { timeout: 20_000 },
  );
