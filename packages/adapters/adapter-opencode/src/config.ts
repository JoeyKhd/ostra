import path from "node:path";

import { GIT_GUARD_ENV_NAMES } from "@ostra/adapter-sdk";
import type { LaunchFile, PrepareLaunchInput } from "@ostra/adapter-sdk";

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

/**
 * Edit and shell inside the worktree are allowed, and `external_directory` is denied: with no
 * approval rules until F-026, the agent's reach ends at its task's workspace (AGENTS.md). Rules
 * are ordered, and the last that matches wins.
 */
export const permissionRules = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "deny" },
] as const;

export const buildOpenCodeConfig = (input: PrepareLaunchInput, instructionsPath: string | null): Record<string, unknown> => {
  const { model } = input;
  const providerModel = {
    name: model.endpointModelId,
    limit: { context: DEFAULT_CONTEXT, output: DEFAULT_OUTPUT },
  };
  return {
    $schema: "https://opencode.ai/config.json",
    model: `${PROVIDER_ID}/${model.endpointModelId}`,
    // Nothing leaves the box on OpenCode's own account.
    share: "disabled",
    update: "disable",
    permissions: permissionRules,
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
    ...(instructionsPath === null ? {} : { instructions: [instructionsPath] }),
    // ostra's tools for the task: the PR's title and body are written through them (ticket 20).
    mcp: {
      servers: {
        ostra: {
          type: "remote",
          url: input.mcp.url,
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
  // The git guard (`gitGuardEnv`): the task-run overlays it on the launch, and no one else sets it.
  ...GIT_GUARD_ENV_NAMES,
  KEY_ENV,
];

const isGitGuardName = (name: string): boolean => GIT_GUARD_ENV_NAMES.some((guarded) => guarded === name);

/** Git never asks the agent's terminal for a credential. The rest of the git guard comes from the task run. */
const GIT_TERMINAL_PROMPT_OFF = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" } as const;

/** The agent's whole environment, from an allowlist: the runner's own is never inherited. */
export const buildAgentEnv = (input: PrepareLaunchInput, dirs: TaskDirs): Record<string, string> => {
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
    [KEY_ENV]: input.model.placeholderKey,
  });
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
  const files: LaunchFile[] = [
    { path: dirs.config, content: `${JSON.stringify(buildOpenCodeConfig(input, input.instructions === null ? null : dirs.instructions), null, 2)}\n` },
    { path: dirs.catalog, content: `${JSON.stringify(buildModelsCatalog(input))}\n` },
    // Empty marker files, so the folders the agent expects exist when it starts.
    { path: path.join(dirs.home, ".ostra-keep"), content: "" },
    { path: path.join(dirs.tmp, ".ostra-keep"), content: "" },
  ];
  if (input.instructions !== null) {
    files.push({ path: dirs.instructions, content: input.instructions });
  }
  return files;
};
