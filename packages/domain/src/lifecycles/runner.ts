import { moveTo, refuse } from "./transition.ts";
import type { Transition } from "./transition.ts";

// A runner's lifecycle (domain-model.md, "A runner's lifecycle"; ADR 0029). `revoked` is final:
// a revoked runner can't connect again. `draining` is an admin's hold: a disconnect or a reconnect
// leaves it draining, and only a resume lifts it (Q108). Any state but `revoked` can be revoked
// (Q131).

export type RunnerLifecycle =
  | { readonly state: "joining" }
  | { readonly state: "online" }
  | { readonly state: "offline" }
  | { readonly state: "draining" }
  | { readonly state: "revoked" };

export type RunnerInput =
  /** Its identity is accepted (an admin approved it, where the pool requires that). */
  | { readonly type: "accept" }
  /**
   * Milestone 5 (F-091): an admin approves a joining runner. `connected`: it holds a connection
   * now, so it's online at once; otherwise it stays `joining`, approved, until its next `hello`
   * accepts it.
   */
  | { readonly type: "approve"; readonly connected: boolean }
  /** It's rejected while joining. */
  | { readonly type: "reject" }
  | { readonly type: "disconnected" }
  | { readonly type: "reconnected" }
  /** An admin drains it: no new tasks, until an admin resumes it. */
  | { readonly type: "drain" }
  /** An admin lifts the drain; `connected` says whether the runner holds a connection now. */
  | { readonly type: "resume"; readonly connected: boolean }
  /** An admin, or the member who owns a personal runner, revokes it. */
  | { readonly type: "revoke" };

export const transitionRunner = (runner: RunnerLifecycle, input: RunnerInput): Transition<RunnerLifecycle> => {
  const from = runner.state;
  switch (input.type) {
    case "accept":
      return from === "joining" ? moveTo({ state: "online" }) : refuse(input, from);
    case "approve":
      return from === "joining" ? moveTo({ state: input.connected ? "online" : "joining" }) : refuse(input, from);
    case "reject":
      return from === "joining" ? moveTo({ state: "revoked" }) : refuse(input, from);
    case "disconnected":
      if (from === "draining") {
        return moveTo({ state: "draining" });
      }
      return from === "online" ? moveTo({ state: "offline" }) : refuse(input, from);
    case "reconnected":
      if (from === "draining") {
        return moveTo({ state: "draining" });
      }
      return from === "offline" ? moveTo({ state: "online" }) : refuse(input, from);
    case "drain":
      return from === "online" || from === "offline" ? moveTo({ state: "draining" }) : refuse(input, from);
    case "resume":
      return from === "draining" ? moveTo({ state: input.connected ? "online" : "offline" }) : refuse(input, from);
    case "revoke":
      return from === "revoked" ? refuse(input, from) : moveTo({ state: "revoked" });
    default:
      return input satisfies never;
  }
};

/** Whether a runner may be offered a new task. */
export const takesTasks = (runner: RunnerLifecycle): boolean => runner.state === "online";
