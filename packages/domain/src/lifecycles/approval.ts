import type { ApprovalDecision, MemberId, OptionId } from "@ostra/protocol";

import { moveTo, refuse } from "./transition.ts";
import type { Transition } from "./transition.ts";

// An approval's lifecycle (domain-model.md, "An approval's lifecycle"; F-026). Every state but
// `open` is final. The first answer wins.

export type ApprovalLifecycle =
  | { readonly state: "open" }
  | {
      readonly state: "answered";
      readonly decision: ApprovalDecision;
      readonly optionId: OptionId;
      readonly memberId: MemberId;
    }
  | { readonly state: "answered_by_rule"; readonly decision: ApprovalDecision; readonly ruleId: string }
  | { readonly state: "closed"; readonly reason: "cancelled" | "expired" };

export type ApprovalInput =
  | { readonly type: "answer"; readonly decision: ApprovalDecision; readonly optionId: OptionId; readonly memberId: MemberId }
  | { readonly type: "rule_answer"; readonly decision: ApprovalDecision; readonly ruleId: string }
  /** The turn was interrupted or the task stopped. */
  | { readonly type: "cancel" }
  /** The turn waited 15 minutes and was cancelled (Q42). */
  | { readonly type: "expire" };

export const transitionApproval = (approval: ApprovalLifecycle, input: ApprovalInput): Transition<ApprovalLifecycle> => {
  if (approval.state !== "open") {
    return refuse(input, approval.state);
  }
  switch (input.type) {
    case "answer":
      return moveTo({ state: "answered", decision: input.decision, optionId: input.optionId, memberId: input.memberId });
    case "rule_answer":
      return moveTo({ state: "answered_by_rule", decision: input.decision, ruleId: input.ruleId });
    case "cancel":
      return moveTo({ state: "closed", reason: "cancelled" });
    case "expire":
      return moveTo({ state: "closed", reason: "expired" });
    default:
      return input satisfies never;
  }
};
