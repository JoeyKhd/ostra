export type HistoryEntry = {
  readonly expression: string;
  readonly result: number;
};

export type History = {
  readonly add: (entry: HistoryEntry) => void;
  /** A copy of the entries, oldest first. */
  readonly list: () => readonly HistoryEntry[];
  readonly last: () => HistoryEntry | undefined;
  readonly clear: () => void;
  readonly size: () => number;
};

export const DEFAULT_HISTORY_LIMIT = 100;

/** A list of the most recent `limit` calculations. Adding past the limit drops the oldest. */
export const createHistory = (limit: number = DEFAULT_HISTORY_LIMIT): History => {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("history limit must be a positive integer");
  const entries: HistoryEntry[] = [];
  return {
    add: (entry) => {
      entries.push(entry);
      while (entries.length > limit) entries.shift();
    },
    list: () => [...entries],
    last: () => entries.at(-1),
    clear: () => {
      entries.length = 0;
    },
    size: () => entries.length,
  };
};
