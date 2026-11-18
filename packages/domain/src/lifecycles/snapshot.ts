import { moveTo, refuse } from "./transition.ts";
import type { Transition } from "./transition.ts";

// A snapshot's lifecycle (domain-model.md, "A snapshot's lifecycle"; Q39, F-051). `replaced` and
// `failed` are final; a failed build leaves the previous ready snapshot in use.

export type SnapshotLifecycle =
  | { readonly state: "queued" }
  | { readonly state: "building" }
  | { readonly state: "ready" }
  | { readonly state: "replaced" }
  | { readonly state: "failed"; readonly reason: string };

export type SnapshotInput =
  | { readonly type: "build_started" }
  | { readonly type: "build_finished" }
  | { readonly type: "build_failed"; readonly reason: string }
  | { readonly type: "newer_ready" };

export const transitionSnapshot = (snapshot: SnapshotLifecycle, input: SnapshotInput): Transition<SnapshotLifecycle> => {
  const from = snapshot.state;
  switch (input.type) {
    case "build_started":
      return from === "queued" ? moveTo({ state: "building" }) : refuse(input, from);
    case "build_finished":
      return from === "building" ? moveTo({ state: "ready" }) : refuse(input, from);
    case "build_failed":
      return from === "building" ? moveTo({ state: "failed", reason: input.reason }) : refuse(input, from);
    case "newer_ready":
      return from === "ready" ? moveTo({ state: "replaced" }) : refuse(input, from);
    default:
      return input satisfies never;
  }
};
