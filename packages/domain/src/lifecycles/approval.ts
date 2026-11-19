import type { ApprovalDecision, MemberId, OptionId, TaskRule } from "@ostra/protocol";

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
      /** Milestone 3: the task rule "Approve for this task" wrote, or `null`. Absent on an answer from before milestone 3. */
      readonly taskRule?: TaskRule | null;
      /** Milestone 3: a deny's reason, or `null`. Never logged, never in the audit entry. */
      readonly reason?: string | null;
    }
  | { readonly state: "answered_by_rule"; readonly decision: ApprovalDecision; readonly ruleId: string }
  | { readonly state: "closed"; readonly reason: "cancelled" | "expired" };

export type ApprovalInput =
  | {
      readonly type: "answer";
      readonly decision: ApprovalDecision;
      readonly optionId: OptionId;
      readonly memberId: MemberId;
      /** Milestone 3: with `allow_task`, the task rule written for it (ADR 0049). */
      readonly taskRule?: TaskRule | null;
      /** Milestone 3: with `deny`, the member's reason. */
      readonly reason?: string | null;
    }
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
    case "answer": {
      const taskRule = input.taskRule ?? null;
      const reason = input.reason?.trim() ?? "";
      // A task rule comes only with "for this task", and a reason only with a deny.
      if ((taskRule !== null && input.decision !== "allow_task") || (reason !== "" && input.decision !== "deny")) {
        return refuse(input, approval.state);
      }
      return moveTo({
        state: "answered",
        decision: input.decision,
        optionId: input.optionId,
        memberId: input.memberId,
        // Present only when given, so an answer without them keeps milestone 1's shape.
        ...(taskRule === null ? {} : { taskRule }),
        ...(reason === "" ? {} : { reason }),
      });
    }
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
