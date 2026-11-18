// What the runner needs to launch OpenCode for one task:
//   - the pinned binary, resolved from its platform package, with its SHA-256
//   - a per-task directory: workspace, home, XDG dirs and temp, so nothing is
//     shared with the runner's user or with other tasks
//   - the provider and permission config ostra writes for the task
//   - an environment built from an allowlist, holding only the fake key

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { z } from "zod";
import type { AgentLaunch } from "./acp-driver.ts";

export type OpenCodeLine = "v2" | "v1";

export type OpenCodeBinary = {
  readonly line: OpenCodeLine;
  readonly path: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly sha256: string;
};

const packageJson = z.looseObject({ name: z.string(), version: z.string() });

const platformSuffix = (): string => {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  return `${platform}-${process.arch}`;
};

const sha256File = async (file: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return hash.digest("hex");
};

/**
 * Resolves the real OpenCode executable from its per-platform package, without
 * running the wrapper's postinstall. v2 is `@opencode/cli`; v1 is `opencode-ai`.
 */
export const resolveOpenCodeBinary = async (line: OpenCodeLine): Promise<OpenCodeBinary> => {
  const require = createRequire(import.meta.url);
  const wrapper = line === "v2" ? "@opencode/cli" : "opencode-ai";
  const platformPackage = line === "v2" ? `@opencode/cli-${platformSuffix()}` : `opencode-${platformSuffix()}`;
  const wrapperJson = require.resolve(`${wrapper}/package.json`);
  const fromWrapper = createRequire(wrapperJson);
  const platformJson = fromWrapper.resolve(`${platformPackage}/package.json`);
  const meta = packageJson.parse(JSON.parse(await readFile(platformJson, "utf8")));
  const binary = path.join(path.dirname(platformJson), "bin", process.platform === "win32" ? "opencode.exe" : "opencode");
  await access(binary);
  return { line, path: binary, packageName: meta.name, packageVersion: meta.version, sha256: await sha256File(binary) };
};

export type TaskDirs = {
  readonly root: string;
  readonly workspace: string;
  readonly home: string;
  readonly xdgData: string;
  readonly xdgConfig: string;
  readonly xdgCache: string;
  readonly xdgState: string;
  readonly tmp: string;
};

export const createTaskDirs = async (root: string): Promise<TaskDirs> => {
  const dirs: TaskDirs = {
    root,
    workspace: path.join(root, "workspace"),
    home: path.join(root, "home"),
    xdgData: path.join(root, "xdg", "data"),
    xdgConfig: path.join(root, "xdg", "config"),
    xdgCache: path.join(root, "xdg", "cache"),
    xdgState: path.join(root, "xdg", "state"),
    tmp: path.join(root, "tmp"),
  };
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
  return dirs;
};

export type ModelSpec = {
  readonly id: string;
  readonly name?: string;
  readonly context?: number;
  readonly output?: number;
  /** USD per million tokens. */
  readonly cost?: { readonly input: number; readonly output: number };
};

export type ProviderSpec =
  | {
      /** A custom provider ostra declares, under an `ostra-` prefix. */
      readonly kind: "custom";
      readonly id: string;
      readonly format: "openai" | "anthropic";
      readonly baseUrl: string;
      readonly keyEnv: string;
      readonly models: readonly ModelSpec[];
      /** OpenAI-compatible only: ask for usage in streams (`stream_options.include_usage`). Unset keeps OpenCode's default. */
      readonly streamUsage?: boolean;
    }
  | {
      /** A provider from OpenCode's bundled catalog, sent through the proxy with `settings.baseURL`. */
      readonly kind: "catalog";
      readonly id: string;
      readonly baseUrl: string;
      readonly keyEnv: string;
    };

export type PermissionRule = { readonly action: string; readonly resource: string; readonly effect: "allow" | "ask" | "deny" };

export type OpenCodeConfigInput = {
  readonly providers: readonly ProviderSpec[];
  /** `provider/model`. */
  readonly model: string;
  readonly permissions?: readonly PermissionRule[];
  readonly compactionAuto?: boolean;
  /** OpenCode experimental flags, e.g. `todo` for the todowrite tool. */
  readonly experimental?: Readonly<Record<string, boolean>>;
};

const PACKAGE_FOR_FORMAT = {
  openai: "@opencode/ai/providers/openai-compatible",
  anthropic: "@opencode/ai/providers/anthropic-compatible",
} as const;

export const buildOpenCodeConfig = (input: OpenCodeConfigInput): Record<string, unknown> => {
  const providers: Record<string, unknown> = {};
  for (const provider of input.providers) {
    switch (provider.kind) {
      case "custom": {
        const models: Record<string, unknown> = {};
        for (const model of provider.models) {
          models[model.id] = {
            name: model.name ?? model.id,
            limit: { context: model.context ?? 128_000, output: model.output ?? 16_000 },
            ...(model.cost === undefined ? {} : { cost: model.cost }),
          };
        }
        providers[provider.id] = {
          name: provider.id,
          env: [provider.keyEnv],
          package: PACKAGE_FOR_FORMAT[provider.format],
          settings: { baseURL: provider.baseUrl },
          ...(provider.streamUsage === undefined ? {} : { compatibility: { streamUsage: provider.streamUsage } }),
          models,
        };
        break;
      }
      case "catalog":
        providers[provider.id] = { env: [provider.keyEnv], settings: { baseURL: provider.baseUrl } };
        break;
      default:
        provider satisfies never;
    }
  }
  return {
    $schema: "https://opencode.ai/config.json",
    model: input.model,
    share: "disabled",
    update: "disable",
    ...(input.permissions === undefined ? {} : { permissions: input.permissions }),
    ...(input.compactionAuto === undefined ? {} : { compaction: { auto: input.compactionAuto } }),
    ...(input.experimental === undefined ? {} : { experimental: input.experimental }),
    providers,
  };
};

/**
 * The same intent in OpenCode 1.x's config format (`provider`, `npm`, `options`),
 * for the 1.19.6 control runs only. `disabled_providers` keeps 1.x off its
 * hosted free models, which it falls back to when it finds no usable provider.
 */
export const buildOpenCodeV1Config = (input: OpenCodeConfigInput): Record<string, unknown> => {
  const provider: Record<string, unknown> = {};
  for (const spec of input.providers) {
    if (spec.kind !== "custom") {
      provider[spec.id] = { options: { baseURL: spec.baseUrl, apiKey: `{env:${spec.keyEnv}}` } };
      continue;
    }
    const models: Record<string, unknown> = {};
    for (const model of spec.models) {
      models[model.id] = { name: model.name ?? model.id, limit: { context: model.context ?? 128_000, output: model.output ?? 16_000 } };
    }
    provider[spec.id] = {
      npm: spec.format === "openai" ? "@ai-sdk/openai-compatible" : "@ai-sdk/anthropic",
      name: spec.id,
      options: { baseURL: spec.baseUrl, apiKey: `{env:${spec.keyEnv}}`, ...(spec.format === "openai" ? { includeUsage: true } : {}) },
      models,
    };
  }
  return {
    $schema: "https://opencode.ai/config.json",
    model: input.model,
    share: "disabled",
    autoupdate: false,
    disabled_providers: ["opencode"],
    provider,
  };
};

/** Writes the task's config into its own XDG config dir: never into the repo, never shared. */
export const writeOpenCodeConfig = async (dirs: TaskDirs, config: Record<string, unknown>): Promise<string> => {
  const dir = path.join(dirs.xdgConfig, "opencode");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "opencode.json");
  await writeFile(file, JSON.stringify(config, null, 2));
  return file;
};

/** Runner variables the agent needs to run at all. None is a secret. */
const PASSTHROUGH = process.platform === "win32"
  ? ["PATH", "Path", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS"]
  : ["PATH", "LANG", "LC_ALL"];

export type AgentEnvInput = {
  readonly dirs: TaskDirs;
  /** Env var name → fake key. Only fake keys go here. */
  readonly fakeKeys: Readonly<Record<string, string>>;
  readonly extra?: Readonly<Record<string, string>>;
};

/** The agent's whole environment, from an allowlist. The runner's own environment is never inherited. */
export const buildAgentEnv = (input: AgentEnvInput): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const name of PASSTHROUGH) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const { dirs } = input;
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
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_FREE_MODELS: "1",
    GIT_TERMINAL_PROMPT: "0",
  });
  Object.assign(env, input.fakeKeys, input.extra ?? {});
  return env;
};

export const openCodeAcpLaunch = (binary: OpenCodeBinary, dirs: TaskDirs, env: Readonly<Record<string, string>>): AgentLaunch => ({
  command: binary.path,
  args: ["acp"],
  cwd: dirs.workspace,
  env,
});
