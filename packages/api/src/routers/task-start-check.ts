import {
  budgetMonthOf,
  checkBudget,
  modelNameText,
  noProviderMessage,
  resolveProfileModelInTx,
  resolveStartProfileInTx,
} from "@ostra/domain";
import type { MemberScope } from "@ostra/domain";
import type { Tx } from "@ostra/db";
import { agentProfileIdSchema, budgetIdSchema, projectIdSchema } from "@ostra/protocol";
import type { AgentProfileId, ProjectId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { projectProcedure } from "../trpc/init.ts";

// F-037 and F-135 (tickets 27 and 50; ADR 0055, ADR 0065): whether a new task in a project would
// start now, or why it would wait, before the member presses Start. It runs the same checks as the
// dispatch: the project's provider list for the profile's model, then `budgetGate` with the origin
// `dispatch`, over the same rows.

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export const startCheckSchema = z.union([
  /** F-135 (ticket 50): the provider whose key the task would use, for New task's "Key" row. */
  z.object({ kind: z.literal("open"), providerName: z.string() }),
  z.object({
    kind: z.literal("wait"),
    reason: z.literal("budget-reached"),
    budgetId: budgetIdSchema,
    scope: z.enum(["organization", "project"]),
    month: z.string(),
    message: z.string(),
  }),
  z.object({
    kind: z.literal("wait"),
    reason: z.literal("unpriced"),
    budgetId: budgetIdSchema,
    message: z.string(),
  }),
  /** No provider on the project's list serves the profile's model ("no key", F-135). */
  z.object({
    kind: z.literal("wait"),
    reason: z.literal("no-provider"),
    modelName: z.string(),
    /** ADR 0065 amended 2026-11-20: the profile's own provider, which the project doesn't allow or which no longer lists the model. */
    provider: z.object({ name: z.string(), reason: z.enum(["not-allowed", "not-listed"]) }).nullable(),
    message: z.string(),
  }),
]);
export type StartCheck = z.infer<typeof startCheckSchema>;

const monthName = (month: string): string => {
  const index = Number(month.slice(5, 7)) - 1;
  return `${MONTHS[index] ?? month} ${month.slice(0, 4)}`;
};

/** The check, inside a transaction the caller holds. */
export const startCheckInTx = async (
  tx: Tx,
  scope: MemberScope,
  input: {
    readonly projectId: ProjectId;
    readonly profileId: AgentProfileId | undefined;
    readonly now: number;
  },
): Promise<StartCheck> => {
  const organizationId = scope.organizationId;
  const project = await tx.project.findFirstOrThrow({
    where: { id: input.projectId, organizationId },
    select: {
      name: true,
      defaultRefineProfileId: true,
      defaultCodeProfileId: true,
      defaultReviewProfileId: true,
    },
  });
  const resolved = await resolveStartProfileInTx(tx, scope, {
    project,
    kind: "code",
    chosen: input.profileId,
  });
  if (!resolved.ok) {
    throw new TRPCError({
      code: resolved.error === "forbidden" ? "FORBIDDEN" : "PRECONDITION_FAILED",
      message: resolved.message,
    });
  }
  // The same resolution as the dispatch: the profile's own provider when it names one, which the
  // project's list must allow (ADR 0065 amended 2026-11-20), else the list's provider for the name.
  const model = await resolveProfileModelInTx(tx, { organizationId, projectId: input.projectId, profileId: resolved.profileId });
  if (!model.ok) {
    if (model.modelName === null) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "The task's agent profile has no model yet: an admin picks one under Models",
      });
    }
    return {
      kind: "wait",
      reason: "no-provider",
      modelName: modelNameText(model.modelName),
      provider: model.provider === null ? null : { name: model.provider.name, reason: model.provider.reason },
      message: noProviderMessage(model.modelName, model.provider),
    };
  }
  const gate = await checkBudget(tx, {
    organizationId,
    projectId: input.projectId,
    modelId: model.modelId,
    origin: "dispatch",
    now: input.now,
  });
  const provider = await tx.modelProvider.findFirst({ where: { id: model.providerId, organizationId }, select: { name: true } });
  const providerName = provider?.name ?? "";
  switch (gate.kind) {
    case "open":
      return { kind: "open", providerName };
    case "held": {
      if (gate.reason === "unpriced") {
        return {
          kind: "wait",
          reason: "unpriced",
          budgetId: gate.budgetId,
          message: "This model has no price, so the budget can't count it",
        };
      }
      const month = budgetMonthOf(input.now);
      const whose = gate.scope === "project" ? `${project.name}'s` : "The organization's";
      return {
        kind: "wait",
        reason: "budget-reached",
        budgetId: gate.budgetId,
        scope: gate.scope,
        month,
        message: `${whose} budget for ${monthName(month)} is reached`,
      };
    }
    default:
      return gate satisfies never;
  }
};

/** `tasks.startCheck`: the New task page and the Inbox call it before Start. */
export const startCheckProcedure = projectProcedure(
  "read",
  z.strictObject({ projectId: projectIdSchema, profileId: agentProfileIdSchema.optional() }),
)
  .output(startCheckSchema)
  .query(async ({ ctx, input }) =>
    ctx.deps.db.$transaction((tx) =>
      startCheckInTx(tx, ctx.scope, {
        projectId: input.projectId,
        profileId: input.profileId,
        now: ctx.deps.ports.clock.now(),
      }),
    ),
  );
