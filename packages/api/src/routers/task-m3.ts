import {
  approvalIdSchema,
  approvalOptionSchema,
  approvalRuleRefSchema,
  approvalSubjectSchema,
  memberIdSchema,
  needsYouItemIdSchema,
  planEntrySchema,
  questionFieldSchema,
  questionIdSchema,
  taskApprovalRuleIdSchema,
  taskRulePatternFor,
  toolForSubjectKind,
  turnIdSchema,
} from "@ostra/protocol";
import type { ApprovalSubject, PlanEntry, TaskRulePattern } from "@ostra/protocol";
import { z } from "zod";

import type { ApiDeps } from "../trpc/context.ts";

// F-026, F-063, F-024 (ticket 35): what the task page needs to answer from: the task's approvals
// with the rule that asked, the subject and the pattern "for this task" would add; its open
// questions; its plan; its task rules; and whether the agent steers mid-turn. Everything is read
// from the task's own rows in the caller's organization. A request's subject, a plan and a deny's
// reason are returned as data, to members who can open the task, and never logged.

type TaskRow = {
  readonly id: string;
  readonly organizationId: string;
  readonly planState: "none" | "proposed" | "approved";
};

/** Resolved approvals shown on the page: the newest this many (the thread has the rest). */
const RESOLVED_APPROVALS_SHOWN = 30;

const requestedPayload = z.looseObject({
  approvalId: approvalIdSchema,
  rule: approvalRuleRefSchema.nullable().optional(),
  subject: approvalSubjectSchema.optional(),
});
const questionAskedPayload = z.looseObject({
  questionId: questionIdSchema,
  message: z.string(),
  fields: z.array(questionFieldSchema),
});
const planProposedPayload = z.looseObject({ turnId: turnIdSchema, entries: z.array(planEntrySchema), message: z.string() });
const planAnsweredPayload = z.looseObject({
  decision: z.enum(["approve", "revise"]),
  text: z.string(),
  memberId: memberIdSchema,
  entries: z.array(planEntrySchema).optional(),
  message: z.string().optional(),
});

/** The pattern "Approve for this task" would write for a request, or `null` when the subject gives no safe one. */
export const taskRulePreviewOf = (subject: ApprovalSubject | null): TaskRulePattern | null =>
  subject === null ? null : taskRulePatternFor({ tool: toolForSubjectKind(subject.kind), subject });

const subjectOfRow = (row: { readonly subjectKind: ApprovalSubject["kind"] | null; readonly subjectValue: string | null }): ApprovalSubject | null =>
  row.subjectKind === null || row.subjectValue === null ? null : { kind: row.subjectKind, value: row.subjectValue };

/** Marks the steps of an approved plan that the driver changed: no step of the proposal says the same. */
export const editedSteps = (proposed: readonly PlanEntry[], approved: readonly PlanEntry[]): readonly boolean[] =>
  approved.map((entry) => !proposed.some((candidate) => candidate.content === entry.content && candidate.priority === entry.priority));

export const loadApprovalsAndPlan = async (deps: ApiDeps, task: TaskRow) => {
  const { db } = deps;
  const { organizationId } = task;
  const [approvals, requested, taskRules, openItems, planEvents, planAnswers, askedEvents] = await Promise.all([
    db.approval.findMany({
      where: { taskId: task.id, organizationId },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { needsYouItems: { select: { id: true, state: true } } },
    }),
    db.event.findMany({ where: { taskId: task.id, organizationId, kind: "approval.requested" }, orderBy: { seq: "desc" }, take: 200, select: { payload: true } }),
    db.taskApprovalRule.findMany({ where: { taskId: task.id, organizationId }, orderBy: { createdAt: "asc" } }),
    db.needsYouItem.findMany({ where: { taskId: task.id, organizationId, state: "open", reason: { in: ["question", "plan"] } }, orderBy: { createdAt: "asc" } }),
    db.event.findMany({ where: { taskId: task.id, organizationId, kind: "plan.proposed" }, orderBy: { seq: "desc" }, take: 2, select: { seq: true, payload: true, occurredAt: true } }),
    db.event.findMany({ where: { taskId: task.id, organizationId, kind: "plan.answered" }, orderBy: { seq: "desc" }, take: 2, select: { seq: true, payload: true, occurredAt: true } }),
    db.event.findMany({ where: { taskId: task.id, organizationId, kind: "question.asked" }, orderBy: { seq: "desc" }, take: 100, select: { seq: true, payload: true } }),
  ]);

  const requestOf = new Map<string, z.infer<typeof requestedPayload>>();
  for (const row of requested) {
    const parsed = requestedPayload.safeParse(row.payload);
    if (parsed.success && !requestOf.has(parsed.data.approvalId)) {
      requestOf.set(parsed.data.approvalId, parsed.data);
    }
  }
  // Who answered the plan is named on its receipt too ("Plan approved by Demo").
  const planAnswerers = planAnswers.flatMap((row) => {
    const parsed = planAnsweredPayload.safeParse(row.payload);
    return parsed.success ? [parsed.data.memberId] : [];
  });
  const memberIds = new Set<string>([...approvals.flatMap((row) => (row.answeredByMemberId === null ? [] : [row.answeredByMemberId])), ...taskRules.map((rule) => rule.createdByMemberId), ...planAnswerers]);
  const members = memberIds.size === 0 ? [] : await db.member.findMany({ where: { id: { in: [...memberIds] }, organizationId }, select: { id: true, user: { select: { name: true } } } });
  const nameOf = (memberId: string | null): { readonly memberId: ReturnType<typeof memberIdSchema.parse>; readonly name: string } | null =>
    memberId === null ? null : { memberId: memberIdSchema.parse(memberId), name: members.find((member) => member.id === memberId)?.user.name ?? "" };

  const view = (row: (typeof approvals)[number]) => {
    const requestedEvent = requestOf.get(row.id);
    const options = z.array(approvalOptionSchema).safeParse(row.options);
    const subject = subjectOfRow(row) ?? requestedEvent?.subject ?? null;
    const item = row.needsYouItems[0];
    return {
      approvalId: approvalIdSchema.parse(row.id),
      itemId: item === undefined ? null : needsYouItemIdSchema.parse(item.id),
      state: row.state,
      /** Why it closed: the turn was cancelled, or the 15 minutes passed. */
      closedReason: row.closedReason,
      /** The rule that asked: a profile's or the task's, with its name; `null` when the agent asked on its own. */
      rule: requestedEvent?.rule ?? null,
      /** What the request touches, as data. */
      subject,
      options: options.success ? options.data : [],
      /** The rule "Approve for this task" would add, or `null` when the subject gives none (the card then offers no such button). */
      forThisTask: taskRulePreviewOf(subject),
      decision: row.decision,
      answeredBy: nameOf(row.answeredByMemberId),
      /** A deny's reason: shown to every member who can open the task (ticket 35's decision). */
      denyReason: row.denyReason,
      /** An expired approval can still be answered while its item is open ("Answer anyway"). */
      answerableAnyway: row.state === "closed" && row.closedReason === "expired" && item?.state === "open",
      createdAt: row.createdAt.getTime(),
      resolvedAt: row.resolvedAt?.getTime() ?? null,
    };
  };
  const views = approvals.map(view);
  const open = views.filter((approval) => approval.state === "open" || approval.answerableAnyway).reverse();
  const resolved = views.filter((approval) => approval.state !== "open" && !approval.answerableAnyway).slice(0, RESOLVED_APPROVALS_SHOWN).reverse();

  // Questions: an open `question` item names the question, the event holds its text and fields.
  const askedById = new Map<string, z.infer<typeof questionAskedPayload>>();
  for (const row of askedEvents) {
    const parsed = questionAskedPayload.safeParse(row.payload);
    if (parsed.success && !askedById.has(parsed.data.questionId)) {
      askedById.set(parsed.data.questionId, parsed.data);
    }
  }
  const questions = openItems.flatMap((item) => {
    const asked = item.questionId === null ? undefined : askedById.get(item.questionId);
    return item.reason === "question" && asked !== undefined
      ? [{ itemId: needsYouItemIdSchema.parse(item.id), questionId: asked.questionId, message: asked.message, fields: asked.fields, askedAt: item.createdAt.getTime() }]
      : [];
  });

  // The plan: the newest proposal, and how it was answered. The receipt shows only what was approved.
  const proposedRow = planEvents[0];
  const proposed = proposedRow === undefined ? null : planProposedPayload.safeParse(proposedRow.payload);
  const answeredRow = planAnswers[0];
  const answered = answeredRow === undefined ? null : planAnswerParse(answeredRow.payload);
  const planItem = openItems.find((item) => item.reason === "plan");
  const answeredAfterProposal = answeredRow !== undefined && proposedRow !== undefined && answeredRow.seq > proposedRow.seq;
  const plan =
    !proposed?.success
      ? null
      : {
          state: task.planState,
          itemId: planItem === undefined ? null : needsYouItemIdSchema.parse(planItem.id),
          turnId: proposed.data.turnId,
          entries: proposed.data.entries,
          message: proposed.data.message,
          proposedAt: proposedRow?.occurredAt.getTime() ?? null,
          /** Once approved: the plan as approved, with the steps the driver changed marked `edited`. */
          approved:
            answeredAfterProposal && answered?.decision === "approve" && answered.entries !== undefined
              ? {
                  entries: answered.entries,
                  message: answered.message ?? "",
                  edited: editedSteps(proposed.data.entries, answered.entries),
                  by: nameOf(answered.memberId),
                }
              : null,
          /** Once the driver asked for changes: their request. */
          revision: answeredAfterProposal && answered?.decision === "revise" ? { request: answered.text, by: nameOf(answered.memberId) } : null,
        };

  return {
    approvals: [...resolved, ...open],
    questions,
    plan,
    taskRules: taskRules.map((rule) => ({
      ruleId: taskApprovalRuleIdSchema.parse(rule.id),
      tool: rule.tool,
      pattern: rule.pattern,
      approvalId: rule.approvalId === null ? null : approvalIdSchema.parse(rule.approvalId),
      createdBy: nameOf(rule.createdByMemberId),
      createdAt: rule.createdAt.getTime(),
    })),
  };
};

const planAnswerParse = (payload: unknown) => {
  const parsed = planAnsweredPayload.safeParse(payload);
  return parsed.success ? parsed.data : null;
};

/** One approval for the card: its rule, subject, options and the pattern "for this task" would write. */
export const previewApproval = async (deps: ApiDeps, organizationId: string, approvalId: string) => {
  const approval = await deps.db.approval.findFirstOrThrow({ where: { id: approvalId, organizationId } });
  const requested = await deps.db.event.findMany({ where: { taskId: approval.taskId, organizationId, kind: "approval.requested" }, orderBy: { seq: "desc" }, take: 200, select: { payload: true } });
  const event = requested.flatMap((row) => {
    const parsed = requestedPayload.safeParse(row.payload);
    return parsed.success && parsed.data.approvalId === approval.id ? [parsed.data] : [];
  })[0];
  const options = z.array(approvalOptionSchema).safeParse(approval.options);
  const subject = subjectOfRow(approval) ?? event?.subject ?? null;
  const forThisTask = taskRulePreviewOf(subject);
  return {
    approvalId: approvalIdSchema.parse(approval.id),
    taskId: approval.taskId,
    state: approval.state,
    closedReason: approval.closedReason,
    /** The rule that asked: a profile's or the task's, by name; `null` when the agent asked on its own. */
    rule: event?.rule ?? null,
    subject,
    options: options.success ? options.data : [],
    /** The rule "Approve for this task" would add. */
    forThisTask,
  };
};
