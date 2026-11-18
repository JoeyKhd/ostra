import { moveTo, refuse } from "./transition.ts";
import type { Transition } from "./transition.ts";

// A runner's lifecycle (domain-model.md, "A runner's lifecycle"; ADR 0029). `revoked` is final:
// a revoked runner can't connect again.

export type RunnerLifecycle =
  | { readonly state: "joining" }
  | { readonly state: "online" }
  | { readonly state: "offline" }
  | { readonly state: "draining" }
  | { readonly state: "revoked" };

export type RunnerInput =
  /** Its identity is accepted (an admin approved it, where the pool requires that). */
  | { readonly type: "accept" }
  /** It's rejected while joining. */
  | { readonly type: "reject" }
  | { readonly type: "disconnected" }
  | { readonly type: "reconnected" }
  /** An admin drains it: no new tasks. */
  | { readonly type: "drain" }
  /** An admin revokes it. */
  | { readonly type: "revoke" };

export const transitionRunner = (runner: RunnerLifecycle, input: RunnerInput): Transition<RunnerLifecycle> => {
  const from = runner.state;
  switch (input.type) {
    case "accept":
      return from === "joining" ? moveTo({ state: "online" }) : refuse(input, from);
    case "reject":
      return from === "joining" ? moveTo({ state: "revoked" }) : refuse(input, from);
    case "disconnected":
      return from === "online" ? moveTo({ state: "offline" }) : refuse(input, from);
    case "reconnected":
      return from === "offline" ? moveTo({ state: "online" }) : refuse(input, from);
    case "drain":
      return from === "online" ? moveTo({ state: "draining" }) : refuse(input, from);
    case "revoke":
      return from === "draining" ? moveTo({ state: "revoked" }) : refuse(input, from);
    default:
      return input satisfies never;
  }
};

/** Whether a runner may be offered a new task. */
export const takesTasks = (runner: RunnerLifecycle): boolean => runner.state === "online";
