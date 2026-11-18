// A box as a fresh container (B1's "a fresh container"): one container per
// box, from an image with git, Node and the pinned OpenCode for Linux.
//
//   - The box's directory tree on the host is mounted at /box, so the host's
//     git (clone, hidden ref) and the checks read the same workspace. The
//     agent sees it as /box/workspace.
//   - OpenCode's data (its session database), HOME and the XDG data, state
//     and cache dirs live in the container's own filesystem, under /tmp/home,
//     so they die with the container. Only the config (no secret in it) and a
//     temp dir for the archive file are on the mount.
//   - The agent is `docker exec -i <box> opencode acp`. The CLI calls are
//     `docker exec <box> opencode session …`. The agent's variables are passed
//     by name (`-e NAME`), so the fake key is never an argument.
//   - Every container carries the run's label, so a sweep removes what a run
//     left behind, and nothing else.
//
// Built for the runs that have Docker; this machine has none, so it has never
// run here.

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { OpenCodeVersion } from "./opencode.ts";

const run = promisify(execFile);

export const BOX_MOUNT = "/box";
export const CONTAINER_HOME = "/tmp/home";
export const RUN_LABEL = "ostra-spike2-run";

/** The image's base, pinned. */
const BASE_IMAGE = "node:24.14.0-bookworm-slim";

const dockerfile = (): string =>
  [
    `FROM ${BASE_IMAGE}`,
    "RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates procps && rm -rf /var/lib/apt/lists/*",
    "ARG OPENCODE_VERSION",
    "ARG TARGETARCH",
    // The platform package directly: the wrapper's postinstall never runs, as on the host.
    'RUN arch=$([ "$TARGETARCH" = "arm64" ] && echo arm64 || echo x64) && npm install -g --ignore-scripts "@opencode/cli-linux-${arch}@${OPENCODE_VERSION}" && ln -s "/usr/local/lib/node_modules/@opencode/cli-linux-${arch}/bin/opencode" /usr/local/bin/opencode && opencode --version',
    "RUN git config --system safe.directory '*' && git config --system core.autocrlf false && git config --system user.name ostra && git config --system user.email ostra@ostra.invalid",
    "USER 1000:1000",
    `WORKDIR ${BOX_MOUNT}/workspace`,
    "",
  ].join("\n");

/** What the docker CLI needs from the host's environment, and nothing else. */
const DOCKER_ENV_NAMES = process.platform === "win32"
  ? ["PATH", "Path", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "TEMP", "TMP", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"]
  : ["PATH", "HOME", "TMPDIR", "XDG_RUNTIME_DIR", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"];

export const dockerEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const name of DOCKER_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
};

const docker = async (args: readonly string[], options: { readonly input?: string; readonly timeoutMs?: number } = {}): Promise<string> => {
  const child = run("docker", [...args], { env: dockerEnv(), maxBuffer: 16 * 1024 * 1024, timeout: options.timeoutMs ?? 120_000, windowsHide: true });
  if (options.input !== undefined) child.child.stdin?.end(options.input);
  return (await child).stdout.trim();
};

export const imageTag = (version: OpenCodeVersion): string => `ostra-spike2-box:opencode-${version}`;

/** Builds the box image for one OpenCode version, unless Docker already has it. Needs the network the first time. */
export const ensureBoxImage = async (version: OpenCodeVersion): Promise<string> => {
  const tag = imageTag(version);
  const present = await docker(["image", "inspect", "--format", "{{.Id}}", tag]).then(
    () => true,
    () => false,
  );
  if (!present) await docker(["build", "-t", tag, "--build-arg", `OPENCODE_VERSION=${version}`, "-"], { input: dockerfile(), timeoutMs: 900_000 });
  return tag;
};

export type Container = {
  readonly name: string;
  /** `docker run` to running, ms. */
  readonly startMs: number;
};

const NAME = /^[a-z0-9][a-z0-9_.-]{0,62}$/;

/** A fresh container for one box, with the box's tree mounted at /box. It only sleeps; the agent and the CLI run through `docker exec`. */
export const startContainer = async (input: { readonly name: string; readonly image: string; readonly boxRoot: string; readonly runLabel: string }): Promise<Container> => {
  if (!NAME.test(input.name)) throw new Error("startContainer: bad container name");
  const started = Date.now();
  const user = process.platform === "win32" || process.getuid === undefined || process.getgid === undefined ? "1000:1000" : `${String(process.getuid())}:${String(process.getgid())}`;
  await docker([
    "run",
    "-d",
    "--name",
    input.name,
    "--label",
    `${RUN_LABEL}=${input.runLabel}`,
    "--user",
    user,
    "--add-host",
    "host.docker.internal:host-gateway",
    "--mount",
    `type=bind,source=${path.resolve(input.boxRoot)},target=${BOX_MOUNT}`,
    input.image,
    "sleep",
    "infinity",
  ]);
  return { name: input.name, startMs: Date.now() - started };
};

/** Stops any `opencode` left inside the container (a stopped `docker exec` client doesn't always take its process with it). */
export const stopAgentsIn = async (name: string): Promise<void> => {
  await docker(["exec", name, "pkill", "-KILL", "-x", "opencode"]).catch(() => undefined);
};

export const removeContainer = async (name: string): Promise<void> => {
  await docker(["rm", "-f", "-v", name]).catch(() => undefined);
};

/** Containers with the run's label: what a sweep removes. Throws when Docker can't list. */
export const containersOfRun = async (runLabel: string): Promise<string[]> => {
  const out = await docker(["ps", "-a", "-q", "--filter", `label=${RUN_LABEL}=${runLabel}`]);
  return out === "" ? [] : out.split(/\s+/);
};

/** The container path for a path inside the box's tree. */
export const containerPath = (boxRoot: string, hostPath: string): string => {
  const rel = path.relative(boxRoot, hostPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("containerPath: the path is outside the box");
  return rel === "" ? BOX_MOUNT : `${BOX_MOUNT}/${rel.split(path.sep).join("/")}`;
};

/** The agent's environment inside the container: its own HOME and XDG dirs, the config from the mount, the fake key. */
export const containerAgentEnv = (input: { readonly fakeKeys: Readonly<Record<string, string>> }): Record<string, string> => ({
  HOME: CONTAINER_HOME,
  XDG_DATA_HOME: `${CONTAINER_HOME}/.local/share`,
  XDG_STATE_HOME: `${CONTAINER_HOME}/.local/state`,
  XDG_CACHE_HOME: `${CONTAINER_HOME}/.cache`,
  XDG_CONFIG_HOME: `${BOX_MOUNT}/xdg/config`,
  TMPDIR: `${BOX_MOUNT}/tmp`,
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_CLAUDE_CODE: "1",
  OPENCODE_DISABLE_FREE_MODELS: "1",
  GIT_TERMINAL_PROMPT: "0",
  ...input.fakeKeys,
});
