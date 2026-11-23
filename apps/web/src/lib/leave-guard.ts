// A page that holds something it can't show again (F-006/c4: Turn on's webhook secret) asks before
// every way out of it (github-events.md: "another row, another page, the panel's close"): a link,
// the router the shell navigates with (its keys, its palette, its panels' buttons), signing out,
// the browser's Back and Forward, and the browser's own leave. While a page holds, each leave goes
// to its guard, which runs it once the person says Leave. The hooks are `use-leave-guard.ts`.

/** Takes a leave over: `go` is the leave, to run once the person says Leave. */
export type LeaveGuard = (go: () => void) => void;

/** A page holding its leaves: who asks, and what it does with a Back or Forward. */
type Hold = { readonly ask: LeaveGuard; readonly traverse: ((event: PopStateEvent) => void) | undefined };

const holds: Hold[] = [];

/** Holds every leave for `ask` until the returned release runs. The last page to hold asks. */
export const holdLeaves = (ask: LeaveGuard, traverse?: (event: PopStateEvent) => void): (() => void) => {
  const hold: Hold = { ask, traverse };
  holds.push(hold);
  return () => {
    const at = holds.indexOf(hold);
    if (at !== -1) holds.splice(at, 1);
  };
};

/** Runs `go` now, or, while a page holds its leaves, hands it to that page's guard. */
export const askBeforeLeaving = (go: () => void): void => {
  const hold = holds.at(-1);
  if (hold === undefined) go();
  else hold.ask(go);
};

let listening = false;

/**
 * Back and Forward reach the page as a `popstate`, which the app router handles in a listener of
 * its own. Listeners on one target run in the order they were added, so this one is added from
 * `src/instrumentation-client.ts`, before any of the panel's React code runs: it goes first, and a
 * page that holds its leaves can stop the router's.
 */
export const listenForTraversals = (): void => {
  if (listening) return;
  listening = true;
  window.addEventListener("popstate", (event) => { holds.at(-1)?.traverse?.(event); });
};
