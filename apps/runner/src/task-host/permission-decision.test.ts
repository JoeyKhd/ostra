import type { PermissionRequest } from "@ostra/adapter-sdk";
import { approvalRuleIdSchema, optionIdSchema, taskApprovalRuleIdSchema, toolCallIdSchema } from "@ostra/protocol";
import type { ApprovalRequestSubject, ApprovalRule, TaskRule } from "@ostra/protocol";
import { describe, expect, it } from "vitest";
import { allowOnce, decidePermission, rejectOnce } from "./permission-decision.ts";

// The runner's order for a permission request (ticket 30): plan mode's check, the task rules, the
// profile's rules, then what the agent's own settings say.

const request = (subject: ApprovalRequestSubject | null, toolKind = "edit"): PermissionRequest => ({
  toolCallId: toolCallIdSchema.parse("call-1"),
  title: "a request",
  toolKind,
  options: [],
  subject,
});

const edit = (value: string): ApprovalRequestSubject => ({ tool: "edit", subject: { kind: "path", value } });
const command = (value: string): ApprovalRequestSubject => ({ tool: "execute", subject: { kind: "command", value } });

const migrations: ApprovalRule = { ruleId: approvalRuleIdSchema.parse("rule-migrations"), name: "Writing a migration", tool: "edit", match: { kind: "path-glob", glob: "migrations/**" } };
const forTask: TaskRule = { ruleId: taskApprovalRuleIdSchema.parse("task-rule-1"), tool: "edit", pattern: "migrations/001.sql" };

const noTaskRules: readonly TaskRule[] = [];
const base = { mode: "build" as const, approvalRules: [migrations], taskRules: noTaskRules, context: { mcpServers: [] }, permissionRules: "runner-only" as const };

describe("decidePermission", () => {
  it("F-026: a profile rule asks a person, with the rule", () => {
    expect(decidePermission({ ...base, request: request(edit("migrations/001.sql")) })).toEqual({
      kind: "ask",
      rule: { source: "profile", ruleId: migrations.ruleId, name: migrations.name },
    });
  });

  it("F-026: a task rule answers before the profile's rule asks", () => {
    expect(decidePermission({ ...base, taskRules: [forTask], request: request(edit("migrations/001.sql")) })).toEqual({ kind: "task-rule", rule: forTask });
    // Exact path only: another migration still asks.
    expect(decidePermission({ ...base, taskRules: [forTask], request: request(edit("migrations/002.sql")) }).kind).toBe("ask");
  });

  it("F-026: without a rule, a request the runner reads needs nobody, for a native agent too; only a native agent's request it can't read still asks", () => {
    expect(decidePermission({ ...base, request: request(edit("src/a.ts")) })).toEqual({ kind: "allow" });
    // A native agent's settings ask for a superset of a rule (ticket 08): the over-ask costs no person.
    expect(decidePermission({ ...base, permissionRules: "native", request: request(edit("src/a.ts")) })).toEqual({ kind: "allow" });
    expect(decidePermission({ ...base, permissionRules: "native", request: request(command('git commit -m "a message"'), "execute") })).toEqual({ kind: "allow" });
    expect(decidePermission({ ...base, permissionRules: "native", request: request(edit("migrations/001.sql")) }).kind).toBe("ask");
    expect(decidePermission({ ...base, permissionRules: "native", request: request(null, "other") })).toEqual({ kind: "ask", rule: null });
    expect(decidePermission({ ...base, request: request(null, "read") })).toEqual({ kind: "allow" });
  });

  it("F-063: a plan turn refuses an edit and a command that changes things, before any rule, and lets reads and read-only commands through", () => {
    const plan = { ...base, mode: "plan" as const, taskRules: [forTask] };
    expect(decidePermission({ ...plan, request: request(edit("migrations/001.sql")) })).toEqual({ kind: "refuse-in-plan" });
    expect(decidePermission({ ...plan, request: request(command("pnpm add zod"), "execute") })).toEqual({ kind: "refuse-in-plan" });
    expect(decidePermission({ ...plan, request: request(command("git status"), "execute") })).toEqual({ kind: "allow" });
    expect(decidePermission({ ...plan, request: request(null, "read") })).toEqual({ kind: "allow" });
    expect(decidePermission({ ...plan, request: request(null, "other") })).toEqual({ kind: "refuse-in-plan" });
  });

  it("F-026: answers the agent's own once and reject options", () => {
    const options = [
      { optionId: optionIdSchema.parse("always"), label: "Always", kind: "allow-always" as const, decision: "allow_task" as const },
      { optionId: optionIdSchema.parse("once"), label: "Once", kind: "allow-once" as const, decision: "allow_once" as const },
      { optionId: optionIdSchema.parse("no"), label: "No", kind: "reject-once" as const, decision: "deny" as const },
    ];
    expect(allowOnce(options)).toEqual({ outcome: "selected", optionId: "once" });
    expect(rejectOnce(options)).toEqual({ outcome: "selected", optionId: "no" });
    expect(rejectOnce(options.slice(0, 2))).toEqual({ outcome: "cancelled" });
  });
});
