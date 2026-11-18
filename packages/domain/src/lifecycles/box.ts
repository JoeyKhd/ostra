import { moveTo, refuse } from "./transition.ts";
import type { Transition } from "./transition.ts";

// A box's lifecycle (domain-model.md, "A box's lifecycle"; ADR 0029). A `host` worktree goes
// through the same states, so a task behaves the same on every executor. A box is never reused:
// `released` and `failed` are final.

export type BoxLifecycle =
  | { readonly state: "creating" }
  | { readonly state: "preparing" }
  | { readonly state: "ready" }
  | { readonly state: "idle" }
  | { readonly state: "stopped" }
  | { readonly state: "released" }
  | { readonly state: "failed"; readonly reason: string };

export type BoxInput =
  /** The containers (or the worktree root) exist. */
  | { readonly type: "created" }
  | { readonly type: "prepared" }
  /** A turn ends (ready → idle) or starts (idle or a kept stopped box → ready). */
  | { readonly type: "turn_ended" }
  | { readonly type: "turn_started" }
  /** The idle timer ran out, or the task was stopped. */
  | { readonly type: "stop" }
  /** The executor removed it. */
  | { readonly type: "release" }
  /** Creating or preparing failed, or the box was lost with its host. */
  | { readonly type: "fail"; readonly reason: string };

export const transitionBox = (box: BoxLifecycle, input: BoxInput): Transition<BoxLifecycle> => {
  const from = box.state;
  switch (input.type) {
    case "created":
      return from === "creating" ? moveTo({ state: "preparing" }) : refuse(input, from);
    case "prepared":
      return from === "preparing" ? moveTo({ state: "ready" }) : refuse(input, from);
    case "turn_ended":
      return from === "ready" ? moveTo({ state: "idle" }) : refuse(input, from);
    case "turn_started":
      // A stopped box kept on `docker` resumes in place.
      return from === "idle" || from === "stopped" ? moveTo({ state: "ready" }) : refuse(input, from);
    case "stop":
      return from === "ready" || from === "idle" ? moveTo({ state: "stopped" }) : refuse(input, from);
    case "release":
      return from === "stopped" ? moveTo({ state: "released" }) : refuse(input, from);
    case "fail":
      return from === "creating" || from === "preparing" || from === "ready" || from === "idle"
        ? moveTo({ state: "failed", reason: input.reason })
        : refuse(input, from);
    default:
      return input satisfies never;
  }
};
