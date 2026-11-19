import type { BudgetId, BudgetScope, TurnOrigin } from "@ostra/protocol";
import { turnOriginSchema } from "@ostra/protocol";

// The budget gate (F-037, ADR 0055): one pure function every turn start calls, over a closed
// list of origins, so no origin can skip it. Months are calendar months in UTC; money is
// micro-USD. At the warn share (80% by default, `OSTRA_BUDGET_WARN_PERCENT`) admins are told; at
// 100% no new turn starts; a running turn finishes, so the spend can overshoot.

/** Every origin a turn can have, for the tests that call the gate with each. */
export const turnOrigins: readonly TurnOrigin[] = turnOriginSchema.options;

/** `YYYY-MM` in UTC. */
export type BudgetMonth = string;

/** The UTC month an instant falls in. */
export const budgetMonthOf = (ms: number): BudgetMonth => {
  const date = new Date(ms);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${String(date.getUTCFullYear())}-${month}`;
};

/** The month's first instant and the next month's, in ms since the epoch, in UTC. */
export const budgetMonthBounds = (month: BudgetMonth): { readonly start: number; readonly end: number } => {
  const [yearText, monthText] = month.split("-");
  const year = Number(yearText);
  const index = Number(monthText) - 1;
  return { start: Date.UTC(year, index, 1), end: Date.UTC(year, index + 1, 1) };
};

/** Where a month's spend stands against a budget. */
export type BudgetLevel = "under" | "warn" | "reached";

/**
 * `reached` at 100% or more, `warn` at the warn share or more, `under` below. A budget of 0 is
 * reached at once. Integer arithmetic: spend × 100 against budget × percent.
 */
export const budgetLevel = (spentMicroUsd: bigint, budgetMicroUsd: bigint, warnPercent: number): BudgetLevel => {
  if (spentMicroUsd >= budgetMicroUsd) {
    return "reached";
  }
  return spentMicroUsd * 100n >= budgetMicroUsd * BigInt(warnPercent) ? "warn" : "under";
};

/** Spend past the budget, which the budget page shows (0 when under). */
export const budgetOvershoot = (spentMicroUsd: bigint, budgetMicroUsd: bigint): bigint =>
  spentMicroUsd > budgetMicroUsd ? spentMicroUsd - budgetMicroUsd : 0n;

/** The notices a month owes now: each threshold once per budget and month, the warning before 100%. */
export const budgetNoticesDue = (level: BudgetLevel, alreadySent: ReadonlySet<"warn" | "reached">): readonly ("warn" | "reached")[] => {
  const due: ("warn" | "reached")[] = [];
  if ((level === "warn" || level === "reached") && !alreadySent.has("warn")) {
    due.push("warn");
  }
  if (level === "reached" && !alreadySent.has("reached")) {
    due.push("reached");
  }
  return due;
};

export type GateBudget = { readonly budgetId: BudgetId; readonly monthlyMicroUsd: bigint };

export type GateBudgets = {
  /** The organization's own budget, or `null` for none. */
  readonly organization: GateBudget | null;
  /** The task's project's budget, or `null` for none. */
  readonly project: GateBudget | null;
};

export type GateSpend = {
  /** The month these sums are of. A sum of another month counts as nothing in this one. */
  readonly month: BudgetMonth;
  readonly organizationMicroUsd: bigint;
  readonly projectMicroUsd: bigint;
  /** Whether the task's model has a price. An unpriced model can't be counted, so a budget holds it. */
  readonly modelPriced: boolean;
};

export type GateResult =
  | { readonly kind: "open" }
  | {
      readonly kind: "held";
      readonly budgetId: BudgetId;
      readonly scope: BudgetScope;
      readonly reason: "reached" | "unpriced";
      /** What wanted the turn, for the `HeldTurn` row and the `turn.held` event. */
      readonly origin: TurnOrigin;
    };

/**
 * Whether a turn of `origin` may start now. The origin never changes the answer: it's an input so
 * every caller names itself and the hold records it, and the closed list means a new origin is a
 * type error until its test has it. The project's budget is checked before the organization's.
 */
export const budgetGate = (budgets: GateBudgets, spend: GateSpend, origin: TurnOrigin, now: number): GateResult => {
  const current = budgetMonthOf(now) === spend.month;
  const checks: readonly { readonly budget: GateBudget | null; readonly scope: BudgetScope; readonly spent: bigint }[] = [
    { budget: budgets.project, scope: "project", spent: current ? spend.projectMicroUsd : 0n },
    { budget: budgets.organization, scope: "organization", spent: current ? spend.organizationMicroUsd : 0n },
  ];
  for (const check of checks) {
    if (check.budget === null) {
      continue;
    }
    if (!spend.modelPriced) {
      return { kind: "held", budgetId: check.budget.budgetId, scope: check.scope, reason: "unpriced", origin };
    }
    if (check.spent >= check.budget.monthlyMicroUsd) {
      return { kind: "held", budgetId: check.budget.budgetId, scope: check.scope, reason: "reached", origin };
    }
  }
  return { kind: "open" };
};
