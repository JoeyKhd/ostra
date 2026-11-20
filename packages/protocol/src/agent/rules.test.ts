import { describe, expect, it } from "vitest";

import { approvalRuleIdSchema, taskApprovalRuleIdSchema } from "../ids.ts";
import { approvalRuleFixtures, taskRuleFixture } from "../testing/fixtures.ts";
import {
  approvalRuleSchema,
  commandMatchesPrefix,
  commandOutsideAllowlist,
  firstMatchingRule,
  firstMatchingTaskRule,
  matchFitsTool,
  normalizeRulePath,
  parseCommandLine,
  pathMatchesGlob,
  ruleMatches,
  taskRulePatternFor,
  taskRuleMatches,
  taskRuleSchema,
} from "./rules.ts";
import type { ApprovalRequestSubject, ApprovalRule, RuleContext } from "./rules.ts";

// The approval rules' schemas and the pure matcher (ADR 0049, Q166, Q167, Q190). The table below
// is the contract the runner, the `runner-only` adapters and the panel share.

const path = (value: string): ApprovalRequestSubject => ({ tool: "edit", subject: { kind: "path", value } });
const command = (value: string): ApprovalRequestSubject => ({ tool: "execute", subject: { kind: "command", value } });
const url = (value: string): ApprovalRequestSubject => ({ tool: "fetch", subject: { kind: "url", value } });
const mcp = (value: string): ApprovalRequestSubject => ({ tool: "mcp", subject: { kind: "tool", value } });

const context: RuleContext = { mcpServers: [{ name: "linear", readOnly: true }, { name: "files", readOnly: false }] };

const rule = (tool: ApprovalRule["tool"], match: ApprovalRule["match"]): ApprovalRule =>
  approvalRuleSchema.parse({ ruleId: "r", name: "a rule", tool, match });

describe("the rule schemas", () => {
  it("F-026: every fixture rule parses, a rule without a preset parses, and an unknown field is refused", () => {
    for (const fixture of Object.values(approvalRuleFixtures)) {
      expect(approvalRuleSchema.parse(JSON.parse(JSON.stringify(fixture)))).toEqual(fixture);
    }
    expect(approvalRuleSchema.parse(approvalRuleFixtures.custom)).not.toHaveProperty("preset");
    expect(approvalRuleSchema.safeParse({ ...approvalRuleFixtures.custom, effect: "deny" }).success).toBe(false);
    expect(approvalRuleSchema.safeParse({ ...approvalRuleFixtures.custom, preset: "everything" }).success).toBe(false);
  });

  it.each([
    ["path-glob", "edit", true],
    ["path-glob", "execute", false],
    ["command-prefix", "execute", true],
    ["command-prefix", "edit", false],
    ["command-outside", "execute", true],
    ["command-outside", "fetch", false],
    ["any", "edit", true],
    ["any", "execute", true],
    ["any", "fetch", true],
    ["any", "mcp", true],
    ["mcp-not-read-only", "mcp", true],
    ["mcp-not-read-only", "edit", false],
  ] as const)("F-026: the match %s with the tool %s is %s", (kind, tool, fits) => {
    expect(matchFitsTool(kind, tool)).toBe(fits);
    const match =
      kind === "path-glob"
        ? { kind, glob: "**/x" }
        : kind === "command-prefix"
          ? { kind, prefixes: ["x"] }
          : kind === "command-outside"
            ? { kind, allowlist: ["x"] }
            : { kind };
    expect(approvalRuleSchema.safeParse({ ruleId: "r", name: "n", tool, match }).success).toBe(fits);
  });

  it("F-026: a task rule needs its row's ID, and refuses an unknown field", () => {
    expect(taskRuleSchema.parse(taskRuleFixture)).toEqual(taskRuleFixture);
    expect(taskRuleSchema.safeParse({ tool: "execute", pattern: "pnpm add" }).success).toBe(false);
    expect(taskRuleSchema.safeParse({ ...taskRuleFixture, scope: "all" }).success).toBe(false);
    expect(taskApprovalRuleIdSchema.safeParse("has space").success).toBe(false);
    expect(approvalRuleIdSchema.parse("rule-1")).toBe("rule-1");
  });
});

describe("paths", () => {
  it.each([
    ["package.json", "package.json"],
    ["./a//b/./c.ts", "a/b/c.ts"],
    ["a\\b\\c.ts", "a/b/c.ts"],
    ["a/../b.ts", "b.ts"],
    ["../outside.ts", null],
    ["/etc/passwd", null],
    ["C:/Windows/x", null],
    [".", null],
  ] as const)("F-026: %s normalizes to %s", (input, expected) => {
    expect(normalizeRulePath(input)).toBe(expected);
  });

  it.each([
    ["**/package.json", "package.json", true],
    ["**/package.json", "test1/package.json", true],
    ["**/package.json", "a/b/c/package.json", true],
    ["**/package.json", "package.json.bak", false],
    ["**/package.json", "my-package.json", false],
    ["**/migrations/**", "db/migrations/001_init.sql", true],
    ["**/migrations/**", "migrations/x/y.sql", true],
    ["**/migrations/**", "db/migration/001.sql", false],
    ["**/*.sql", "schema.sql", true],
    ["**/*.sql", "db/a/schema.sql", true],
    ["**/*.sql", "db/schema.sqlx", false],
    ["**/requirements*.txt", "requirements-dev.txt", true],
    ["**/Gemfile*", "api/Gemfile.lock", true],
    ["**/prisma/schema.prisma", "packages/db/prisma/schema.prisma", true],
    [".github/**", ".github/workflows/ci.yml", true],
    [".github/**", "src/.github/x", false],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/a/b.ts", false],
    ["src/?.ts", "src/a.ts", true],
    ["src/a.(ts)", "src/a.(ts)", true],
    ["src/a.(ts)", "src/a.ts", false],
    ["**/package.json", "../package.json", true],
    ["docs/**", "/etc/passwd", true],
  ] as const)("F-026/c1: the glob %s against %s is %s", (glob, input, expected) => {
    expect(pathMatchesGlob(input, glob)).toBe(expected);
  });
});

describe("commands", () => {
  it("F-026: reads a command line into simple commands without a shell", () => {
    expect(parseCommandLine("pnpm add zod")).toEqual({ segments: [["pnpm", "add", "zod"]], substitution: false });
    expect(parseCommandLine(`git commit -m "fix: a && b" && pnpm add 'x y'`).segments).toEqual([
      ["git", "commit", "-m", "fix: a && b"],
      ["pnpm", "add", "x y"],
    ]);
    expect(parseCommandLine("a; b | c || d & e\nf").segments).toEqual([["a"], ["b"], ["c"], ["d"], ["e"], ["f"]]);
    expect(parseCommandLine("pnpm test 2>&1 | tee out").segments).toEqual([["pnpm", "test", "2>&1"], ["tee", "out"]]);
    expect(parseCommandLine("echo $(pnpm add x)")).toEqual({ segments: [["echo"], ["pnpm", "add", "x"]], substitution: true });
    expect(parseCommandLine("echo `pnpm add x`").substitution).toBe(true);
    expect(parseCommandLine(`echo "$(rm -rf x)"`).substitution).toBe(true);
    expect(parseCommandLine("echo '$(not run)'").substitution).toBe(false);
    expect(parseCommandLine(String.raw`echo a\ b`).segments).toEqual([["echo", "a b"]]);
  });

  it.each([
    ["pnpm add zod", true],
    ["pnpm add -D vitest", true],
    ["  pnpm   add zod", true],
    ["NODE_ENV=dev pnpm add zod", true],
    ["/usr/local/bin/pnpm add zod", true],
    ["cd web && pnpm add zod", true],
    ["echo $(npm install x)", true],
    ["npm install", true],
    ["npm i lodash", false],
    ["pnpm install", false],
    ["pnpm addx", false],
    ["echo pnpm add zod", false],
    ["", false],
  ] as const)("F-026/c1: the prefixes `pnpm add`, `npm install` against %j is %s", (line, expected) => {
    expect(commandMatchesPrefix(line, ["pnpm add", "npm install"])).toBe(expected);
  });

  it.each([
    ["git status", false],
    ["pnpm test --filter api", false],
    ["ls -la && git status", false],
    ["pnpm test 2>&1", false],
    ["rm -rf dist", true],
    ["git status && rm -rf dist", true],
    ["ls $(rm -rf x)", true],
    [`ls "$(rm -rf x)"`, true],
    ["ls `git push`", true],
    ["git push", true],
    ["", false],
  ] as const)("F-026/c1: the allowlist `git status`, `pnpm test`, `ls` against %j: outside is %s", (line, expected) => {
    expect(commandOutsideAllowlist(line, ["git status", "pnpm test", "ls"])).toBe(expected);
  });
});

describe("a rule against a request", () => {
  it.each([
    ["dependencyFiles", path("web/package.json"), true],
    ["dependencyFiles", path("web/src/index.ts"), false],
    ["dependencyFiles", command("cat package.json"), false],
    ["dependencyCommands", command("pnpm add zod"), true],
    ["dependencyCommands", command("pnpm test"), false],
    ["allowlist", command("rm -rf /"), true],
    ["allowlist", command("git status"), false],
    ["network", url("https://registry.npmjs.org/zod"), true],
    ["network", command("curl https://x"), false],
    ["mcp", mcp("files/write"), true],
    ["mcp", mcp("linear/list_issues"), false],
    ["mcp", mcp("unknown/anything"), true],
    ["custom", path(".github/workflows/ci.yml"), true],
  ] as const)("F-026: %s against %j is %s", (name, request, expected) => {
    expect(ruleMatches(approvalRuleFixtures[name], request, context)).toBe(expected);
  });

  it("F-026: the first matching rule names the rule that asks, and none matching means the request goes on", () => {
    const rules = Object.values(approvalRuleFixtures);
    expect(firstMatchingRule(rules, command("pnpm add zod"), context)?.ruleId).toBe("rule-dependency-commands");
    expect(firstMatchingRule(rules, path("src/index.ts"), context)).toBeNull();
    expect(firstMatchingRule([rule("edit", { kind: "any" })], path("src/index.ts"))?.tool).toBe("edit");
  });
});

describe("for this task", () => {
  it.each([
    [path("./web/package.json"), { tool: "edit", pattern: "web/package.json" }],
    [path("../x"), null],
    [command("pnpm add zod --save-exact"), { tool: "execute", pattern: "pnpm add" }],
    [command("NODE_ENV=dev /usr/bin/pnpm add zod"), { tool: "execute", pattern: "pnpm add" }],
    [command("make"), { tool: "execute", pattern: "make" }],
    [command("pnpm add zod && rm -rf /"), null],
    [command("pnpm add $(cat list)"), null],
    [command("   "), null],
    [url("https://Registry.npmjs.org:443/zod"), { tool: "fetch", pattern: "registry.npmjs.org" }],
    [url("not a url"), null],
    [mcp("files/write"), { tool: "mcp", pattern: "files/write" }],
  ] as const)("F-026: the pattern drawn from %j is %j", (request, expected) => {
    expect(taskRulePatternFor(request)).toEqual(expected);
  });

  it.each([
    [command("pnpm add date-fns"), true],
    [command("pnpm add"), true],
    [command("pnpm install"), false],
    [command("pnpm add x; rm -rf /"), false],
    [command("pnpm add $(evil)"), false],
    [path("pnpm add"), false],
  ] as const)("F-026: the task rule `pnpm add` answers %j: %s", (request, expected) => {
    expect(taskRuleMatches(taskRuleFixture, request)).toBe(expected);
  });

  it("F-026: a path, a host and an MCP tool answer only the same one", () => {
    expect(taskRuleMatches({ tool: "edit", pattern: "web/package.json" }, path("web//package.json"))).toBe(true);
    expect(taskRuleMatches({ tool: "edit", pattern: "web/package.json" }, path("package.json"))).toBe(false);
    expect(taskRuleMatches({ tool: "fetch", pattern: "registry.npmjs.org" }, url("https://registry.npmjs.org/a"))).toBe(true);
    expect(taskRuleMatches({ tool: "fetch", pattern: "registry.npmjs.org" }, url("https://evil.example/registry.npmjs.org"))).toBe(false);
    expect(taskRuleMatches({ tool: "mcp", pattern: "files/write" }, mcp("files/delete"))).toBe(false);
    expect(firstMatchingTaskRule([taskRuleFixture], command("pnpm add zod"))).toBe(taskRuleFixture);
    expect(firstMatchingTaskRule([taskRuleFixture], command("pnpm remove zod"))).toBeNull();
  });

  it("F-026: a drawn pattern answers the request it came from", () => {
    for (const request of [path("a/b.ts"), command("pnpm add zod"), url("https://x.example/y"), mcp("files/write")]) {
      const pattern = taskRulePatternFor(request);
      expect(pattern).not.toBeNull();
      if (pattern !== null) {
        expect(taskRuleMatches(pattern, request)).toBe(true);
      }
    }
  });
});
