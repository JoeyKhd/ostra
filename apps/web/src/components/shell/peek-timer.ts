import type { Space } from "./places";

// The peek (F-147; app-shell.md, "The peek"): while the panel is collapsed, a mouse resting on a rail
// space for 150ms shows that space's panel over the page. Moving to another space switches it at
// once; it closes 200ms after the pointer leaves both the rail and the overlay, on Escape, or on
// navigation. The timers are passed in, so the test runs them on a fake clock.

export const PEEK_OPEN_MS = 150;
export const PEEK_CLOSE_MS = 200;

export type Timers<Handle> = {
  readonly set: (run: () => void, ms: number) => Handle;
  readonly clear: (handle: Handle) => void;
};

export type PeekController = {
  /** The pointer rests on a space of the rail. */
  readonly enter: (space: Space) => void;
  /** The pointer is over the overlay itself: it stays. */
  readonly hold: () => void;
  /** The pointer left the rail or the overlay. */
  readonly leave: () => void;
  /** Escape, navigation, docking: it closes now. */
  readonly close: () => void;
  readonly dispose: () => void;
};

export const createPeek = <Handle,>(onChange: (space: Space | null) => void, timers: Timers<Handle>): PeekController => {
  let shown: Space | null = null;
  let pending: Handle | null = null;
  const cancel = () => {
    if (pending !== null) timers.clear(pending);
    pending = null;
  };
  const show = (space: Space | null) => {
    if (shown === space) return;
    shown = space;
    onChange(space);
  };
  return {
    enter: (space) => {
      cancel();
      if (shown !== null) {
        show(space);
        return;
      }
      pending = timers.set(() => {
        pending = null;
        show(space);
      }, PEEK_OPEN_MS);
    },
    hold: cancel,
    leave: () => {
      cancel();
      if (shown === null) return;
      pending = timers.set(() => {
        pending = null;
        show(null);
      }, PEEK_CLOSE_MS);
    },
    close: () => {
      cancel();
      show(null);
    },
    dispose: cancel,
  };
};
