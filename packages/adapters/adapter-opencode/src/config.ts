import path from "node:path";

import { composeLaunchInstructions, GIT_GUARD_ENV_NAMES } from "@ostra/adapter-sdk";
import type { LaunchFile, LaunchMcpServer, PrepareLaunchInput } from "@ostra/adapter-sdk";

import { agentForMode, buildPermissions, OSTRA_MCP_SERVER, planModePermissions } from "./permissions.ts";
import type { OpenCodePermission } from "./permissions.ts";

export { permissionRules } from "./permissions.ts";

// What ostra writes for OpenCode, per task (ADR 0032, spec section 11 item 6). Ported from
// spikes/how-should-the-runner-drive-opencode/src/lib/opencode.ts (`buildOpenCodeConfig`,
// `buildAgentEnv`). The config is OpenCode's V2 format (`providers`, `permissions`, `mcp.servers`),
// checked against `https://opencode.ai/config.json`.
//
// The agent's model endpoint is the key proxy, and the key is the task's fake one: the real token
// never reaches this file (ADR 0030). Nothing here comes from the runner's own environment except
// the few variables the agent needs to run at all.

/** The environment variable that holds the fake key. The provider's config names it. */
export const KEY_ENV = "OSTRA_MODEL_API_KEY";
const PROVIDER_ID = "ostra";

/** OpenCode's SDK packages, by API format (ADR 0033). */
const PACKAGE_BY_FORMAT = {
  "openai-compatible": "@opencode/ai/providers/openai-compatible",
  "anthropic-messages": "@opencode/ai/providers/anthropic-compatible",
} as const;

/** The same formats as models.dev names them, for the catalog file. */
const CATALOG_NPM_BY_FORMAT = {
  "openai-compatible": "@ai-sdk/openai-compatible",
  "anthropic-messages": "@ai-sdk/anthropic",
} as const;

const DEFAULT_CONTEXT = 128_000;
const DEFAULT_OUTPUT = 16_000;

/** The task's folders under its agent directory: nothing shared with the runner's user or another task. */
export const taskDirs = (agentDir: string) => ({
  home: path.join(agentDir, "home"),
  xdgData: path.join(agentDir, "xdg", "data"),
  xdgConfig: path.join(agentDir, "xdg", "config"),
  xdgCache: path.join(agentDir, "xdg", "cache"),
  xdgState: path.join(agentDir, "xdg", "state"),
  tmp: path.join(agentDir, "tmp"),
  config: path.join(agentDir, "xdg", "config", "opencode", "opencode.json"),
  catalog: path.join(agentDir, "models.json"),
  instructions: path.join(agentDir, "instructions.md"),
});
export type TaskDirs = ReturnType<typeof taskDirs>;

/** An MCP server of the profile as OpenCode's config names it (ADR 0049, Q170). */
const mcpServerConfig = (server: LaunchMcpServer): Record<string, unknown> =>
  server.transport === "http"
    ? // At the sidecar's MCP proxy, which adds the server's secret: the address holds none, and no header goes with it.
      { type: "remote", url: server.url, codemode: false }
    : // A command in the image, with the server's variables, none of them a secret.
      { type: "local", command: [server.command, ...server.args], environment: { ...server.env }, codemode: false };

/** A folder with `/` between its parts and none at its end: OpenCode reads it so on every platform. */
const slashed = (dir: string): string => dir.replaceAll("\\", "/").replace(/\/+$/, "");

/**
 * The repo's own instructions, which OpenCode reads from the project when its project config is
 * on. With it off (`OPENCODE_DISABLE_PROJECT_CONFIG`, so the profile's permissions and MCP servers
 * win, ADR 0049), they're named here instead: the `AGENTS.md` at the workspace's root and at each
 * repo's (F-021: "added beside the repo's own `AGENTS.md`, never replacing it").
 */
export const repoInstructionGlobs = (workspaceDir: string): readonly string[] => {
  const root = slashed(workspaceDir);
  return [`${root}/AGENTS.md`, `${root}/*/AGENTS.md`];
};

/**
 * The repos' own skill folders, which OpenCode reads from the project only when its project config
 * is on. With it off they're named here, at the workspace's root and in each repo's checkout,
 * because a wildcard in `skills` finds nothing (checked on 2.3.2), and a folder that isn't there is
 * passed over. So the profile's skills sit beside the repo's, never replacing them (F-021).
 */
export const repoSkillDirs = (workspaceDir: string, repoDirs: readonly string[]): readonly string[] => {
  const root = slashed(workspaceDir);
  return [root, ...repoDirs.map((dir) => `${root}/${dir}`)].map((dir) => `${dir}/.opencode/skills`);
};

/** One of OpenCode's permission rules (the name ticket 30 gave it). */
export type OpenCodePermissionRule = OpenCodePermission;

/**
 * The task's permissions (F-026): the profile's rules written into OpenCode's own as `ask`, after
 * everything allowed and before `external_directory` denied (`buildPermissions`). A plan turn adds
 * no ask here: it runs as OpenCode's plan agent, whose own denies make it read-only (F-063).
 */
export const taskPermissionRules = (input: PrepareLaunchInput): readonly OpenCodePermissionRule[] =>
  buildPermissions({ approvalRules: input.approvalRules ?? [], mcpServers: input.mcpServers ?? [] });

export const buildOpenCodeConfig = (input: PrepareLaunchInput, instructionsPath: string | null): Record<string, unknown> => {
  const { model } = input;
  const providerModel = {
    name: model.endpointModelId,
    limit: { context: DEFAULT_CONTEXT, output: DEFAULT_OUTPUT },
  };
  const mcpServers = input.mcpServers ?? [];
  const skills = input.skills ?? [];
  return {
    $schema: "https://opencode.ai/config.json",
    model: `${PROVIDER_ID}/${model.endpointModelId}`,
    // Nothing leaves the box on OpenCode's own account.
    share: "disabled",
    update: "disable",
    // The profile's rules as OpenCode's own permissions, never its defaults (ADR 0031, ADR 0049).
    permissions: taskPermissionRules(input),
    // Plan first runs as OpenCode's plan agent, made read-only by the denies it adds (F-063).
    agents: { [agentForMode("plan")]: { permissions: planModePermissions(mcpServers) } },
    default_agent: agentForMode(input.mode ?? "build"),
    // The profile's skills, from the folders the runner wrote them to in the task's agent folder,
    // then the repos' own, which the project config being off would otherwise drop.
    skills: [...skills.map((skill) => skill.dir), ...repoSkillDirs(input.workspaceDir, input.repoDirs ?? [])],
    experimental: { todo: true },
    providers: {
      [PROVIDER_ID]: {
        name: "ostra",
        env: [KEY_ENV],
        package: PACKAGE_BY_FORMAT[model.apiFormat],
        settings: { baseURL: model.baseUrl },
        // Ask an OpenAI-compatible endpoint for usage in its stream, so the key proxy counts without estimating.
        ...(model.apiFormat === "openai-compatible" ? { compatibility: { streamUsage: true } } : {}),
        models: { [model.endpointModelId]: providerModel },
      },
    },
    // The task's instructions file first (the profile's, the repos side by side, then the memory
    // block, F-110), then the repos' own AGENTS.md: OpenCode puts them in its prompt in this order.
    instructions: [...(instructionsPath === null ? [] : [instructionsPath]), ...repoInstructionGlobs(input.workspaceDir)],
    mcp: {
      servers: {
        // The profile's servers, beside ostra's own.
        ...Object.fromEntries(mcpServers.map((server) => [server.name, mcpServerConfig(server)])),
        // ostra's tools for the task: the PR's title and body (ticket 20), and with milestone 4 the
        // memory tools, `memory_search`, `memory_read` and `memory_propose` (F-110), on the same
        // server. A profile can't name a server `ostra` (`checkProfileInputs`), so this one is always ostra's.
        [OSTRA_MCP_SERVER]: {
          type: "remote",
          url: input.mcp.url,
          // Each tool listed to the model by its name (`ostra_memory_search`), as the profile's are:
          // with OpenCode's code mode on, they'd sit behind its one `execute` tool (checked on 2.3.2).
          codemode: false,
          ...(input.mcp.bearer === undefined ? {} : { headers: { authorization: `Bearer ${input.mcp.bearer}` } }),
        },
      },
    },
  };
};

/**
 * The model catalog as a file, in models.dev's shape, which OpenCode reads from `OPENCODE_MODELS_PATH`
 * so the agent never fetches it (ADR 0033: "the agent never fetches the catalog").
 */
export const buildModelsCatalog = (input: PrepareLaunchInput): Record<string, unknown> => ({
  [PROVIDER_ID]: {
    id: PROVIDER_ID,
    name: "ostra",
    env: [KEY_ENV],
    npm: CATALOG_NPM_BY_FORMAT[input.model.apiFormat],
    models: {
      [input.model.endpointModelId]: {
        id: input.model.endpointModelId,
        name: input.model.endpointModelId,
        tool_call: true,
        limit: { context: DEFAULT_CONTEXT, output: DEFAULT_OUTPUT },
      },
    },
  },
});

/** Variables the agent needs to run at all, passed from the runner's own. None is a secret. */
const PASSTHROUGH =
  process.platform === "win32"
    ? ["PATH", "Path", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS"]
    : ["PATH", "LANG", "LC_ALL"];

/** The names the agent's environment may hold (the agent contract suite checks it). */
export const allowedEnvNames: readonly string[] = [
  ...PASSTHROUGH,
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "TMP",
  "TEMP",
  "TMPDIR",
  "OPENCODE_MODELS_PATH",
  "OPENCODE_DISABLE_MODELS_FETCH",
  "OPENCODE_DISABLE_AUTOUPDATE",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_FREE_MODELS",
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  // The git guard (`gitGuardEnv`): the task-run overlays it on the launch, and no one else sets it.
  ...GIT_GUARD_ENV_NAMES,
  KEY_ENV,
  // The task's containment marker (ticket 42): the host executor overlays it on the launch, so the
  // runner can find every process of the task by it. Not a secret.
  "OSTRA_TASK_UNIT",
];

/** The hosts OpenCode adds to NO_PROXY at startup, when the launch passes none of its own. */
const OPENCODE_LOOPBACK_NO_PROXY = "127.0.0.1,localhost,::1";

/**
 * What OpenCode sets in its own environment once it runs, with the value it sets: ostra never
 * passes these. OpenCode 2.3.2's `acp` command sets `OPENCODE_CLIENT=acp`, and its entry point
 * merges the loopback hosts into `NO_PROXY` and `no_proxy`. Anything that reads the live agent's
 * environment (not the launch) sees them. Windows keeps one of the two NO_PROXY spellings.
 */
export const selfSetEnv: Readonly<Record<string, string>> = {
  OPENCODE_CLIENT: "acp",
  NO_PROXY: OPENCODE_LOOPBACK_NO_PROXY,
  no_proxy: OPENCODE_LOOPBACK_NO_PROXY,
};

const isGitGuardName = (name: string): boolean => GIT_GUARD_ENV_NAMES.some((guarded) => guarded === name);

/** Git never asks the agent's terminal for a credential. The rest of the git guard comes from the task run. */
const GIT_TERMINAL_PROMPT_OFF = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" } as const;

/**
 * The environment of an OpenCode process in the task's own folders: an allowlist, and no credential
 * of any kind. The agent's launch adds the fake key to it; the session export and import commands,
 * which call no model, run with it as it is.
 */
export const buildCliEnv = (dirs: TaskDirs): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const name of PASSTHROUGH) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  Object.assign(env, {
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    APPDATA: path.join(dirs.home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(dirs.home, "AppData", "Local"),
    XDG_DATA_HOME: dirs.xdgData,
    XDG_CONFIG_HOME: dirs.xdgConfig,
    XDG_CACHE_HOME: dirs.xdgCache,
    XDG_STATE_HOME: dirs.xdgState,
    TMP: dirs.tmp,
    TEMP: dirs.tmp,
    TMPDIR: dirs.tmp,
    OPENCODE_MODELS_PATH: dirs.catalog,
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_FREE_MODELS: "1",
    // A repo's own `opencode.json` and `.opencode/` are never read: its permissions, MCP servers,
    // agents and plugins can't widen the profile's (ADR 0049, Q171). Checked on 2.3.2: without
    // this, a repo config that allows everything wins, and even with the profile's config given as
    // content, a repo's MCP server is added (the README). The repo's AGENTS.md is named in the config.
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  });
  return env;
};

/** The agent's whole environment, from an allowlist: the runner's own is never inherited. */
export const buildAgentEnv = (input: PrepareLaunchInput, dirs: TaskDirs): Record<string, string> => {
  const env = buildCliEnv(dirs);
  env[KEY_ENV] = input.model.placeholderKey;
  // The environment's own variables, which are not secrets (secrets go to each repo's checkout only).
  // They never override the git guard: git reads the task's config and nothing of the machine's.
  for (const [name, value] of Object.entries(input.extraEnv)) {
    if (!isGitGuardName(name)) {
      env[name] = value;
    }
  }
  Object.assign(env, GIT_TERMINAL_PROMPT_OFF);
  return env;
};

/** Every file ostra writes before OpenCode starts. The folders they sit in are made with them. */
export const launchFiles = (input: PrepareLaunchInput, dirs: TaskDirs): readonly LaunchFile[] => {
  const instructions = instructionsText(input);
  const files: LaunchFile[] = [
    { path: dirs.config, content: `${JSON.stringify(buildOpenCodeConfig(input, instructions === null ? null : dirs.instructions), null, 2)}\n` },
    { path: dirs.catalog, content: `${JSON.stringify(buildModelsCatalog(input))}\n` },
    // Empty marker files, so the folders the agent expects exist when it starts.
    { path: path.join(dirs.home, ".ostra-keep"), content: "" },
    { path: path.join(dirs.tmp, ".ostra-keep"), content: "" },
  ];
  if (instructions !== null) {
    files.push({ path: dirs.instructions, content: instructions });
  }
  return files;
};

/**
 * The task's instructions file, in the task's config folder and never in a repo: the profile's
 * instructions with the IDs of its skills after them, then (milestone 4) the repos side by side and
 * the memory block, which comes after the profile's instructions and before the repos' own
 * `AGENTS.md` (`buildOpenCodeConfig` names this file first). OpenCode lists a skill to the model
 * only when its `SKILL.md` starts with a `description` (checked on 2.3.2), and a profile's skill
 * may have none: named here, every one of them can be loaded with the `skill` tool.
 */
export const instructionsText = (input: PrepareLaunchInput): string | null => {
  const skills = input.skills ?? [];
  const index = skills.length === 0 ? null : `${SKILLS_HEADING}: ${skills.map((skill) => `\`${skill.name}\``).join(", ")}.\n`;
  const profile = index === null ? input.instructions : input.instructions === null ? index : `${input.instructions.replace(/\n*$/, "")}\n\n${index}`;
  // Milestone 4: with several repos or a memory block, the base class's one text (F-098, F-110).
  const more = (input.repoDirs ?? []).length > 1 || (input.memory?.block ?? "").trim() !== "";
  return more ? composeLaunchInstructions({ ...input, instructions: profile }) : profile;
};

/** The line that names the profile's skills in the instructions. */
export const SKILLS_HEADING = "Skills this task's profile adds (load one with the `skill` tool, by its ID)";
