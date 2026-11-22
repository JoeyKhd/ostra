import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import type { EffortLevel, TaskEvent, TurnMode } from "@ostra/protocol";
import { afterAll, describe, expect, it } from "vitest";

import { ok } from "../common/result.ts";
import type { AdapterResult, HealthReport } from "../common/result.ts";
import { TinyAgent } from "../test-adapters/tiny-adapters.ts";
import { AgentAdapter } from "./base.ts";
import type { AgentLaunch, AgentSession, DriverConnection, DriverPort, MappedUpdate } from "./base.ts";
import type { AgentCapabilities } from "./capabilities.ts";
import { describeStandardPermission, pathForRules } from "./permission-subject.ts";
import { planModeAllows } from "./plan-mode.ts";
import { HIDDEN_CONFIG_SUFFIX, hideRepoAgentConfig } from "./repo-config.ts";

// Milestone 3's agent interface (ticket 02, ADR 0049): the base class reads `planMode` and never
// assumes it, the subject a request touches, plan mode's check, and hiding a repo's agent config.

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const capabilities = (planMode: AgentCapabilities["planMode"]): AgentCapabilities => ({
  steerMidTurn: false,
  sessionLoad: true,
  nativePlan: false,
  rejectAndContinue: false,
  elicitationForm: false,
  modelBaseUrlAndPlaceholderKey: true,
  sessionArchive: false,
  permissionRules: "runner-only",
  planMode,
  skills: false,
  mcp: { http: false, stdio: false },
  projectConfigOverride: false,
  memory: "index-only",
  reasoningEffort: "none",
  subagents: "none",
  promptImages: false,
  questionFreeText: false,
});

const unusedDriver: DriverPort = {
  connect: () => Promise.resolve({ ok: false, error: { code: "unavailable", message: "no agent here" } }),
  mapUpdate: () => [],
};

class ModeAgent extends AgentAdapter {
  readonly name = "mode-agent";
  readonly capabilities: AgentCapabilities;
  constructor(planMode: AgentCapabilities["planMode"]) {
    super(unusedDriver);
    this.capabilities = capabilities(planMode);
  }
  health(): Promise<HealthReport> {
    return Promise.resolve({ status: "ok" });
  }
  effortLevels(): readonly EffortLevel[] {
    return ["default"];
  }
  prepareLaunch(): Promise<AdapterResult<AgentLaunch>> {
    return Promise.resolve(ok({ command: "x", args: [], env: {}, cwd: ".", files: [] }));
  }
  protected override modeIdFor(mode: TurnMode): string {
    return mode === "plan" ? "agent-plan" : "agent-build";
  }
  protected mapUpdate(): MappedUpdate {
    return { handled: false };
  }
}

const sessionWith = (connection: Partial<DriverConnection>): AgentSession => ({
  taskId: taskIdSchema.parse("task-1"),
  sessionId: sessionIdSchema.parse("session-1"),
  agentSessionId: "agent-session-1",
  replayedUpdates: 0,
  configOptions: [],
  connection: {
    agentName: null,
    agentVersion: null,
    steeringAdvertised: false,
    imagesAdvertised: false,
    newSession: () => Promise.resolve(ok({ agentSessionId: "x", configOptions: [] })),
    loadSession: () => Promise.resolve(ok({ configOptions: [] })),
    prompt: () => Promise.resolve(ok({ stopReason: "end_turn" as const })),
    cancel: () => Promise.resolve(),
    steer: () => Promise.resolve(ok(undefined)),
    close: () => Promise.resolve(),
    ...connection,
  },
});

describe("setMode reads planMode", () => {
  it("F-063: an agent without a plan mode refuses, and its driver is never asked", async () => {
    const asked: string[] = [];
    const session = sessionWith({
      setMode: (_id, modeId) => {
        asked.push(modeId);
        return Promise.resolve(ok<readonly TaskEvent[]>([]));
      },
    });
    expect(await new TinyAgent(unusedDriver).setMode(session, "plan")).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(await new ModeAgent("none").setMode(session, "plan")).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(asked).toEqual([]);
  });

  it("F-063: a session-mode agent switches in place, with its own mode ID", async () => {
    const asked: string[] = [];
    const session = sessionWith({
      setMode: (_id, modeId) => {
        asked.push(modeId);
        return Promise.resolve(ok<readonly TaskEvent[]>([{ kind: "session.config_changed", key: "mode", value: modeId }]));
      },
    });
    const switched = await new ModeAgent("session-mode").setMode(session, "plan");
    expect(switched).toEqual({ ok: true, value: session });
    expect(asked).toEqual(["agent-plan"]);
  });

  it("F-063: a session-mode agent whose driver can't set a mode refuses, never pretending it switched", async () => {
    expect(await new ModeAgent("session-mode").setMode(sessionWith({}), "build")).toMatchObject({ ok: false, error: { code: "unsupported" } });
  });

  it("F-063: a relaunch agent needs the runner's relaunch, and never switches in place", async () => {
    const asked: string[] = [];
    const session = sessionWith({
      setMode: (_id, modeId) => {
        asked.push(modeId);
        return Promise.resolve(ok<readonly TaskEvent[]>([]));
      },
    });
    // No session was started with a relaunch: there's nothing to restart the agent with.
    expect(await new ModeAgent("relaunch").setMode(session, "build")).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(asked).toEqual([]);
  });
});

describe("what a request touches", () => {
  const cwd = path.resolve("/work/task");

  it.each([
    [{ toolKind: "edit", locations: ["web/package.json"] }, { tool: "edit", subject: { kind: "path", value: "web/package.json" } }],
    [{ toolKind: "edit", rawInput: { filePath: path.join(cwd, "src", "a.ts") } }, { tool: "edit", subject: { kind: "path", value: "src/a.ts" } }],
    [{ toolKind: "delete", rawInput: { path: "old.txt" } }, { tool: "edit", subject: { kind: "path", value: "old.txt" } }],
    [{ toolKind: "execute", rawInput: { command: "pnpm add zod" } }, { tool: "execute", subject: { kind: "command", value: "pnpm add zod" } }],
    [{ toolKind: "execute", rawInput: { command: ["pnpm", "add", "zod"] } }, { tool: "execute", subject: { kind: "command", value: "pnpm add zod" } }],
    [{ toolKind: "fetch", rawInput: { url: "https://registry.npmjs.org/zod" } }, { tool: "fetch", subject: { kind: "url", value: "https://registry.npmjs.org/zod" } }],
    [{ toolKind: "read", locations: ["a.ts"] }, null],
    [{ toolKind: "execute", rawInput: {} }, null],
    [{ toolKind: "edit" }, null],
    [{}, null],
  ] as const)("F-026: %j touches %j", (facts, expected) => {
    expect(describeStandardPermission(facts, cwd)).toEqual(expected);
  });

  it("F-026: a path outside the session's folder stays absolute, so every glob covers it", () => {
    const outside = path.resolve("/etc/passwd");
    expect(pathForRules(outside, cwd)).toBe(outside);
    expect(pathForRules("a\\b.ts", cwd)).toBe("a/b.ts");
  });
});

describe("plan mode's check", () => {
  const context = { mcpServers: [{ name: "docs", readOnly: true }, { name: "files", readOnly: false }] };

  it.each([
    [{ subject: null, toolKind: "read" }, true],
    [{ subject: null, toolKind: "search" }, true],
    [{ subject: null, toolKind: "other" }, false],
    [{ subject: null }, false],
    [{ subject: { tool: "edit", subject: { kind: "path", value: "a.ts" } } }, false],
    [{ subject: { tool: "fetch", subject: { kind: "url", value: "https://x" } } }, false],
    [{ subject: { tool: "execute", subject: { kind: "command", value: "git status" } } }, true],
    [{ subject: { tool: "execute", subject: { kind: "command", value: "ls -la && git diff" } } }, true],
    [{ subject: { tool: "execute", subject: { kind: "command", value: "git status && rm -rf x" } } }, false],
    [{ subject: { tool: "execute", subject: { kind: "command", value: "pnpm install" } } }, false],
    [{ subject: { tool: "mcp", subject: { kind: "tool", value: "docs/search" } } }, true],
    [{ subject: { tool: "mcp", subject: { kind: "tool", value: "files/write" } } }, false],
    [{ subject: { tool: "mcp", subject: { kind: "tool", value: "unknown/x" } } }, false],
  ] as const)("F-063: %j is allowed: %s", (request, expected) => {
    expect(planModeAllows(request, context)).toBe(expected);
  });
});

describe("hiding a repo's agent config", () => {
  it("F-021: moves each config file aside in every repo, and puts it back", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ostra-repo-config-"));
    roots.push(root);
    const repoA = path.join(root, "a");
    const repoB = path.join(root, "b");
    await mkdir(path.join(repoA, ".opencode"), { recursive: true });
    await mkdir(repoB, { recursive: true });
    await writeFile(path.join(repoA, "opencode.json"), '{"permission":"allow"}');
    await writeFile(path.join(repoA, ".opencode", "agent.md"), "x");
    await writeFile(path.join(repoB, "README.md"), "kept");
    const hidden = await hideRepoAgentConfig([repoA, repoB], ["opencode.json", ".opencode", "opencode.jsonc"]);
    if (!hidden.ok) throw new Error(hidden.error.message);
    expect(hidden.value.hidden.map((file) => path.relative(root, file)).sort()).toEqual([path.join("a", ".opencode"), path.join("a", "opencode.json")]);
    await expect(readFile(path.join(repoA, "opencode.json"), "utf8")).rejects.toThrow();
    expect(await readFile(path.join(repoA, `opencode.json${HIDDEN_CONFIG_SUFFIX}`), "utf8")).toBe('{"permission":"allow"}');
    expect(await readFile(path.join(repoB, "README.md"), "utf8")).toBe("kept");
    expect((await hidden.value.restore()).ok).toBe(true);
    expect(await readFile(path.join(repoA, "opencode.json"), "utf8")).toBe('{"permission":"allow"}');
    expect(await readFile(path.join(repoA, ".opencode", "agent.md"), "utf8")).toBe("x");
    // Restoring twice is harmless.
    expect((await hidden.value.restore()).ok).toBe(true);
  });

  it("F-021: refuses a config path that leaves the repo, and reports an agent's own file where the repo's was", async () => {
    expect(await hideRepoAgentConfig(["/x"], ["../outside.json"])).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    const root = await mkdtemp(path.join(tmpdir(), "ostra-repo-config-"));
    roots.push(root);
    await writeFile(path.join(root, "opencode.json"), "repo's");
    const hidden = await hideRepoAgentConfig([root], ["opencode.json"]);
    if (!hidden.ok) throw new Error(hidden.error.message);
    await writeFile(path.join(root, "opencode.json"), "agent's");
    expect(await hidden.value.restore()).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});
