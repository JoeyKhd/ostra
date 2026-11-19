import path from "node:path";
import { fileURLToPath } from "node:url";

// What milestone 5's dev tools share (ticket 36): the development-only guard, the ports and the
// data folder they read from the environment, and how each one says it's ready and stops.

export type Env = Readonly<Record<string, string | undefined>>;

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** Development and test only, as `pnpm dev:seed-member` and the mail sink: an unset `NODE_ENV` counts as development. */
export const devToolAllowed = (env: Env): boolean => {
  const mode = env["NODE_ENV"] ?? "development";
  return mode === "development" || mode === "test";
};

/** A port from the environment, or the default; `null` when it's set to something that isn't one. */
export const portFrom = (env: Env, name: string, fallback: number): number | null => {
  const raw = env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  return Number.isInteger(value) && value >= 0 && value < 65_536 ? value : null;
};

/** Where the tools write what other processes read (a kubeconfig, a CA): `.ostra-dev/` at the repo root, gitignored. */
export const devDataDir = (env: Env): string => {
  const dir = env["OSTRA_DEV_DATA_DIR"];
  return dir === undefined || dir === "" ? path.join(repoRoot, ".ostra-dev") : dir;
};

/** `40s`, `2m`, `500ms` or a number of milliseconds. */
export const parseDuration = (text: string): number | null => {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(text.trim());
  if (match?.[1] === undefined) return null;
  const value = Number(match[1]);
  const unit = match[2] ?? "ms";
  return Math.round(unit === "m" ? value * 60_000 : unit === "s" ? value * 1000 : value);
};

export const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

export const refuseOutsideDev = (tool: string): number => {
  process.stderr.write(`${tool} runs only when NODE_ENV is development or test.\n`);
  return 1;
};

/**
 * Tells a parent with an IPC channel the tool is up (`{ type: "ready", ... }`), then waits for
 * Ctrl-C, SIGTERM or `{ type: "stop" }`, and stops it.
 */
export const serveUntilStopped = async (ready: Readonly<Record<string, unknown>>, stop: () => Promise<void>): Promise<number> => {
  process.send?.({ type: "ready", ...ready });
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
    process.on("message", (message: unknown) => {
      if (typeof message === "object" && message !== null && "type" in message && message.type === "stop") resolve();
    });
  });
  await stop();
  process.disconnect?.();
  return 0;
};

/** The version after `version`'s patch: `1.4.0` → `1.4.1`. */
export const nextPatch = (version: string): string => {
  const [major = "0", minor = "0", patch = "0"] = version.split("-")[0]?.split(".") ?? [];
  return `${major}.${minor}.${String(Number(patch) + 1)}`;
};
