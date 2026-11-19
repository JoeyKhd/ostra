// Numbers and times as the panel shows them: mono, short, no units spelled out.

const dash = "–";

/** 1_000_000 → "1M", 256_000 → "256k", 1_050_000 → "1.05M". */
export const formatTokens = (n: number | null): string => {
  if (n === null) return dash;
  if (n >= 1_000_000) return `${String(Number((n / 1_000_000).toFixed(2)))}M`;
  if (n >= 1_000) return `${String(Number((n / 1_000).toFixed(1)))}k`;
  return String(n);
};

/** A price per million tokens: "$2.00". */
export const formatPrice = (n: number | null): string => (n === null ? dash : `$${n.toFixed(2)}`);

/** 1234 → "1,234". */
export const formatCount = (n: number): string => new Intl.NumberFormat("en-US").format(n);

/** How long ago, in the panel's short form: "now", "4m", "3h", "2d". */
export const formatAge = (since: number, now: number = Date.now()): string => {
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${String(hours)}h`;
  return `${String(Math.round(hours / 24))}d`;
};

/** A duration in ms: "2.1s", "3m 04s". */
export const formatDuration = (ms: number): string => {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${String(minutes)}m ${String(seconds).padStart(2, "0")}s`;
};

/** How long something has run, in words: "1 min", "14 min", "2 h 5 min", "3 d". Under a minute is "1 min". */
export const formatElapsed = (since: number, now: number = Date.now()): string => {
  const minutes = Math.max(1, Math.floor((now - since) / 60_000));
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(minutes % 60)} min`;
  return `${String(Math.floor(hours / 24))} d`;
};

/** A clock time, 24-hour: "14:02". */
export const formatClock = (at: number): string => {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};
