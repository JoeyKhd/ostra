import { randomUUID } from "node:crypto";

import { mapTask } from "@ostra/db";
import type { Db, Session, Tx } from "@ostra/db";
import {
  approvedPlanPrompt,
  clientMessageIdSchema,
  planEntriesSchema,
  planRevisionPrompt,
  planText,
  planTextSchema,
  projectIdSchema,
  questionFieldSchema,
  runnerIdSchema,
  runnerLimits,
  sessionIdSchema,
  taskEventSchema,
} from "@ostra/protocol";
import type { MessageIntent, PlanEntry, QuestionField, QuestionId, SessionId, TaskEvent, TaskId } from "@ostra/protocol";
import { z } from "zod";

import { requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import type { Ports } from "../ports.ts";
import { lateQuestionAnswerPrompt } from "../prompts/index.ts";
import type { ApprovalEffectDeps } from "./approvals.ts";
import type { UseCaseResult } from "./common.ts";
import { moveSessionInTx, moveTaskInTx } from "./moves.ts";
import { createNeedsYouItemInTx, resolveNeedsYouItemsInTx } from "./needs-you-items.ts";
import type { TaskMoveDeps } from "./moves.ts";
import { reopenTask } from "./reopen.ts";
import { appendServerEvent } from "./server-events.ts";
import type { SessionTimers } from "./sessions-m2.ts";
import type { SpendCapSettings } from "./spend.ts";

// Plan first and the agent's questions (F-063, F-024, ADR 0049; milestone 3's ticket 18). A plan
// turn ends with `plan.proposed`: core sets the task's `planState` to `proposed`, raises the `plan`
// item for the driver and moves the task to needs you. The driver approves the plan (as shown or
// edited) or asks for changes; either is a `plan-answer` command whose text core renders with the
// protocol's prompts, the plan or the request inside a marked block. A question (`question.asked`)
// is the same for the driver alone: the answers are checked against the question's fields and sent
// once as `question-answer`. With no session going (the box idled out while waiting), an answer
// reopens the task instead: an approved plan in build mode, a revision in plan mode (the reopen's
// message carries `intent: "plan-revision"`, which the spec reads), a question's answer as the
// first message.

type PlanProposed = Extract<TaskEvent, { readonly kind: "plan.proposed" }>;
type QuestionAsked = Extract<TaskEvent, { readonly kind: "question.asked" }>;

type LockedTask = ReturnType<typeof mapTask>;

const ACTIVE_SESSION_STATES = ["starting", "running", "waiting", "idle"] as const;

const moveDepsOf = (deps: ApprovalEffectDeps): TaskMoveDeps => ({ tx: deps.tx, notices: deps.notices, jobs: deps.jobs, ...(deps.logger === undefined ? {} : { logger: deps.logger }) });

// ---------- ingest ----------

/**
 * `plan.proposed` saved: `planState` to `proposed`, the `plan` item for the driver (one open per
 * task: a second proposal before an answer raises no second one), the task to needs you, the fan-out.
 */
export const recordPlanProposedInTx = async (deps: ApprovalEffectDeps, input: { readonly task: LockedTask; readonly event: PlanProposed }): Promise<void> => {
  const { tx } = deps;
  const { task, event } = input;
  await tx.task.update({ where: { id: task.id }, data: { planState: "proposed" } });
  const open = await tx.needsYouItem.findFirst({ where: { taskId: task.id, reason: "plan", state: "open" }, select: { id: true } });
  if (open === null) {
    await createNeedsYouItemInTx(deps, tx, {
      organizationId: task.organizationId,
      projectId: task.projectId,
      taskId: task.id,
      reason: "plan",
      audience: task.driverMemberId === null ? "project_members" : "driver",
      planTurnId: event.turnId,
    });
  }
  if (task.state === "running") {
    await moveTaskInTx(moveDepsOf(deps), task, { type: "plan_proposed" });
  }
  await deps.notices.emitInTx(tx, { organizationId: task.organizationId, projectId: task.projectId, entity: "task", entityId: task.id });
};

/** `question.asked` saved: the `question` item for the driver, the session waiting, the task to needs you, the fan-out. */
export const recordQuestionAskedInTx = async (
  deps: ApprovalEffectDeps,
  input: { readonly task: LockedTask; readonly session: Session; readonly event: QuestionAsked },
): Promise<void> => {
  const { tx } = deps;
  const { task, session, event } = input;
  const existing = await tx.needsYouItem.findFirst({ where: { taskId: task.id, reason: "question", questionId: event.questionId }, select: { id: true } });
  if (existing !== null) {
    return;
  }
  await createNeedsYouItemInTx(deps, tx, {
    organizationId: task.organizationId,
    projectId: task.projectId,
    taskId: task.id,
    reason: "question",
    audience: task.driverMemberId === null ? "project_members" : "driver",
    questionId: event.questionId,
  });
  const moveDeps = moveDepsOf(deps);
  if (session.state === "running") {
    await moveSessionInTx(moveDeps, session, { type: "waiting_on_person" });
  }
  if (task.state === "running") {
    await moveTaskInTx(moveDeps, task, { type: "needs_you", reason: "question" });
  }
  await deps.notices.emitInTx(tx, { organizationId: task.organizationId, projectId: task.projectId, entity: "task", entityId: task.id });
};

// ---------- the driver's answers ----------

export type AnswerDeps = { readonly db: Db } & Pick<Ports, "jobs" | "outbox" | "notices" | "audit" | "clock"> & {
  /** The caps a reopen honours (an answer with no session going reopens the task). */
  readonly spendCap?: SpendCapSettings | undefined;
  readonly timers?: SessionTimers | undefined;
};

type Refusal<E extends string> = { readonly ok: false; readonly error: E; readonly message: string };

/** The task locked for an answer, with what the answer needs: the project's access and the driver. */
const lockForAnswerInTx = async (
  tx: Tx,
  scope: MemberScope,
  taskId: TaskId,
): Promise<{ readonly ok: true; readonly task: LockedTask } | Refusal<"not-found" | "not-driver">> => {
  const organizationId = scope.organizationId;
  const locked = await tx.$queryRaw<readonly unknown[]>`SELECT 1 FROM "task" WHERE "id" = ${taskId} AND "organizationId" = ${organizationId} FOR UPDATE`;
  if (locked.length === 0) {
    return { ok: false, error: "not-found", message: "No such task" };
  }
  const task = mapTask(await tx.task.findUniqueOrThrow({ where: { id: taskId } }));
  const project = await tx.project.findFirst({ where: { id: task.projectId, organizationId }, select: { id: true, access: true } });
  if (project === null || !requireProjectAccess(scope, { id: projectIdSchema.parse(project.id), organizationId, access: project.access }, "read").ok) {
    return { ok: false, error: "not-found", message: "No such task" };
  }
  // Read under the task's lock: a take-over that committed first is seen here (ADR 0036).
  if (task.driverMemberId !== scope.memberId) {
    return { ok: false, error: "not-driver", message: "Only the driver answers. Take over to answer" };
  }
  return { ok: true, task };
};

/** The session an answer goes to as a command, when one is going and a runner holds the task. */
const goingSessionInTx = async (tx: Tx, taskId: string) => {
  const [lease, session] = await Promise.all([
    tx.lease.findFirst({ where: { taskId, state: "active" }, select: { runnerId: true } }),
    tx.session.findFirst({ where: { taskId, state: { in: [...ACTIVE_SESSION_STATES] } }, orderBy: { startedAt: "desc" } }),
  ]);
  return lease === null || session === null ? null : { runnerId: runnerIdSchema.parse(lease.runnerId), session };
};

/** The newest session of the task, for the answer's event when none is going. */
const newestSessionInTx = async (tx: Tx, taskId: string): Promise<SessionId> =>
  sessionIdSchema.parse((await tx.session.findFirstOrThrow({ where: { taskId }, orderBy: [{ startedAt: "desc" }, { id: "desc" }], select: { id: true } })).id);

/** Closes the task's open items of a reason (optionally one question's), each with its "answered" fan-out. */
const closeItemsInTx = async (deps: Pick<Ports, "jobs">, tx: Tx, task: LockedTask, where: { readonly reason: "plan" | "question"; readonly questionId?: string }, memberId: string, now: number): Promise<void> => {
  await resolveNeedsYouItemsInTx(deps, tx, { taskId: task.id, ...where }, { state: "answered", at: new Date(now), byMemberId: memberId });
};

/** A reopen the answer needed, refused: thrown to roll the answer back, its words kept by the caller. */
const REOPEN_REFUSED = "the answer's reopen was refused";

const reopenWithInTx = async (
  deps: AnswerDeps,
  tx: Tx,
  scope: MemberScope,
  taskId: TaskId,
  text: string,
  intent: MessageIntent | undefined,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> => {
  const reopened = await reopenTask(
    { tx, scope, jobs: deps.jobs, notices: deps.notices, audit: deps.audit, clock: deps.clock, spendCap: deps.spendCap, timers: deps.timers },
    { taskId, clientMessageId: clientMessageIdSchema.parse(randomUUID()), text: text.slice(0, runnerLimits.steerTextMaxChars), ...(intent === undefined ? {} : { intent }) },
  );
  return reopened.ok ? { ok: true } : { ok: false, message: reopened.message };
};

// ---------- the plan ----------

export const answerPlanInputSchema = z.discriminatedUnion("decision", [
  z.strictObject({ taskId: z.string().min(1), decision: z.literal("approve"), entries: planEntriesSchema.min(1), message: planTextSchema }),
  z.strictObject({ taskId: z.string().min(1), decision: z.literal("revise"), request: planTextSchema.trim().min(1) }),
]);

export type AnswerPlanResult = UseCaseResult<{ readonly reopened: boolean }, "not-found" | "not-driver" | "no-plan" | "invalid-input">;

/** The newest `plan.proposed` of the task: what the driver saw. */
const proposedPlanInTx = async (tx: Tx, taskId: string): Promise<PlanProposed | null> => {
  const row = await tx.event.findFirst({ where: { taskId, kind: "plan.proposed" }, orderBy: { seq: "desc" }, select: { payload: true } });
  const parsed = taskEventSchema.safeParse(row?.payload);
  return parsed.success && parsed.data.kind === "plan.proposed" ? parsed.data : null;
};

const sameSteps = (a: readonly PlanEntry[], b: readonly PlanEntry[]): boolean => a.length === b.length && a.every((entry, index) => entry.content === b[index]?.content);

/**
 * The driver's answer to the plan (F-063): "Approve plan" with the plan as shown or edited, or "Ask
 * for changes" with a request. Under the task's lock, the driver only. An approve sets `planState`
 * to `approved`; a revise leaves it `proposed` until the next plan. Either closes the item.
 */
export const answerPlan = async (
  deps: AnswerDeps,
  scope: MemberScope,
  raw:
    | { readonly taskId: TaskId; readonly decision: "approve"; readonly entries: readonly PlanEntry[]; readonly message: string }
    | { readonly taskId: TaskId; readonly decision: "revise"; readonly request: string },
): Promise<AnswerPlanResult> => {
  const parsed = answerPlanInputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "invalid-input", message: "That answer doesn't read: a plan needs at least one step, and a request some words" };
  }
  const input = parsed.data;
  let refusal: string | null = null;
  return deps.db
    .$transaction(async (tx): Promise<AnswerPlanResult> => {
      const locked = await lockForAnswerInTx(tx, scope, raw.taskId);
      if (!locked.ok) {
        return locked;
      }
      const { task } = locked;
      const proposed = await proposedPlanInTx(tx, task.id);
      const planState = (await tx.task.findUniqueOrThrow({ where: { id: task.id }, select: { planState: true } })).planState;
      if (proposed === null || planState !== "proposed") {
        return { ok: false, error: "no-plan", message: "There's no plan waiting for an answer" };
      }
      const now = deps.clock.now();
      const organizationId = scope.organizationId;
      const projectId = projectIdSchema.parse(task.projectId);
      const going = await goingSessionInTx(tx, task.id);
      const sessionId = going === null ? await newestSessionInTx(tx, task.id) : sessionIdSchema.parse(going.session.id);

      let commandText: string;
      if (input.decision === "approve") {
        const text = planText(input.entries, input.message);
        const edited = !sameSteps(input.entries, proposed.entries) || input.message.trim() !== proposed.message.trim();
        commandText = approvedPlanPrompt({ text, edited });
        await appendServerEvent(tx, {
          organizationId,
          projectId,
          taskId: task.id,
          sessionId,
          at: now,
          event: { kind: "plan.answered", decision: "approve", text, memberId: scope.memberId, entries: [...input.entries], message: input.message },
        });
        await tx.task.update({ where: { id: task.id }, data: { planState: "approved" } });
      } else {
        commandText = planRevisionPrompt(input.request);
        await appendServerEvent(tx, {
          organizationId,
          projectId,
          taskId: task.id,
          sessionId,
          at: now,
          event: { kind: "plan.answered", decision: "revise", text: input.request, memberId: scope.memberId },
        });
      }
      await closeItemsInTx(deps, tx, task, { reason: "plan" }, scope.memberId, now);
      await deps.audit.recordInTx(tx, {
        organizationId,
        projectId,
        actor: { kind: "member", id: scope.memberId },
        action: "plan.answered",
        entity: "task",
        entityId: task.id,
        // The decision, never the plan's or the request's text.
        data: { decision: input.decision, ...(input.decision === "approve" ? { steps: input.entries.length } : {}) },
      });

      if (going === null) {
        // The box idled out while the plan waited: the answer is the reopen's message.
        const reopened = await reopenWithInTx(deps, tx, scope, task.id, commandText, input.decision === "revise" ? "plan-revision" : undefined);
        if (!reopened.ok) {
          refusal = reopened.message;
          throw new Error(REOPEN_REFUSED);
        }
        return { ok: true, reopened: true };
      }
      await moveTaskInTx({ tx, notices: deps.notices, jobs: deps.jobs }, task, { type: "plan_answered", boxWarm: true });
      await deps.outbox.enqueueInTx(tx, organizationId, going.runnerId, {
        kind: "plan-answer",
        body: { sessionId, decision: input.decision, text: commandText },
        notAfter: now + runnerLimits.offerTimeoutMs,
        task: { taskId: task.id, projectId },
      });
      await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: task.id });
      return { ok: true, reopened: false };
    })
    .catch((error: unknown) => {
      if (refusal !== null) {
        return { ok: false, error: "invalid-input", message: refusal } as const;
      }
      throw error;
    });
};

// ---------- a question ----------

export type AnswerQuestionResult = UseCaseResult<{ readonly reopened: boolean }, "not-found" | "not-driver" | "already-answered" | "invalid-input">;

/** The answers checked against the question's fields: every field once, a select's value among its options. */
export const checkQuestionAnswers = (
  fields: readonly QuestionField[],
  answers: Readonly<Record<string, string>>,
): { readonly ok: true; readonly answers: Record<string, string> } | { readonly ok: false; readonly message: string } => {
  const known = new Set(fields.map((field) => field.id));
  const unknown = Object.keys(answers).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    return { ok: false, message: "An answer names a field the question doesn't have" };
  }
  const checked: Record<string, string> = {};
  for (const field of fields) {
    const value = answers[field.id];
    if (value === undefined || value.trim() === "") {
      return { ok: false, message: `Answer "${field.label}"` };
    }
    if (value.length > runnerLimits.steerTextMaxChars) {
      return { ok: false, message: `The answer to "${field.label}" is too long` };
    }
    if (field.type === "select" && !(field.options ?? []).includes(value)) {
      return { ok: false, message: `Pick one of the choices for "${field.label}"` };
    }
    checked[field.id] = value;
  }
  return { ok: true, answers: checked };
};

const questionEventsInTx = async (tx: Tx, taskId: string, questionId: QuestionId) => {
  const rows = await tx.event.findMany({
    where: { taskId, kind: { in: ["question.asked", "question.answered", "question.closed"] }, payload: { path: ["questionId"], equals: questionId } },
    orderBy: { seq: "asc" },
    select: { payload: true, sessionId: true },
  });
  let asked: (QuestionAsked & { readonly sessionId: string }) | null = null;
  let answered = false;
  let closed = false;
  for (const row of rows) {
    const parsed = taskEventSchema.safeParse(row.payload);
    if (!parsed.success) {
      continue;
    }
    if (parsed.data.kind === "question.asked") {
      asked = { ...parsed.data, sessionId: row.sessionId };
    } else if (parsed.data.kind === "question.answered") {
      answered = true;
    } else if (parsed.data.kind === "question.closed") {
      closed = true;
    }
  }
  return { asked, answered, closed };
};

/**
 * The driver's answer to the agent's question (F-024, Q168): checked against its fields, written as
 * `question.answered`, its item closed, and sent once as `question-answer`. A question the turn's end
 * closed keeps its item open; its answer reopens the task with the answer as the first message.
 */
export const answerQuestion = async (
  deps: AnswerDeps,
  scope: MemberScope,
  input: { readonly taskId: TaskId; readonly questionId: QuestionId; readonly answers: Readonly<Record<string, string>> },
): Promise<AnswerQuestionResult> => {
  let refusal: string | null = null;
  return deps.db
    .$transaction(async (tx): Promise<AnswerQuestionResult> => {
      const locked = await lockForAnswerInTx(tx, scope, input.taskId);
      if (!locked.ok) {
        return locked;
      }
      const { task } = locked;
      const { asked, answered, closed } = await questionEventsInTx(tx, task.id, input.questionId);
      if (asked === null) {
        return { ok: false, error: "not-found", message: "No such question" };
      }
      if (answered) {
        return { ok: false, error: "already-answered", message: "This question is answered already" };
      }
      const fields = z.array(questionFieldSchema).parse(asked.fields);
      const checked = checkQuestionAnswers(fields, input.answers);
      if (!checked.ok) {
        return { ok: false, error: "invalid-input", message: checked.message };
      }
      const now = deps.clock.now();
      const organizationId = scope.organizationId;
      const projectId = projectIdSchema.parse(task.projectId);
      const going = closed ? null : await goingSessionInTx(tx, task.id);
      // The answer goes on the session that asked, unless another one is going now.
      const sessionId = going === null ? sessionIdSchema.parse(asked.sessionId) : sessionIdSchema.parse(going.session.id);
      await appendServerEvent(tx, {
        organizationId,
        projectId,
        taskId: task.id,
        sessionId,
        at: now,
        event: { kind: "question.answered", questionId: input.questionId, answers: checked.answers, memberId: scope.memberId },
      });
      await closeItemsInTx(deps, tx, task, { reason: "question", questionId: input.questionId }, scope.memberId, now);

      if (going?.session.id !== asked.sessionId) {
        // Closed by the turn's end, or the session that asked is gone: the answer starts the next turn.
        const reopened = await reopenWithInTx(deps, tx, scope, task.id, lateQuestionAnswerPrompt({ question: asked.message, fields, answers: checked.answers }), undefined);
        if (!reopened.ok) {
          refusal = reopened.message;
          throw new Error(REOPEN_REFUSED);
        }
        return { ok: true, reopened: true };
      }
      const others = await tx.needsYouItem.count({ where: { taskId: task.id, state: "open", reason: { in: ["question", "approval"] } } });
      if (others === 0 && task.state === "needs_you" && task.needsYouReason === "question") {
        await moveTaskInTx({ tx, notices: deps.notices, jobs: deps.jobs }, task, { type: "member_acted", boxWarm: true });
        if (going.session.state === "waiting") {
          await moveSessionInTx({ tx, notices: deps.notices }, going.session, { type: "person_answered" });
        }
      }
      await deps.outbox.enqueueInTx(tx, organizationId, going.runnerId, {
        kind: "question-answer",
        body: { sessionId, questionId: input.questionId, answers: checked.answers },
        notAfter: now + runnerLimits.offerTimeoutMs,
        task: { taskId: task.id, projectId },
      });
      await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: task.id });
      return { ok: true, reopened: false };
    })
    .catch((error: unknown) => {
      if (refusal !== null) {
        return { ok: false, error: "invalid-input", message: refusal } as const;
      }
      throw error;
    });
};
