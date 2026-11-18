export type Summary = { n: number; p50: number; p95: number; p99: number; max: number; mean: number };

export const summarize = (values: readonly number[]): Summary => {
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] ?? 0;
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(s.at(-1) ?? 0),
    mean: round(s.length === 0 ? 0 : sum / s.length),
  };
};

export const round = (n: number): number => Math.round(n * 10) / 10;

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wall-clock time with sub-millisecond resolution, comparable across processes on one machine. */
export const nowPrecise = (): number => performance.timeOrigin + performance.now();
