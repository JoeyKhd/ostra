import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createAcpMapper, GIT_GUARD_ENV_NAMES, ok } from "@ostra/adapter-sdk";
import type { AdapterResult, PrepareLaunchInput } from "@ostra/adapter-sdk";
import { memoryAdapterContext } from "@ostra/adapter-sdk/testing";
import { approvalRuleIdSchema, sessionIdSchema, taskApprovalRuleIdSchema, taskIdSchema, turnIdSchema } from "@ostra/protocol";
import type { TaskEvent } from "@ostra/protocol";
import { fixtureIds } from "@ostra/protocol/testing";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { OPENCODE_VERSION, pinnedChecksums, platformPackages, resolveOpenCodeBinary, sha256File } from "./binary.ts";
import type { OpenCodeBinary } from "./binary.ts";
import { allowedEnvNames, KEY_ENV, repoInstructionGlobs, selfSetEnv } from "./config.ts";
import { OpenCodeAdapter } from "./opencode-adapter.ts";
import { createTodoTracker } from "./todo-plan.ts";

const fakeBinary: OpenCodeBinary = { path: path.join(tmpdir(), "opencode-not-run"), packageName: "@opencode/cli-test", packageVersion: OPENCODE_VERSION, sha256: "0".repeat(64) };

const input = (overrides: Partial<PrepareLaunchInput> = {}): PrepareLaunchInput => ({
  taskId: fixtureIds.task,
  sessionId: fixtureIds.session,
  workspaceDir: path.join(tmpdir(), "task", "workspace"),
  agentDir: path.join(tmpdir(), "task", "agent"),
  model: { endpointModelId: "acme/model-1", apiFormat: "openai-compatible", baseUrl: "http://127.0.0.1:8123/v1", placeholderKey: "ostra-fake-key-abc" },
  mcp: { url: "http://127.0.0.1:8124/mcp", bearer: "task-mcp-bearer-xyz" },
  instructions: null,
  extraEnv: { NODE_ENV: "test" },
  ...overrides,
});

const adapter = () => new OpenCodeAdapter({ resolveBinary: () => Promise.resolve(ok(fakeBinary)) }, memoryAdapterContext());

const launch = async (overrides: Partial<PrepareLaunchInput> = {}) => {
  const prepared = await adapter().prepareLaunch(input(overrides));
  if (!prepared.ok) {
    throw new Error(prepared.error.message);
  }
  return prepared.value;
};

const record = (value: unknown): Record<string, unknown> => z.record(z.string(), z.unknown()).parse(value);

const jsonFile = (files: readonly { readonly path: string; readonly content: string }[], suffix: string): Record<string, unknown> => {
  const file = files.find((candidate) => candidate.path.endsWith(suffix));
  if (file === undefined) {
    throw new Error(`no file ${suffix}`);
  }
  return record(JSON.parse(file.content));
};

describe("the OpenCode adapter's launch", () => {
  it("starts `opencode acp` in the task's workspace", async () => {
    const launched = await launch();
    expect(launched.command).toBe(fakeBinary.path);
    expect(launched.args).toEqual(["acp"]);
    expect(launched.cwd).toBe(input().workspaceDir);
  });

  it("F-019: writes the provider, the model, the todo tool and the MCP server into the task's own config", async () => {
    const { files } = await launch();
    const config = jsonFile(files, "opencode.json");
    expect(config["model"]).toBe("ostra/acme/model-1");
    expect(config["experimental"]).toEqual({ todo: true });
    expect(config["share"]).toBe("disabled");
    expect(config["update"]).toBe("disable");
    expect(config["providers"]).toEqual({
      ostra: {
        name: "ostra",
        env: [KEY_ENV],
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: "http://127.0.0.1:8123/v1" },
        compatibility: { streamUsage: true },
        models: { "acme/model-1": { name: "acme/model-1", limit: { context: 128_000, output: 16_000 } } },
      },
    });
    expect(config["mcp"]).toEqual({
      servers: { ostra: { type: "remote", url: "http://127.0.0.1:8124/mcp", codemode: false, headers: { authorization: "Bearer task-mcp-bearer-xyz" } } },
    });
  });

  it("picks the SDK package by API format, and asks only OpenAI-compatible endpoints for stream usage", async () => {
    const { files } = await launch({ model: { endpointModelId: "m", apiFormat: "anthropic-messages", baseUrl: "http://127.0.0.1:1/v1", placeholderKey: "k" } });
    const { ostra } = record(record(jsonFile(files, "opencode.json")["providers"]));
    expect(ostra).toMatchObject({ package: "@opencode/ai/providers/anthropic-compatible" });
    expect(ostra).not.toHaveProperty("compatibility");
  });

  it("F-019: writes the permission rules into the task's own config: edit and shell allowed in the worktree, `external_directory` denied", async () => {
    const config = jsonFile((await launch()).files, "opencode.json");
    expect(config["permissions"]).toEqual([
      { action: "*", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "*", effect: "deny" },
    ]);
  });

  it("F-026: writes the profile's rules into OpenCode's own permissions as ask on what each covers, with `external_directory` denied last; a task rule or a plan turn adds none", async () => {
    const withRules = jsonFile(
      (
        await launch({
          approvalRules: [
            { ruleId: approvalRuleIdSchema.parse("rule-1"), name: "Dependencies", tool: "execute", match: { kind: "command-prefix", prefixes: ["pnpm add"] } },
            { ruleId: approvalRuleIdSchema.parse("rule-2"), name: "Migrations", tool: "edit", match: { kind: "path-glob", glob: "migrations/**" } },
          ],
        })
      ).files,
      "opencode.json",
    );
    const permissions = z.array(z.strictObject({ action: z.string(), resource: z.string(), effect: z.string() })).parse(withRules["permissions"]);
    expect(permissions[0]).toEqual({ action: "*", resource: "*", effect: "allow" });
    expect(permissions.at(-1)).toEqual({ action: "external_directory", resource: "*", effect: "deny" });
    // Each rule asks on what it covers, not on its whole tool.
    expect(permissions).toContainEqual({ action: "shell", resource: "*pnpm*add*", effect: "ask" });
    expect(permissions).toContainEqual({ action: "edit", resource: "migrations/*", effect: "ask" });
    expect(permissions).not.toContainEqual({ action: "edit", resource: "*", effect: "ask" });
    // A task rule only answers what a profile rule asks about, so it adds no ask; a plan turn runs
    // as OpenCode's plan agent, whose own denies make it read-only.
    const base = [
      { action: "*", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "*", effect: "deny" },
    ];
    const withTaskRule = jsonFile(
      (await launch({ taskRules: [{ ruleId: taskApprovalRuleIdSchema.parse("task-rule-1"), tool: "fetch", pattern: "example.com" }] })).files,
      "opencode.json",
    );
    expect(withTaskRule["permissions"]).toEqual(base);
    const plan = jsonFile((await launch({ mode: "plan" })).files, "opencode.json");
    expect(plan["permissions"]).toEqual(base);
    expect(plan["default_agent"]).toBe("plan");
  });

  it("omits the MCP header when there is no bearer, and writes the instructions when there are some", async () => {
    const { files } = await launch({ mcp: { url: "http://127.0.0.1:8124/mcp" }, instructions: "Prefer small commits." });
    const config = jsonFile(files, "opencode.json");
    expect(config["mcp"]).toEqual({ servers: { ostra: { type: "remote", url: "http://127.0.0.1:8124/mcp", codemode: false } } });
    const written = files.find((file) => file.path.endsWith("instructions.md"));
    expect(written?.content).toBe("Prefer small commits.");
    // The task's file comes first, then the repo's own AGENTS.md, named because OpenCode's project
    // config is off (ADR 0049): the memory block sits before the repo's instructions (ticket 07).
    expect(config["instructions"]).toEqual([written?.path, ...repoInstructionGlobs(input().workspaceDir)]);
  });

  it("F-110: writes the memory block after the profile's instructions and its skills, in the task's config folder, named before the repos' own AGENTS.md", async () => {
    const block = "## Project memory\nAlways:\n- Use pnpm, never npm: run pnpm install at the root.";
    const skillDir = path.join(input().agentDir, "ostra-skills", "release-notes");
    const { files } = await launch({ instructions: "Prefer small commits.", skills: [{ name: "release-notes", dir: skillDir }], memory: { block, tools: true }, repoDirs: ["web", "api"] });
    const written = files.find((file) => file.path.endsWith("instructions.md"));
    expect(written?.path).toBe(path.join(input().agentDir, "instructions.md"));
    const text = written?.content ?? "";
    const at = (part: string): number => text.indexOf(part);
    expect(at("Prefer small commits.")).toBe(0);
    expect(at("`release-notes`")).toBeGreaterThan(at("Prefer small commits."));
    expect(at("web, api")).toBeGreaterThan(at("`release-notes`"));
    expect(at(block)).toBeGreaterThan(at("web, api"));
    expect(text.endsWith(block)).toBe(true);
    const config = jsonFile(files, "opencode.json");
    expect(config["instructions"]).toEqual([written?.path, ...repoInstructionGlobs(input().workspaceDir)]);
    // Nothing in the launch lands in the workspace, where the repos are.
    for (const file of files) {
      expect(path.relative(input().workspaceDir, file.path).startsWith("..")).toBe(true);
    }
    // The memory tools are on ostra's own server, which the config always names, with the task's bearer.
    expect(record(record(config["mcp"])["servers"])["ostra"]).toEqual({ type: "remote", url: "http://127.0.0.1:8124/mcp", codemode: false, headers: { authorization: "Bearer task-mcp-bearer-xyz" } });
  });

  it("F-110: with no memory block and one repo, the instructions file is the profile's alone, as before milestone 4", async () => {
    const { files } = await launch({ instructions: "Prefer small commits.", memory: null, repoDirs: ["web"] });
    expect(files.find((file) => file.path.endsWith("instructions.md"))?.content).toBe("Prefer small commits.");
    const blockOnly = await launch({ memory: { block: "## Project memory", tools: true } });
    expect(blockOnly.files.find((file) => file.path.endsWith("instructions.md"))?.content).toBe("## Project memory");
  });

  it("F-019: writes the model catalog as a file, and points OpenCode at it with its own fetch off", async () => {
    const { files, env } = await launch();
    const catalog = jsonFile(files, "models.json");
    expect(catalog["ostra"]).toMatchObject({ npm: "@ai-sdk/openai-compatible", models: { "acme/model-1": { tool_call: true } } });
    expect(env["OPENCODE_MODELS_PATH"]).toBe(path.join(input().agentDir, "models.json"));
    expect(env["OPENCODE_DISABLE_MODELS_FETCH"]).toBe("1");
  });

  it("keeps every file and folder under the task's own agent folder", async () => {
    const { files, env } = await launch();
    for (const file of files) {
      expect(path.relative(input().agentDir, file.path).startsWith("..")).toBe(false);
    }
    for (const name of ["HOME", "USERPROFILE", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TMP", "TEMP"]) {
      expect(path.relative(input().agentDir, env[name] ?? "..").startsWith("..")).toBe(false);
    }
  });

  it("gives the agent an environment of an allowlist only: the fake key and base config, never the runner's own", async () => {
    const hostile = { OSTRA_RUNNER_TOKEN: "runner-secret", GITHUB_TOKEN: "ghs_real", AWS_SECRET_ACCESS_KEY: "aws", OPENAI_API_KEY: "sk-real" };
    const saved = Object.entries(hostile).map(([name, value]) => [name, process.env[name], value] as const);
    for (const [name, , value] of saved) {
      process.env[name] = value;
    }
    try {
      const { env } = await launch();
      const names = Object.keys(env);
      expect(names.filter((name) => !allowedEnvNames.includes(name) && name !== "NODE_ENV")).toEqual([]);
      expect(env[KEY_ENV]).toBe("ostra-fake-key-abc");
      expect(JSON.stringify(env)).not.toContain("runner-secret");
      expect(JSON.stringify(env)).not.toContain("ghs_real");
      expect(JSON.stringify(env)).not.toContain("sk-real");
    } finally {
      for (const [name, before] of saved) {
        if (before === undefined) {
          Reflect.deleteProperty(process.env, name);
        } else {
          process.env[name] = before;
        }
      }
    }
  });

  it("puts the environment's own variables in, which hold no secret", async () => {
    expect((await launch({ extraEnv: { DATABASE_URL: "postgres://local/dev" } })).env["DATABASE_URL"]).toBe("postgres://local/dev");
  });

  it("lets no extra variable override the git guard's names, and keeps git off the terminal", async () => {
    const hostile = Object.fromEntries(GIT_GUARD_ENV_NAMES.map((name) => [name, "hostile"]));
    const { env } = await launch({ extraEnv: { ...hostile, DATABASE_URL: "postgres://local/dev" } });
    for (const name of GIT_GUARD_ENV_NAMES.filter((guarded) => guarded !== "GIT_TERMINAL_PROMPT" && guarded !== "GCM_INTERACTIVE")) {
      expect(env).not.toHaveProperty(name);
    }
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
    expect(env["GCM_INTERACTIVE"]).toBe("never");
    expect(env["DATABASE_URL"]).toBe("postgres://local/dev");
    expect(GIT_GUARD_ENV_NAMES.filter((name) => !allowedEnvNames.includes(name))).toEqual([]);
  });

  it("never passes what OpenCode sets in its own environment, so a live reading tells the two apart", async () => {
    const { env } = await launch();
    const fold = (name: string): string => name.toUpperCase();
    const launched = new Set(Object.keys(env).map(fold));
    for (const name of Object.keys(selfSetEnv)) {
      expect(launched.has(fold(name))).toBe(false);
      expect(allowedEnvNames.map(fold)).not.toContain(fold(name));
    }
  });

  it("refuses a launch with no base URL or key, and passes a refused binary through", async () => {
    const empty = await adapter().prepareLaunch(input({ model: { endpointModelId: "m", apiFormat: "openai-compatible", baseUrl: "", placeholderKey: "k" } }));
    expect(empty).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    const refusing = new OpenCodeAdapter({
      resolveBinary: (): Promise<AdapterResult<OpenCodeBinary>> =>
        Promise.resolve({ ok: false, error: { code: "conflict", message: "the binary does not match" } }),
    });
    expect(await refusing.prepareLaunch(input())).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await refusing.health()).toMatchObject({ status: "down" });
  });
});

describe("the OpenCode adapter's capabilities", () => {
  it("F-019: declares steering, session load, elicitation and the base URL, and no native plan or reject-and-continue", () => {
    expect(adapter().capabilities).toEqual({
      steerMidTurn: true,
      sessionLoad: true,
      nativePlan: false,
      rejectAndContinue: false,
      elicitationForm: true,
      modelBaseUrlAndPlaceholderKey: true,
      sessionArchive: true,
      // Milestone 3 (ticket 08), each proved on the pinned binary in the contract tests.
      permissionRules: "native",
      planMode: "session-mode",
      skills: true,
      mcp: { http: true, stdio: true },
      projectConfigOverride: true,
      // Milestone 4 (ticket 02).
      memory: "mcp",
    });
    expect(adapter().repoConfigPaths).toEqual(["opencode.json", "opencode.jsonc", ".opencode"]);
  });
});

describe("the todo list as a plan", () => {
  const context = { taskId: taskIdSchema.parse("task-1"), sessionId: sessionIdSchema.parse("session-1"), turnId: turnIdSchema.parse("turn-1") };

  it("turns a todowrite call into plan.updated, from its input and then its output", () => {
    const tracker = createTodoTracker();
    const mapper = createAcpMapper();
    const events: TaskEvent[] = [];
    const feed = (update: Record<string, unknown>): void => {
      const outcome = tracker.read({ sessionUpdate: "x", ...update });
      if (outcome.kind === "plan") {
        events.push(...mapper.map(outcome.update, context));
      } else if (outcome.kind === "other") {
        events.push(...mapper.map({ sessionUpdate: "x", ...update }, context));
      }
    };
    feed({ sessionUpdate: "tool_call", toolCallId: "t1", title: "todowrite", name: "todowrite", kind: "other", status: "pending", rawInput: {} });
    feed({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      title: "todowrite",
      status: "in_progress",
      rawInput: { todos: [{ content: "Read it", status: "in_progress" }, { content: "Edit it", status: "pending", priority: "high" }, { content: "Dropped", status: "cancelled" }] },
    });
    feed({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      rawOutput: { metadata: { todos: [{ content: "Read it", status: "completed" }, { content: "Edit it", status: "in_progress", priority: "high" }] } },
    });
    expect(events).toEqual([
      {
        kind: "plan.updated",
        turnId: "turn-1",
        entries: [
          { content: "Read it", priority: "medium", status: "in_progress" },
          { content: "Edit it", priority: "high", status: "pending" },
        ],
      },
      {
        kind: "plan.updated",
        turnId: "turn-1",
        entries: [
          { content: "Read it", priority: "medium", status: "completed" },
          { content: "Edit it", priority: "high", status: "in_progress" },
        ],
      },
    ]);
  });

  it("swallows the same list the second time, and leaves other tools to the shared mapping", () => {
    const tracker = createTodoTracker();
    const call = { sessionUpdate: "tool_call_update", toolCallId: "t1", title: "todowrite", rawInput: { todos: [{ content: "A", status: "pending" }] } };
    expect(tracker.read(call).kind).toBe("plan");
    expect(tracker.read(call).kind).toBe("swallow");
    expect(tracker.read({ sessionUpdate: "tool_call", toolCallId: "r1", title: "read", kind: "read" }).kind).toBe("other");
    expect(tracker.read({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }).kind).toBe("other");
  });
});

describe("the pinned binary", () => {
  const roots: string[] = [];
  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  /** An install of `@opencode/cli` with a platform package whose binary holds `content`. */
  const install = async (content: string, version = OPENCODE_VERSION): Promise<{ readonly from: string; readonly packageName: string; readonly binary: string }> => {
    const root = await mkdtemp(path.join(tmpdir(), "ostra-oc-install-"));
    roots.push(root);
    const packageName = platformPackages()[0] ?? "";
    const wrapper = path.join(root, "node_modules", "@opencode", "cli");
    const platform = path.join(root, "node_modules", "@opencode", packageName.slice("@opencode/".length));
    await mkdir(path.join(platform, "bin"), { recursive: true });
    await mkdir(wrapper, { recursive: true });
    await writeFile(path.join(wrapper, "package.json"), JSON.stringify({ name: "@opencode/cli", version: OPENCODE_VERSION }));
    await writeFile(path.join(platform, "package.json"), JSON.stringify({ name: packageName, version }));
    const binary = path.join(platform, "bin", process.platform === "win32" ? "opencode.exe" : "opencode");
    await writeFile(binary, content);
    return { from: path.join(root, "x.js"), packageName, binary };
  };

  it("pins a checksum for every platform package of the version", () => {
    expect(Object.keys(pinnedChecksums)).toHaveLength(12);
    expect(Object.values(pinnedChecksums).every((sum) => /^[0-9a-f]{64}$/.test(sum))).toBe(true);
  });

  it("starts a binary that matches its pin", async () => {
    const { from, packageName, binary } = await install("the genuine binary");
    const resolved = await resolveOpenCodeBinary({ from, checksums: { [packageName]: await sha256File(binary) } });
    expect(resolved).toMatchObject({ ok: true, value: { path: binary, packageName, packageVersion: OPENCODE_VERSION } });
  });

  it("F-019: refuses a binary that changed, and says so without starting it", async () => {
    const { from, packageName, binary } = await install("the genuine binary");
    const pinned = await sha256File(binary);
    await writeFile(binary, "a tampered binary");
    const resolved = await resolveOpenCodeBinary({ from, checksums: { [packageName]: pinned } });
    expect(resolved).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(!resolved.ok && resolved.error.message).toContain("does not match its pinned SHA-256");
    // The adapter won't launch it either.
    const refusing = new OpenCodeAdapter({ resolveBinary: () => resolveOpenCodeBinary({ from, checksums: { [packageName]: pinned } }) });
    expect(await refusing.prepareLaunch(input())).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("refuses a platform with no pin, and another version of the package", async () => {
    const unpinned = await install("a binary");
    expect(await resolveOpenCodeBinary({ from: unpinned.from, checksums: {} })).toMatchObject({ ok: false, error: { code: "conflict" } });
    const other = await install("a binary", "2.4.0");
    const refused = await resolveOpenCodeBinary({ from: other.from, checksums: {} });
    expect(refused).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(!refused.ok && refused.error.message).toContain("pinned to");
  });

  it("F-019: finds this machine's real binary of the pinned version and checks it against its SHA-256", async () => {
    const resolved = await resolveOpenCodeBinary();
    expect(resolved, "the installed OpenCode binary matches its pinned SHA-256").toMatchObject({ ok: true });
  });
});
