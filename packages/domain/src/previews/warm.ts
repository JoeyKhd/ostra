// Warm while watched (milestone 8, F-141, Q299, ADR 0068, ADR 0039 amended): the idle sweep keeps
// a box whose preview someone watches, up to a cap. Pure: the box's times and the settings go in,
// `hold` or `idle` comes out.

/** How recent a pane's or a viewer page's heartbeat must be for the box to count as watched. */
export const PREVIEW_WATCHED_WITHIN_MS = 2 * 60_000;

/** How often an open, visible pane or viewer page sends its heartbeat *(working value)*. */
export const PREVIEW_HEARTBEAT_MS = 30_000;

/** A box as the warm rule reads it. */
export type WarmBox = {
  /** The last heartbeat of a pane or a viewer page watching one of its previews (`Box.previewWatchedAt`). */
  readonly previewWatchedAt: number | null;
  /** When its last turn ended, or `null` before any did. */
  readonly lastTurnEndedAt: number | null;
  /** When its app started without a turn ("Start the app"), or `null`. */
  readonly appStartedAt: number | null;
  /**
   * The app's own traffic, such as a dev server's HMR socket. Never counts as watching: CodeSandbox
   * and Cloudflare both found it keeps a sandbox awake for nobody (`research/live-previews.md` §1.5).
   */
  readonly lastAppTrafficAt?: number | null;
};

export type WarmSettings = {
  /** `OSTRA_PREVIEW_WARM_MINUTES`: the longest a watched box stays warm after its last turn or app start. */
  readonly warmMinutes: number;
};

export type WarmHold =
  | { readonly hold: true; readonly until: number }
  | { readonly hold: false; readonly reason: "not-watched" | "past-the-cap" | "never-started" };

/**
 * Whether the idle sweep keeps `box` warm at `now`: only while a heartbeat came in the last 2
 * minutes, and only up to `warmMinutes` after its last turn ended or its app started, whichever is
 * later. Past the cap it idles out as ADR 0039 says, watched or not.
 */
export const warmHold = (box: WarmBox, now: number, settings: WarmSettings): WarmHold => {
  const started = Math.max(box.lastTurnEndedAt ?? Number.NEGATIVE_INFINITY, box.appStartedAt ?? Number.NEGATIVE_INFINITY);
  if (!Number.isFinite(started)) {
    return { hold: false, reason: "never-started" };
  }
  const until = started + settings.warmMinutes * 60_000;
  if (now >= until) {
    return { hold: false, reason: "past-the-cap" };
  }
  if (box.previewWatchedAt === null || now - box.previewWatchedAt > PREVIEW_WATCHED_WITHIN_MS || box.previewWatchedAt > now) {
    return { hold: false, reason: "not-watched" };
  }
  return { hold: true, until };
};
