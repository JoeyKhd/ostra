import type { DbEnum } from "@ostra/db";
import type { BoxWaitingReason, ExecutorKind } from "@ostra/protocol";

import { moveTo, refuse } from "./transition.ts";
import type { Transition } from "./transition.ts";

// A box's lifecycle (domain-model.md, "A box's lifecycle"; ADR 0029). A `host` worktree goes
// through the same states, so a task behaves the same on every executor. A box is never reused:
// `released` and `failed` are final.

/**
 * Why a box was released (F-079). `@ostra/protocol` writes them with a hyphen. `session_ended` is
 * core's own record of a box that went with its session; the rest are a `release` command's.
 */
export type BoxReleaseReason = DbEnum.BoxReleaseReason;

/** The reasons core asks a runner to release a box for: never `session_ended`, a box already gone. */
export type ReleaseCommandBoxReason = Exclude<BoxReleaseReason, "session_ended">;

/**
 * Whether a box outlives its session (ADR 0039, amended 2026-11-22, Q343). A `docker` box's or a
 * `kubernetes` pod's sidecar runs one session and exits with it, and its runner removes the box
 * then (`box-dispatcher.ts`, `kubernetes-dispatcher.ts`), on every runner minor: core records it
 * `released` (`session_ended`), and a reopen starts a fresh box. A `host` worktree stays, stopped,
 * until its release, and the task's next session on that runner resumes in it.
 */
export const boxOutlivesItsSession = (executor: ExecutorKind): boolean => {
  switch (executor) {
    case "host":
      return true;
    case "docker":
    case "kubernetes":
      return false;
    default:
      return executor satisfies never;
  }
};

/** A wait while `creating` (F-093): why, and since when (epoch ms). */
export type BoxWaiting = { readonly reason: BoxWaitingReason; readonly since: number };

export type BoxLifecycle =
  /**
   * Milestone 5 (F-093): a `kubernetes` box may wait for a node or its image while `creating`,
   * with no state of its own. `waiting` is absent or `null` when it doesn't.
   */
  | { readonly state: "creating"; readonly waiting?: BoxWaiting | null }
  | { readonly state: "preparing" }
  | { readonly state: "ready" }
  | { readonly state: "idle" }
  | { readonly state: "stopped" }
  /** `reason` is `null` for a box released before milestone 2 recorded one. */
  | { readonly state: "released"; readonly reason: BoxReleaseReason | null }
  | { readonly state: "failed"; readonly reason: string };

export type BoxInput =
  /** The containers (or the worktree root) exist. */
  | { readonly type: "created" }
  /** Milestone 5 (F-093): the runner's `box.waiting`: no node yet, or the image is being pulled. */
  | { readonly type: "waiting"; readonly reason: BoxWaitingReason; readonly since: number }
  /** Milestone 5 (F-093): the runner's `box.scheduled`: the wait is over, still `creating`. */
  | { readonly type: "scheduled" }
  | { readonly type: "prepared" }
  /** A turn ends (ready → idle) or starts (idle or a kept stopped box → ready). */
  | { readonly type: "turn_ended" }
  | { readonly type: "turn_started" }
  /** The idle timer ran out, or the task was stopped. */
  | { readonly type: "stop" }
  /** The executor removed it, for this reason. */
  | { readonly type: "release"; readonly reason: BoxReleaseReason }
  /** Creating or preparing failed, or the box was lost with its host. */
  | { readonly type: "fail"; readonly reason: string };

export const transitionBox = (box: BoxLifecycle, input: BoxInput): Transition<BoxLifecycle> => {
  const from = box.state;
  switch (input.type) {
    case "created":
      return from === "creating" ? moveTo({ state: "preparing" }) : refuse(input, from);
    case "waiting":
      return from === "creating" ? moveTo({ state: "creating", waiting: { reason: input.reason, since: input.since } }) : refuse(input, from);
    case "scheduled":
      return from === "creating" ? moveTo({ state: "creating", waiting: null }) : refuse(input, from);
    case "prepared":
      return from === "preparing" ? moveTo({ state: "ready" }) : refuse(input, from);
    case "turn_ended":
      return from === "ready" ? moveTo({ state: "idle" }) : refuse(input, from);
    case "turn_started":
      // A stopped worktree kept on `host` resumes in place (a `docker` or `kubernetes` box is never kept).
      return from === "idle" || from === "stopped" ? moveTo({ state: "ready" }) : refuse(input, from);
    case "stop":
      return from === "ready" || from === "idle" ? moveTo({ state: "stopped" }) : refuse(input, from);
    case "release":
      return from === "stopped" ? moveTo({ state: "released", reason: input.reason }) : refuse(input, from);
    case "fail":
      return from === "creating" || from === "preparing" || from === "ready" || from === "idle"
        ? moveTo({ state: "failed", reason: input.reason })
        : refuse(input, from);
    default:
      return input satisfies never;
  }
};
