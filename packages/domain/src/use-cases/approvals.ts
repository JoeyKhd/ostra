import { randomUUID } from "node:crypto";

import type { Logger } from "@ostra/adapter-sdk";
import { mapTask } from "@ostra/db";
import type { Db, Session, Tx } from "@ostra/db";
import {
  approvalIdSchema,
  approvalOptionSchema,
  clientMessageIdSchema,
  denyReasonSchema,
  optionIdSchema,
  projectIdSchema,
  PROTOCOL_MINOR,
  runnerIdSchema,
  runnerLimits,
  sessionIdSchema,
  taskApprovalRuleIdSchema,
  taskIdSchema,
  taskRulePatternFor,
  toolForSubjectKind,
} from "@ostra/protocol";
import type { ApprovalSubject, NeedsYouItemId, RunnerId, TaskEvent, TaskRule } from "@ostra/protocol";
import { z } from "zod";

import { requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import type { Ports } from "../ports.ts";
import { expiredApprovalAnswerPrompt } from "../prompts/index.ts";
import type { UseCaseResult } from "./common.ts";
import { moveSessionInTx, moveTaskInTx } from "./moves.ts";
import { createNeedsYouItemInTx, resolveNeedsYouItemsInTx } from "./needs-you-items.ts";
import type { TaskMoveDeps } from "./moves.ts";
import { reopenTask } from "./reopen.ts";
import { appendServerEvent } from "./server-events.ts";
import { recordPersonActionInTx } from "../review-loop/rounds.ts";
import type { SessionTimers } from "./sessions-m2.ts";
import type { SpendCapSettings } from "./spend.ts";

// Approvals (F-026, ADR 0049, ADR 0036, milestone 3's ticket 17). The runner asks when a profile
// rule covers a tool call, or when the agent asks on its own; it answers a task rule's match itself
// and says so. Core keeps one `Approval` row per request and, for one a person must answer, one
// needs-you item (audience: the driver, or the project's members when the task has none), moves the
// task to needs you and enqueues the item's fan-out. A member's answer is a compare-and-set on the
// row: the first answer wins and a second gets `already-answered`. "Approve for this task" writes a
// `TaskApprovalRule` and sends it in the command; a deny carries its reason, which reaches the
// command, the event and the row, and never the audit entry or a log line.
//
// An approval that expired (the runner cancelled the turn after 15 minutes) keeps its item open
// (ADR 0039): an answer then reopens the task with the decision as the reopen's message. A minor-1
// runner answers its own approvals "once" (milestone 1's behaviour): core records each with the rule
// `peer-too-old`, and raises nothing.

/** The rule a minor-1 runner's own "once" is recorded with (spec section 5.1). */
export const PEER_TOO_OLD_RULE = "peer-too-old";

/** The first protocol minor whose runner waits for a member's answer. */
const APPROVALS_MINOR = 2;

type ApprovalRequested = Extract<TaskEvent, { readonly kind: "approval.requested" }>;
type ApprovalAutoAnswered = Extract<TaskEvent, { readonly kind: "approval.auto_answered" }>;
type ApprovalClosed = Extract<TaskEvent, { readonly kind: "approval.closed" }>;

type LockedTask = ReturnType<typeof mapTask>;

/** What ingest hands the approval effects: its transaction and ports. */
export type ApprovalEffectDeps = Pick<Ports, "jobs" | "notices" | "clock"> & {
  readonly tx: Tx;
  readonly logger?: Logger | undefined;
};

const moveDepsOf = (deps: ApprovalEffectDeps): TaskMoveDeps => ({ tx: deps.tx, notices: deps.notices, jobs: deps.jobs, ...(deps.logger === undefined ? {} : { logger: deps.logger }) });

/**
 * The task leaves needs you once no approval holds it: when its reason is `approval` and no other
 * approval item of the task is open (`except` aside). The session waiting on the person goes on.
 */
const releaseWhenNoneOpenInTx = async (deps: TaskMoveDeps, taskId: string, sessionId: string, except: string | null, force = false): Promise<boolean> => {
  const { tx } = deps;
  const task = mapTask(await tx.task.findUniqueOrThrow({ where: { id: taskId } }));
  if (task.state !== "needs_you" || task.needsYouReason !== "approval") {
    return false;
  }
  if (!force) {
    const open = await tx.needsYouItem.count({ where: { taskId, reason: "approval", state: "open", ...(except === null ? {} : { id: { not: except } }) } });
    if (open > 0) {
      return false;
    }
  }
  const moved = await moveTaskInTx(deps, task, { type: "member_acted", boxWarm: true });
  const session = await tx.session.findUnique({ where: { id: sessionId } });
  if (session?.state === "waiting") {
    await moveSessionInTx(deps, session, { type: "person_answered" });
  }
  return moved;
};

/** The runner's protocol minor, from its presence; a runner with none is taken at the current minor. */
const runnerMinorInTx = async (tx: Tx, runnerId: RunnerId): Promise<number> =>
  (await tx.runnerPresence.findUnique({ where: { runnerId }, select: { minor: true } }))?.minor ?? PROTOCOL_MINOR;

/**
 * `approval.requested` saved (ingest): the approval with its rule and subject, its needs-you item,
 * the session waiting and the task needing you, the item's fan-out. From a minor-1 runner, which
 * answered "once" already, only the row, answered by `peer-too-old`. `null` when no item was raised.
 */
export const recordApprovalRequestedInTx = async (
  deps: ApprovalEffectDeps,
  input: { readonly task: LockedTask; readonly session: Session; readonly runnerId: RunnerId; readonly event: ApprovalRequested },
): Promise<{ readonly itemId: NeedsYouItemId | null }> => {
  const { tx } = deps;
  const { task, session, event } = input;
  const existing = await tx.approval.findUnique({ where: { id: event.approvalId }, select: { taskId: true } });
  if (existing !== null) {
    // The same request twice (a resend past the cursor can't happen, but another task's ID can).
    if (existing.taskId !== task.id) {
      deps.logger?.warn("approval.id-taken", { taskId: task.id, approvalId: event.approvalId });
    }
    return { itemId: null };
  }
  const now = new Date(deps.clock.now());
  const subject: ApprovalSubject | undefined = event.subject;
  const base = {
    id: event.approvalId,
    organizationId: task.organizationId,
    projectId: task.projectId,
    taskId: task.id,
    sessionId: session.id,
    toolCallId: event.toolCallId,
    options: event.options,
    ruleId: event.rule?.ruleId ?? null,
    ruleSource: event.rule?.source ?? null,
    subjectKind: subject?.kind ?? null,
    subjectValue: subject?.value ?? null,
  };
  if ((await runnerMinorInTx(tx, input.runnerId)) < APPROVALS_MINOR) {
    // Milestone 1's runner answered it "once" already: recorded, never raised.
    await tx.approval.create({ data: { ...base, state: "answered_by_rule", decision: "allow_once", ruleId: PEER_TOO_OLD_RULE, resolvedAt: now } });
    await deps.notices.emitInTx(tx, { organizationId: task.organizationId, projectId: task.projectId, entity: "task", entityId: task.id });
    return { itemId: null };
  }
  await tx.approval.create({ data: { ...base, state: "open" } });
  // The item and its fan-out, through the one writer of needs-you items (F-036).
  const itemId = await createNeedsYouItemInTx(deps, tx, {
    organizationId: task.organizationId,
    projectId: task.projectId,
    taskId: task.id,
    reason: "approval",
    audience: task.driverMemberId === null ? "project_members" : "driver",
    approvalId: event.approvalId,
  });
  const moveDeps = moveDepsOf(deps);
  if (session.state === "running") {
    await moveSessionInTx(moveDeps, session, { type: "waiting_on_person" });
  }
  if (task.state === "running") {
    await moveTaskInTx(moveDeps, task, { type: "needs_you", reason: "approval" });
  }
  await deps.notices.emitInTx(tx, { organizationId: task.organizationId, projectId: task.projectId, entity: "task", entityId: task.id });
  return { itemId };
};

/**
 * `approval.auto_answered` saved: a task rule answered the request. For a request already stored
 * and open (a rule "Approve for this task" just added answered a request the runner held), the row
 * is answered by that rule and its item closes, with its "answered" fan-out. One with no earlier
 * request is the event alone: no row, no item, no notification.
 */
export const recordApprovalAutoAnsweredInTx = async (
  deps: ApprovalEffectDeps,
  input: { readonly task: LockedTask; readonly session: Session; readonly event: ApprovalAutoAnswered },
): Promise<void> => {
  const { tx } = deps;
  const { task, event } = input;
  const now = new Date(deps.clock.now());
  const won = await tx.approval.updateMany({
    where: { id: event.approvalId, taskId: task.id, state: "open" },
    // A minor-2 runner answers on its own only by a task rule (ticket 30).
    data: { state: "answered_by_rule", decision: "allow_once", ruleId: event.ruleId, ruleSource: "task", resolvedAt: now },
  });
  if (won.count !== 1) {
    return;
  }
  await resolveNeedsYouItemsInTx(deps, tx, { approvalId: event.approvalId, taskId: task.id }, { state: "answered", at: now, byMemberId: null });
  const approval = await tx.approval.findUniqueOrThrow({ where: { id: event.approvalId }, select: { sessionId: true } });
  await releaseWhenNoneOpenInTx(moveDepsOf(deps), task.id, approval.sessionId, null);
  await deps.notices.emitInTx(tx, { organizationId: task.organizationId, projectId: task.projectId, entity: "task", entityId: task.id });
};

/**
 * `approval.closed` saved: `cancelled` (the turn was interrupted, the task stopped, or a deny's
 * other requests) closes the row and dismisses its item; `expired` closes the row and leaves the
 * item open, so a late answer reopens the task (ADR 0039).
 */
export const recordApprovalClosedInTx = async (
  deps: ApprovalEffectDeps,
  input: { readonly task: LockedTask; readonly session: Session; readonly event: ApprovalClosed },
): Promise<void> => {
  const { tx } = deps;
  const { task, event } = input;
  const now = new Date(deps.clock.now());
  const closed = await tx.approval.updateMany({
    where: { id: event.approvalId, taskId: task.id, state: "open" },
    data: { state: "closed", closedReason: event.reason, resolvedAt: now },
  });
  if (closed.count !== 1) {
    return;
  }
  if (event.reason === "cancelled") {
    await resolveNeedsYouItemsInTx(deps, tx, { approvalId: event.approvalId, taskId: task.id }, { state: "dismissed", at: now, byMemberId: null });
    const approval = await tx.approval.findUniqueOrThrow({ where: { id: event.approvalId }, select: { sessionId: true } });
    await releaseWhenNoneOpenInTx(moveDepsOf(deps), task.id, approval.sessionId, null);
  }
  await deps.notices.emitInTx(tx, { organizationId: task.organizationId, projectId: task.projectId, entity: "task", entityId: task.id });
};

// ---------- a member's answer (`approvals.answer`) ----------

export const answerApprovalInputSchema = z.strictObject({
  approvalId: approvalIdSchema,
  decision: z.enum(["allow_once", "allow_task", "deny"]),
  optionId: optionIdSchema,
  /** With `deny`: shown to the project's members, never logged or audited. */
  reason: z.string().max(runnerLimits.denyReasonMaxChars * 2).nullable(),
});

export type AnswerApprovalDeps = { readonly db: Db } & Pick<Ports, "jobs" | "outbox" | "notices" | "audit" | "clock"> & {
  /** The caps a reopen honours (an answer to an expired approval reopens the task). */
  readonly spendCap?: SpendCapSettings | undefined;
  readonly timers?: SessionTimers | undefined;
};

export type AnswerApprovalResult = UseCaseResult<
  { readonly taskRule: TaskRule | null; readonly reopened: boolean },
  "not-found" | "already-answered" | "no-pattern" | "invalid-input"
>;

const refuse = (error: Exclude<AnswerApprovalResult, { readonly ok: true }>["error"], message: string): AnswerApprovalResult => ({ ok: false, error, message });

/** Why an answer reaches the task: the row's subject, for the reopen's message. */
const subjectOf = (row: { readonly subjectKind: ApprovalSubject["kind"] | null; readonly subjectValue: string | null }): ApprovalSubject | null =>
  row.subjectKind === null || row.subjectValue === null ? null : { kind: row.subjectKind, value: row.subjectValue };

/**
 * A member's answer to an approval (F-026): any member who can open the project. The first answer
 * wins by a compare-and-set; "for this task" writes the task rule first (one row per task, tool and
 * pattern, so two answers in a race write one) and sends it in the command; a deny's reason goes to
 * the command, the event and the row. An expired approval whose item is open is answered too, and
 * reopens the task with the decision; a cancelled one is refused.
 */
export const answerApproval = async (
  deps: AnswerApprovalDeps,
  scope: MemberScope,
  raw: z.input<typeof answerApprovalInputSchema>,
): Promise<AnswerApprovalResult> => {
  const parsed = answerApprovalInputSchema.safeParse(raw);
  if (!parsed.success) {
    return refuse("invalid-input", "That answer doesn't read");
  }
  const input = parsed.data;
  const organizationId = scope.organizationId;
  let reason: string | null = null;
  if (input.reason !== null && input.reason.trim() !== "") {
    if (input.decision !== "deny") {
      return refuse("invalid-input", "Only a deny takes a reason");
    }
    const checked = denyReasonSchema.safeParse(input.reason);
    if (!checked.success) {
      return refuse("invalid-input", `A reason is at most ${String(runnerLimits.denyReasonMaxChars)} characters`);
    }
    reason = checked.data;
  }
  const found = await deps.db.approval.findFirst({ where: { id: input.approvalId, organizationId }, select: { taskId: true, projectId: true } });
  if (found === null) {
    return refuse("not-found", "No such approval");
  }
  const project = await deps.db.project.findFirst({ where: { id: found.projectId, organizationId }, select: { id: true, access: true } });
  if (project === null || !requireProjectAccess(scope, { id: projectIdSchema.parse(project.id), organizationId, access: project.access }, "read").ok) {
    // A project the member can't open reads as no approval at all.
    return refuse("not-found", "No such approval");
  }
  const projectId = projectIdSchema.parse(project.id);
  const taskId = taskIdSchema.parse(found.taskId);

  // A late answer whose reopen is refused throws to roll the answer back; this holds its words.
  let refusal: string | null = null;
  return deps.db.$transaction(async (tx): Promise<AnswerApprovalResult> => {
    // The task's row first, as every writer of the task's log takes it: answers to one task serialize.
    const locked = await tx.$queryRaw<readonly unknown[]>`SELECT 1 FROM "task" WHERE "id" = ${taskId} AND "organizationId" = ${organizationId} FOR UPDATE`;
    if (locked.length === 0) {
      return refuse("not-found", "No such approval");
    }
    const approval = await tx.approval.findUniqueOrThrow({ where: { id: input.approvalId } });
    const options = z.array(approvalOptionSchema).safeParse(approval.options);
    const option = options.success ? options.data.find((candidate) => candidate.optionId === input.optionId && candidate.decision === input.decision) : undefined;
    if (option === undefined) {
      return refuse("invalid-input", "The agent offered no such option");
    }
    // Milestone 6 (ADR 0041): an answer is a person's action, so the automatic turns count from nothing.
    await recordPersonActionInTx(tx, taskId, new Date(deps.clock.now()));
    const openItem = await tx.needsYouItem.findFirst({ where: { approvalId: approval.id, taskId, state: "open" }, select: { id: true } });
    // "Answer anyway": an expired approval while its item is open. A cancelled one is over.
    const late = approval.state === "closed" && approval.closedReason === "expired" && openItem !== null;
    if (approval.state !== "open" && !late) {
      return refuse("already-answered", approval.state === "closed" ? "This request was cancelled: the agent no longer waits for it" : "Someone answered this first");
    }

    // "For this task" needs a pattern from the request's subject; without one there's nothing to write.
    const subject = subjectOf(approval);
    const pattern = input.decision === "allow_task" && subject !== null ? taskRulePatternFor({ tool: toolForSubjectKind(subject.kind), subject }) : null;
    if (input.decision === "allow_task" && pattern === null) {
      return refuse("no-pattern", "This request gives no pattern to approve for the whole task: approve it once instead");
    }

    // The compare-and-set: of two members answering at once, one row update matches. The loser
    // writes nothing at all.
    const now = deps.clock.now();
    const won = await tx.approval.updateMany({
      where: { id: approval.id, state: approval.state, ...(late ? { closedReason: "expired" } : {}) },
      data: { state: "answered", decision: input.decision, optionId: option.optionId, answeredByMemberId: scope.memberId, denyReason: reason, resolvedAt: new Date(now) },
    });
    if (won.count !== 1) {
      return refuse("already-answered", "Someone answered this first");
    }

    // The task rule, before the command that names its ID (ticket 01). The unique key on (task,
    // tool, pattern) makes a second write of the same rule, from another approval, the same row.
    let taskRule: TaskRule | null = null;
    if (pattern !== null) {
      const row = await tx.taskApprovalRule.upsert({
        where: { taskId_tool_pattern: { taskId, tool: pattern.tool, pattern: pattern.pattern } },
        create: { organizationId, projectId, taskId, tool: pattern.tool, pattern: pattern.pattern, approvalId: approval.id, createdByMemberId: scope.memberId },
        update: {},
        select: { id: true, tool: true, pattern: true },
      });
      taskRule = { ruleId: taskApprovalRuleIdSchema.parse(row.id), tool: row.tool, pattern: row.pattern };
    }
    const sessionId = sessionIdSchema.parse(approval.sessionId);
    await appendServerEvent(tx, {
      organizationId,
      projectId,
      taskId,
      sessionId,
      at: now,
      event: {
        kind: "approval.answered",
        approvalId: approvalIdSchema.parse(approval.id),
        optionId: option.optionId,
        decision: input.decision,
        memberId: scope.memberId,
        ...(reason === null ? {} : { reason }),
        ...(input.decision === "allow_task" ? { taskRule } : {}),
      },
    });
    await resolveNeedsYouItemsInTx(deps, tx, { approvalId: approval.id, taskId }, { state: "answered", at: new Date(now), byMemberId: scope.memberId });
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId,
      actor: { kind: "member", id: scope.memberId },
      action: "approval.answered",
      entity: "approval",
      entityId: input.approvalId,
      // The decision and the rule, never a reason's text or the rule's pattern (ADR 0049).
      data: { decision: input.decision, ...(taskRule === null ? {} : { taskRuleId: taskRule.ruleId, tool: taskRule.tool }), ...(late ? { late: true } : {}) },
    });

    if (late) {
      // The turn that asked is over: the decision is the reopen's message (milestone 2's path).
      const reopened = await reopenTask(
        { tx, scope, jobs: deps.jobs, notices: deps.notices, audit: deps.audit, clock: deps.clock, spendCap: deps.spendCap, timers: deps.timers },
        {
          taskId,
          clientMessageId: clientMessageIdSchema.parse(randomUUID()),
          text: expiredApprovalAnswerPrompt({ decision: input.decision, subject: subject?.value ?? null, reason }),
        },
      );
      if (!reopened.ok) {
        // Nothing of the answer stays: the transaction rolls back with the refusal.
        refusal = reopened.message;
        throw new Error("the late answer's reopen was refused");
      }
      return { ok: true, taskRule, reopened: true };
    }

    // A deny ends the agent's turn, and the runner closes the session's other requests as
    // cancelled (ADR 0036): those are the runner's events, so the task leaves needs you now.
    await releaseWhenNoneOpenInTx({ tx, notices: deps.notices, jobs: deps.jobs }, taskId, sessionId, null, input.decision === "deny");
    const lease = await tx.lease.findFirst({ where: { taskId, state: "active" }, select: { runnerId: true } });
    if (lease !== null) {
      await deps.outbox.enqueueInTx(tx, organizationId, runnerIdSchema.parse(lease.runnerId), {
        kind: "approval-answer",
        body: {
          sessionId,
          approvalId: approvalIdSchema.parse(approval.id),
          decision: input.decision,
          ...(reason === null ? {} : { reason }),
          ...(input.decision === "allow_task" ? { taskRule } : {}),
        },
        notAfter: now + runnerLimits.offerTimeoutMs,
        task: { taskId, projectId },
      });
    }
    await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: taskId });
    return { ok: true, taskRule, reopened: false };
  }).catch((error: unknown) => {
    if (refusal !== null) {
      return refuse("invalid-input", refusal);
    }
    throw error;
  });
};

