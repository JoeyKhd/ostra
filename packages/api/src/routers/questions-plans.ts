import { answerPlan, answerQuestion } from "@ostra/domain";
import { QUESTION_OTHER_MAX, planEntrySchema, questionIdSchema, runnerLimits, taskIdSchema } from "@ostra/protocol";
import { z } from "zod";

import { router, taskProcedure, unwrap } from "../trpc/init.ts";

// F-063, F-026 (questions), ticket 35 (ADR 0036, ADR 0049): the driver's answers to the agent's
// questions and to the plan. Only the driver answers, under the task's lock (a take-over committed
// first is seen), and anyone else is told "Take over to answer". An answer to a task with no session
// going reopens it, as the composer's send does. The plan and the answers are a member's words and
// the agent's: returned and stored as data, never logged.

const spendCapOf = (settings: { readonly taskSpendCapMicroUsd: number; readonly taskTokenCap: number }) => ({ capMicroUsd: settings.taskSpendCapMicroUsd, capTokens: settings.taskTokenCap });

export const questionsRouter = router({
  /**
   * Answers a question the agent asked, with one answer per field. Every field must be answered, and
   * a choice must be one of the field's options. The driver only; a second answer is `CONFLICT`.
   *
   * Milestone 10 (F-151/c5, the targets' choice 5): `other` names the choices answered in the
   * member's own words (`Something else…`), whose answer is those words; none by default. Field IDs
   * only: the words are the answers', as data, never logged.
   */
  answer: taskProcedure(
    "read",
    z.strictObject({
      taskId: taskIdSchema,
      questionId: questionIdSchema,
      answers: z.record(z.string().max(200), z.string().max(runnerLimits.steerTextMaxChars)),
      other: z.array(z.string().max(200)).max(QUESTION_OTHER_MAX).default([]),
    }),
  ).mutation(async ({ ctx, input }) => {
    const { db, ports, settings } = ctx.deps;
    const result = await answerQuestion({ db, ...ports, spendCap: spendCapOf(settings) }, ctx.scope, { taskId: input.taskId, questionId: input.questionId, answers: input.answers, other: input.other });
    const answered = unwrap(result, { "not-found": "NOT_FOUND", "not-driver": "FORBIDDEN", "already-answered": "CONFLICT", "invalid-input": "BAD_REQUEST" });
    return { questionId: input.questionId, reopened: answered.reopened };
  }),
});

export const plansRouter = router({
  /**
   * The driver's answer to the plan: "Approve plan" with the steps as shown or as edited, and the
   * message, or "Ask for changes" with a request. Core renders the text the agent reads from them
   * (marked blocks), so the panel sends structure, not prose.
   */
  answer: taskProcedure(
    "read",
    z.discriminatedUnion("decision", [
      z.strictObject({ taskId: taskIdSchema, decision: z.literal("approve"), entries: z.array(planEntrySchema).min(1).max(runnerLimits.planEntriesMax), message: z.string().max(runnerLimits.planMessageMaxBytes) }),
      z.strictObject({ taskId: taskIdSchema, decision: z.literal("revise"), request: z.string().trim().min(1).max(runnerLimits.planMessageMaxBytes) }),
    ]),
  ).mutation(async ({ ctx, input }) => {
    const { db, ports, settings } = ctx.deps;
    const result = await answerPlan(
      { db, ...ports, spendCap: spendCapOf(settings) },
      ctx.scope,
      input.decision === "approve" ? { taskId: input.taskId, decision: "approve", entries: input.entries, message: input.message } : { taskId: input.taskId, decision: "revise", request: input.request },
    );
    const answered = unwrap(result, { "not-found": "NOT_FOUND", "not-driver": "FORBIDDEN", "no-plan": "PRECONDITION_FAILED", "invalid-input": "BAD_REQUEST" });
    return { decision: input.decision, reopened: answered.reopened };
  }),
});
