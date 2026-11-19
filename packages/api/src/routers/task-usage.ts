import { effortLevelFromDb } from "@ostra/db";
import { readTaskUsage } from "@ostra/domain";
import { turnIdSchema } from "@ostra/protocol";
import type { OrganizationId, TaskId } from "@ostra/protocol";

import type { ApiDeps } from "../trpc/context.ts";

// F-084 (ticket 39; ADR 0042, Q163): a task's tokens in four kinds, its spend and its agent time,
// in total and per turn, with the figures the key proxy estimated marked as estimates. Core keeps
// the figures on the turns as usage arrives (ticket 28); this reads them. Spend is `null` for tokens
// whose model has no price: the page then shows tokens and no dollars.

export const loadUsageView = async (deps: ApiDeps, organizationId: OrganizationId, taskId: TaskId) => {
  const [usage, effortRows, sessions] = await Promise.all([
    readTaskUsage(deps.db, organizationId, taskId),
    // F-137 (ADR 0066): each turn's level, the level it was asked for when the clamp moved it, and
    // the reasoning tokens the endpoint reported, a part of the output tokens.
    deps.db.turn.findMany({ where: { organizationId, taskId }, select: { id: true, effort: true, effortAdjustedFrom: true, reasoningTokens: true } }),
    deps.db.session.findMany({ where: { organizationId, taskId }, select: { reasoningTokens: true } }),
  ]);
  if (usage === null) {
    return null;
  }
  const effortOf = new Map(effortRows.map((row) => [row.id, row] as const));
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
      /** F-137: the reasoning tokens, a part of `outputTokens`. */
      reasoningTokens: sessions.reduce((sum, session) => sum + session.reasoningTokens, 0),
      /** Some of it was estimated by the key proxy. */
      estimated: usage.totals.estimated,
    },
    turns: usage.turns.map((turn) => {
      const effort = effortOf.get(turn.turnId);
      return {
      turnId: turnIdSchema.parse(turn.turnId),
      sessionId: turn.sessionId,
      ordinal: turn.ordinal,
      startedAt: turn.startedAt.getTime(),
      endedAt: turn.endedAt?.getTime() ?? null,
      ...counts(turn),
      spentMicroUsd: turn.spentMicroUsd,
      agentMs: turn.agentMs,
      estimated: turn.estimated,
      /** F-137: the level the turn ran at (`null` for a turn before milestone 4), and the one asked for when the clamp moved it. */
      effort: effort === undefined || effort.effort === null ? null : effortLevelFromDb[effort.effort],
      adjustedFrom: effort === undefined || effort.effortAdjustedFrom === null ? null : effortLevelFromDb[effort.effortAdjustedFrom],
      reasoningTokens: effort?.reasoningTokens ?? 0,
    };
    }),
  };
};
