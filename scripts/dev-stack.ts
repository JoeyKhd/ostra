// The pure parts of `pnpm dev` (ticket 29): which pieces of the stack exist, how their output is
// shown, and what in it the person at the terminal must see. `scripts/dev.ts` does the processes.

import { readFile } from "node:fs/promises";
import path from "node:path";

/** A server of the dev stack, started with its package's `dev` script when it has one. */
export type DevApp = {
  /** `core`, `core2`, `core3`... for each core replica (`OSTRA_DEV_CORE_REPLICAS`), and `web`. */
  readonly label: string;
  readonly dir: string;
  /** What the terminal shows when it runs. */
  readonly address: (env: Readonly<Record<string, string | undefined>>) => string;
  /**
   * What its `dev` script gets besides the stack's own environment: the panel's port, as Next reads
   * it, and the public addresses that follow the ports (`devPublicUrls`).
   */
  readonly extraEnv: (env: Readonly<Record<string, string | undefined>>) => Readonly<Record<string, string>>;
};

const port = (env: Readonly<Record<string, string | undefined>>, name: string, fallback: number): number => {
  const raw = env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  return Number.isInteger(value) && value > 0 && value < 65_536 ? value : fallback;
};

const isSet = (env: Readonly<Record<string, string | undefined>>, name: string): boolean => {
  const value = env[name];
  return value !== undefined && value !== "";
};

const webAddress = (env: Readonly<Record<string, string | undefined>>): string => `http://localhost:${String(port(env, "OSTRA_WEB_PORT", 3000))}`;
const coreAddress = (env: Readonly<Record<string, string | undefined>>): string => `http://localhost:${String(port(env, "OSTRA_CORE_PORT", 8787))}`;

/**
 * The public addresses a dev stack on other ports needs: `OSTRA_PUBLIC_URL` and
 * `OSTRA_CORE_PUBLIC_URL` default to ports 3000 and 8787, so with `OSTRA_WEB_PORT` alone the panel
 * moved but sign-in refused its own origin, and runners were sent to the wrong panel to approve a
 * device code. Each follows its port unless it's set; one that's set is kept as it is.
 */
export const devPublicUrls = (env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> => ({
  ...(isSet(env, "OSTRA_PUBLIC_URL") ? {} : { OSTRA_PUBLIC_URL: webAddress(env) }),
  ...(isSet(env, "OSTRA_CORE_PUBLIC_URL") ? {} : { OSTRA_CORE_PUBLIC_URL: coreAddress(env) }),
});

/** How many core replicas `pnpm dev` starts: `OSTRA_DEV_CORE_REPLICAS`, 1 to 8, default 1; `null` when it's set to anything else. */
export const coreReplicas = (env: Readonly<Record<string, string | undefined>>): number | null => {
  const raw = env["OSTRA_DEV_CORE_REPLICAS"];
  if (raw === undefined || raw === "") return 1;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 8 ? value : null;
};

/**
 * The stack's servers: `replicas` cores (milestone 5, ticket 36: the demo's and the load test's
 * several replicas over one database), each on the next port after `OSTRA_CORE_PORT`, and one panel.
 * Runners are told the first core's address; any replica takes them.
 */
export const devApps = (repoRoot: string, replicas = 1): readonly DevApp[] => [
  ...Array.from({ length: Math.max(1, replicas) }, (_unused, index): DevApp => {
    const replicaPort = (env: Readonly<Record<string, string | undefined>>): number => port(env, "OSTRA_CORE_PORT", 8787) + index;
    return {
      label: index === 0 ? "core" : `core${String(index + 1)}`,
      dir: path.join(repoRoot, "apps", "core"),
      address: (env) => `http://localhost:${String(replicaPort(env))}`,
      extraEnv: (env) => ({ ...devPublicUrls(env), ...(index === 0 ? {} : { OSTRA_CORE_PORT: String(replicaPort(env)) }) }),
    };
  }),
  {
    label: "web",
    dir: path.join(repoRoot, "apps", "web"),
    address: webAddress,
    // `next dev` listens on PORT: OSTRA_WEB_PORT moves the panel, so two checkouts can run at once.
    extraEnv: (env) => ({ PORT: String(port(env, "OSTRA_WEB_PORT", 3000)), ...devPublicUrls(env) }),
  },
];

/** Whether a package has a `dev` script: the sign its server exists yet. */
export const hasDevScript = async (packageDir: string): Promise<boolean> => {
  let text: string;
  try {
    text = await readFile(path.join(packageDir, "package.json"), "utf8");
  } catch {
    return false;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return false;
  }
  const scripts: unknown = Reflect.get(Object(json), "scripts");
  const dev: unknown = Reflect.get(Object(scripts), "dev");
  return typeof dev === "string" && dev.trim() !== "";
};

/** One line of a piece's output, with its label, so the pieces' logs can be told apart. */
export const prefixLine = (label: string, line: string): string => `[${label.padEnd(4)}] ${line}`;

/**
 * Whether a log line is the panel's "first admin seeded" record (F-001): a fresh install's first
 * start, which `pnpm dev` follows with how to sign in, where it can't be missed.
 */
export const isFirstAdminSeededLine = (line: string): boolean => line.includes('"msg":"setup.first_admin_seeded"');

/**
 * How to sign in as the seeded admin: demo@demo.com / demo unless OSTRA_ADMIN_* says otherwise
 * (F-001). An operator's own password is never printed, only where it comes from.
 */
export const firstAdminSignIn = (env: Readonly<Record<string, string | undefined>>): readonly string[] => {
  const set = (name: string): string | undefined => {
    const value = env[name];
    return value === undefined || value === "" ? undefined : value;
  };
  const email = set("OSTRA_ADMIN_EMAIL") ?? "demo@demo.com";
  const url = set("OSTRA_PUBLIC_URL") ?? webAddress(env);
  return set("OSTRA_ADMIN_PASSWORD") === undefined
    ? [`The first admin is ready. Sign in at ${url}`, `as ${email} with the password demo, then choose your own.`]
    : [`The first admin is ready. Sign in at ${url}`, `as ${email} with the password in OSTRA_ADMIN_PASSWORD.`];
};

/** The dev database's own line with its URL: `pnpm dev` says it's ready instead of echoing it. */
export const isDatabaseUrlLine = (line: string): boolean => line.startsWith("DATABASE_URL=");

/** Whether DATABASE_URL names another server, so no embedded Postgres starts. */
export const usesExternalDatabase = (env: Readonly<Record<string, string | undefined>>): boolean => {
  const url = env["DATABASE_URL"];
  return url !== undefined && url !== "";
};

/**
 * How to run pnpm from a script that pnpm started: Node with pnpm's own entry, which needs no shell
 * on Windows. `null`: not started by pnpm, so run `pnpm` from PATH.
 */
export const pnpmEntry = (env: Readonly<Record<string, string | undefined>>): string | null => {
  const entry = env["npm_execpath"];
  return entry !== undefined && /pnpm[^/\\]*\.(?:c?js|mjs)$/i.test(entry) ? entry : null;
};
