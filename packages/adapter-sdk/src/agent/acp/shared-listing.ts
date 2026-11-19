// One listing of the machine's processes at a time, shared by every caller in this process. Each
// agent's tree snapshot, each reap and each tracked PID used to start a listing of its own, and on
// Windows that was a PowerShell each: under parallel tests they piled up by the hundred, faster
// than an overloaded WMI answered them (`research/host-process-containment.md`, section 6).
//
// Sharing must not loosen the PID-reuse guarantees (`process-tree.ts`): a process a listing shows
// may have exited, and its PID gone to another, since the listing started. So a caller that decides
// what to end by a listing gets one that starts after it asks (`fresh`); only a snapshot, which
// just remembers, takes the one in flight or one a moment old (`recent`).

/**
 * How old a listing may be. `fresh`: one that starts after the call, for a decision to end a
 * process. `recent`: the listing in flight, or one that started at most `cacheMs` ago, for a
 * snapshot that only remembers what it saw.
 */
export type Freshness = "fresh" | "recent";

export type SharedListing<T> = {
  /** A listing as fresh as asked. Rejects when the listing it shares fails. */
  readonly list: (freshness?: Freshness) => Promise<T>;
};

export type SharedListingOptions = {
  /** How long a finished listing serves `recent` callers, counted from its start. Default 250 ms. */
  readonly cacheMs?: number;
  /** A monotonic clock, in ms. Default `performance.now`. */
  readonly now?: () => number;
};

/**
 * Shares `listOnce` between callers: never more than one call in flight. A `fresh` caller that
 * arrives during a listing waits for the next one, which starts as soon as that one ends and serves
 * every caller that waited for it. A failed listing is never kept.
 */
export const sharedListing = <T>(listOnce: () => Promise<T>, options: SharedListingOptions = {}): SharedListing<T> => {
  const cacheMs = options.cacheMs ?? 250;
  const now = options.now ?? (() => performance.now());
  let running: Promise<T> | undefined;
  let waiting: PromiseWithResolvers<T> | undefined;
  let last: { readonly startedAt: number; readonly value: T } | undefined;

  const launch = (): Promise<T> => {
    const startedAt = now();
    const listing = (async () => listOnce())();
    running = listing;
    // In one step, so no caller sees a gap between this listing and the next.
    const settle = (): void => {
      running = undefined;
      const next = waiting;
      waiting = undefined;
      if (next !== undefined) {
        void launch().then(next.resolve, (error: unknown) => {
          next.reject(error);
        });
      }
    };
    void listing.then(
      (value) => {
        last = { startedAt, value };
        settle();
      },
      () => {
        settle();
      },
    );
    return listing;
  };

  return {
    list: (freshness = "fresh") => {
      if (freshness === "recent") {
        if (running !== undefined) {
          return running;
        }
        if (last !== undefined && now() - last.startedAt <= cacheMs) {
          return Promise.resolve(last.value);
        }
      }
      if (running === undefined) {
        return launch();
      }
      waiting ??= Promise.withResolvers<T>();
      return waiting.promise;
    },
  };
};
