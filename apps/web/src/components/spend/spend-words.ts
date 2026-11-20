// The Spend page's numbers and dates (spend-budgets.md): money in dollars and cents, tokens short,
// shares as whole percents, and days as "18 Nov". Every amount the API gives is micro-USD.

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

/** 1_842_170_000 micro-USD → "$1,842.17". */
export const formatUsd = (microUsd: number): string =>
  `$${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(microUsd / 1_000_000)}`;

/** "750.00": the value a budget input starts with. */
export const dollarsText = (microUsd: number): string => (microUsd / 1_000_000).toFixed(2);

/** A share (1 is 100%) as "74%". */
export const formatShare = (share: number): string => `${String(Math.round(share * 100))}%`;

/** "18 Nov", in UTC. */
export const dayMonth = (at: number): string => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(at));

/** "2026-11" → "November 2026". */
export const monthName = (month: string): string => `${MONTHS[Number(month.slice(5, 7)) - 1] ?? month} ${month.slice(0, 4)}`;

/** "2026-11" → "Nov 1 – 19" up to `now`'s day, the month so far. */
export const monthSoFar = (month: string, now: number): string => {
  const short = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
  return `${short} 1 – ${String(new Date(now).getUTCDate())}`;
};

/** The first day of the month after `month`: "Dec 1". */
export const resetsOn = (month: string): string => {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  const next = new Date(Date.UTC(index === 12 ? year + 1 : year, index % 12, 1));
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(next);
};

/** The month and the eleven before it, newest first. */
export const monthsBack = (month: string, count = 12): readonly string[] => {
  const out: string[] = [];
  let year = Number(month.slice(0, 4));
  let index = Number(month.slice(5, 7));
  for (let i = 0; i < count; i += 1) {
    out.push(`${String(year)}-${String(index).padStart(2, "0")}`);
    index -= 1;
    if (index === 0) {
      index = 12;
      year -= 1;
    }
  }
  return out;
};

/** A typed dollar amount: "750", "750.5", "$1,200.00" → micro-USD; `null` when it doesn't parse. */
export const parseDollars = (text: string): number | null => {
  const clean = text.trim().replace(/^\$/, "").replaceAll(",", "");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(clean)) return null;
  const value = Number(clean);
  return value > 1_000_000 ? null : Math.round(value * 100) * 10_000;
};

/** A typed price per million tokens: up to six decimals; empty is `null` (no price for that kind). */
export const parsePrice = (text: string): { readonly ok: true; readonly value: number | null } | { readonly ok: false } => {
  const clean = text.trim().replace(/^\$/, "");
  if (clean === "") return { ok: true, value: null };
  if (!/^\d{1,7}(\.\d{1,6})?$/.test(clean)) return { ok: false };
  const value = Number(clean);
  return value > 1_000_000 ? { ok: false } : { ok: true, value };
};
