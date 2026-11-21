import { randomUUID } from "node:crypto";

import type { Logger } from "@ostra/adapter-sdk";
import { mapTask } from "@ostra/db";
import type { Db, Tx } from "@ostra/db";
import {
  blobIdSchema,
  boxIdSchema,
  clientMessageIdSchema,
  leaseEpochSchema,
  memberIdSchema,
  organizationIdSchema,
  projectIdSchema,
  runnerIdSchema,
  runnerLimits,
  sessionIdSchema,
  taskIdSchema,
  taskSeqSchema,
} from "@ostra/protocol";
import type { BlobId, ClientMessageId, MemberId, MessageIntent, OrganizationId, ProjectId, SessionId, TaskId, TaskSeq } from "@ostra/protocol";
import { z } from "zod";

import type { RoundVerdict } from "../lifecycles/m6.ts";
import type { TaskInput } from "../lifecycles/task.ts";
import type { Ports } from "../ports.ts";
import { fixCiPrompt, fixFindingsPrompt } from "../prompts/m6.ts";
import type { FailingCheckForPrompt, FindingForPrompt } from "../prompts/m6.ts";
import { checkBudget, holdTurnInTx, sessionModelIdInTx } from "../use-cases/budgets.ts";
import type { UseCaseResult } from "../use-cases/common.ts";
import { moveSessionInTx, moveTaskInTx } from "../use-cases/moves.ts";
import { createNeedsYouItemInTx } from "../use-cases/needs-you-items.ts";
import { appendServerEvent } from "../use-cases/server-events.ts";
import { cancelBoxIdleTimerInTx, endSessionTimersInTx, limitSummary } from "../use-cases/sessions-m2.ts";
import type { SessionTimers } from "../use-cases/sessions-m2.ts";
import { modelTokenPrices, spendCapFor, spendCapReached, taskTokensInTx } from "../use-cases/spend.ts";
import type { SpendCapSettings } from "../use-cases/spend.ts";
import { countRound, DEFAULT_ROUND_LIMITS, roundAllowed, roundKindFromDb } from "./rounds.ts";
import type { RoundCounters, RoundLimits, TaskRoundKind } from "./rounds.ts";

// A round (F-035, F-101, ADR 0041, ADR 0058; milestone 6's ticket 18): the coding agent's
// automatic turn on a failing CI or on an AI review's blocking findings. `round.start`, keyed by
// the task, the kind and the cause, runs in the task's lock:
// 1. the caps: `roundAllowed` against the kind's rounds and the automatic turns since a person
//    last acted; a cap reached moves the task to needs you (`round_cap`) for its driver;
// 2. the budget gate, as an automatic round: a closed one holds the turn (`HeldTurn`, the round
//    `held`), and the release sends it in order;
// 3. the task's spend cap: reached, the task needs you (`spend_cap`);
// 4. the turn: on the warm box when the session is idle and its runner speaks minor 5, else a
//    reopen on a fresh box, the round's prompt as the session's first message.
// The counters rise when a round's turn starts. The prompts wrap the untrusted text (the checks'
// names, the findings) as data, and none of it reaches a log line.

/** The minor a runner needs for an automatic turn on its warm box (`automatic` on `steer`). */
export const AUTOMATIC_TURN_MINOR = 5;

export type StartRoundDeps = Pick<Ports, "jobs" | "outbox" | "notices" | "audit" | "clock"> & {
  readonly db: Db;
  /** `OSTRA_CI_ROUNDS`, `OSTRA_REVIEW_ROUNDS`, `OSTRA_AUTOMATIC_TURNS`; the working values without it. */
  readonly limits?: RoundLimits;
  /** The task's spend cap (`OSTRA_TASK_SPEND_CAP_USD`, `OSTRA_TASK_TOKEN_CAP`). Without it, no cap is checked here. */
  readonly spendCap?: SpendCapSettings;
  readonly timers?: SessionTimers;
  readonly logger?: Logger;
};

export type StartRoundInput = {
  readonly organizationId: OrganizationId;
  readonly taskId: TaskId;
  readonly kind: TaskRoundKind;
  /** What caused it: `<head>.<n>` for CI, the review run's ID for findings. An ID, never text. */
  readonly causeRef: string;
};

export type RoundOutcome = "warm" | "fresh" | "held" | "capped" | "spend-cap";

export type StartRoundResult = UseCaseResult<
  { readonly verdict: RoundVerdict; readonly held: boolean; readonly outcome: RoundOutcome },
  "not-found" | "already-started" | "not-waiting"
>;

/** A CI log tail as `CiRun.logBlobIds` keeps it: the check's name and the blob. */
export const ciLogEntrySchema = z.looseObject({ name: z.string(), blobId: blobIdSchema });
export const ciLogEntriesSchema = z.array(ciLogEntrySchema);
export type CiLogEntry = z.infer<typeof ciLogEntrySchema>;

const storedChecksSchema = z.array(z.looseObject({ name: z.string(), conclusion: z.string() }));

/** The conclusions a failing check is stored with (`evaluate-ci.ts`). */
export const CI_FAILING_CONCLUSIONS: ReadonlySet<string> = new Set(["failure", "timed_out", "action_required", "startup_failure", "error"]);
const FAILING_WORDS = CI_FAILING_CONCLUSIONS;

/** A CI log's file name under `ci/`: from its blob, never from the check's name. */
export const ciLogFileName = (blobId: BlobId): string => `${blobId}.log`;

/** The intent a round's message carries. */
const intentOf = (kind: TaskRoundKind): Extract<MessageIntent, "fix-ci" | "fix-findings"> | null => {
  switch (kind) {
    case "ci":
      return "fix-ci";
    case "findings":
      return "fix-findings";
    case "changes_requested":
      return null;
    default:
      return kind satisfies never;
  }
};

/** The words of a round cap's needs-you item: which cap, never content. */
export const roundCapSummary = (kind: TaskRoundKind, reason: "rounds" | "automatic-turns", limits: RoundLimits): string => {
  if (reason === "automatic-turns") {
    return `ostra ran ${String(limits.automaticTurns)} automatic turns on this task since a person last acted, the most it runs. Read the PRs, then press Keep working or send a message.`;
  }
  return kind === "ci"
    ? `CI still fails after ${String(limits.ciRounds)} rounds of fixes. Read the failing checks, then press Keep working or send a message.`
    : `The AI review still finds blocking problems after ${String(limits.reviewRounds)} rounds of fixes. Read its findings, then press Keep working or send a message.`;
};

/** ADR 0058 as amended 2026-11-21: the item when a new head would run the AI review past its rounds. */
export const reviewRerunCapSummary = (limits: RoundLimits): string =>
  `The PRs got new heads while the AI review ran, and it has run its ${String(limits.reviewRounds)} review rounds since a person last acted, so the new head gets no review. Read the PRs, then press Keep working or send a message.`;

/**
 * ADR 0058 as amended 2026-11-21: a review rerun the review rounds' cap stops. The code task, in
 * "AI review", needs its driver with the same item as every round cap. In the task's lock, in the
 * caller's transaction.
 */
export const reviewRerunCappedInTx = async (
  deps: Pick<StartRoundDeps, "jobs" | "notices" | "logger">,
  tx: Tx,
  task: ReturnType<typeof mapTask>,
  limits: RoundLimits,
): Promise<void> => {
  await moveTaskInTx({ tx, notices: deps.notices, jobs: deps.jobs, ...(deps.logger === undefined ? {} : { logger: deps.logger }) }, task, { type: "ai_review_done", blocking: true, capReached: true });
  await createNeedsYouItemInTx(deps, tx, {
    organizationId: organizationIdSchema.parse(task.organizationId),
    projectId: projectIdSchema.parse(task.projectId),
    taskId: task.id,
    reason: "round_cap",
    audience: "driver",
    summary: reviewRerunCapSummary(limits),
  });
};

type Prompt = { readonly text: string; readonly logFiles: readonly CiLogEntry[] };

/**
 * A CI round's prompt: the failing checks of the task's open PRs at their current heads (the head
 * that caused it among them), each with its log file. `null` when nothing failing is stored.
 */
const ciPromptInTx = async (tx: Pick<Tx, "taskRepo" | "ciRun">, taskId: TaskId, causeRef: string): Promise<Prompt | null> => {
  const head = causeRef.split(".")[0] ?? "";
  const open = await tx.taskRepo.findMany({ where: { taskId, state: "pr_open", headSha: { not: null } }, select: { id: true, headSha: true } });
  const heads = [...open.flatMap((row) => (row.headSha === null ? [] : [{ taskRepoId: row.id, headSha: row.headSha }]))];
  const runs = await tx.ciRun.findMany({
    where: { OR: [{ headSha: head, taskRepo: { taskId } }, ...heads.map((one) => ({ taskRepoId: one.taskRepoId, headSha: one.headSha, state: "failed" as const }))] },
    orderBy: { firstSeenAt: "asc" },
    select: { id: true, checks: true, logBlobIds: true },
  });
  if (runs.length === 0) {
    return null;
  }
  const checks: FailingCheckForPrompt[] = [];
  const logFiles: CiLogEntry[] = [];
  for (const run of runs.filter((one, index) => runs.findIndex((other) => other.id === one.id) === index)) {
    const stored = storedChecksSchema.safeParse(run.checks);
    const logs = ciLogEntriesSchema.safeParse(run.logBlobIds);
    const runLogs = logs.success ? logs.data : [];
    logFiles.push(...runLogs);
    for (const check of (stored.success ? stored.data : []).filter((one) => FAILING_WORDS.has(one.conclusion))) {
      const log = runLogs.find((entry) => entry.name === check.name);
      checks.push({ name: check.name, conclusion: check.conclusion, logFile: log === undefined ? null : ciLogFileName(log.blobId) });
    }
  }
  return { text: fixCiPrompt(checks.slice(0, runnerLimits.ciLogChecksMax * runnerLimits.projectReposMax)), logFiles: logFiles.slice(0, runnerLimits.ciLogChecksMax) };
};

/** A findings round's prompt: the review run's findings, blocking ones to fix and the nits listed. */
const findingsPromptInTx = async (tx: Tx, causeRef: string): Promise<Prompt | null> => {
  const findings = await tx.finding.findMany({
    where: { reviewRunId: causeRef },
    orderBy: { createdAt: "asc" },
    select: { path: true, line: true, side: true, severity: true, title: true, body: true, taskRepo: { select: { repo: { select: { fullName: true } } } } },
  });
  if (!findings.some((finding) => finding.severity === "blocking")) {
    return null;
  }
  const quoted: FindingForPrompt[] = findings.map((finding) => ({
    repo: finding.taskRepo.repo.fullName,
    path: finding.path,
    line: finding.line,
    side: finding.side,
    severity: finding.severity,
    title: finding.title,
    body: finding.body,
  }));
  return { text: fixFindingsPrompt(quoted), logFiles: [] };
};

/** The member a round's message is written as: the task's driver, else whoever started it. */
const messageMemberOf = (task: { readonly driverMemberId: string | null; readonly creatorMemberId: string | null }): MemberId | null => {
  const id = task.driverMemberId ?? task.creatorMemberId;
  return id === null ? null : memberIdSchema.parse(id);
};

const GOING_SESSION_STATES = ["starting", "running", "waiting", "idle"] as const;
const GOING_STATES: ReadonlySet<string> = new Set(GOING_SESSION_STATES);

/** A round's message: the prompt, as the driver's message with the round's intent. */
type RoundMessage = { readonly clientMessageId: ClientMessageId; readonly text: string; readonly intent: "fix-ci" | "fix-findings"; readonly memberId: MemberId; readonly logFiles: readonly CiLogEntry[] };

/**
 * Starts the round's turn: steered into the session on its warm box when that session is idle, its
 * lease active and its runner at minor 5 (and, for CI, no log file has to reach the box: only a
 * dispatch carries files), else a reopen on a fresh box, which the dispatch resumes in the kept box
 * when it can (ADR 0039). `savedSeq`: the message is already in the thread (a held round's).
 */
export const startRoundTurnInTx = async (
  deps: Pick<StartRoundDeps, "jobs" | "outbox" | "notices" | "clock" | "timers">,
  tx: Tx,
  task: ReturnType<typeof mapTask>,
  message: RoundMessage,
  savedSeq: TaskSeq | null,
): Promise<{ readonly outcome: "warm" | "fresh"; readonly sessionId: SessionId }> => {
  const now = deps.clock.now();
  const organizationId = organizationIdSchema.parse(task.organizationId);
  const projectId = projectIdSchema.parse(task.projectId);
  const [lease, session] = await Promise.all([
    tx.lease.findFirst({ where: { taskId: task.id, state: "active" }, select: { runnerId: true } }),
    tx.session.findFirst({ where: { taskId: task.id, state: { in: [...GOING_SESSION_STATES] } }, orderBy: { startedAt: "desc" } }),
  ]);
  const minor = lease === null ? 0 : ((await tx.runnerPresence.findUnique({ where: { runnerId: lease.runnerId }, select: { minor: true } }))?.minor ?? 0);
  const warm = lease !== null && session?.state === "idle" && minor >= AUTOMATIC_TURN_MINOR && message.logFiles.length === 0;
  if (warm) {
    const sessionId = sessionIdSchema.parse(session.id);
    if (savedSeq === null) {
      await appendServerEvent(tx, {
        organizationId,
        projectId,
        taskId: task.id,
        sessionId,
        at: now,
        event: { kind: "user.message", memberId: message.memberId, clientMessageId: message.clientMessageId, text: message.text, delivery: "queued", intent: message.intent },
      });
    }
    await deps.outbox.enqueueInTx(tx, organizationId, runnerIdSchema.parse(lease.runnerId), {
      kind: "steer",
      body: { sessionId, clientMessageId: message.clientMessageId, text: message.text, delivery: "queue", intent: message.intent, automatic: true },
      notAfter: now + runnerLimits.offerTimeoutMs,
      task: { taskId: task.id, projectId },
    });
    if (session.boxId !== null) {
      await cancelBoxIdleTimerInTx(deps, tx, { organizationId, taskId: task.id, boxId: boxIdSchema.parse(session.boxId) });
    }
    return { outcome: "warm", sessionId };
  }

  // A fresh box (milestone 2's reopen path): the old session and its grant end; a new session
  // starts with the round's message as its first prompt, and the dispatch picks the step.
  const sessions = await tx.session.findMany({ where: { taskId: task.id }, orderBy: [{ startedAt: "desc" }, { id: "desc" }] });
  const moveDeps = { tx, notices: deps.notices, jobs: deps.jobs };
  for (const old of sessions.filter((row) => GOING_STATES.has(row.state))) {
    await moveSessionInTx(moveDeps, old, { type: "stop" });
    await endSessionTimersInTx(deps, tx, { organizationId, taskId: task.id, sessionId: sessionIdSchema.parse(old.id) });
  }
  await tx.lease.updateMany({ where: { taskId: task.id, state: "active" }, data: { state: "ended", endedAt: new Date(now), endReason: "superseded" } });
  const created = await tx.session.create({
    data: { organizationId, projectId, taskId: task.id, agentProfileId: sessions[0]?.agentProfileId ?? task.agentProfileId, origin: "new", state: "starting" },
    select: { id: true },
  });
  const sessionId = sessionIdSchema.parse(created.id);
  if (savedSeq === null) {
    await appendServerEvent(tx, {
      organizationId,
      projectId,
      taskId: task.id,
      sessionId,
      at: now,
      event: { kind: "user.message", memberId: message.memberId, clientMessageId: message.clientMessageId, text: message.text, delivery: "queued", intent: message.intent },
    });
  }
  await tx.task.update({ where: { id: task.id }, data: { queuedAt: null } });
  await moveTaskInTx(moveDeps, task, { type: "reopen" });
  await deps.jobs.enqueueInTx(tx, "task.dispatch", { organizationId, taskId: task.id, sessionId, leaseEpoch: leaseEpochSchema.parse(task.leaseEpoch + 1) });
  return { outcome: "fresh", sessionId };
};

/** What a round's start does to the task: into the fixing sub-state, or needs you at a cap. */
const roundInput = (kind: TaskRoundKind, capReached: boolean): TaskInput | null => {
  switch (kind) {
    case "ci":
      return { type: "ci_failed", capReached };
    case "findings":
      return { type: "ai_review_done", blocking: true, capReached };
    case "changes_requested":
      return null;
    default:
      return kind satisfies never;
  }
};

/** The sub-state a round waits in before it starts. */
const waitingSubState = (kind: TaskRoundKind): "ci_running" | "ai_review" | null => (kind === "ci" ? "ci_running" : kind === "findings" ? "ai_review" : null);

/** The counters as the task row holds them. */
const countersOf = (task: { readonly ciRounds: number; readonly reviewRounds: number; readonly automaticTurns: number }): RoundCounters => ({
  ciRounds: task.ciRounds,
  reviewRounds: task.reviewRounds,
  automaticTurns: task.automaticTurns,
});

/** The counters after a round's turn starts, written on the task. */
const countRoundInTx = async (tx: Tx, taskId: TaskId, kind: TaskRoundKind): Promise<void> => {
  const row = await tx.task.findUniqueOrThrow({ where: { id: taskId }, select: { ciRounds: true, reviewRounds: true, automaticTurns: true } });
  await tx.task.update({ where: { id: taskId }, data: { ...countRound(countersOf(row), kind) } });
};

/** `round.started` in the thread. */
const roundStartedInTx = async (tx: Tx, input: { readonly organizationId: OrganizationId; readonly projectId: ProjectId; readonly taskId: TaskId; readonly kind: TaskRoundKind; readonly number: number; readonly at: number }): Promise<void> => {
  const session = await tx.session.findFirst({ where: { taskId: input.taskId }, orderBy: { startedAt: "desc" }, select: { id: true } });
  if (session === null) {
    return;
  }
  await appendServerEvent(tx, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    taskId: input.taskId,
    sessionId: sessionIdSchema.parse(session.id),
    at: input.at,
    event: { kind: "round.started", round: roundKindFromDb[input.kind], number: input.number, automatic: true },
  });
};

/** Whether the task has reached its spend cap, priced on its latest session's model. */
const roundSpendCapReachedInTx = async (tx: Tx, settings: SpendCapSettings, task: ReturnType<typeof mapTask>, modelId: string | null): Promise<boolean> => {
  const model = modelId === null ? null : await tx.model.findFirst({ where: { id: modelId, organizationId: task.organizationId } });
  return spendCapReached(spendCapFor(settings, model === null ? null : modelTokenPrices(model), { microUsd: task.spentMicroUsd, tokens: await taskTokensInTx(tx, task.id) }));
};

/** A round's turn the spend cap stops: the task needs its driver, with the cap's words. */
const spendCapNeedsYouInTx = async (deps: Parameters<typeof moveTaskInTx>[0], task: ReturnType<typeof mapTask>): Promise<void> => {
  await moveTaskInTx(deps, task, { type: "needs_you", reason: "spend_cap" });
  await createNeedsYouItemInTx(deps, deps.tx, {
    organizationId: organizationIdSchema.parse(task.organizationId),
    projectId: projectIdSchema.parse(task.projectId),
    taskId: task.id,
    reason: "spend_cap",
    audience: "driver",
    summary: limitSummary("spend-cap", 0),
  });
};

/** `round.start`: one round, if its caps, the budget and the spend cap allow. One transaction. */
export const startRound = (deps: StartRoundDeps, input: StartRoundInput): Promise<StartRoundResult> =>
  deps.db.$transaction((tx) => startRoundInTx(deps, tx, input), { timeout: 20_000 });

export const startRoundInTx = async (deps: StartRoundDeps, tx: Tx, input: StartRoundInput): Promise<StartRoundResult> => {
  const limits = deps.limits ?? DEFAULT_ROUND_LIMITS;
  const locked = await tx.$queryRaw<readonly unknown[]>`
    SELECT 1 FROM "task" WHERE "id" = ${input.taskId} AND "organizationId" = ${input.organizationId} FOR UPDATE`;
  if (locked.length === 0) {
    return { ok: false, error: "not-found", message: "no such task" };
  }
  const task = mapTask(await tx.task.findUniqueOrThrow({ where: { id: input.taskId } }));
  const existing = await tx.taskRound.findUnique({ where: { taskId_kind_causeRef: { taskId: task.id, kind: input.kind, causeRef: input.causeRef } }, select: { id: true } });
  if (existing !== null) {
    return { ok: false, error: "already-started", message: "this round was started already" };
  }
  const intent = intentOf(input.kind);
  const waiting = waitingSubState(input.kind);
  if (task.kind !== "code" || intent === null || waiting === null || task.state !== "in_review" || task.subState !== waiting) {
    return { ok: false, error: "not-waiting", message: "the task isn't waiting on this round" };
  }
  const prompt = input.kind === "ci" ? await ciPromptInTx(tx, task.id, input.causeRef) : await findingsPromptInTx(tx, input.causeRef);
  const memberId = messageMemberOf(task);
  if (prompt === null || memberId === null) {
    return { ok: false, error: "not-found", message: "the round's cause has nothing to send" };
  }
  const now = deps.clock.now();
  const organizationId = organizationIdSchema.parse(task.organizationId);
  const projectId = projectIdSchema.parse(task.projectId);
  const moveDeps = { tx, notices: deps.notices, jobs: deps.jobs, ...(deps.logger === undefined ? {} : { logger: deps.logger }) };
  const number = (await tx.taskRound.count({ where: { taskId: task.id, kind: input.kind } })) + 1;
  const counters = countersOf(await tx.task.findUniqueOrThrow({ where: { id: task.id }, select: { ciRounds: true, reviewRounds: true, automaticTurns: true } }));
  const verdict = roundAllowed(counters, input.kind, limits);
  const move = roundInput(input.kind, verdict.kind === "capped");
  if (move === null) {
    return { ok: false, error: "not-waiting", message: "a changes-requested round isn't automatic" };
  }

  // 1. A cap reached: the task needs its driver, and the round is recorded as capped.
  if (verdict.kind === "capped") {
    await tx.taskRound.create({ data: { organizationId, projectId, taskId: task.id, kind: input.kind, number, automatic: true, causeRef: input.causeRef, state: "capped" } });
    await moveTaskInTx(moveDeps, task, move);
    await createNeedsYouItemInTx(deps, tx, { organizationId, projectId, taskId: task.id, reason: "round_cap", audience: "driver", summary: roundCapSummary(input.kind, verdict.reason, limits) });
    const session = await tx.session.findFirst({ where: { taskId: task.id }, orderBy: { startedAt: "desc" }, select: { id: true } });
    if (session !== null) {
      await appendServerEvent(tx, {
        organizationId,
        projectId,
        taskId: task.id,
        sessionId: sessionIdSchema.parse(session.id),
        at: now,
        event: { kind: "round.capped", round: roundKindFromDb[input.kind], reason: verdict.reason },
      });
    }
    deps.logger?.info("round.capped", { taskId: task.id, kind: input.kind, reason: verdict.reason, ...counters });
    return { ok: true, verdict, held: false, outcome: "capped" };
  }

  // The task waits in its fixing sub-state while the round's turn goes (or is held).
  await moveTaskInTx(moveDeps, task, move);
  const moved = mapTask(await tx.task.findUniqueOrThrow({ where: { id: task.id } }));
  const message: RoundMessage = { clientMessageId: clientMessageIdSchema.parse(randomUUID()), text: prompt.text.slice(0, runnerLimits.steerTextMaxChars), intent, memberId, logFiles: prompt.logFiles };
  const latest = await tx.session.findFirst({ where: { taskId: task.id }, orderBy: [{ startedAt: "desc" }, { id: "desc" }] });

  // 2. The budget gate, as an automatic round: a closed one saves the message and holds the turn.
  const gate = await checkBudget(tx, {
    organizationId,
    projectId,
    modelId: latest === null ? null : await sessionModelIdInTx(tx, organizationId, { agentProfileId: latest.agentProfileId, modelId: latest.modelId }),
    origin: "automatic-round",
    now,
  });
  if (gate.kind === "held" && latest !== null) {
    const sessionId = sessionIdSchema.parse(latest.id);
    const seq = await appendServerEvent(tx, {
      organizationId,
      projectId,
      taskId: task.id,
      sessionId,
      at: now,
      event: { kind: "user.message", memberId, clientMessageId: message.clientMessageId, text: message.text, delivery: "queued", intent },
    });
    await tx.taskRound.create({ data: { organizationId, projectId, taskId: task.id, kind: input.kind, number, automatic: true, causeRef: input.causeRef, state: "held" } });
    await holdTurnInTx(deps, tx, { organizationId, projectId, taskId: task.id, sessionId, held: gate, pendingMessageSeq: seq, now, queued: false });
    deps.logger?.info("round.held", { taskId: task.id, kind: input.kind, budgetId: gate.budgetId });
    return { ok: true, verdict, held: true, outcome: "held" };
  }

  // 3. The task's spend cap: reached, the round's turn doesn't start and the driver hears it.
  if (deps.spendCap !== undefined && latest !== null && (await roundSpendCapReachedInTx(tx, deps.spendCap, moved, latest.modelId))) {
    await tx.taskRound.create({ data: { organizationId, projectId, taskId: task.id, kind: input.kind, number, automatic: true, causeRef: input.causeRef, state: "capped" } });
    await spendCapNeedsYouInTx(moveDeps, moved);
    deps.logger?.info("round.spend-cap", { taskId: task.id, kind: input.kind });
    return { ok: true, verdict, held: false, outcome: "spend-cap" };
  }

  // 4. The turn.
  const round = await tx.taskRound.create({
    data: { organizationId, projectId, taskId: task.id, kind: input.kind, number, automatic: true, causeRef: input.causeRef, state: "started" },
    select: { id: true },
  });
  await countRoundInTx(tx, task.id, input.kind);
  await roundStartedInTx(tx, { organizationId, projectId, taskId: task.id, kind: input.kind, number, at: now });
  const turn = await startRoundTurnInTx(deps, tx, moved, message, null);
  const outcome = turn.outcome;
  await tx.taskRound.update({ where: { id: round.id }, data: { turnId: turn.sessionId } });
  await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: task.id });
  deps.logger?.info("round.started", { taskId: task.id, kind: input.kind, number, outcome, logFiles: prompt.logFiles.length });
  return { ok: true, verdict, held: false, outcome };
};

/**
 * A held round's release (`budget.release`, in the task's lock): the round starts, its counters
 * rise, and its saved message goes as an automatic turn, on the warm box or a fresh one. The spend
 * cap is checked here too, as `round.start` checks it after the budget gate: a task that reached
 * it meanwhile gets no turn, the round is capped and the driver hears it. Returns `false` when the
 * task has no held round, so the release sends the message as any other.
 */
export const releaseHeldRoundInTx = async (
  deps: Pick<StartRoundDeps, "jobs" | "outbox" | "notices" | "clock" | "timers" | "spendCap">,
  tx: Tx,
  input: { readonly taskId: TaskId; readonly pendingMessageSeq: number | null },
): Promise<boolean> => {
  const round = await tx.taskRound.findFirst({ where: { taskId: input.taskId, state: "held" }, orderBy: { createdAt: "asc" } });
  if (round === null || input.pendingMessageSeq === null) {
    return false;
  }
  const event = await tx.event.findFirst({ where: { taskId: input.taskId, seq: input.pendingMessageSeq }, select: { payload: true } });
  const saved = heldMessageSchema.safeParse(event?.payload);
  if (!saved.success) {
    return false;
  }
  const task = mapTask(await tx.task.findUniqueOrThrow({ where: { id: input.taskId } }));
  const organizationId = organizationIdSchema.parse(task.organizationId);
  const projectId = projectIdSchema.parse(task.projectId);
  if (deps.spendCap !== undefined) {
    const latest = await tx.session.findFirst({ where: { taskId: task.id }, orderBy: [{ startedAt: "desc" }, { id: "desc" }], select: { modelId: true } });
    if (await roundSpendCapReachedInTx(tx, deps.spendCap, task, latest?.modelId ?? null)) {
      await tx.taskRound.update({ where: { id: round.id }, data: { state: "capped" } });
      await spendCapNeedsYouInTx({ tx, notices: deps.notices, jobs: deps.jobs }, task);
      return true;
    }
  }
  await tx.taskRound.update({ where: { id: round.id }, data: { state: "started" } });
  await countRoundInTx(tx, task.id, round.kind);
  await roundStartedInTx(tx, { organizationId, projectId, taskId: task.id, kind: round.kind, number: round.number, at: deps.clock.now() });
  const logFiles = round.kind === "ci" ? ((await ciPromptInTx(tx, task.id, round.causeRef))?.logFiles ?? []) : [];
  const turn = await startRoundTurnInTx(
    deps,
    tx,
    task,
    { clientMessageId: saved.data.clientMessageId, text: saved.data.text.slice(0, runnerLimits.steerTextMaxChars), intent: saved.data.intent, memberId: saved.data.memberId, logFiles },
    // Saved already: the warm box is steered with it, and a fresh box replays it as unanswered.
    taskSeqSchema.parse(input.pendingMessageSeq),
  );
  await tx.taskRound.update({ where: { id: round.id }, data: { turnId: turn.sessionId } });
  return true;
};

const heldMessageSchema = z.looseObject({
  kind: z.literal("user.message"),
  memberId: memberIdSchema,
  clientMessageId: clientMessageIdSchema,
  text: z.string(),
  intent: z.enum(["fix-ci", "fix-findings"]),
});

/** For a test or a caller that reads the task's counters. */
export const roundCountersInTx = async (tx: Pick<Tx, "task">, taskId: TaskId): Promise<RoundCounters & { readonly lastPersonActionAt: Date | null }> => {
  const row = await tx.task.findUniqueOrThrow({ where: { id: taskId }, select: { ciRounds: true, reviewRounds: true, automaticTurns: true, lastPersonActionAt: true } });
  return row;
};

/**
 * The automatic round a session runs, when it is one: the round's turn (`TaskRound.turnId`, the
 * session it ran in) and, for a CI round, the log tails its fresh box gets as `ci` files. The spec
 * and the dispatch read it, so the session starts with `automatic` and goes only to a runner at
 * minor 5. `null` for every other session.
 */
export const automaticRoundOfSessionInTx = async (
  tx: Pick<Tx, "taskRound" | "taskRepo" | "ciRun">,
  input: { readonly taskId: string; readonly sessionId: string },
): Promise<{ readonly kind: TaskRoundKind; readonly logFiles: readonly CiLogEntry[] } | null> => {
  const round = await tx.taskRound.findFirst({ where: { taskId: input.taskId, turnId: input.sessionId, automatic: true, state: "started" }, select: { kind: true, causeRef: true } });
  if (round === null) {
    return null;
  }
  if (round.kind !== "ci") {
    return { kind: round.kind, logFiles: [] };
  }
  const prompt = await ciPromptInTx(tx, taskIdSchema.parse(input.taskId), round.causeRef);
  return { kind: round.kind, logFiles: prompt?.logFiles ?? [] };
};
