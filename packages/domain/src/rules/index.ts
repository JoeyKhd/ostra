import { approvalRuleIdSchema } from "@ostra/protocol";
import type { ApprovalRule, ApprovalRulePreset } from "@ostra/protocol";

// Approval rules (ADR 0049, F-026, Q166, Q190). The schemas, the matcher and the "for this task"
// pattern live in `@ostra/protocol`, because the runner and the adapters (Apache-2.0) use them and
// can't import this package; they're re-exported here so core reads them from one place. This
// module adds the four presets the profile editor offers, each a plain rule underneath.

export {
  approvalRuleSchema,
  approvalRulesSchema,
  commandMatchesPrefix,
  commandOutsideAllowlist,
  firstMatchingRule,
  firstMatchingTaskRule,
  matchFitsTool,
  matchKindTools,
  normalizeRulePath,
  parseCommandLine,
  pathMatchesGlob,
  ruleMatches,
  taskRuleMatches,
  taskRulePatternFor,
  taskRuleSchema,
  taskRulesSchema,
} from "@ostra/protocol";
export type { ApprovalRequestSubject, ApprovalRule, ApprovalRulePreset, RuleContext, TaskRule, TaskRulePattern } from "@ostra/protocol";

/** "Adding a dependency": the manifests and lockfiles (ADR 0049). */
export const DEPENDENCY_FILES: readonly string[] = [
  "**/package.json",
  "**/pnpm-lock.yaml",
  "**/package-lock.json",
  "**/yarn.lock",
  "**/requirements*.txt",
  "**/pyproject.toml",
  "**/poetry.lock",
  "**/go.mod",
  "**/go.sum",
  "**/Cargo.toml",
  "**/Cargo.lock",
  "**/Gemfile*",
];

/** "Adding a dependency": the install commands (ADR 0049). */
export const DEPENDENCY_COMMANDS: readonly string[] = [
  "npm install",
  "npm i",
  "pnpm add",
  "yarn add",
  "pip install",
  "poetry add",
  "go get",
  "cargo add",
  "bundle add",
];

/** "Writing a migration": where migrations live (ADR 0049). */
export const MIGRATION_FILES: readonly string[] = ["**/migrations/**", "**/migrate/**", "**/*.sql", "**/prisma/schema.prisma"];

/**
 * "Commands outside an allowlist": the allowlist it starts with, read-only and test commands the
 * admin edits (ADR 0049; working values).
 */
export const DEFAULT_COMMAND_ALLOWLIST: readonly string[] = [
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "pwd",
  "echo",
  "grep",
  "rg",
  "find",
  "tree",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git add",
  "git commit",
  "npm test",
  "npm run test",
  "npm run lint",
  "npm run typecheck",
  "pnpm test",
  "pnpm lint",
  "pnpm typecheck",
  "pnpm run test",
  "yarn test",
  "pytest",
  "go test",
  "cargo test",
  "make test",
];

/** The preset names the editor shows, in its order. */
export const PRESET_NAMES: Readonly<Record<ApprovalRulePreset, string>> = {
  dependency: "Adding a dependency",
  migration: "Writing a migration",
  allowlist: "Commands outside an allowlist",
  network: "Reaching the network",
};

/**
 * A preset's rules, each with `preset` set, so the editor draws its chip and refuses the preset a
 * second time (ticket 01's decision). `newRuleId` mints each rule's ID; the profile stores them.
 * "Adding a dependency" and "Reaching the network" are two rules each.
 */
export const presetRules = (preset: ApprovalRulePreset, newRuleId: () => string): readonly ApprovalRule[] => {
  const rule = (tool: ApprovalRule["tool"], match: ApprovalRule["match"]): ApprovalRule => ({
    ruleId: approvalRuleIdSchema.parse(newRuleId()),
    name: PRESET_NAMES[preset],
    tool,
    match,
    preset,
  });
  switch (preset) {
    case "dependency":
      return [
        ...DEPENDENCY_FILES.map((glob) => rule("edit", { kind: "path-glob", glob })),
        rule("execute", { kind: "command-prefix", prefixes: [...DEPENDENCY_COMMANDS] }),
      ];
    case "migration":
      return MIGRATION_FILES.map((glob) => rule("edit", { kind: "path-glob", glob }));
    case "allowlist":
      return [rule("execute", { kind: "command-outside", allowlist: [...DEFAULT_COMMAND_ALLOWLIST] })];
    case "network":
      return [rule("fetch", { kind: "any" }), rule("mcp", { kind: "mcp-not-read-only" })];
    default:
      return preset satisfies never;
  }
};

/** The presets a profile has already, so the editor offers only the others. */
export const presetsIn = (rules: readonly ApprovalRule[]): ReadonlySet<ApprovalRulePreset> =>
  new Set(rules.flatMap((rule) => (rule.preset === undefined ? [] : [rule.preset])));
