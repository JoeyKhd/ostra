// F-080 (ADR 0054, ticket 26): the search box's query, as words and filters. A token
// `repo:`, `project:`, `ticket:`, `status:`, `by:`, `after:` or `before:` with a value it can read
// becomes a filter; anything else, an unknown token or a known one with a value it can't read,
// stays text. Pure: the router resolves the names to IDs.

/** A task list state as the search box writes it, and the column's value. */
const statusWords: Readonly<Record<string, string>> = {
  "awaiting-approval": "awaiting_approval",
  queued: "queued",
  preparing: "preparing",
  running: "running",
  "needs-you": "needs_you",
  stopped: "stopped",
  "in-review": "in_review",
  merged: "merged",
  done: "done",
};

export type ParsedQuery = {
  /** What's left after the filters: the words to match, joined by one space. */
  readonly text: string;
  readonly repo: string | null;
  readonly project: string | null;
  readonly ticket: string | null;
  /** The task's state, as the column holds it (`needs_you`). */
  readonly status: string | null;
  /** A username, or `me`. */
  readonly by: string | null;
  /** Epoch ms: tasks made from the day after `after:`'s date (UTC), inclusive. */
  readonly after: number | null;
  /** Epoch ms: tasks made before `before:`'s date (UTC), exclusive. */
  readonly before: number | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** A `YYYY-MM-DD` date as the epoch ms of its start (UTC), or `null` for anything else. */
const dayStart = (value: string): number | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  // 2026-02-31 is not a date: it must read back as itself.
  return new Date(at).toISOString().slice(0, 10) === value ? at : null;
};

/** A name, key or username a filter takes: no spaces, no quotes, at most 200 characters. */
const plainValue = (value: string): string | null => (/^[^\s"']{1,200}$/.test(value) ? value : null);

/** The task state a `status:` value names: hyphenated or in snake case alike (decided 2026-11-19). */
export const statusOf = (value: string): string | null => statusWords[value.toLowerCase().replaceAll("_", "-")] ?? null;

export const parseSearchQuery = (query: string): ParsedQuery => {
  const words: string[] = [];
  const found: { -readonly [K in keyof Omit<ParsedQuery, "text">]: ParsedQuery[K] } = {
    repo: null,
    project: null,
    ticket: null,
    status: null,
    by: null,
    after: null,
    before: null,
  };
  for (const token of query.split(/\s+/).filter((word) => word !== "")) {
    const colon = token.indexOf(":");
    const name = colon > 0 ? token.slice(0, colon).toLowerCase() : "";
    const raw = colon > 0 ? token.slice(colon + 1) : "";
    let read = false;
    switch (name) {
      case "repo":
      case "project":
      case "ticket":
      case "by": {
        const value = plainValue(raw);
        if (value !== null) {
          found[name] = value;
          read = true;
        }
        break;
      }
      case "status": {
        const value = statusOf(raw);
        if (value !== null) {
          found.status = value;
          read = true;
        }
        break;
      }
      case "after": {
        const start = dayStart(raw);
        if (start !== null) {
          found.after = start + DAY_MS;
          read = true;
        }
        break;
      }
      case "before": {
        const start = dayStart(raw);
        if (start !== null) {
          found.before = start;
          read = true;
        }
        break;
      }
      default:
        break;
    }
    if (!read) {
      words.push(token);
    }
  }
  return { text: words.join(" "), ...found };
};
