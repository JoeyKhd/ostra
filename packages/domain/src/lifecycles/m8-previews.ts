import type { AppProcessReason, MemberId } from "@ostra/protocol";

import { moveTo, refuse } from "./transition.ts";
import type { Transition } from "./transition.ts";

// Milestone 8's lifecycles (spec section 5.4; ADR 0068; domain-model.md, "An app process's
// lifecycle", "A view's lifecycle", "A preview link's lifecycle" and "A lease's purpose"). Each is
// a discriminated union with one transition function, and every switch is exhaustive.

// ---------- an app process in a box (F-140) ----------

/**
 * An app process in one box. It starts `stopped`; `start_app`, the after-turn screenshots, an
 * opened view or "Start the app" start it. One that exited or failed may be started again; every
 * process stops with its box.
 */
export type AppProcessLifecycle =
  | { readonly state: "stopped" }
  | { readonly state: "starting"; readonly since: number }
  | { readonly state: "ready"; readonly since: number }
  | { readonly state: "exited"; readonly exitCode: number | null; readonly at: number }
  | { readonly state: "failed"; readonly reason: AppProcessReason; readonly exitCode: number | null; readonly at: number };

export type AppProcessInput =
  | { readonly type: "start"; readonly at: number }
  /** Its ready check passed. */
  | { readonly type: "ready"; readonly at: number }
  /** It couldn't start, or its ready check didn't pass in time, or it exited before it was ready. */
  | { readonly type: "fail"; readonly reason: AppProcessReason; readonly exitCode: number | null; readonly at: number }
  /** It exited on its own after it was ready. */
  | { readonly type: "exit"; readonly exitCode: number | null; readonly at: number }
  /** `app.stop`, or its box stopped. */
  | { readonly type: "stop" };

export const transitionAppProcess = (process: AppProcessLifecycle, input: AppProcessInput): Transition<AppProcessLifecycle> => {
  const from = process.state;
  switch (input.type) {
    case "start":
      return from === "stopped" || from === "exited" || from === "failed" ? moveTo({ state: "starting", since: input.at }) : refuse(input, from);
    case "ready":
      return from === "starting" ? moveTo({ state: "ready", since: input.at }) : refuse(input, from);
    case "fail":
      return from === "starting" ? moveTo({ state: "failed", reason: input.reason, exitCode: input.exitCode, at: input.at }) : refuse(input, from);
    case "exit":
      return from === "ready" ? moveTo({ state: "exited", exitCode: input.exitCode, at: input.at }) : refuse(input, from);
    case "stop":
      return from === "starting" || from === "ready" ? moveTo({ state: "stopped" }) : refuse(input, from);
    default:
      return input satisfies never;
  }
};

/** Whether a process is serving: what a view and a screenshot need. */
export const appProcessServing = (process: AppProcessLifecycle): boolean => process.state === "ready";

// ---------- a view of a preview (F-141) ----------

/**
 * One opening of a preview. `opening` until the box's preview connection reaches a replica; then
 * `open` while heartbeats come; `closed` for good (closed by its viewer, swept after 2 minutes with
 * no heartbeat, a revoked link, or the box gone).
 */
export type PreviewViewLifecycle =
  | { readonly state: "opening"; readonly since: number }
  | { readonly state: "open"; readonly since: number; readonly lastHeartbeatAt: number }
  | { readonly state: "closed"; readonly at: number; readonly reason: PreviewViewCloseReason };

/**
 * Why a view closed: its viewer closed it, its heartbeats stopped, its link ended, its box did, its
 * viewer's access was narrowed away (`refused`), (ticket 19) its box passed the warm cap
 * (`OSTRA_PREVIEW_WARM_MINUTES`) and idles out, or (2026-11-21) its box refused its `preview.open`
 * (`box-refused`, with the box's reason on the view).
 */
export type PreviewViewCloseReason = "closed" | "no-heartbeat" | "link-ended" | "box-gone" | "refused" | "warm-cap" | "box-refused";

export type PreviewViewInput =
  /** The box's preview connection reached a replica, which wrote its presence. */
  | { readonly type: "connected"; readonly at: number }
  | { readonly type: "heartbeat"; readonly at: number }
  | { readonly type: "close"; readonly at: number; readonly reason: PreviewViewCloseReason };

export const transitionPreviewView = (view: PreviewViewLifecycle, input: PreviewViewInput): Transition<PreviewViewLifecycle> => {
  switch (view.state) {
    case "opening":
      switch (input.type) {
        case "connected":
          return moveTo({ state: "open", since: input.at, lastHeartbeatAt: input.at });
        case "heartbeat":
          return refuse(input, view.state);
        case "close":
          return moveTo({ state: "closed", at: input.at, reason: input.reason });
        default:
          return input satisfies never;
      }
    case "open":
      switch (input.type) {
        case "connected":
          return refuse(input, view.state);
        case "heartbeat":
          return moveTo({ ...view, lastHeartbeatAt: Math.max(view.lastHeartbeatAt, input.at) });
        case "close":
          return moveTo({ state: "closed", at: input.at, reason: input.reason });
        default:
          return input satisfies never;
      }
    case "closed":
      return refuse(input, view.state);
    default:
      return view satisfies never;
  }
};

// ---------- a preview link (F-142) ----------

/** A link: `active` until it expires or a member revokes it, both for good. A public link never expires. */
export type PreviewLinkLifecycle =
  | { readonly state: "active"; readonly expiresAt: number | null }
  | { readonly state: "expired"; readonly at: number }
  | { readonly state: "revoked"; readonly at: number; readonly byMemberId: MemberId };

export type PreviewLinkInput =
  | { readonly type: "expire"; readonly at: number }
  | { readonly type: "revoke"; readonly at: number; readonly byMemberId: MemberId };

export const transitionPreviewLink = (link: PreviewLinkLifecycle, input: PreviewLinkInput): Transition<PreviewLinkLifecycle> => {
  switch (link.state) {
    case "active":
      switch (input.type) {
        case "expire":
          return link.expiresAt !== null && link.expiresAt <= input.at ? moveTo({ state: "expired", at: link.expiresAt }) : refuse(input, link.state);
        case "revoke":
          return moveTo({ state: "revoked", at: input.at, byMemberId: input.byMemberId });
        default:
          return input satisfies never;
      }
    case "expired":
    case "revoked":
      return refuse(input, link.state);
    default:
      return link satisfies never;
  }
};

/** A link's state from its row at `now`: revoked first, then expired by its time. */
export const previewLinkFromRow = (
  row: { readonly expiresAt: Date | null; readonly revokedAt: Date | null; readonly revokedByMemberId: MemberId | null },
  now: number,
): PreviewLinkLifecycle => {
  if (row.revokedAt !== null && row.revokedByMemberId !== null) {
    return { state: "revoked", at: row.revokedAt.getTime(), byMemberId: row.revokedByMemberId };
  }
  const expiresAt = row.expiresAt === null ? null : row.expiresAt.getTime();
  return expiresAt !== null && expiresAt <= now ? { state: "expired", at: expiresAt } : { state: "active", expiresAt };
};

// ---------- a lease's purpose (F-141, Q300) ----------

/**
 * Why a lease's box runs: a `turn` of the agent, or the `app` alone ("Start the app"), which
 * launches no agent. A member's message on an `app` lease turns it into a turn in the same box.
 */
export type LeasePurposeLifecycle =
  | { readonly purpose: "turn" }
  | { readonly purpose: "app"; readonly startedByMemberId: MemberId; readonly at: number };

export type LeasePurposeInput =
  /** A member's message arrived while the app ran: the agent starts in this box. */
  | { readonly type: "message"; readonly at: number };

export const transitionLeasePurpose = (lease: LeasePurposeLifecycle, input: LeasePurposeInput): Transition<LeasePurposeLifecycle> => {
  switch (lease.purpose) {
    case "app":
      // A message, the one input: the agent starts in this box.
      return moveTo({ purpose: "turn" });
    case "turn":
      // A turn's lease is already a turn's: a message is the session's own business.
      return refuse(input, lease.purpose);
    default:
      return lease satisfies never;
  }
};
