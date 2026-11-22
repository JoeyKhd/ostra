import { z } from "zod";

import { httpUrlSchema, runnerLabelSchema } from "../common.ts";
import { describeIssues } from "../json.ts";
import { NPM_REGISTRY } from "../release.ts";

// The runner's configuration (`ostra runner`), from flags and `OSTRA_*` variables. A flag wins
// over its variable. ostra owns this format, so an unknown flag or `OSTRA_RUNNER_*` variable is
// refused. `docs/configuration.md` lists every field, quoting `description`; a test keeps the two
// in step.

/**
 * F-017 (ADR 0029, Q154): the pool a `docker` runner carves its boxes' networks from, a /24 each:
 * spike 3's range, clear of Docker's own default pools (172.17.0.0/16 to 172.31.0.0/16, 192.168.0.0/16).
 */
export const DEFAULT_BOX_SUBNET_POOL = "10.89.0.0/16";

/** Each `docker` box's network: one /24 of the pool, room for the gateway, the agent, the sidecar and the services. */
export const BOX_SUBNET_PREFIX = 24;

/** An IPv4 address as a number, or `null`. */
const ipv4ToNumber = (address: string): number | null => {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
    return null;
  }
  return parts.reduce((sum, part) => sum * 256 + Number(part), 0);
};

/** A box subnet pool: its first address, as a number, and how many /24s it holds. */
export type BoxSubnetPool = { readonly first: number; readonly size: number };

/**
 * A box subnet pool as its first address and its number of /24s, or `null` when it isn't an IPv4
 * network of /8 to /24 written as its own address (no host bits set). The one rule: the setting's
 * schema below refuses what this refuses, and the `docker` executor carves the boxes' /24s from it.
 */
export const parseBoxSubnetPool = (pool: string): BoxSubnetPool | null => {
  const [address = "", bits = "", ...rest] = pool.split("/");
  const first = ipv4ToNumber(address);
  const prefix = /^\d{1,2}$/.test(bits) ? Number(bits) : NaN;
  if (rest.length > 0 || first === null || !Number.isInteger(prefix) || prefix < 8 || prefix > BOX_SUBNET_PREFIX) {
    return null;
  }
  const span = 2 ** (32 - prefix);
  return first % span === 0 ? { first, size: span / 2 ** (32 - BOX_SUBNET_PREFIX) } : null;
};

/** An IPv4 network of /8 to /24, written as its own address (no host bits set), such as `10.89.0.0/16`. */
const ipv4PoolSchema = z
  .string()
  .refine((pool) => parseBoxSubnetPool(pool) !== null, { message: "an IPv4 network of /8 to /24, written as its own address (such as 10.89.0.0/16)" });

/** Every field's key. `runnerConfigFields` must hold exactly these: the compiler refuses a missing or an extra one. */
export const runnerConfigKeys = [
  "serverUrl",
  "dataDir",
  "transport",
  "executor",
  "capacity",
  "labels",
  "name",
  "joinToken",
  "shell",
  "joinTokenFile",
  "boxBaseImage",
  "boxRunnerImage",
  "boxServerUrl",
  // F-017 (ADR 0029, Q154): the docker executor's own subnets.
  "boxSubnetPool",
  // Milestone 5 (spec section 5.4).
  "slots",
  "reserveCpuMillis",
  "reserveMemoryMiB",
  "wsRetryMinutes",
  "pin",
  "npmRegistry",
  "hostPoolAgentUser",
  "k8sNamespace",
  "k8sBuildNamespace",
  "k8sNodeWaitMinutes",
  "k8sRuntimeClass",
  "egressAllow",
  "sidecarCpuMillis",
  "sidecarMemoryMiB",
  "serviceCpuMillis",
  "serviceMemoryMiB",
  // Subagents (2026-11-20).
  "subagentWaitMinutes",
  // Milestone 8 (spec section 5.4, ADR 0068): the box's browser on `host`.
  "browser",
  "browserDownload",
] as const;

export type RunnerConfigKey = (typeof runnerConfigKeys)[number];

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
    default: "auto",
    description:
      "How the runner talks to the server: auto (a WebSocket, falling back to HTTP by itself when a proxy blocks it), websocket or http. Both go through HTTPS_PROXY, HTTP_PROXY and NO_PROXY, and trust NODE_EXTRA_CA_CERTS.",
  },
  executor: {
    flag: "executor",
    env: "OSTRA_RUNNER_EXECUTOR",
    default: "host",
    description: "Where tasks run: host (a worktree on this machine, not isolated), docker (a box per task) or kubernetes (a pod per task, from a pool runner in the cluster).",
  },
  capacity: {
    flag: "capacity",
    env: "OSTRA_RUNNER_CAPACITY",
    default: "(none: the slots' default)",
    description: "How many tasks a host runner runs at once: the older name of OSTRA_RUNNER_SLOTS, which wins.",
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
    description: "The shell the host executor runs setup scripts with. On Linux and macOS, bash from PATH. On Windows, the bare name bash means Git for Windows' own bin\\bash.exe, found from the git on PATH, never WSL's System32\\bash.exe; without Git for Windows, set it to a shell's full path. A full path is used as given.",
  },
  joinTokenFile: {
    flag: "join-token-file",
    env: "OSTRA_JOIN_TOKEN_FILE",
    default: "(none)",
    description: "A file holding a pool runner's join token, such as the bootstrap token core writes at first start. --join-token wins.",
  },
  boxBaseImage: {
    flag: "box-base-image",
    env: "OSTRA_BOX_BASE_IMAGE",
    default: "<the release's image namespace>/base:<the runner's version>",
    description: "The docker executor's base image, for an environment that names none.",
  },
  boxRunnerImage: {
    flag: "box-runner-image",
    env: "OSTRA_BOX_RUNNER_IMAGE",
    default: "<the release's image namespace>/runner:<the runner's version>",
    description: "The image each docker box's sidecar runs: the ostra CLI.",
  },
  boxServerUrl: {
    flag: "box-server-url",
    env: "OSTRA_BOX_SERVER_URL",
    default: "the --server address",
    description: "Core's address as a docker box's sidecar reaches it, when that differs from --server.",
  },
  boxSubnetPool: {
    flag: "box-subnet-pool",
    env: "OSTRA_BOX_SUBNET_POOL",
    default: DEFAULT_BOX_SUBNET_POOL,
    description: "The IPv4 network, /8 to /24, the docker executor carves each box's own network out of, a /24 per box, so Docker's default address pools never run out. Keep it clear of your own networks.",
  },
  slots: {
    flag: "slots",
    env: "OSTRA_RUNNER_SLOTS",
    default: "docker: the host's CPUs / 2; kubernetes: 20; host: 2",
    description: "How many tasks or boxes the runner holds at once (ADR 0059). The server may hold a personal runner to fewer (its member's setting, 2 by default).",
  },
  reserveCpuMillis: {
    flag: "reserve-cpu-millis",
    env: "OSTRA_RUNNER_RESERVE_CPU_MILLIS",
    default: "1000",
    description: "The CPU, in millicores, a docker runner keeps for the host and itself: it offers the engine's CPU less this.",
  },
  reserveMemoryMiB: {
    flag: "reserve-memory-mib",
    env: "OSTRA_RUNNER_RESERVE_MEMORY_MIB",
    default: "2048",
    description: "The memory, in MiB, a docker runner keeps for the host and itself: it offers the engine's memory less this.",
  },
  wsRetryMinutes: {
    flag: "ws-retry-minutes",
    env: "OSTRA_RUNNER_WS_RETRY_MINUTES",
    default: "10",
    description: "After falling back to HTTP, how often the runner tries the WebSocket again.",
  },
  pin: {
    flag: "pin",
    env: "OSTRA_RUNNER_PIN",
    default: "true",
    description: "Whether a runner installed from npm installs its server's version at start (ADR 0034). false keeps the installed one, inside the version window.",
  },
  npmRegistry: {
    flag: "npm-registry",
    env: "OSTRA_RUNNER_NPM_REGISTRY",
    default: NPM_REGISTRY,
    description: "The npm registry the pin installs the ostra CLI from, such as a company mirror.",
  },
  hostPoolAgentUser: {
    flag: "host-pool-agent-user",
    env: "OSTRA_HOST_POOL_AGENT_USER",
    default: "(none: a host pool runner refuses to start without it)",
    description: "The OS user a host pool runner runs the agent as, separate from the runner's own (Linux and macOS).",
  },
  k8sNamespace: {
    flag: "k8s-namespace",
    env: "OSTRA_K8S_NAMESPACE",
    default: "the service account's namespace",
    description: "The namespace a kubernetes runner makes its boxes' pods in. The cluster must run Kubernetes 1.29 or later, for native sidecars.",
  },
  k8sBuildNamespace: {
    flag: "k8s-build-namespace",
    env: "OSTRA_K8S_BUILD_NAMESPACE",
    default: "<namespace>-builds",
    description: "The namespace a kubernetes runner builds snapshots in, with BuildKit.",
  },
  k8sNodeWaitMinutes: {
    flag: "k8s-node-wait-minutes",
    env: "OSTRA_K8S_NODE_WAIT_MINUTES",
    default: "15",
    description: "How long a kubernetes box waits for a node before it fails and its task is queued again.",
  },
  k8sRuntimeClass: {
    flag: "k8s-runtime-class",
    env: "OSTRA_K8S_RUNTIME_CLASS",
    default: "(none)",
    description: "The RuntimeClass a kubernetes box's pod runs with, such as gvisor.",
  },
  egressAllow: {
    flag: "egress-allow",
    env: "OSTRA_EGRESS_ALLOW",
    default: "the server's address only",
    description: "Comma-separated addresses a docker or kubernetes box may reach in private ranges, besides the server's (F-116).",
  },
  sidecarCpuMillis: {
    flag: "sidecar-cpu-millis",
    env: "OSTRA_SIDECAR_CPU_MILLIS",
    default: "1000",
    description: "The CPU limit, in millicores, of a box's sidecar, counted in the box's footprint.",
  },
  sidecarMemoryMiB: {
    flag: "sidecar-memory-mib",
    env: "OSTRA_SIDECAR_MEMORY_MIB",
    default: "256",
    description: "The memory limit, in MiB, of a box's sidecar, counted in the box's footprint.",
  },
  serviceCpuMillis: {
    flag: "service-cpu-millis",
    env: "OSTRA_SERVICE_CPU_MILLIS",
    default: "1000",
    description: "The CPU limit, in millicores, of a service that names none, counted in the box's footprint.",
  },
  serviceMemoryMiB: {
    flag: "service-memory-mib",
    env: "OSTRA_SERVICE_MEMORY_MIB",
    default: "1024",
    description: "The memory limit, in MiB, of a service that names none, counted in the box's footprint.",
  },
  subagentWaitMinutes: {
    flag: "subagent-wait-minutes",
    env: "OSTRA_RUNNER_SUBAGENT_WAIT_MINUTES",
    default: "30",
    description:
      "How long a turn waits, once its agent's prompt is answered, for the subagents it started and the turns their reports wake (OpenCode runs subagents in the background). Past it, ostra stops them, fails each one on the call that started it, and ends the turn.",
  },
  browser: {
    flag: "browser",
    env: "OSTRA_RUNNER_BROWSER",
    default: "(none: the runner finds Chrome, Chromium or Edge, else downloads its pinned headless shell)",
    description:
      "The Chromium-family browser a host runner takes screenshots, recordings and the browser view with (F-121, F-141): its executable's path. Unset, the runner finds Chrome, Chromium or Edge, else downloads Chrome for Testing's headless shell at the version pinned in its release, checks its SHA-256 and keeps it in its folder. docker and kubernetes boxes use the image's.",
  },
  browserDownload: {
    flag: "browser-download",
    env: "OSTRA_RUNNER_BROWSER_DOWNLOAD",
    default: "true",
    description:
      "Whether a host runner with no browser of the machine's may download the pinned headless shell (F-121). false never downloads: the runner then reports no browser, and the panel says how to fix it.",
  },
} as const satisfies Record<
  RunnerConfigKey,
  { readonly flag: string; readonly env: string; readonly default: string; readonly description: string }
>;

const describe = (key: RunnerConfigKey): string => runnerConfigFields[key].description;

/** A whole number from a flag or a variable. */
const whole = (min: number, max: number) => z.coerce.number().pipe(z.number().int().min(min).max(max));

/** A boolean from a flag or a variable. */
const booleanSetting = z
  .enum(["true", "false", "1", "0", "on", "off", "yes", "no"])
  .transform((value) => value === "true" || value === "1" || value === "on" || value === "yes");

/** A Kubernetes object name (RFC 1123 label). */
const kubernetesName = z.string().min(1).max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, "a Kubernetes name");

export const runnerConfigSchema = z.strictObject({
  serverUrl: httpUrlSchema.describe(describe("serverUrl")),
  /** Unset: the runner uses `<home>/.ostra/runner`. */
  dataDir: z.string().min(1).optional().describe(describe("dataDir")),
  transport: z.enum(["auto", "websocket", "http"]).default("auto").describe(describe("transport")),
  executor: z.enum(["host", "docker", "kubernetes"]).default("host").describe(describe("executor")),
  /** Unset: the slots' default (`OSTRA_RUNNER_SLOTS` wins over it). */
  capacity: z.coerce.number().pipe(z.number().int().positive().max(1024)).optional().describe(describe("capacity")),
  labels: z.array(runnerLabelSchema).max(64).default([]).describe(describe("labels")),
  /** Unset: the runner uses the machine's host name. */
  name: z.string().min(1).max(128).optional().describe(describe("name")),
  joinToken: z.string().min(1).max(512).optional().describe(describe("joinToken")),
  shell: z.string().min(1).default("bash").describe(describe("shell")),
  joinTokenFile: z.string().min(1).max(4096).optional().describe(describe("joinTokenFile")),
  boxBaseImage: z.string().min(1).max(512).optional().describe(describe("boxBaseImage")),
  boxRunnerImage: z.string().min(1).max(512).optional().describe(describe("boxRunnerImage")),
  boxServerUrl: httpUrlSchema.optional().describe(describe("boxServerUrl")),
  boxSubnetPool: ipv4PoolSchema.default(DEFAULT_BOX_SUBNET_POOL).describe(describe("boxSubnetPool")),
  // Milestone 5. Unset `slots`: the executor's default (ADR 0059).
  slots: whole(1, 1024).optional().describe(describe("slots")),
  reserveCpuMillis: whole(0, 1_000_000).default(1000).describe(describe("reserveCpuMillis")),
  reserveMemoryMiB: whole(0, 16_777_216).default(2048).describe(describe("reserveMemoryMiB")),
  wsRetryMinutes: whole(1, 1440).default(10).describe(describe("wsRetryMinutes")),
  pin: booleanSetting.default(true).describe(describe("pin")),
  npmRegistry: httpUrlSchema.default(NPM_REGISTRY).describe(describe("npmRegistry")),
  hostPoolAgentUser: z.string().min(1).max(64).regex(/^[a-z_][a-z0-9_-]*$/i, "a user name").optional().describe(describe("hostPoolAgentUser")),
  k8sNamespace: kubernetesName.optional().describe(describe("k8sNamespace")),
  k8sBuildNamespace: kubernetesName.optional().describe(describe("k8sBuildNamespace")),
  k8sNodeWaitMinutes: whole(1, 1440).default(15).describe(describe("k8sNodeWaitMinutes")),
  k8sRuntimeClass: kubernetesName.optional().describe(describe("k8sRuntimeClass")),
  egressAllow: z.array(z.string().min(1).max(253).regex(/^[^\s,]+$/, "an address")).max(64).default([]).describe(describe("egressAllow")),
  sidecarCpuMillis: whole(1, 1_000_000).default(1000).describe(describe("sidecarCpuMillis")),
  sidecarMemoryMiB: whole(1, 16_777_216).default(256).describe(describe("sidecarMemoryMiB")),
  serviceCpuMillis: whole(1, 1_000_000).default(1000).describe(describe("serviceCpuMillis")),
  serviceMemoryMiB: whole(1, 16_777_216).default(1024).describe(describe("serviceMemoryMiB")),
  subagentWaitMinutes: whole(1, 1440).default(30).describe(describe("subagentWaitMinutes")),
  /** Unset: the runner finds the machine's browser, or downloads its pinned one (`browserDownload`). */
  browser: z.string().min(1).max(4096).optional().describe(describe("browser")),
  browserDownload: booleanSetting.default(true).describe(describe("browserDownload")),
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

const knownFlags: ReadonlySet<string> = new Set(runnerConfigKeys.map((key) => runnerConfigFields[key].flag));
const knownEnv: ReadonlySet<string> = new Set(runnerConfigKeys.map((key) => runnerConfigFields[key].env));

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
  for (const key of runnerConfigKeys) {
    const field = runnerConfigFields[key];
    const value = input.flags[field.flag] ?? input.env[field.env];
    if (value === undefined || value === "") {
      continue;
    }
    raw[key] =
      key === "labels" || key === "egressAllow"
        ? value
            .split(",")
            .map((label) => label.trim())
            .filter((label) => label.length > 0)
        : value;
  }
  const parsed = runnerConfigSchema.safeParse(raw);
  return parsed.success ? { ok: true, config: parsed.data } : { ok: false, errors: [describeIssues(parsed.error)] };
};
