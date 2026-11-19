import type { Db } from "@ostra/db";
import { sessionIdSchema, taskIdSchema, turnIdSchema } from "@ostra/protocol";
import type { OrganizationId, SessionId, TaskId, TurnId } from "@ostra/protocol";

import { totalTokens } from "./spend.ts";
import type { TokenCounts } from "./spend.ts";

// A task's usage (F-084, ADR 0042, Q163): its tokens in four kinds, its spend and its agent time,
// per task and per turn. Ingest keeps the figures as `usage.recorded` events arrive (each turn's own
// on `Turn`, each session's and the task's spend beside them), so the read is one query over rows
// and never walks the events. An estimated figure is marked wherever it is summed.

/** One turn's figures. `spentMicroUsd` is `null` when the turn used tokens but its model has no price: tokens and no spend. */
export type TurnUsage = TokenCounts & {
  readonly turnId: TurnId;
  readonly sessionId: SessionId;
  /** The turn's number in its session, from 1. */
  readonly ordinal: number;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly spentMicroUsd: number | null;
  /** The agent's time in the turn, in ms; `null` while the turn runs (or when it ended without an end event). */
  readonly agentMs: number | null;
  /** True when any of the turn's usage was estimated by the key proxy. */
  readonly estimated: boolean;
};

export type TaskUsageTotals = TokenCounts & {
  /** `null` when the task used tokens and none of it has a price. */
  readonly spentMicroUsd: number | null;
  /** The sum of the turns' agent time, in ms. */
  readonly agentMs: number;
  /** True when any turn of the task has an estimated figure. */
  readonly estimated: boolean;
};

export type TaskUsage = {
  readonly taskId: TaskId;
  readonly totals: TaskUsageTotals;
  /** Every turn of every session, oldest first. */
  readonly turns: readonly TurnUsage[];
};

/** A spend of zero on tokens that were used is a model with no price: no spend to show. */
const spendOf = (counts: TokenCounts, spentMicroUsd: number): number | null => (spentMicroUsd === 0 && totalTokens(counts) > 0 ? null : spentMicroUsd);

/**
 * A task's totals and its turns' figures, in one query. The caller has checked the member can read
 * the project; the organization is part of the lookup, so another organization's task is `null`.
 * The totals are the sessions' sums (every `usage.recorded` lands in its session, in or out of a
 * turn) and the task's spend, so they equal the sum of the task's events.
 */
export const readTaskUsage = async (db: Db, organizationId: OrganizationId, taskId: TaskId): Promise<TaskUsage | null> => {
  const task = await db.task.findFirst({
    where: { id: taskId, organizationId },
    select: {
      id: true,
      spentMicroUsd: true,
      sessions: { select: { inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true } },
      turns: {
        orderBy: [{ startSeq: "asc" }],
        select: {
          id: true,
          sessionId: true,
          ordinal: true,
          startedAt: true,
          endedAt: true,
          inputTokens: true,
          outputTokens: true,
          cacheReadTokens: true,
          cacheWriteTokens: true,
          spentMicroUsd: true,
          estimated: true,
          agentMs: true,
        },
      },
    },
  });
  if (task === null) {
    return null;
  }
  const tokens: TokenCounts = task.sessions.reduce<TokenCounts>(
    (sum, session) => ({
      inputTokens: sum.inputTokens + session.inputTokens,
      outputTokens: sum.outputTokens + session.outputTokens,
      cacheReadTokens: sum.cacheReadTokens + session.cacheReadTokens,
      cacheWriteTokens: sum.cacheWriteTokens + session.cacheWriteTokens,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  );
  const turns = task.turns.map(
    (turn): TurnUsage => ({
      turnId: turnIdSchema.parse(turn.id),
      sessionId: sessionIdSchema.parse(turn.sessionId),
      ordinal: turn.ordinal,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      cacheReadTokens: turn.cacheReadTokens,
      cacheWriteTokens: turn.cacheWriteTokens,
      spentMicroUsd: spendOf(turn, turn.spentMicroUsd),
      agentMs: turn.agentMs,
      estimated: turn.estimated,
    }),
  );
  return {
    taskId: taskIdSchema.parse(task.id),
    totals: {
      ...tokens,
      spentMicroUsd: spendOf(tokens, task.spentMicroUsd),
      agentMs: task.turns.reduce((sum, turn) => sum + (turn.agentMs ?? 0), 0),
      estimated: task.turns.some((turn) => turn.estimated),
    },
    turns,
  };
};
