import path from "node:path";

import { devDatabaseUrl, devDataDir, devPgPort, DEV_PG_PORT_DEFAULT } from "@ostra/db/dev";
import { describeIssues, runnerEnvNames } from "@ostra/protocol";
import { z } from "zod";

// The server's settings (ticket 08): one strict schema over the environment, with a working
// default for every setting, so a fresh install needs none (the self-hosting rule, AGENTS.md).
// `docs/configuration.md` lists every one, and a test keeps the two in step: a new setting adds
// its line there.

const DEV_ONLY = "development only";

/** Every setting: its variable, its default as the docs write it, and what it does. */
export const settingFields = {
  NODE_ENV: {
    default: "development",
    description: "development, production or test. Production requires DATABASE_URL.",
  },
  DATABASE_URL: {
    default: "the dev database (development); required in production",
    description: "The Postgres server ostra keeps everything in. Unset in development: the embedded one `pnpm db:dev` starts.",
  },
  OSTRA_WEB_PORT: { default: "3000", description: "The port the panel (apps/web) listens on." },
  OSTRA_CORE_PORT: { default: "8787", description: "The port core (apps/core) listens on: runners connect here." },
  OSTRA_PUBLIC_URL: {
    default: "http://localhost:3000",
    description: "The panel's address as browsers reach it. Runners are sent here to approve a device code.",
  },
  OSTRA_CORE_PUBLIC_URL: {
    default: "http://localhost:8787",
    description: "Core's address as runners and webhooks reach it.",
  },
  OSTRA_DATA_DIR: {
    default: ".ostra-dev/server (development), /var/lib/ostra (production)",
    description: "Where the server keeps its generated keys. Back it up: it holds the secrets key when OSTRA_SECRETS_KEY is unset.",
  },
  OSTRA_SECRETS_KEY: {
    default: "generated on first start, kept in OSTRA_DATA_DIR",
    description: "The key the built-in secret store encrypts with (32 bytes, base64). Back it up: without it, stored secrets can't be read.",
  },
  OSTRA_CATALOG_FETCH: {
    default: "true",
    description: "Fetch the models.dev catalog daily. false: use the copy bundled with ostra only.",
  },
  OSTRA_OPEN_SIGNUP_ACCOUNTS: {
    default: "false",
    description: "Let anyone create an account. Off: after the first admin, accounts come by invitation.",
  },
  OSTRA_OPEN_SIGNUP_ORGANIZATIONS: {
    default: "false",
    description: "Let any account create an organization. Off: only the instance admin can.",
  },
  BETTER_AUTH_SECRET: {
    default: "generated on first start, kept in OSTRA_DATA_DIR",
    description: "Signs sessions and tokens (at least 32 characters). Changing it signs everyone out.",
  },
  OSTRA_SETUP_TOKEN: {
    default: "generated and printed in the server's log at first start",
    description: "Needed to create the first admin. It stops working once the first account exists (F-001, Q117).",
  },
  OSTRA_DEV_PG_PORT: {
    default: String(DEV_PG_PORT_DEFAULT),
    description: `The embedded dev database's port (${DEV_ONLY}).`,
  },
} as const;

export type SettingName = keyof typeof settingFields;

/** Variables ostra's development setup reads, which the settings don't refuse (docs/development.md). */
export const devOnlyEnvNames = [
  "OSTRA_DEV_MODEL_BASE_URL",
  "OSTRA_DEV_MODEL_API_KEY",
  "OSTRA_DEV_MODEL_ID",
  "OSTRA_DEV_GITHUB_ORG",
  "OSTRA_DEV_GITHUB_REPOS",
  "OSTRA_DEV_PUBLIC_URL",
] as const;

/** Spikes' own variables (`spikes/`), which share the dev env files: never read, never refused. */
const SPIKE_PREFIX = "OSTRA_SPIKE_";

export const settingNames: readonly SettingName[] = Object.keys(settingFields).filter(
  (name): name is SettingName => name in settingFields,
);

const describe = (name: SettingName): string => settingFields[name].description;

const flag = z
  .enum(["true", "false", "1", "0", "on", "off", "yes", "no"])
  .transform((value) => value === "true" || value === "1" || value === "on" || value === "yes");

const port = z.coerce.number().pipe(z.number().int().min(1).max(65_535));
const url = z.url({ protocol: /^https?$/ });

const rawSettingsSchema = z.strictObject({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development").describe(describe("NODE_ENV")),
  DATABASE_URL: z.string().min(1).optional().describe(describe("DATABASE_URL")),
  OSTRA_WEB_PORT: port.default(3000).describe(describe("OSTRA_WEB_PORT")),
  OSTRA_CORE_PORT: port.default(8787).describe(describe("OSTRA_CORE_PORT")),
  OSTRA_PUBLIC_URL: url.default("http://localhost:3000").describe(describe("OSTRA_PUBLIC_URL")),
  OSTRA_CORE_PUBLIC_URL: url.default("http://localhost:8787").describe(describe("OSTRA_CORE_PUBLIC_URL")),
  OSTRA_DATA_DIR: z.string().min(1).optional().describe(describe("OSTRA_DATA_DIR")),
  OSTRA_SECRETS_KEY: z
    .string()
    .regex(/^[A-Za-z0-9+/_-]{43,}={0,2}$/, "32 bytes or more, base64")
    .optional()
    .describe(describe("OSTRA_SECRETS_KEY")),
  OSTRA_CATALOG_FETCH: flag.default(true).describe(describe("OSTRA_CATALOG_FETCH")),
  OSTRA_OPEN_SIGNUP_ACCOUNTS: flag.default(false).describe(describe("OSTRA_OPEN_SIGNUP_ACCOUNTS")),
  OSTRA_OPEN_SIGNUP_ORGANIZATIONS: flag.default(false).describe(describe("OSTRA_OPEN_SIGNUP_ORGANIZATIONS")),
  BETTER_AUTH_SECRET: z.string().min(32).optional().describe(describe("BETTER_AUTH_SECRET")),
  OSTRA_SETUP_TOKEN: z.string().min(16).optional().describe(describe("OSTRA_SETUP_TOKEN")),
  OSTRA_DEV_PG_PORT: port.default(DEV_PG_PORT_DEFAULT).describe(describe("OSTRA_DEV_PG_PORT")),
});

/** The server's settings, resolved: every default filled in. Holds secrets: never logged whole. */
export type ServerSettings = {
  readonly mode: "development" | "production" | "test";
  /** Holds credentials: never log it. */
  readonly databaseUrl: string;
  readonly webPort: number;
  readonly corePort: number;
  readonly publicUrl: string;
  readonly corePublicUrl: string;
  readonly dataDir: string;
  /** `null`: generate one on first start and keep it in `dataDir`. */
  readonly secretsKey: string | null;
  readonly catalogFetch: boolean;
  readonly openSignupAccounts: boolean;
  readonly openSignupOrganizations: boolean;
  /** `null`: generate one on first start and keep it in `dataDir`. */
  readonly betterAuthSecret: string | null;
  /** `null`: generate one at first start and print it in the log. */
  readonly setupToken: string | null;
};

export type SettingsResult =
  | { readonly ok: true; readonly settings: ServerSettings }
  | { readonly ok: false; readonly errors: readonly string[] };

const knownOstraNames: ReadonlySet<string> = new Set<string>([
  ...settingNames,
  ...runnerEnvNames,
  ...devOnlyEnvNames,
]);

/** Reads the server's settings from the environment. Never throws; the errors name variables, never values. */
export const parseServerSettings = (env: Readonly<Record<string, string | undefined>>): SettingsResult => {
  const unknown = Object.keys(env).filter((name) => name.startsWith("OSTRA_") && !name.startsWith(SPIKE_PREFIX) && !knownOstraNames.has(name));
  if (unknown.length > 0) {
    const known = [...knownOstraNames].filter((name) => name.startsWith("OSTRA_")).sort();
    return {
      ok: false,
      errors: unknown.map((name) => `unknown setting ${name}; known: ${known.join(", ")}`),
    };
  }
  const raw: Record<string, string> = {};
  for (const name of settingNames) {
    const value = env[name];
    if (value !== undefined && value !== "") {
      raw[name] = value;
    }
  }
  const parsed = rawSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: [describeIssues(parsed.error, 20)] };
  }
  const value = parsed.data;
  const production = value.NODE_ENV === "production";
  if (production && value.DATABASE_URL === undefined) {
    return { ok: false, errors: ["DATABASE_URL is required in production"] };
  }
  return {
    ok: true,
    settings: {
      mode: value.NODE_ENV,
      databaseUrl: value.DATABASE_URL ?? devDatabaseUrl(devPgPort(env)),
      webPort: value.OSTRA_WEB_PORT,
      corePort: value.OSTRA_CORE_PORT,
      publicUrl: value.OSTRA_PUBLIC_URL,
      corePublicUrl: value.OSTRA_CORE_PUBLIC_URL,
      dataDir: value.OSTRA_DATA_DIR ?? (production ? "/var/lib/ostra" : path.join(devDataDir, "server")),
      secretsKey: value.OSTRA_SECRETS_KEY ?? null,
      catalogFetch: value.OSTRA_CATALOG_FETCH,
      openSignupAccounts: value.OSTRA_OPEN_SIGNUP_ACCOUNTS,
      openSignupOrganizations: value.OSTRA_OPEN_SIGNUP_ORGANIZATIONS,
      betterAuthSecret: value.BETTER_AUTH_SECRET ?? null,
      setupToken: value.OSTRA_SETUP_TOKEN ?? null,
    },
  };
};
