import type { DbEnum } from "@ostra/db";

import { moveTo, refuse } from "./transition.ts";
import type { Transition } from "./transition.ts";

// A needs-you item's lifecycle (domain-model.md, "When a task needs you"; F-036): open, then
// answered or dismissed. Each item has an audience.

export type NeedsYouAudience = DbEnum.NeedsYouAudience;

export type NeedsYouLifecycle =
  | { readonly state: "open" }
  | { readonly state: "answered" }
  | { readonly state: "dismissed" };

export type NeedsYouInput = { readonly type: "answer" } | { readonly type: "dismiss" };

export const transitionNeedsYou = (item: NeedsYouLifecycle, input: NeedsYouInput): Transition<NeedsYouLifecycle> => {
  if (item.state !== "open") {
    return refuse(input, item.state);
  }
  switch (input.type) {
    case "answer":
      return moveTo({ state: "answered" });
    case "dismiss":
      return moveTo({ state: "dismissed" });
    default:
      return input satisfies never;
  }
};
