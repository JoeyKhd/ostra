import path from "node:path";
import { tmpdir } from "node:os";

import { ok } from "@ostra/adapter-sdk";
import type { LaunchMcpServer, PermissionRequest, PrepareLaunchInput } from "@ostra/adapter-sdk";
import { memoryAdapterContext } from "@ostra/adapter-sdk/testing";
import { approvalRuleIdSchema, firstMatchingRule, optionIdSchema, toolCallIdSchema } from "@ostra/protocol";
import type { ApprovalRequestSubject, ApprovalRule } from "@ostra/protocol";
import { fixtureIds } from "@ostra/protocol/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { OPENCODE_VERSION } from "./binary.ts";
import type { OpenCodeBinary } from "./binary.ts";
import { allowedEnvNames, buildCliEnv, SKILLS_HEADING, taskDirs } from "./config.ts";
import { OpenCodeAdapter } from "./opencode-adapter.ts";
import { buildPermissions, globToResource, planModePermissions, prefixToResource } from "./permissions.ts";
import type { OpenCodePermission } from "./permissions.ts";

// The profile's side of OpenCode's config (ticket 08, ADR 0049): the rules as its own permissions,
// the plan agent's denies, the MCP servers and skills, the repo's config off, and what a request
// touches. What OpenCode does with them is checked on the pinned binary in the contract tests.

const rule = (id: string, tool: ApprovalRule["tool"], match: ApprovalRule["match"]): ApprovalRule => ({ ruleId: approvalRuleIdSchema.parse(id), name: `rule ${id}`, tool, match });

const servers: readonly LaunchMcpServer[] = [
  { name: "docs", transport: "http", url: "http://127.0.0.1:7/mcp/docs", readOnly: true },
  { name: "files", transport: "stdio", command: "/usr/bin/mcp-files", args: ["--root", "."], env: { FILES_MODE: "rw" }, readOnly: false },
];

/** OpenCode's wildcard as 2.3.2 reads it: `*` is any run of characters, `/` included; `?` one character. */
const wildcard = (pattern: string): RegExp => new RegExp(`^${pattern.replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`).replaceAll("*", ".*").replaceAll("?", ".")}$`, "s");

/** What OpenCode decides for an action and a resource: the last rule that matches wins. */
const decide = (rules: readonly OpenCodePermission[], action: string, resource: string): OpenCodePermission["effect"] | undefined =>
  rules.findLast((candidate) => wildcard(candidate.action).test(action) && wildcard(candidate.resource).test(resource))?.effect;

const fakeBinary: OpenCodeBinary = { path: path.join(tmpdir(), "opencode-not-run"), packageName: "@opencode/cli-test", packageVersion: OPENCODE_VERSION, sha256: "0".repeat(64) };
const agentDir = path.join(tmpdir(), "task-m3", "agent");
const workspaceDir = path.join(tmpdir(), "task-m3", "workspace");

const input = (overrides: Partial<PrepareLaunchInput> = {}): PrepareLaunchInput => ({
  taskId: fixtureIds.task,
  sessionId: fixtureIds.session,
  workspaceDir,
  agentDir,
  model: { endpointModelId: "acme/model-1", apiFormat: "openai-compatible", baseUrl: "http://127.0.0.1:8123/v1", placeholderKey: "ostra-fake-key-abc" },
  mcp: { url: "http://127.0.0.1:8124/mcp" },
  instructions: null,
  extraEnv: {},
  ...overrides,
});

const configOf = async (adapter: OpenCodeAdapter, overrides: Partial<PrepareLaunchInput>): Promise<Record<string, unknown>> => {
  const prepared = await adapter.prepareLaunch(input(overrides));
  if (!prepared.ok) throw new Error(prepared.error.message);
  const file = prepared.value.files.find((candidate) => candidate.path === taskDirs(agentDir).config);
  return z.record(z.string(), z.unknown()).parse(JSON.parse(file?.content ?? "{}"));
};

const permissionsSchema = z.array(z.strictObject({ action: z.string(), resource: z.string(), effect: z.enum(["allow", "ask", "deny"]) }));

const newAdapter = (): OpenCodeAdapter => new OpenCodeAdapter({ resolveBinary: () => Promise.resolve(ok(fakeBinary)) }, memoryAdapterContext());

/** A testing subclass that reaches the protected `describePermission`, as the base class calls it. */
class Describing extends OpenCodeAdapter {
  subjectOf(request: PermissionRequest, cwd: string): ApprovalRequestSubject | null {
    return this.describePermission(request, cwd);
  }
}

const request = (title: string, toolKind: string, rawInput: unknown, locations: readonly string[] = []): PermissionRequest => ({
  toolCallId: toolCallIdSchema.parse("call-1"),
  title,
  options: [{ optionId: optionIdSchema.parse("once"), name: "Allow once", kind: "allow_once" }],
  toolKind,
  rawInput,
  locations,
});

describe("the profile's rules as OpenCode's permissions", () => {
  it("F-026: ostra writes every rule into OpenCode's own permissions as ask, between its allow and its deny, and relies on none of OpenCode's defaults", () => {
    const permissions = buildPermissions({
      approvalRules: [
        rule("deps", "edit", { kind: "path-glob", glob: "**/package.json" }),
        rule("installs", "execute", { kind: "command-prefix", prefixes: ["pnpm add"] }),
        rule("network", "fetch", { kind: "any" }),
        rule("writing-tools", "mcp", { kind: "mcp-not-read-only" }),
      ],
      mcpServers: servers,
    });
    // Everything allowed first, and `external_directory` denied last, so no rule reaches outside.
    expect(permissions[0]).toEqual({ action: "*", resource: "*", effect: "allow" });
    expect(permissions.at(-1)).toEqual({ action: "external_directory", resource: "*", effect: "deny" });
    expect(decide(permissions, "external_directory", "/etc/*")).toBe("deny");
    expect(permissions).toEqual(
      expect.arrayContaining([
        { action: "edit", resource: "*package.json", effect: "ask" },
        { action: "shell", resource: "*pnpm*add*", effect: "ask" },
        { action: "webfetch", resource: "*", effect: "ask" },
        { action: "websearch", resource: "*", effect: "ask" },
        { action: "files_*", resource: "*", effect: "ask" },
      ]),
    );
    // A read-only server's tools ask nothing.
    expect(permissions.some((permission) => permission.action.startsWith("docs_"))).toBe(false);
    // Every effect is the base's or "ask": a rule never allows more than OpenCode's base does.
    expect(permissions.slice(1, -1).every((permission) => permission.effect === "ask")).toBe(true);
  });

  it("F-026: without a rule, the agent works freely inside its box, and never outside it", () => {
    const permissions = buildPermissions({ approvalRules: [], mcpServers: servers });
    expect(permissions).toEqual([
      { action: "*", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "*", effect: "deny" },
    ]);
    expect(decide(permissions, "edit", "src/index.ts")).toBe("allow");
    expect(decide(permissions, "shell", "rm -rf dist")).toBe("allow");
    expect(decide(permissions, "external_directory", "/etc/*")).toBe("deny");
  });

  it("F-026: asks for at least everything a rule covers, however the request spells it: an over-ask costs a round trip, an under-ask a person", () => {
    const rules = [
      rule("deps", "edit", { kind: "path-glob", glob: "**/package.json" }),
      rule("migrations", "edit", { kind: "path-glob", glob: "db/migrations/*.sql" }),
      rule("installs", "execute", { kind: "command-prefix", prefixes: ["pnpm add", "rm"] }),
    ];
    const permissions = buildPermissions({ approvalRules: rules, mcpServers: [] });
    const paths = ["package.json", "web/package.json", "a/b/c/package.json", "db/migrations/001.sql", "db/migrations/sub/002.sql"];
    const commands = ["pnpm add x", "/usr/local/bin/pnpm add x", "CI=1 pnpm add x", "pnpm  add x", 'pnpm "add" x', "pn''pm add x", "rm -rf dist", "echo $(rm -rf /)", "x=`rm -rf /`"];
    for (const value of paths) {
      const subject: ApprovalRequestSubject = { tool: "edit", subject: { kind: "path", value } };
      if (firstMatchingRule(rules, subject) !== null) {
        expect(decide(permissions, "edit", value), value).toBe("ask");
      }
    }
    for (const value of commands) {
      const subject: ApprovalRequestSubject = { tool: "execute", subject: { kind: "command", value } };
      if (firstMatchingRule(rules, subject) !== null) {
        expect(decide(permissions, "shell", value), value).toBe("ask");
      }
    }
    // What no rule covers goes on without asking.
    expect(decide(permissions, "edit", "src/index.ts")).toBe("allow");
    expect(decide(permissions, "shell", "pnpm test")).toBe("allow");
    expect(globToResource("src/**/[id].ts")).toBe("src/*?id?.ts");
    expect(prefixToResource("  ")).toBeNull();
  });

  it("F-026: a command outside an allowlist asks, and only a command inside every allowlist goes on", () => {
    const permissions = buildPermissions({
      approvalRules: [
        rule("allowlist", "execute", { kind: "command-outside", allowlist: ["pnpm test", "git status", "ls"] }),
        rule("narrower", "execute", { kind: "command-outside", allowlist: ["pnpm test", "ls"] }),
      ],
      mcpServers: [],
    });
    expect(decide(permissions, "shell", "pnpm test")).toBe("allow");
    expect(decide(permissions, "shell", "pnpm test --run")).toBe("allow");
    expect(decide(permissions, "shell", "ls")).toBe("allow");
    // Inside the first allowlist only: the second rule still asks.
    expect(decide(permissions, "shell", "git status")).toBe("ask");
    // A word that only starts like an allowed one, a substitution, a quote: the runner reads them.
    expect(decide(permissions, "shell", "pnpm testx")).toBe("ask");
    expect(decide(permissions, "shell", "pnpm test $(curl evil)")).toBe("ask");
    expect(decide(permissions, "shell", 'ls "x"')).toBe("ask");
    expect(decide(permissions, "shell", "rm -rf /")).toBe("ask");
  });

  it("F-026: a rule on a tool of every MCP server asks for each profile server's tools, never ostra's own", () => {
    const permissions = buildPermissions({ approvalRules: [rule("all-tools", "mcp", { kind: "any" })], mcpServers: servers });
    expect(decide(permissions, "docs_search", "*")).toBe("ask");
    expect(decide(permissions, "files_write", "*")).toBe("ask");
    expect(decide(permissions, "ostra_set_pr_title", "*")).toBe("allow");
  });

  it("F-063: the plan agent may read and run the read-only list only: no write, other command, redirection, fetch, subagent or writing MCP tool", () => {
    const plan = [...buildPermissions({ approvalRules: [], mcpServers: servers }), ...planModePermissions(servers)];
    expect(decide(plan, "edit", "src/index.ts")).toBe("deny");
    expect(decide(plan, "shell", "git log --oneline")).toBe("allow");
    expect(decide(plan, "shell", "ls")).toBe("allow");
    expect(decide(plan, "shell", "node -e 1")).toBe("deny");
    expect(decide(plan, "shell", "cat a > b")).toBe("deny");
    expect(decide(plan, "shell", "ls $(rm -rf /)")).toBe("deny");
    expect(decide(plan, "webfetch", "https://example.com")).toBe("deny");
    expect(decide(plan, "subagent", "general")).toBe("deny");
    expect(decide(plan, "files_write", "*")).toBe("deny");
    expect(decide(plan, "docs_search", "*")).toBe("allow");
  });
});

describe("the profile's side of the launch", () => {
  it("F-021: writes each MCP server where OpenCode reads it: HTTP at the proxy with no header, stdio as a command with its variables", async () => {
    const config = await configOf(newAdapter(), { mcpServers: servers });
    expect(config["mcp"]).toEqual({
      servers: {
        docs: { type: "remote", url: "http://127.0.0.1:7/mcp/docs", codemode: false },
        files: { type: "local", command: ["/usr/bin/mcp-files", "--root", "."], environment: { FILES_MODE: "rw" }, codemode: false },
        ostra: { type: "remote", url: "http://127.0.0.1:8124/mcp", codemode: false },
      },
    });
  });

  it("F-021: points OpenCode at the profile's skill folders, then the repos' own, names the profile's in the instructions, and refuses one outside the agent folder", async () => {
    const skillDir = path.join(agentDir, "ostra-skills", "release-notes");
    const adapter = newAdapter();
    const prepared = await adapter.prepareLaunch(input({ instructions: "Prefer small commits.\n", skills: [{ name: "release-notes", dir: skillDir }] }));
    if (!prepared.ok) throw new Error(prepared.error.message);
    const config = await configOf(adapter, { skills: [{ name: "release-notes", dir: skillDir }], repoDirs: ["web", "api"] });
    // The repos' own skill folders, which the project config being off would otherwise drop.
    const root = workspaceDir.replaceAll("\\", "/");
    expect(config["skills"]).toEqual([skillDir, `${root}/.opencode/skills`, `${root}/web/.opencode/skills`, `${root}/api/.opencode/skills`]);
    const instructions = prepared.value.files.find((file) => file.path === taskDirs(agentDir).instructions);
    expect(instructions?.content).toBe(`Prefer small commits.\n\n${SKILLS_HEADING}: \`release-notes\`.\n`);
    for (const dir of [path.join(workspaceDir, ".opencode", "skills", "x"), path.join(agentDir, "..", "elsewhere"), "relative/skill"]) {
      expect(await adapter.prepareLaunch(input({ skills: [{ name: "x", dir }] })), dir).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    }
    // A repo's folder is one name inside the workspace, never a way out of it.
    for (const dir of ["..", "web/../..", "/etc", ""]) {
      expect(await adapter.prepareLaunch(input({ repoDirs: [dir] })), dir).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    }
  });

  it("F-021: never reads the repo's own OpenCode config, in the agent and in every other OpenCode command", async () => {
    const prepared = await newAdapter().prepareLaunch(input());
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value.env["OPENCODE_DISABLE_PROJECT_CONFIG"]).toBe("1");
    expect(buildCliEnv(taskDirs(agentDir))["OPENCODE_DISABLE_PROJECT_CONFIG"]).toBe("1");
    expect(allowedEnvNames).toContain("OPENCODE_DISABLE_PROJECT_CONFIG");
    expect(newAdapter().capabilities.projectConfigOverride).toBe(true);
  });

  it("F-063: starts a plan-first task in OpenCode's plan agent, with the plan agent's denies, and a build task in its build agent", async () => {
    const adapter = newAdapter();
    const plan = await configOf(adapter, { mode: "plan", mcpServers: servers });
    expect(plan["default_agent"]).toBe("plan");
    const agents = z.object({ plan: z.object({ permissions: permissionsSchema }) }).parse(plan["agents"]);
    expect(agents.plan.permissions).toEqual(planModePermissions(servers));
    expect((await configOf(adapter, {}))["default_agent"]).toBe("build");
  });

  it("refuses an MCP server named like ostra's own, one named twice, and one whose name isn't plain", async () => {
    const adapter = newAdapter();
    const http = (name: string): LaunchMcpServer => ({ name, transport: "http", url: "http://127.0.0.1:7/mcp", readOnly: true });
    for (const mcpServers of [[http("ostra")], [http("docs"), http("docs")], [http("bad name")], [http("a_b")]]) {
      expect(await adapter.prepareLaunch(input({ mcpServers })), JSON.stringify(mcpServers)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    }
  });
});

describe("what an OpenCode permission request touches", () => {
  it("F-026: reads an edit's path, a command and a fetch's URL, and an MCP tool as its profile server and tool", async () => {
    const adapter = new Describing({ resolveBinary: () => Promise.resolve(ok(fakeBinary)) }, memoryAdapterContext());
    await adapter.prepareLaunch(input({ mcpServers: [...servers, { name: "docs-v2", transport: "http", url: "http://127.0.0.1:7/mcp/v2", readOnly: true }] }));
    // As OpenCode 2.3.2 sent them (the probe in the README).
    expect(adapter.subjectOf(request("guarded.txt", "edit", { path: "guarded.txt", content: "x\n" }, [path.join(workspaceDir, "guarded.txt")]), workspaceDir)).toEqual({
      tool: "edit",
      subject: { kind: "path", value: "guarded.txt" },
    });
    expect(adapter.subjectOf(request("rm nothing.txt", "execute", { command: "rm nothing.txt", description: "probe", cwd: workspaceDir }, [workspaceDir]), workspaceDir)).toEqual({
      tool: "execute",
      subject: { kind: "command", value: "rm nothing.txt" },
    });
    expect(adapter.subjectOf(request("http://127.0.0.1:9/x", "fetch", { url: "http://127.0.0.1:9/x", format: "text" }), workspaceDir)).toEqual({
      tool: "fetch",
      subject: { kind: "url", value: "http://127.0.0.1:9/x" },
    });
    expect(adapter.subjectOf(request("files_wipe", "other", {}), workspaceDir)).toEqual({ tool: "mcp", subject: { kind: "tool", value: "files/wipe" } });
    expect(adapter.subjectOf(request("docs-v2_search", "other", {}), workspaceDir)).toEqual({ tool: "mcp", subject: { kind: "tool", value: "docs-v2/search" } });
    // ostra's own tools, a server the profile doesn't name, a skill: nothing a rule watches.
    for (const title of ["ostra_set_pr_title", "evil_wipe", "skill", "files_"]) {
      expect(adapter.subjectOf(request(title, "other", {}), workspaceDir), title).toBeNull();
    }
    // Another task's workspace knows none of these servers.
    expect(adapter.subjectOf(request("files_wipe", "other", {}), path.join(tmpdir(), "another-task")), "another task").toBeNull();
  });
});

describe("milestone 6: the read-only kinds and ostra's tools on OpenCode (ticket 09)", () => {
  const editRule = rule("m6-edit", "edit", { kind: "path-glob", glob: "src/**" });

  it("F-100: a review task's agent never edits, whatever a rule asks, and still runs commands in its box, never outside it", () => {
    const rules = buildPermissions({ approvalRules: [editRule], mcpServers: [], kind: "review" });
    expect(decide(rules, "edit", "src/banner.ts")).toBe("deny");
    expect(decide(rules, "edit", "README.md")).toBe("deny");
    expect(decide(rules, "shell", "pnpm test")).toBe("allow");
    expect(decide(rules, "read", "src/banner.ts")).toBe("allow");
    expect(decide(rules, "external_directory", "/etc/passwd")).toBe("deny");
    expect(rules.at(-1)).toEqual({ action: "external_directory", resource: "*", effect: "deny" });
  });

  it("F-099: a refine task edits only when its profile allows prototyping; the built-in Refine profile doesn't, and a code task always may", () => {
    expect(decide(buildPermissions({ approvalRules: [], mcpServers: [], kind: "refine" }), "edit", "src/a.ts")).toBe("deny");
    expect(decide(buildPermissions({ approvalRules: [], mcpServers: [], kind: "refine", allowPrototyping: false }), "edit", "src/a.ts")).toBe("deny");
    expect(decide(buildPermissions({ approvalRules: [], mcpServers: [], kind: "refine", allowPrototyping: true }), "edit", "src/a.ts")).toBe("allow");
    // Prototyping is a refine profile's: a review task never edits, even with it set.
    expect(decide(buildPermissions({ approvalRules: [], mcpServers: [], kind: "review", allowPrototyping: true }), "edit", "src/a.ts")).toBe("deny");
    expect(decide(buildPermissions({ approvalRules: [], mcpServers: [], kind: "code" }), "edit", "src/a.ts")).toBe("allow");
    expect(decide(buildPermissions({ approvalRules: [], mcpServers: [] }), "edit", "src/a.ts")).toBe("allow");
    // A prototyping refine task's edits still stay inside the workspace.
    expect(decide(buildPermissions({ approvalRules: [], mcpServers: [], kind: "refine", allowPrototyping: true }), "external_directory", "/tmp/x")).toBe("deny");
  });

  it("F-100: a code task's config offers none of submit_draft, submit_review and propose_environment, and a review task's only submit_review", async () => {
    const adapter = newAdapter();
    const permissionsOf = async (setup: Partial<PrepareLaunchInput>): Promise<readonly OpenCodePermission[]> => permissionsSchema.parse((await configOf(adapter, setup))["permissions"]);
    const offered = async (setup: Partial<PrepareLaunchInput>): Promise<readonly string[]> => {
      const permissions = await permissionsOf(setup);
      return ["submit_draft", "submit_review", "propose_environment"].filter((tool) => decide(permissions, `ostra_${tool}`, "{}") !== "deny");
    };
    expect(await offered({ kind: "code", tools: ["pr-text", "memory"] })).toEqual([]);
    expect(await offered({ kind: "review", tools: ["memory", "review"] })).toEqual(["submit_review"]);
    expect(await offered({ kind: "refine", tools: ["memory", "draft"] })).toEqual(["submit_draft"]);
    expect(await offered({ kind: "code", tools: ["pr-text", "memory", "environment"] })).toEqual(["propose_environment"]);
    // The memory tools and the PR's text stay offered to every kind.
    expect(decide(await permissionsOf({ kind: "review", tools: ["memory", "review"] }), "ostra_memory_search", "{}")).toBe("allow");
    // Without the task's sets (a runner before milestone 6), the config filters nothing: the sidecar serves the defaults.
    expect(await offered({})).toEqual(["submit_draft", "submit_review", "propose_environment"]);
  });
});
