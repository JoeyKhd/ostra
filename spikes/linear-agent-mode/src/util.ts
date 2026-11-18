import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const errorName = (error: unknown): string =>
  error instanceof Error ? error.name : typeof error;

/** Waits (real time) until `predicate` is true. Resolves false on timeout. */
export const until = async (
  predicate: () => boolean,
  options: { timeoutMs: number; pollMs?: number },
): Promise<boolean> => {
  const deadline = performance.now() + options.timeoutMs;
  const pollMs = options.pollMs ?? 5;
  while (!predicate()) {
    if (performance.now() >= deadline) return false;
    await delay(pollMs);
  }
  return true;
};

export type Summary = {
  readonly n: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
};

export const summarize = (values: readonly number[]): Summary => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number): number => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[index] ?? Number.NaN;
  };
  return { n: sorted.length, min: sorted[0] ?? Number.NaN, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? Number.NaN };
};

export const formatMs = (ms: number): string =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`;

export const formatSummary = (s: Summary): string =>
  `n=${String(s.n)} min ${formatMs(s.min)}, p50 ${formatMs(s.p50)}, p95 ${formatMs(s.p95)}, max ${formatMs(s.max)}`;

export const sha256Base64Url = (input: string): string =>
  createHash("sha256").update(input).digest("base64url");

export const median = (values: readonly number[]): number => summarize(values).p50;

/** JSON with object keys in sorted order, so two equal values print the same. */
export const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};
