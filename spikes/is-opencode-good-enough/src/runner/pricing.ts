// Turning the proxy's token counts into dollars (ADR 0042: a price per model,
// from the endpoint's list, models.dev or the admin). This spike takes the
// price from variables, or leaves spend in tokens.

import { totalTokens, type TokenUsage } from "../lib/usage.ts";

export type Pricing = {
  /** Where the price came from. `stub` is the dry-run's placeholder, never a real model's price. */
  readonly source: "stub" | "configured";
  /** USD per million tokens. */
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheReadPerMTok: number;
  readonly cacheWritePerMTok: number;
};

/** The stub model's made-up price list, so the dry-run exercises the dollar arithmetic. */
export const STUB_PRICING: Pricing = { source: "stub", inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 };

export const usdOf = (usage: TokenUsage, pricing: Pricing): number =>
  (usage.input * pricing.inputPerMTok + usage.output * pricing.outputPerMTok + usage.cacheRead * pricing.cacheReadPerMTok + usage.cacheWrite * pricing.cacheWritePerMTok) /
  1_000_000;

export { totalTokens };

/** The dollar cap a real set runs under when the operator does not name one, applied only when prices are set. */
export const DEFAULT_MAX_USD = 5;

export type DollarCap = { readonly ok: true; readonly maxUsd: number | undefined } | { readonly ok: false; readonly message: string };

/**
 * The per-run dollar cap. It can only be enforced when prices are known (the
 * proxy counts tokens): a cap asked for without prices would silently not act
 * while the run reports one, so it is refused instead.
 */
export const dollarCap = (requested: number | undefined, pricing: Pricing | undefined): DollarCap => {
  if (requested !== undefined && pricing === undefined) {
    return { ok: false, message: "--max-usd needs prices: set OSTRA_SPIKE_PRICE_INPUT and OSTRA_SPIKE_PRICE_OUTPUT (USD per million tokens), or cap by tokens with --max-tokens" };
  }
  if (pricing === undefined) return { ok: true, maxUsd: undefined };
  return { ok: true, maxUsd: requested ?? DEFAULT_MAX_USD };
};
