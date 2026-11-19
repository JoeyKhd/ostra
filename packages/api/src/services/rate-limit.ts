// A fixed-window limiter in the web process's memory (ticket 22): enough for a public read such as
// an invitation's preview, which a stranger could otherwise use to probe IDs. Each replica counts on
// its own, which only loosens the limit by the number of replicas.

export type RateLimiter = {
  /** Counts one hit for `key` at `now`; `false` once the window's limit is spent. */
  readonly allow: (key: string, now: number) => boolean;
};

export const fixedWindowLimiter = (input: { readonly limit: number; readonly windowMs: number; readonly maxKeys?: number }): RateLimiter => {
  const windows = new Map<string, { start: number; count: number }>();
  const maxKeys = input.maxKeys ?? 10_000;
  return {
    allow: (key, now) => {
      const current = windows.get(key);
      if (current === undefined || now - current.start >= input.windowMs) {
        if (windows.size >= maxKeys) {
          // Forget the oldest windows first: a flood of new keys can't grow the map without bound.
          for (const [stale, window] of windows) {
            if (now - window.start >= input.windowMs || windows.size >= maxKeys) {
              windows.delete(stale);
            }
            if (windows.size < maxKeys) break;
          }
        }
        windows.set(key, { start: now, count: 1 });
        return true;
      }
      current.count += 1;
      return current.count <= input.limit;
    },
  };
};

/** The client's address as the proxy in front of the panel reports it, or `unknown`. */
export const clientAddressOf = (headers: Headers): string => {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded !== undefined && forwarded !== "") {
    return forwarded;
  }
  return headers.get("x-real-ip")?.trim() ?? "unknown";
};
