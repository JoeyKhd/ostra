import type { Model, Tx } from "@ostra/db";
import type { SpendCap, TaskId, TokenPrices } from "@ostra/protocol";

// What a task spends (F-068, ADR 0042, Q163): each `usage.recorded` priced on its four kinds of
// token (fresh input, output, cache reads, cache writes) with the model's prices from the catalog
// or an admin, and added to the session's and the task's `spentMicroUsd` in the ingest transaction.
// A model with no known price is counted in tokens instead (spec section 11, item 8), so the cap
// holds in tokens. The key proxy enforces the cap (ticket 25); core prices, sums and tells it what
// is left in the task spec's `limits.spendCap`.

/** The four token counts of a usage record, or of a sum of them. */
export type TokenCounts = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
};

type Price = { toNumber: () => number } | null;

/** US dollars per million tokens, to micro-USD per million tokens. */
const microPerMTok = (price: NonNullable<Price>): number => Math.max(0, Math.round(price.toNumber() * 1_000_000));

/**
 * A model's four prices, in micro-USD per million tokens, or `null` when it has no known price
 * (fresh input or output unknown). An unknown cache price is the input price: never an undercount.
 */
export const modelTokenPrices = (
  model: Pick<Model, "inputPricePerMTok" | "outputPricePerMTok" | "cacheReadPricePerMTok" | "cacheWritePricePerMTok">,
): TokenPrices | null => {
  if (model.inputPricePerMTok === null || model.outputPricePerMTok === null) {
    return null;
  }
  const input = microPerMTok(model.inputPricePerMTok);
  return {
    inputPerMTok: input,
    outputPerMTok: microPerMTok(model.outputPricePerMTok),
    cacheReadPerMTok: model.cacheReadPricePerMTok === null ? input : microPerMTok(model.cacheReadPricePerMTok),
    cacheWritePerMTok: model.cacheWritePricePerMTok === null ? input : microPerMTok(model.cacheWritePricePerMTok),
  };
};

/** What `tokens` cost at `prices`, in whole micro-USD (rounded up, so many small calls never add to nothing). */
export const priceTokens = (prices: TokenPrices, tokens: TokenCounts): number => {
  const microTimesTokens =
    tokens.inputTokens * prices.inputPerMTok +
    tokens.outputTokens * prices.outputPerMTok +
    tokens.cacheReadTokens * prices.cacheReadPerMTok +
    tokens.cacheWriteTokens * prices.cacheWritePerMTok;
  return Math.ceil(microTimesTokens / 1_000_000);
};

/** Every token of the four kinds. */
export const totalTokens = (tokens: TokenCounts): number =>
  tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens;

/** The task's tokens across all its sessions: the token form of the cap counts them. */
export const taskTokensInTx = async (tx: Pick<Tx, "session">, taskId: TaskId): Promise<number> => {
  const sum = await tx.session.aggregate({
    where: { taskId },
    _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true },
  });
  return (
    (sum._sum.inputTokens ?? 0) + (sum._sum.outputTokens ?? 0) + (sum._sum.cacheReadTokens ?? 0) + (sum._sum.cacheWriteTokens ?? 0)
  );
};

/** The caps a server runs with: `OSTRA_TASK_SPEND_CAP_USD` (as micro-USD) and `OSTRA_TASK_TOKEN_CAP`. */
export type SpendCapSettings = { readonly capMicroUsd: number; readonly capTokens: number };

/**
 * The task spec's `limits.spendCap`: in micro-USD with the prices when the model has them, or in
 * tokens when it has none. `spent` is the task's, across every session, so a reopen carries it.
 */
export const spendCapFor = (
  settings: SpendCapSettings,
  prices: TokenPrices | null,
  spent: { readonly microUsd: number; readonly tokens: number },
): SpendCap =>
  prices === null
    ? { capTokens: settings.capTokens, spentTokens: spent.tokens }
    : { capMicroUsd: settings.capMicroUsd, spentMicroUsd: spent.microUsd, prices };

/** Whether the task has reached its cap, in the cap's own unit. A reopen is refused while it has. */
export const spendCapReached = (cap: SpendCap): boolean =>
  "capMicroUsd" in cap ? cap.spentMicroUsd >= cap.capMicroUsd : cap.spentTokens >= cap.capTokens;
