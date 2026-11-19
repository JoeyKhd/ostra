import { planModeAllows } from "@ostra/adapter-sdk";
import type { AgentCapabilities, PermissionAnswer, PermissionRequest } from "@ostra/adapter-sdk";
import { firstMatchingRule, firstMatchingTaskRule } from "@ostra/protocol";
import type { ApprovalOption, ApprovalRequestSubject, ApprovalRule, ApprovalRuleRef, RuleContext, TaskRule, TurnMode } from "@ostra/protocol";

// What the runner does with an agent's permission request (F-026, ADR 0049, ADR 0036). The order
// is the profile suite's (`agent-profile-cases.ts`), and the runner's own part of it:
//
//   1. A plan turn (F-063) allows only what plan mode allows: read, search, a read-only command, a
//      read-only MCP server's tools. Anything else is refused at once, and no person is asked.
//   2. A "for this task" rule answers "once" at once (`approval.auto_answered` with its ID).
//   3. A profile rule asks a person: the request is held for an `approval-answer`.
//   4. Nothing covers it. A `native` agent asked because its own settings said "ask", and those
//      came from the profile, so a person is asked still. A `runner-only` agent asks for every
//      request: this one needs nobody, and it's allowed once.
//
// Pure: the request's text (paths, commands) is the agent's and never logged.

export type PermissionDecision =
  | { readonly kind: "refuse-in-plan" }
  | { readonly kind: "task-rule"; readonly rule: TaskRule }
  | { readonly kind: "ask"; readonly rule: ApprovalRuleRef | null }
  | { readonly kind: "allow" };

export type PermissionDecisionInput = {
  readonly request: PermissionRequest;
  readonly mode: TurnMode;
  readonly approvalRules: readonly ApprovalRule[];
  readonly taskRules: readonly TaskRule[];
  readonly context: RuleContext;
  readonly permissionRules: AgentCapabilities["permissionRules"];
};

/** The name a task rule goes by on the card: it has none of its own. */
export const TASK_RULE_NAME = "Approved for this task";

export const decidePermission = (input: PermissionDecisionInput): PermissionDecision => {
  const subject: ApprovalRequestSubject | null = input.request.subject ?? null;
  if (input.mode === "plan" && !planModeAllows({ subject, toolKind: input.request.toolKind }, input.context)) {
    return { kind: "refuse-in-plan" };
  }
  if (subject !== null) {
    const taskRule = firstMatchingTaskRule(input.taskRules, subject);
    if (taskRule !== null) {
      return { kind: "task-rule", rule: taskRule };
    }
    const profileRule = firstMatchingRule(input.approvalRules, subject, input.context);
    if (profileRule !== null) {
      return { kind: "ask", rule: { source: "profile", ruleId: profileRule.ruleId, name: profileRule.name } };
    }
  }
  return input.permissionRules === "native" ? { kind: "ask", rule: null } : { kind: "allow" };
};

/** The agent's "once" option: ADR 0036 answers "for this task" once too, and the runner keeps the rule. */
export const allowOnce = (options: readonly ApprovalOption[]): PermissionAnswer => {
  const chosen = options.find((option) => option.kind === "allow-once") ?? options.find((option) => option.decision !== "deny");
  return chosen === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId: chosen.optionId };
};

/** The agent's "reject" option: once, where the agent offers it. */
export const rejectOnce = (options: readonly ApprovalOption[]): PermissionAnswer => {
  const chosen = options.find((option) => option.kind === "reject-once") ?? options.find((option) => option.decision === "deny");
  return chosen === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId: chosen.optionId };
};
