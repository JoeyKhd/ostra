import { z } from "zod";

import { httpUrlSchema, runnerLabelSchema } from "../common.ts";
import { describeIssues } from "../json.ts";

// The runner's configuration (`ostra runner`), from flags and `OSTRA_*` variables. A flag wins
// over its variable. ostra owns this format, so an unknown flag or `OSTRA_RUNNER_*` variable is
// refused. `docs/configuration.md` lists every field, quoting `description`; a test keeps the two
// in step.

/** Where each field comes from, its default as written in the docs, and what it does. */
export const runnerConfigFields = {
  serverUrl: {
    flag: "server",
    env: "OSTRA_SERVER_URL",
    default: "(required)",
    description: "The ostra server's core address, such as http://localhost:8787.",
  },
  dataDir: {
    flag: "data-dir",
    env: "OSTRA_RUNNER_DATA_DIR",
    default: "~/.ostra/runner",
    description: "The runner's folder: its key pair, its spool and the task workspaces.",
  },
  transport: {
    flag: "transport",
    env: "OSTRA_RUNNER_TRANSPORT",
    default: "websocket",
    description: "How the runner talks to the server. Milestone 1 has websocket only; auto and http come in milestone 5.",
  },
  executor: {
    flag: "executor",
    env: "OSTRA_RUNNER_EXECUTOR",
    default: "host",
    description: "Where tasks run: host (a worktree on this machine, not isolated) or docker (a box per task).",
  },
  capacity: {
    flag: "capacity",
    env: "OSTRA_RUNNER_CAPACITY",
    default: "1",
    description: "How many tasks the runner runs at once.",
  },
  labels: {
    flag: "labels",
    env: "OSTRA_RUNNER_LABELS",
    default: "(none)",
    description: "Comma-separated labels that tasks can ask for, such as gpu,macos.",
  },
  name: {
    flag: "name",
    env: "OSTRA_RUNNER_NAME",
    default: "the machine's host name",
    description: "The runner's name in the panel.",
  },
  joinToken: {
    flag: "join-token",
    env: "OSTRA_JOIN_TOKEN",
    default: "(none)",
    description: "A pool runner's join token, used once to register. A personal runner signs in with a device code instead.",
  },
  shell: {
    flag: "shell",
    env: "OSTRA_RUNNER_SHELL",
    default: "bash",
    description: "The shell the host executor runs setup scripts with, from PATH (Git Bash on Windows).",
  },
} as const;

export type RunnerConfigKey = keyof typeof runnerConfigFields;

const describe = (key: RunnerConfigKey): string => runnerConfigFields[key].description;

export const runnerConfigSchema = z.strictObject({
  serverUrl: httpUrlSchema.describe(describe("serverUrl")),
  /** Unset: the runner uses `<home>/.ostra/runner`. */
  dataDir: z.string().min(1).optional().describe(describe("dataDir")),
  transport: z.enum(["websocket"]).default("websocket").describe(describe("transport")),
  executor: z.enum(["host", "docker"]).default("host").describe(describe("executor")),
  capacity: z.coerce.number().pipe(z.number().int().positive().max(1024)).default(1).describe(describe("capacity")),
  labels: z.array(runnerLabelSchema).max(64).default([]).describe(describe("labels")),
  /** Unset: the runner uses the machine's host name. */
  name: z.string().min(1).max(128).optional().describe(describe("name")),
  joinToken: z.string().min(1).max(512).optional().describe(describe("joinToken")),
  shell: z.string().min(1).default("bash").describe(describe("shell")),
});
export type RunnerConfig = z.infer<typeof runnerConfigSchema>;

export type RunnerConfigInput = {
  /** Parsed flags by their long name, without the dashes: `{ server: "http://…" }`. */
  readonly flags: Readonly<Record<string, string | undefined>>;
  /** The process environment. */
  readonly env: Readonly<Record<string, string | undefined>>;
};

export type RunnerConfigResult =
  | { readonly ok: true; readonly config: RunnerConfig }
  | { readonly ok: false; readonly errors: readonly string[] };

const fieldKeys = Object.keys(runnerConfigFields).filter(
  (key): key is RunnerConfigKey => key in runnerConfigFields,
);
const knownFlags: ReadonlySet<string> = new Set(fieldKeys.map((key) => runnerConfigFields[key].flag));
const knownEnv: ReadonlySet<string> = new Set(fieldKeys.map((key) => runnerConfigFields[key].env));

/** Every variable name the runner reads. */
export const runnerEnvNames: readonly string[] = [...knownEnv];

/** Reads the runner's config from flags and the environment. Never throws. */
export const parseRunnerConfig = (input: RunnerConfigInput): RunnerConfigResult => {
  const errors: string[] = [];
  for (const flag of Object.keys(input.flags)) {
    if (!knownFlags.has(flag)) {
      errors.push(`unknown flag --${flag}; known: ${[...knownFlags].map((name) => `--${name}`).join(", ")}`);
    }
  }
  for (const name of Object.keys(input.env)) {
    if (name.startsWith("OSTRA_RUNNER_") && !knownEnv.has(name)) {
      errors.push(`unknown variable ${name}; known: ${runnerEnvNames.join(", ")}`);
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const raw: Record<string, unknown> = {};
  for (const key of fieldKeys) {
    const field = runnerConfigFields[key];
    const value = input.flags[field.flag] ?? input.env[field.env];
    if (value === undefined || value === "") {
      continue;
    }
    raw[key] =
      key === "labels"
        ? value
            .split(",")
            .map((label) => label.trim())
            .filter((label) => label.length > 0)
        : value;
  }
  const parsed = runnerConfigSchema.safeParse(raw);
  return parsed.success ? { ok: true, config: parsed.data } : { ok: false, errors: [describeIssues(parsed.error)] };
};
