// F-080 (ticket 35): the search query as the panel draws it. The server's parse (ticket 26) is the truth;
// the panel splits the same tokens out only to draw chips and set the page's filter controls.

export const tokenKeys = ["repo", "project", "ticket", "status", "by", "after", "before"] as const;
export type TokenKey = (typeof tokenKeys)[number];
export type Token = { readonly key: TokenKey; readonly value: string };

/** The `status:` values, hyphenated as the task list writes them (the server takes snake case too). */
export const statusValues = ["queued", "preparing", "running", "needs-you", "in-review", "merged", "stopped", "done"] as const;

const isTokenKey = (value: string): value is TokenKey => tokenKeys.some((key) => key === value);

/** A `key:value` word as a token, or `null` for text (an unknown key, or a known one with no value). */
export const tokenOf = (word: string): Token | null => {
  const colon = word.indexOf(":");
  if (colon <= 0) return null;
  const key = word.slice(0, colon).toLowerCase();
  const value = word.slice(colon + 1);
  if (!isTokenKey(key) || value === "" || /["'\s]/.test(value)) return null;
  return { key, value };
};

/** A query as its tokens and its text. Tokens only from words already finished (a space after them), unless `all`. */
export const splitQuery = (query: string, all = false): { readonly tokens: readonly Token[]; readonly text: string } => {
  const tokens: Token[] = [];
  const words: string[] = [];
  const parts = query.split(/(\s+)/);
  const finished = (index: number) => all || index < parts.length - 1;
  parts.forEach((part, index) => {
    if (/^\s*$/.test(part)) return;
    const token = finished(index) ? tokenOf(part) : null;
    if (token === null) words.push(part);
    else tokens.push(token);
  });
  const trailing = /\s$/.test(query) && words.length > 0 ? " " : "";
  return { tokens, text: `${words.join(" ")}${trailing}` };
};

/** Tokens and text back as one query string, tokens first. */
export const joinQuery = (tokens: readonly Token[], text: string): string => [...tokens.map((token) => `${token.key}:${token.value}`), text.trim()].filter((part) => part !== "").join(" ");

/** The word being typed at the end of the text, when it's a known key with no value yet (`status:`). */
export const pendingKey = (text: string): TokenKey | null => {
  const last = text.split(/\s+/).at(-1) ?? "";
  const match = /^([a-z]+):(\S*)$/i.exec(last);
  if (match === null) return null;
  const key = (match[1] ?? "").toLowerCase();
  return isTokenKey(key) ? key : null;
};

/** What's been typed of a pending key's value (`status:in` → `in`). */
export const pendingValue = (text: string): string => {
  const last = text.split(/\s+/).at(-1) ?? "";
  const colon = last.indexOf(":");
  return colon < 0 ? "" : last.slice(colon + 1);
};

/** The search page's period as `after:`'s date (UTC days): `7d` → the day 8 days ago, so the last 7 count. */
export const periodAfter = (period: string, now: number): string | null => {
  const days = period === "7d" ? 7 : period === "30d" ? 30 : period === "90d" ? 90 : null;
  if (days === null) return null;
  return new Date(now - (days + 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
};
