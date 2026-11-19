import type { TokenUsage } from "@ostra/adapter-sdk";
import type { SpendCap, TokenPrices } from "@ostra/protocol";

// The task's spend cap at the key proxy (F-068, ticket 25, ADR 0042): only the key proxy sees each
// model call, so it counts them against the cap the spec names, from what the task had already
// spent in earlier sessions. A model with a price is counted in micro-USD on its four token kinds
// (fresh input, output, cache reads, cache writes: Q163); one with no known price in tokens (spec
// section 11, item 8). Numbers only: nothing here sees a prompt or an answer.

/** A call's cost in millionths of a micro-USD (prices are per million tokens), kept exact. */
const costUnits = (usage: TokenUsage, prices: TokenPrices): number =>
  usage.input * prices.inputPerMTok +
  usage.output * prices.outputPerMTok +
  usage.cacheRead * prices.cacheReadPerMTok +
  usage.cacheWrite * prices.cacheWritePerMTok;

/** A call's cost in micro-USD, priced on the four token kinds. */
export const priceUsage = (usage: TokenUsage, prices: TokenPrices): number => costUnits(usage, prices) / 1_000_000;

/** A call's tokens, for the token form: every kind the provider bills. */
export const countTokens = (usage: TokenUsage): number => usage.input + usage.output + usage.cacheRead + usage.cacheWrite;

export type SpendUnit = "micro-usd" | "tokens";

export type SpendMeter = {
  readonly unit: SpendUnit;
  /** Adds one call's usage. Answers `true` the one time the total reaches the cap. */
  readonly add: (usage: TokenUsage) => boolean;
  /** The cap is reached: the next model call is refused. */
  readonly reached: () => boolean;
  /** What the task has spent, earlier sessions included, in the meter's unit, rounded. */
  readonly spent: () => number;
};

export const createSpendMeter = (cap: SpendCap): SpendMeter => {
  if ("capMicroUsd" in cap) {
    // Kept in millionths of a micro-USD, so a sum of many small calls doesn't drift.
    let units = cap.spentMicroUsd * 1_000_000;
    const limit = cap.capMicroUsd * 1_000_000;
    let fired = false;
    return {
      unit: "micro-usd",
      add: (usage) => {
        units += costUnits(usage, cap.prices);
        if (!fired && units >= limit) {
          fired = true;
          return true;
        }
        return false;
      },
      reached: () => units >= limit,
      spent: () => Math.round(units / 1_000_000),
    };
  }
  let tokens = cap.spentTokens;
  let fired = false;
  return {
    unit: "tokens",
    add: (usage) => {
      tokens += countTokens(usage);
      if (!fired && tokens >= cap.capTokens) {
        fired = true;
        return true;
      }
      return false;
    },
    reached: () => tokens >= cap.capTokens,
    spent: () => tokens,
  };
};
