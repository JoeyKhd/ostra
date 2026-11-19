import type { DbEnum, Tx } from "@ostra/db";
import { budgetIdSchema, modelIdSchema, organizationIdSchema, projectIdSchema } from "@ostra/protocol";
import type { BudgetId, MessageIntent, ModelId, OrganizationId, ProjectId, SessionId, TaskId, TaskSeq, TurnOrigin } from "@ostra/protocol";

import { budgetGate, budgetLevel, budgetMonthBounds, budgetMonthOf, budgetOvershoot } from "../budget/gate.ts";
import type { BudgetLevel, BudgetMonth, GateBudgets, GateResult } from "../budget/gate.ts";
import { dispatchWaitColumns } from "../dispatch-wait.ts";
import type { DispatchWait } from "../dispatch-wait.ts";
import type { Ports } from "../ports.ts";
import type { CheckBudget, RecordSpend } from "./m4-signatures.ts";
import { appendServerEvent } from "./server-events.ts";
import { modelTokenPrices } from "./spend.ts";

// Spend rollups and the budget gate (F-037, ADR 0055, ticket 12). Ingest's pricing of a
// `usage.recorded` adds to `SpendDaily` for the task's project, the UTC day and the model, in the
// same transaction, and when the month's total for the project's budget or the organization's
// crosses the warn share or 100% it enqueues `budget.check` (ticket 13 sends the notice). Every turn
// start calls `checkBudget` inside the task's lock: a closed gate leaves a new task queued with its
// reason, and holds any other turn as a `HeldTurn` with a `turn.held` event, starting nothing.

/** The warn share when the caller passes none (`OSTRA_BUDGET_WARN_PERCENT`'s default). */
export const BUDGET_WARN_PERCENT_DEFAULT = 80;

/** A UTC day's first instant, as `SpendDaily.day` stores it. */
export const utcDayOf = (ms: number): Date => {
  const date = new Date(ms);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
};

const big = (value: number): bigint => BigInt(Math.max(0, Math.trunc(value)));

/** The money a month's `SpendDaily` rows add up to: the project's, or the whole organization's when `projectId` is `null`. */
export const monthSpendInTx = async (
  tx: Pick<Tx, "spendDaily">,
  input: { readonly organizationId: OrganizationId; readonly projectId: ProjectId | null; readonly month: BudgetMonth },
): Promise<bigint> => {
  const { start, end } = budgetMonthBounds(input.month);
  const sum = await tx.spendDaily.aggregate({
    where: {
      organizationId: input.organizationId,
      ...(input.projectId === null ? {} : { projectId: input.projectId }),
      day: { gte: new Date(start), lt: new Date(end) },
    },
    _sum: { spentMicroUsd: true },
  });
  return sum._sum.spentMicroUsd ?? 0n;
};

/** The budgets that apply to a project's tasks: the project's own and the organization's. */
export const budgetsForProjectInTx = async (
  tx: Pick<Tx, "budget">,
  organizationId: OrganizationId,
  projectId: ProjectId,
): Promise<GateBudgets> => {
  const rows = await tx.budget.findMany({
    where: { organizationId, OR: [{ projectId: null }, { projectId }] },
    select: { id: true, projectId: true, monthlyMicroUsd: true },
  });
  const organization = rows.find((row) => row.projectId === null);
  const project = rows.find((row) => row.projectId === projectId);
  return {
    organization: organization === undefined ? null : { budgetId: budgetIdSchema.parse(organization.id), monthlyMicroUsd: organization.monthlyMicroUsd },
    project: project === undefined ? null : { budgetId: budgetIdSchema.parse(project.id), monthlyMicroUsd: project.monthlyMicroUsd },
  };
};

/** At ingest: adds one priced (or unpriced) call to its project's, day's and model's row. */
export const recordSpend: RecordSpend = async (tx, input) => {
  const tokens = { inputTokens: big(input.inputTokens), outputTokens: big(input.outputTokens), cacheReadTokens: big(input.cacheReadTokens), cacheWriteTokens: big(input.cacheWriteTokens) };
  const unpriced = input.spentMicroUsd === null ? tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens : 0n;
  const spent = input.spentMicroUsd === null ? 0n : big(input.spentMicroUsd);
  const day = utcDayOf(input.at);
  await tx.spendDaily.upsert({
    where: { projectId_day_modelId: { projectId: input.projectId, day, modelId: input.modelId } },
    create: { organizationId: input.organizationId, projectId: input.projectId, day, modelId: input.modelId, ...tokens, spentMicroUsd: spent, unpricedTokens: unpriced },
    update: {
      inputTokens: { increment: tokens.inputTokens },
      outputTokens: { increment: tokens.outputTokens },
      cacheReadTokens: { increment: tokens.cacheReadTokens },
      cacheWriteTokens: { increment: tokens.cacheWriteTokens },
      spentMicroUsd: { increment: spent },
      unpricedTokens: { increment: unpriced },
    },
  });
};

/** The thresholds a month passed between two totals: `warn` at the warn share, `reached` at 100%. */
export const thresholdsCrossed = (before: BudgetLevel, after: BudgetLevel): readonly ("warn" | "reached")[] => {
  const rank = { under: 0, warn: 1, reached: 2 } as const;
  const crossed: ("warn" | "reached")[] = [];
  if (rank[before] < 1 && rank[after] >= 1) {
    crossed.push("warn");
  }
  if (rank[before] < 2 && rank[after] >= 2) {
    crossed.push("reached");
  }
  return crossed;
};

export type RecordSpendDeps = Pick<Ports, "jobs"> & {
  /** `OSTRA_BUDGET_WARN_PERCENT`. */
  readonly budgetWarnPercent?: number | undefined;
};

/**
 * `recordSpend`, then a `budget.check` for each threshold the month's total of a budget that
 * applies crossed with this call, keyed by budget, month and threshold. Only priced spend moves a
 * total; a zero-cost call enqueues nothing.
 */
export const recordSpendInTx = async (deps: RecordSpendDeps, tx: Tx, input: Parameters<RecordSpend>[1]): Promise<void> => {
  const month = budgetMonthOf(input.at);
  const budgets = await budgetsForProjectInTx(tx, input.organizationId, input.projectId);
  const watched = [
    { budget: budgets.project, projectId: input.projectId },
    { budget: budgets.organization, projectId: null },
  ].flatMap((entry) => (entry.budget === null ? [] : [{ budget: entry.budget, projectId: entry.projectId }]));
  const cost = input.spentMicroUsd === null ? 0n : big(input.spentMicroUsd);
  const before = cost === 0n ? [] : await Promise.all(watched.map((entry) => monthSpendInTx(tx, { organizationId: input.organizationId, projectId: entry.projectId, month })));
  await recordSpend(tx, input);
  if (cost === 0n) {
    return;
  }
  const warn = deps.budgetWarnPercent ?? BUDGET_WARN_PERCENT_DEFAULT;
  for (const [index, entry] of watched.entries()) {
    const spentBefore = before[index] ?? 0n;
    const crossed = thresholdsCrossed(
      budgetLevel(spentBefore, entry.budget.monthlyMicroUsd, warn),
      budgetLevel(spentBefore + cost, entry.budget.monthlyMicroUsd, warn),
    );
    for (const threshold of crossed) {
      await deps.jobs.enqueueInTx(tx, "budget.check", { organizationId: input.organizationId, budgetId: entry.budget.budgetId, month, threshold });
    }
  }
};

/** Where a budget's month stands: its spend, its level and the overshoot past 100% (ticket 27 shows it). */
export type BudgetMonthStatus = {
  readonly budgetId: BudgetId;
  readonly projectId: ProjectId | null;
  readonly month: BudgetMonth;
  readonly monthlyMicroUsd: bigint;
  readonly spentMicroUsd: bigint;
  readonly level: BudgetLevel;
  /** The spend counted after the month's total passed 100%: running turns finish, so it can go over. */
  readonly overshootMicroUsd: bigint;
};

export const budgetMonthStatusInTx = async (
  tx: Pick<Tx, "budget" | "spendDaily">,
  input: { readonly organizationId: OrganizationId; readonly budgetId: BudgetId; readonly month: BudgetMonth; readonly warnPercent?: number },
): Promise<BudgetMonthStatus | null> => {
  const budget = await tx.budget.findFirst({ where: { id: input.budgetId, organizationId: input.organizationId }, select: { id: true, projectId: true, monthlyMicroUsd: true } });
  if (budget === null) {
    return null;
  }
  const projectId = budget.projectId === null ? null : projectIdSchema.parse(budget.projectId);
  const spent = await monthSpendInTx(tx, { organizationId: input.organizationId, projectId, month: input.month });
  return {
    budgetId: input.budgetId,
    projectId,
    month: input.month,
    monthlyMicroUsd: budget.monthlyMicroUsd,
    spentMicroUsd: spent,
    level: budgetLevel(spent, budget.monthlyMicroUsd, input.warnPercent ?? BUDGET_WARN_PERCENT_DEFAULT),
    overshootMicroUsd: budgetOvershoot(spent, budget.monthlyMicroUsd),
  };
};

// ---------- the gate ----------

/**
 * The one gate every turn start calls: the budgets that apply to the task's project, their month's
 * spend at `now`, and whether the model has a price (an unpriced model holds only where a budget
 * applies). `modelId` `null` (no model yet) counts as priced: the dispatch says "no model" itself.
 */
export const checkBudget = async (
  tx: Tx,
  input: Parameters<CheckBudget>[1] & { readonly now: number },
): Promise<GateResult> => {
  const budgets = await budgetsForProjectInTx(tx, input.organizationId, input.projectId);
  if (budgets.organization === null && budgets.project === null) {
    return { kind: "open" };
  }
  const month = budgetMonthOf(input.now);
  const model =
    input.modelId === null
      ? null
      : await tx.model.findFirst({
          where: { id: input.modelId, organizationId: input.organizationId },
          select: { inputPricePerMTok: true, outputPricePerMTok: true, cacheReadPricePerMTok: true, cacheWritePricePerMTok: true },
        });
  const [projectSpend, organizationSpend] = await Promise.all([
    budgets.project === null ? 0n : monthSpendInTx(tx, { organizationId: input.organizationId, projectId: input.projectId, month }),
    budgets.organization === null ? 0n : monthSpendInTx(tx, { organizationId: input.organizationId, projectId: null, month }),
  ]);
  return budgetGate(
    budgets,
    { month, projectMicroUsd: projectSpend, organizationMicroUsd: organizationSpend, modelPriced: input.modelId === null || (model !== null && modelTokenPrices(model) !== null) },
    input.origin,
    input.now,
  );
};

/** The model a session's turn runs on: the one its start resolved, else its profile's. */
export const sessionModelIdInTx = async (
  tx: Pick<Tx, "session" | "agentProfile">,
  organizationId: string,
  session: { readonly id: string } | { readonly agentProfileId: string | null; readonly modelId?: string | null },
): Promise<ModelId | null> => {
  const row =
    "id" in session
      ? await tx.session.findFirst({ where: { id: session.id, organizationId }, select: { modelId: true, agentProfileId: true } })
      : { modelId: session.modelId ?? null, agentProfileId: session.agentProfileId };
  if (row === null) {
    return null;
  }
  if (row.modelId !== null) {
    return modelIdSchema.parse(row.modelId);
  }
  if (row.agentProfileId === null) {
    return null;
  }
  const profile = await tx.agentProfile.findFirst({ where: { id: row.agentProfileId, organizationId }, select: { modelId: true } });
  return profile?.modelId === null || profile === null ? null : modelIdSchema.parse(profile.modelId);
};

/** The turn origin of a member message ostra rendered for an action (ADR 0055's closed list). */
export const turnOriginOfIntent = (intent: MessageIntent | undefined): TurnOrigin => {
  switch (intent) {
    case undefined:
    case "message":
    case "plan-revision":
    case "fix-checks":
      return "message";
    case "diff-comments":
      return "diff-comments";
    case "update-branch":
      return "update-branch";
    case "pr-comment":
      return "pr-comment";
    case "keep-working":
      return "keep-working";
    default:
      return intent satisfies never;
  }
};

const HELD_ORIGIN: Readonly<Record<TurnOrigin, DbEnum.HeldTurnOrigin>> = {
  dispatch: "dispatch",
  reopen: "reopen",
  message: "message",
  "diff-comments": "diff_comments",
  "update-branch": "update_branch",
  "pr-comment": "pr_comment",
  "keep-working": "keep_working",
  "closing-turn": "closing_turn",
  "automatic-round": "automatic_round",
};

/** A held turn's stored origin, as the gate names it. */
export const heldTurnOriginToDb = (origin: TurnOrigin): DbEnum.HeldTurnOrigin => HELD_ORIGIN[origin];

/** Why a task waits on a closed gate, as the dispatch note says it. */
export const budgetWaitOf = (held: Extract<GateResult, { readonly kind: "held" }>): DispatchWait =>
  held.reason === "unpriced" ? { code: "model-unpriced" } : { code: "budget-reached", scope: held.scope };

/**
 * A turn the gate held (any origin but a new task's dispatch): the `HeldTurn` row and the
 * `turn.held` event in the thread. Nothing starts; the saved message, when there is one, is named
 * by its seq so the release can send it. Written in the task's lock, in the caller's transaction.
 */
export const holdTurnInTx = async (
  deps: Pick<Ports, "notices">,
  tx: Tx,
  input: {
    readonly organizationId: OrganizationId;
    readonly projectId: ProjectId;
    readonly taskId: TaskId;
    readonly sessionId: SessionId;
    readonly held: Extract<GateResult, { readonly kind: "held" }>;
    readonly pendingMessageSeq: TaskSeq | null;
    readonly now: number;
    /** A task left queued by the hold also says why on its row. */
    readonly queued: boolean;
  },
): Promise<void> => {
  await tx.heldTurn.create({
    data: {
      organizationId: input.organizationId,
      projectId: input.projectId,
      taskId: input.taskId,
      origin: heldTurnOriginToDb(input.held.origin),
      budgetId: input.held.budgetId,
      pendingMessageSeq: input.pendingMessageSeq,
      heldAt: new Date(input.now),
    },
  });
  await appendServerEvent(tx, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    at: input.now,
    event: { kind: "turn.held", origin: input.held.origin, budgetId: input.held.budgetId, scope: input.held.scope },
  });
  if (input.queued) {
    await tx.task.update({ where: { id: input.taskId }, data: dispatchWaitColumns(budgetWaitOf(input.held)) });
  }
  await deps.notices.emitInTx(tx, { organizationId: organizationIdSchema.parse(input.organizationId), projectId: input.projectId, entity: "task", entityId: input.taskId });
};
