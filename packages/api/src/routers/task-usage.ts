import { readTaskUsage } from "@ostra/domain";
import { turnIdSchema } from "@ostra/protocol";
import type { OrganizationId, TaskId } from "@ostra/protocol";

import type { ApiDeps } from "../trpc/context.ts";

// F-084 (ticket 39; ADR 0042, Q163): a task's tokens in four kinds, its spend and its agent time,
// in total and per turn, with the figures the key proxy estimated marked as estimates. Core keeps
// the figures on the turns as usage arrives (ticket 28); this reads them. Spend is `null` for tokens
// whose model has no price: the page then shows tokens and no dollars.

export const loadUsageView = async (deps: ApiDeps, organizationId: OrganizationId, taskId: TaskId) => {
  const usage = await readTaskUsage(deps.db, organizationId, taskId);
  if (usage === null) {
    return null;
  }
  const counts = (figures: { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens: number; readonly cacheWriteTokens: number }) => ({
    inputTokens: figures.inputTokens,
    outputTokens: figures.outputTokens,
    cacheReadTokens: figures.cacheReadTokens,
    cacheWriteTokens: figures.cacheWriteTokens,
  });
  return {
    totals: {
      ...counts(usage.totals),
      spentMicroUsd: usage.totals.spentMicroUsd,
      agentMs: usage.totals.agentMs,
      /** Some of it was estimated by the key proxy. */
      estimated: usage.totals.estimated,
    },
    turns: usage.turns.map((turn) => ({
      turnId: turnIdSchema.parse(turn.turnId),
      sessionId: turn.sessionId,
      ordinal: turn.ordinal,
      startedAt: turn.startedAt.getTime(),
      endedAt: turn.endedAt?.getTime() ?? null,
      ...counts(turn),
      spentMicroUsd: turn.spentMicroUsd,
      agentMs: turn.agentMs,
      estimated: turn.estimated,
    })),
  };
};
