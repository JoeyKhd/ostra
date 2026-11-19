import { describe, expect, it } from "vitest";

import { presetRules } from "@ostra/domain";
import { approvalRuleSchema } from "@ostra/protocol";

import { draftToRules, draftsToRules, emptyRule, groupRules, longMatch, matchKindsFor, ruleProblem, shortMatch, withTool } from "./rule-drafts";

// F-021, F-026: the profile editor shows a preset's several stored rules as one rule, and writes
// back exactly the rules it stands for (agent-profile.md, "Approval rules").

let next = 0;
const newId = (): string => `01900000-0000-7000-8000-${String(next++).padStart(12, "0")}`;

describe("approval rules in the panel", () => {
  it("F-021: a preset's globs show as one rule and save back as the same rules", () => {
    const migration = presetRules("migration", newId);
    const allowlist = presetRules("allowlist", newId);
    const drafts = groupRules([...migration, ...allowlist]);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({ name: "Writing a migration", tool: "edit", matchKind: "path-glob", preset: "migration" });
    expect(drafts[0]?.text).toBe("**/migrations/**, **/migrate/**, **/*.sql, **/prisma/schema.prisma");
    const back = draftsToRules(drafts, newId);
    expect(back).toEqual([...migration, ...allowlist]);
    for (const rule of back) expect(approvalRuleSchema.safeParse(rule).success).toBe(true);
  });

  it("F-026: the dependency and network presets each show as two rules, one per tool", () => {
    expect(groupRules(presetRules("dependency", newId)).map((draft) => draft.tool)).toEqual(["edit", "execute"]);
    expect(groupRules(presetRules("network", newId)).map((draft) => draft.matchKind)).toEqual(["any", "mcp-not-read-only"]);
  });

  it("F-026: an edited glob list keeps the old IDs in order and mints one for a new glob", () => {
    const [draft] = groupRules(presetRules("migration", newId));
    if (draft === undefined) throw new Error("no draft");
    const rules = draftToRules({ ...draft, text: "db/**, **/*.sql, sql/**, more/**, extra/**" }, () => "01900000-0000-7000-8000-ffffffffffff");
    expect(rules.map((rule) => rule.ruleId)).toEqual([...draft.ruleIds, "01900000-0000-7000-8000-ffffffffffff"]);
    expect(rules.map((rule) => (rule.match.kind === "path-glob" ? rule.match.glob : ""))).toEqual(["db/**", "**/*.sql", "sql/**", "more/**", "extra/**"]);
  });

  it("F-026: a custom rule needs a name and a valid glob, and a prefix rule a command", () => {
    const rule = emptyRule("k");
    expect(ruleProblem(rule)?.key).toBe("agentProfiles.rules.errorName");
    expect(ruleProblem({ ...rule, name: "Config" })?.key).toBe("agentProfiles.rules.errorGlobs");
    expect(ruleProblem({ ...rule, name: "Config", text: "../secrets/**" })).toEqual({ key: "agentProfiles.rules.errorGlob", reason: "it leaves the repo with .." });
    expect(ruleProblem({ ...rule, name: "Config", text: "config/**" })).toBeNull();
    expect(ruleProblem({ ...rule, name: "Deps", tool: "execute", matchKind: "command-prefix", text: " , " })?.key).toBe("agentProfiles.rules.errorCommands");
  });

  it("offers each tool only the matches that fit it, and moves the match when the tool changes", () => {
    expect(matchKindsFor("edit")).toEqual(["path-glob", "any"]);
    expect(matchKindsFor("execute")).toEqual(["command-prefix", "command-outside", "any"]);
    expect(matchKindsFor("fetch")).toEqual(["any"]);
    expect(matchKindsFor("mcp")).toEqual(["mcp-not-read-only", "any"]);
    const moved = withTool({ ...emptyRule("k"), text: "config/**" }, "execute");
    expect(moved).toMatchObject({ tool: "execute", matchKind: "command-prefix", text: "" });
    expect(withTool({ ...emptyRule("k"), matchKind: "any" }, "mcp").matchKind).toBe("any");
  });

  it("summarizes a match short for the list and long for the editor", () => {
    const [migration] = groupRules(presetRules("migration", newId));
    const [allowlist] = groupRules(presetRules("allowlist", newId));
    const [, commands] = groupRules(presetRules("dependency", newId));
    if (migration === undefined || allowlist === undefined || commands === undefined) throw new Error("no drafts");
    expect(shortMatch(migration)).toEqual({ kind: "text", text: "**/migrations/** · **/migrate/** · +2" });
    expect(shortMatch(allowlist)).toEqual({ kind: "message", key: "agentProfiles.rules.allowedMany", params: { n: 31 } });
    expect(shortMatch(commands)).toEqual({ kind: "text", text: "npm install, npm i +7" });
    expect(longMatch(migration)).toEqual({ kind: "text", text: "**/migrations/**, **/migrate/**, **/*.sql, **/prisma/schema.prisma" });
    expect(longMatch(allowlist)).toEqual({ kind: "message", key: "agentProfiles.rules.outside", params: { n: 31, list: "ls, cat, head, tail, wc …" } });
  });
});
