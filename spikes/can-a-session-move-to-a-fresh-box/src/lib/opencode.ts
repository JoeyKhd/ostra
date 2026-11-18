// Copied from spike 1 (src/lib/opencode.ts), with the binary resolved per
// patch version instead of per major line, and the 1.x config builder dropped.
//
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

/**
 * The OpenCode patch versions this spike installs: 2.3.2 (the version spike 1
 * and research/rivet.md pin), and 2.3.1 and 2.3.0, the patches before it, for
 * the patch-version-change check. The older two are installed under pnpm
 * aliases.
 */
export const OPENCODE_VERSIONS = ["2.3.2", "2.3.1", "2.3.0"] as const;
export type OpenCodeVersion = (typeof OPENCODE_VERSIONS)[number];

const WRAPPER_FOR_VERSION: Readonly<Record<OpenCodeVersion, string>> = {
  "2.3.2": "@opencode/cli",
  "2.3.1": "opencode-cli-2-3-1",
  "2.3.0": "opencode-cli-2-3-0",
};

export type OpenCodeBinary = {
  readonly version: OpenCodeVersion;
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
 * running the wrapper's postinstall. Checks that the platform package carries
 * the version asked for, so an alias that resolved to the wrong one fails here.
 */
export const resolveOpenCodeBinary = async (version: OpenCodeVersion): Promise<OpenCodeBinary> => {
  const require = createRequire(import.meta.url);
  const wrapperJson = require.resolve(`${WRAPPER_FOR_VERSION[version]}/package.json`);
  const fromWrapper = createRequire(wrapperJson);
  const platformJson = fromWrapper.resolve(`@opencode/cli-${platformSuffix()}/package.json`);
  const meta = packageJson.parse(JSON.parse(await readFile(platformJson, "utf8")));
  if (meta.version !== version) throw new Error(`OpenCode ${version}: the platform package is ${meta.version}`);
  const binary = path.join(path.dirname(platformJson), "bin", process.platform === "win32" ? "opencode.exe" : "opencode");
  await access(binary);
  return { version, path: binary, packageName: meta.name, packageVersion: meta.version, sha256: await sha256File(binary) };
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
