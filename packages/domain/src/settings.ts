import path from "node:path";

import { devDatabaseUrl, devDataDir, devPgPort, DEV_PG_PORT_DEFAULT } from "@ostra/db/dev";
import { describeIssues, runnerEnvNames } from "@ostra/protocol";
import { z } from "zod";

import { defaultFirstAdmin, organizationNameSchema, passwordSchema, usernameSchema } from "./accounts.ts";

// The server's settings (ticket 08): one strict schema over the environment, with a working
// default for every setting, so a fresh install needs none (the self-hosting rule, AGENTS.md).
// `docs/configuration.md` lists every one, and a test keeps the two in step: a new setting adds
// its line there.

const DEV_ONLY = "development only";

/** GitHub.com's LFS storage hosts (Q119, spike 4): the default of OSTRA_GITHUB_LFS_HOSTS. */
export const GITHUB_COM_LFS_HOSTS = ["github-cloud.githubusercontent.com", "github-cloud.s3.amazonaws.com", "lfs.github.com"] as const;

const lfsHostPattern = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Every setting's variable. `settingFields` must hold exactly these: the compiler refuses a missing or an extra one. */
export const settingNames = [
  "NODE_ENV",
  "DATABASE_URL",
  "OSTRA_WEB_PORT",
  "OSTRA_CORE_PORT",
  "OSTRA_PUBLIC_URL",
  "OSTRA_CORE_PUBLIC_URL",
  "OSTRA_GITHUB_API_URL",
  "OSTRA_GITHUB_LFS_HOSTS",
  "OSTRA_DATA_DIR",
  "OSTRA_SECRETS_KEY",
  "OSTRA_RUNNER_TOKEN_KEY",
  "OSTRA_CATALOG_FETCH",
  "OSTRA_MODEL_ENDPOINT_ALLOW_PRIVATE",
  "OSTRA_OPEN_SIGNUP_ACCOUNTS",
  "OSTRA_OPEN_SIGNUP_ORGANIZATIONS",
  "BETTER_AUTH_SECRET",
  "OSTRA_ADMIN_EMAIL",
  "OSTRA_ADMIN_USERNAME",
  "OSTRA_ADMIN_PASSWORD",
  "OSTRA_ORGANIZATION_NAME",
  "OSTRA_ALLOW_DEFAULT_PASSWORD",
  "OSTRA_DEV_PG_PORT",
  // ---- milestone 2 (spec section 5.4) ----
  "OSTRA_BOX_IDLE_MINUTES",
  "OSTRA_SESSION_MAX_MINUTES",
  "OSTRA_SESSION_STALL_MINUTES",
  "OSTRA_TASK_SPEND_CAP_USD",
  "OSTRA_TASK_TOKEN_CAP",
  "OSTRA_TRACKER_POLL_SECONDS",
  "OSTRA_RECONCILE_MINUTES",
  "OSTRA_WEBHOOK_INSERT_DEADLINE_MS",
  "OSTRA_BOX_RELEASE_IDLE_DAYS",
  "OSTRA_RETENTION_DAYS",
  "OSTRA_BLOB_STORE",
  "OSTRA_BLOB_MAX_MIB",
  "OSTRA_S3_ENDPOINT",
  "OSTRA_S3_BUCKET",
  "OSTRA_S3_REGION",
  "OSTRA_S3_ACCESS_KEY_ID",
  "OSTRA_S3_SECRET_ACCESS_KEY",
] as const;

export type SettingName = (typeof settingNames)[number];

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
  OSTRA_GITHUB_API_URL: {
    default: "https://api.github.com",
    description: "The GitHub REST API the panel and core talk to: a GitHub Enterprise Server's, or a fake GitHub in tests.",
  },
  OSTRA_GITHUB_LFS_HOSTS: {
    default: GITHUB_COM_LFS_HOSTS.join(","),
    description:
      "The hosts a task's git proxy may send Git LFS uploads and downloads to, besides the code host's own address: comma-separated host names, `*.` for a subdomain. A GitHub Enterprise Server install lists its own storage host.",
  },
  OSTRA_DATA_DIR: {
    default: ".ostra-dev/server (development), /var/lib/ostra (production)",
    description: "Where the server keeps its generated keys. Back it up: it holds the secrets key when OSTRA_SECRETS_KEY is unset.",
  },
  OSTRA_SECRETS_KEY: {
    default: "generated on first start, kept in OSTRA_DATA_DIR",
    description:
      "The key the built-in secret store encrypts with (32 bytes, base64). Back it up: without it, stored secrets can't be read. A key that can't read the database's secrets stops the server at start.",
  },
  OSTRA_RUNNER_TOKEN_KEY: {
    default: "generated on first start, kept in OSTRA_DATA_DIR",
    description:
      "The key core signs runners' access tokens and tasks' MCP tokens with (32 bytes, base64 or 64 hex characters). Set the same one on every core replica that doesn't share the data folder. Changing it makes every runner get a new token.",
  },
  OSTRA_CATALOG_FETCH: {
    default: "true",
    description: "Fetch the models.dev catalog daily. false: use the copy bundled with ostra only.",
  },
  OSTRA_MODEL_ENDPOINT_ALLOW_PRIVATE: {
    default: "false",
    description:
      "Let a model provider's base URL point at a private, loopback or link-local address, such as a model server on your own network. Off: those addresses and cloud metadata hosts are refused.",
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
  OSTRA_ADMIN_EMAIL: {
    default: defaultFirstAdmin.email,
    description: "The first admin's email. Read once: when the server starts with no account, it creates the first admin and the first organization (F-001).",
  },
  OSTRA_ADMIN_USERNAME: {
    default: defaultFirstAdmin.username,
    description: "The first admin's username (lowercase letters, digits and inner hyphens). Read once, like OSTRA_ADMIN_EMAIL.",
  },
  OSTRA_ADMIN_PASSWORD: {
    default: defaultFirstAdmin.password,
    description: "The first admin's password, 12 characters or more. Unset: the default password, which the admin must change at the first sign-in. Read once, like OSTRA_ADMIN_EMAIL.",
  },
  OSTRA_ORGANIZATION_NAME: {
    default: defaultFirstAdmin.organizationName,
    description: "The first organization's name. Read once, like OSTRA_ADMIN_EMAIL.",
  },
  OSTRA_ALLOW_DEFAULT_PASSWORD: {
    default: "false",
    description: "Let the seeded admin keep the default password (for demos): no forced change at sign-in, but the panel's warning stays until it changes.",
  },
  OSTRA_DEV_PG_PORT: {
    default: String(DEV_PG_PORT_DEFAULT),
    description: `The embedded dev database's port (${DEV_ONLY}).`,
  },
  OSTRA_BOX_IDLE_MINUTES: {
    default: "15",
    description: "After this many minutes with no turn, a box stops its agent and its session ends (F-096). The next message reopens the task.",
  },
  OSTRA_SESSION_MAX_MINUTES: {
    default: "120",
    description: "A session's longest life: past it, core stops the session and the task needs you (runaway protection, F-068).",
  },
  OSTRA_SESSION_STALL_MINUTES: {
    default: "10",
    description: "This long with no agent event, and core stops the session as stalled (F-068).",
  },
  OSTRA_TASK_SPEND_CAP_USD: {
    default: "25",
    description: "A task's spend cap in US dollars, on the four token kinds at the model's prices (F-068). At the cap the session stops and the task needs you. At most 2000.",
  },
  OSTRA_TASK_TOKEN_CAP: {
    default: "10000000",
    description: "A task's cap in tokens, used instead of the dollar cap when the model has no known price.",
  },
  OSTRA_TRACKER_POLL_SECONDS: {
    default: "60",
    description: "How often a board is polled when its tracker can't reach ostra's webhooks (F-042).",
  },
  OSTRA_RECONCILE_MINUTES: {
    default: "5",
    description: "How often core checks the open PRs' states on GitHub, in case a webhook was missed (F-044).",
  },
  OSTRA_WEBHOOK_INSERT_DEADLINE_MS: {
    default: "2000",
    description: "How long saving a webhook may take before core answers 503, so the sender retries (spec section 4).",
  },
  OSTRA_BOX_RELEASE_IDLE_DAYS: {
    default: "14",
    description: "A stopped box is released after this many idle days, and its task's hidden ref deleted (F-079).",
  },
  OSTRA_RETENTION_DAYS: {
    default: "unset: keep while the task exists",
    description: "Delete a finished task's histories, archives and blobs this many days after it ends (F-079). A retention an admin saves in the panel wins over it.",
  },
  OSTRA_BLOB_STORE: {
    default: "postgres",
    description: "Where blobs (session archives, ticket images) are kept: postgres, in the database's own tables, or s3, any S3-compatible store (F-114).",
  },
  OSTRA_BLOB_MAX_MIB: {
    default: "64",
    description: "The largest blob, in MiB, and so the largest session archive; over it, the next reopen uses the rebuild template. At most 64.",
  },
  OSTRA_S3_ENDPOINT: {
    default: "unset: AWS S3",
    description: "The S3-compatible store's endpoint, such as a MinIO or R2 URL. Read only with OSTRA_BLOB_STORE=s3.",
  },
  OSTRA_S3_BUCKET: {
    default: "unset; required with OSTRA_BLOB_STORE=s3",
    description: "The bucket blobs are kept in. Read only with OSTRA_BLOB_STORE=s3.",
  },
  OSTRA_S3_REGION: {
    default: "unset",
    description: "The store's region. Read only with OSTRA_BLOB_STORE=s3.",
  },
  OSTRA_S3_ACCESS_KEY_ID: {
    default: "unset; required with OSTRA_BLOB_STORE=s3",
    description: "The access key's ID. Read only with OSTRA_BLOB_STORE=s3.",
  },
  OSTRA_S3_SECRET_ACCESS_KEY: {
    default: "unset; required with OSTRA_BLOB_STORE=s3",
    description: "The access key's secret. Never logged. Read only with OSTRA_BLOB_STORE=s3.",
  },
} as const satisfies Record<SettingName, { readonly default: string; readonly description: string }>;

/** Variables ostra's development setup reads, which the settings don't refuse (docs/development.md). */
export const devOnlyEnvNames = [
  "OSTRA_DEV_MODEL_BASE_URL",
  "OSTRA_DEV_MODEL_API_KEY",
  "OSTRA_DEV_MODEL_ID",
  "OSTRA_DEV_GITHUB_ORG",
  "OSTRA_DEV_GITHUB_REPOS",
  "OSTRA_DEV_PUBLIC_URL",
  "OSTRA_DEV_BLOCK_WEBHOOKS",
] as const;

/**
 * Variables the runner sets in a task's own processes (ticket 42's containment marker): never read
 * by the server, and not refused, so an agent that runs ostra's own server in its task can start it.
 */
const taskEnvNames = ["OSTRA_TASK_UNIT"] as const;

/** Spikes' own variables (`spikes/`), which share the dev env files: never read, never refused. */
const SPIKE_PREFIX = "OSTRA_SPIKE_";

const describe = (name: SettingName): string => settingFields[name].description;

const flag = z
  .enum(["true", "false", "1", "0", "on", "off", "yes", "no"])
  .transform((value) => value === "true" || value === "1" || value === "on" || value === "yes");

/** 32 bytes from 64 hex characters or base64 (the schema checked the form). */
const decodeKey32 = (text: string): Buffer =>
  /^[0-9a-fA-F]{64}$/.test(text) ? Buffer.from(text, "hex") : Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");

const port = z.coerce.number().pipe(z.number().int().min(1).max(65_535));
const whole = (min: number, max: number) => z.coerce.number().pipe(z.number().int().min(min).max(max));
const url = z.url({ protocol: /^https?$/ });

const rawSettingsSchema = z.strictObject({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development").describe(describe("NODE_ENV")),
  DATABASE_URL: z.string().min(1).optional().describe(describe("DATABASE_URL")),
  OSTRA_WEB_PORT: port.default(3000).describe(describe("OSTRA_WEB_PORT")),
  OSTRA_CORE_PORT: port.default(8787).describe(describe("OSTRA_CORE_PORT")),
  OSTRA_PUBLIC_URL: url.default("http://localhost:3000").describe(describe("OSTRA_PUBLIC_URL")),
  OSTRA_CORE_PUBLIC_URL: url.default("http://localhost:8787").describe(describe("OSTRA_CORE_PUBLIC_URL")),
  OSTRA_GITHUB_API_URL: url.default("https://api.github.com").describe(describe("OSTRA_GITHUB_API_URL")),
  OSTRA_GITHUB_LFS_HOSTS: z
    .string()
    .transform((text) => text.split(",").map((host) => host.trim().toLowerCase()).filter((host) => host !== ""))
    .pipe(z.array(z.string().regex(lfsHostPattern, "host names, comma-separated")).min(1).max(20))
    .default([...GITHUB_COM_LFS_HOSTS])
    .describe(describe("OSTRA_GITHUB_LFS_HOSTS")),
  OSTRA_DATA_DIR: z.string().min(1).optional().describe(describe("OSTRA_DATA_DIR")),
  OSTRA_SECRETS_KEY: z
    .string()
    .regex(/^[A-Za-z0-9+/_-]{43,}={0,2}$/, "32 bytes or more, base64")
    .optional()
    .describe(describe("OSTRA_SECRETS_KEY")),
  OSTRA_RUNNER_TOKEN_KEY: z
    .string()
    .regex(/^(?:[0-9a-fA-F]{64}|[A-Za-z0-9+/_-]{43}=?)$/, "32 bytes: base64 or 64 hex characters")
    .optional()
    .describe(describe("OSTRA_RUNNER_TOKEN_KEY")),
  OSTRA_CATALOG_FETCH: flag.default(true).describe(describe("OSTRA_CATALOG_FETCH")),
  OSTRA_MODEL_ENDPOINT_ALLOW_PRIVATE: flag.default(false).describe(describe("OSTRA_MODEL_ENDPOINT_ALLOW_PRIVATE")),
  OSTRA_OPEN_SIGNUP_ACCOUNTS: flag.default(false).describe(describe("OSTRA_OPEN_SIGNUP_ACCOUNTS")),
  OSTRA_OPEN_SIGNUP_ORGANIZATIONS: flag.default(false).describe(describe("OSTRA_OPEN_SIGNUP_ORGANIZATIONS")),
  BETTER_AUTH_SECRET: z.string().min(32).optional().describe(describe("BETTER_AUTH_SECRET")),
  OSTRA_ADMIN_EMAIL: z.email().max(320).default(defaultFirstAdmin.email).describe(describe("OSTRA_ADMIN_EMAIL")),
  OSTRA_ADMIN_USERNAME: usernameSchema.default(defaultFirstAdmin.username).describe(describe("OSTRA_ADMIN_USERNAME")),
  // An operator's own password meets the policy; only the default may be shorter (accounts.ts).
  OSTRA_ADMIN_PASSWORD: passwordSchema.optional().describe(describe("OSTRA_ADMIN_PASSWORD")),
  OSTRA_ORGANIZATION_NAME: organizationNameSchema.default(defaultFirstAdmin.organizationName).describe(describe("OSTRA_ORGANIZATION_NAME")),
  OSTRA_ALLOW_DEFAULT_PASSWORD: flag.default(false).describe(describe("OSTRA_ALLOW_DEFAULT_PASSWORD")),
  OSTRA_DEV_PG_PORT: port.default(DEV_PG_PORT_DEFAULT).describe(describe("OSTRA_DEV_PG_PORT")),
  OSTRA_BOX_IDLE_MINUTES: whole(1, 7 * 24 * 60).default(15).describe(describe("OSTRA_BOX_IDLE_MINUTES")),
  OSTRA_SESSION_MAX_MINUTES: whole(1, 7 * 24 * 60).default(120).describe(describe("OSTRA_SESSION_MAX_MINUTES")),
  OSTRA_SESSION_STALL_MINUTES: whole(1, 24 * 60).default(10).describe(describe("OSTRA_SESSION_STALL_MINUTES")),
  OSTRA_TASK_SPEND_CAP_USD: z.coerce
    .number()
    .pipe(z.number().positive().max(2000))
    .default(25)
    .describe(describe("OSTRA_TASK_SPEND_CAP_USD")),
  OSTRA_TASK_TOKEN_CAP: whole(1, 2_000_000_000).default(10_000_000).describe(describe("OSTRA_TASK_TOKEN_CAP")),
  OSTRA_TRACKER_POLL_SECONDS: whole(10, 3600).default(60).describe(describe("OSTRA_TRACKER_POLL_SECONDS")),
  OSTRA_RECONCILE_MINUTES: whole(1, 24 * 60).default(5).describe(describe("OSTRA_RECONCILE_MINUTES")),
  OSTRA_WEBHOOK_INSERT_DEADLINE_MS: whole(100, 4500).default(2000).describe(describe("OSTRA_WEBHOOK_INSERT_DEADLINE_MS")),
  OSTRA_BOX_RELEASE_IDLE_DAYS: whole(1, 365).default(14).describe(describe("OSTRA_BOX_RELEASE_IDLE_DAYS")),
  OSTRA_RETENTION_DAYS: whole(1, 36_500).optional().describe(describe("OSTRA_RETENTION_DAYS")),
  OSTRA_BLOB_STORE: z.enum(["postgres", "s3"]).default("postgres").describe(describe("OSTRA_BLOB_STORE")),
  OSTRA_BLOB_MAX_MIB: whole(1, 64).default(64).describe(describe("OSTRA_BLOB_MAX_MIB")),
  OSTRA_S3_ENDPOINT: url.optional().describe(describe("OSTRA_S3_ENDPOINT")),
  OSTRA_S3_BUCKET: z.string().min(3).max(255).optional().describe(describe("OSTRA_S3_BUCKET")),
  OSTRA_S3_REGION: z.string().min(1).max(64).optional().describe(describe("OSTRA_S3_REGION")),
  OSTRA_S3_ACCESS_KEY_ID: z.string().min(1).max(256).optional().describe(describe("OSTRA_S3_ACCESS_KEY_ID")),
  OSTRA_S3_SECRET_ACCESS_KEY: z.string().min(1).max(512).optional().describe(describe("OSTRA_S3_SECRET_ACCESS_KEY")),
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
  /** OSTRA_GITHUB_API_URL: the GitHub REST API, without a trailing slash. */
  readonly githubApiUrl: string;
  /** OSTRA_GITHUB_LFS_HOSTS: where a task's git proxy may send LFS transfers, besides the code host itself. */
  readonly githubLfsHosts: readonly string[];
  readonly dataDir: string;
  /** `null`: generate one on first start and keep it in `dataDir`. */
  readonly secretsKey: string | null;
  /** OSTRA_RUNNER_TOKEN_KEY, 32 bytes. `null`: generate one on first start and keep it in `dataDir`. Never logged. */
  readonly runnerTokenKey: Buffer | null;
  readonly catalogFetch: boolean;
  /** OSTRA_MODEL_ENDPOINT_ALLOW_PRIVATE: model provider URLs may point at private networks. */
  readonly modelEndpointAllowPrivate: boolean;
  readonly openSignupAccounts: boolean;
  readonly openSignupOrganizations: boolean;
  /** `null`: generate one on first start and keep it in `dataDir`. */
  readonly betterAuthSecret: string | null;
  /** The account a server that starts with no account seeds (F-001). Holds a password: never logged. */
  readonly firstAdmin: FirstAdminSettings;
  /** The seeded admin may keep the default password: no forced change (the warning stays). */
  readonly allowDefaultPassword: boolean;
  // ---- milestone 2 ----
  /** OSTRA_BOX_IDLE_MINUTES. */
  readonly boxIdleMinutes: number;
  /** OSTRA_SESSION_MAX_MINUTES. */
  readonly sessionMaxMinutes: number;
  /** OSTRA_SESSION_STALL_MINUTES. */
  readonly sessionStallMinutes: number;
  /** OSTRA_TASK_SPEND_CAP_USD, in micro-USD. */
  readonly taskSpendCapMicroUsd: number;
  /** OSTRA_TASK_TOKEN_CAP. */
  readonly taskTokenCap: number;
  /** OSTRA_TRACKER_POLL_SECONDS. */
  readonly trackerPollSeconds: number;
  /** OSTRA_RECONCILE_MINUTES. */
  readonly reconcileMinutes: number;
  /** OSTRA_WEBHOOK_INSERT_DEADLINE_MS. */
  readonly webhookInsertDeadlineMs: number;
  /** OSTRA_BOX_RELEASE_IDLE_DAYS. */
  readonly boxReleaseIdleDays: number;
  /** OSTRA_RETENTION_DAYS, or `null` (keep). A retention saved in the panel wins: `retentionDaysInEffect`. */
  readonly retentionDays: number | null;
  readonly blobStore: BlobStoreSettings;
};

/** OSTRA_BLOB_STORE and its settings. The S3 one holds a secret: never logged. */
export type BlobStoreSettings =
  | { readonly kind: "postgres"; readonly maxBytes: number }
  | {
      readonly kind: "s3";
      readonly maxBytes: number;
      /** `null`: AWS S3's own endpoint. */
      readonly endpoint: string | null;
      readonly bucket: string;
      readonly region: string | null;
      readonly accessKeyId: string;
      /** Never logged. */
      readonly secretAccessKey: string;
    };

export type FirstAdminSettings = {
  readonly email: string;
  readonly username: string;
  /** `null`: the default password (`defaultFirstAdmin.password`), which must be changed at first sign-in. */
  readonly password: string | null;
  readonly organizationName: string;
};

export type SettingsResult =
  | { readonly ok: true; readonly settings: ServerSettings }
  | { readonly ok: false; readonly errors: readonly string[] };

const knownOstraNames: ReadonlySet<string> = new Set<string>([
  ...settingNames,
  ...runnerEnvNames,
  ...devOnlyEnvNames,
  ...taskEnvNames,
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
  const maxBytes = value.OSTRA_BLOB_MAX_MIB * 1024 * 1024;
  let blobStore: BlobStoreSettings = { kind: "postgres", maxBytes };
  if (value.OSTRA_BLOB_STORE === "s3") {
    const bucket = value.OSTRA_S3_BUCKET;
    const accessKeyId = value.OSTRA_S3_ACCESS_KEY_ID;
    const secretAccessKey = value.OSTRA_S3_SECRET_ACCESS_KEY;
    if (bucket === undefined || accessKeyId === undefined || secretAccessKey === undefined) {
      const missing = [
        bucket === undefined ? "OSTRA_S3_BUCKET" : null,
        accessKeyId === undefined ? "OSTRA_S3_ACCESS_KEY_ID" : null,
        secretAccessKey === undefined ? "OSTRA_S3_SECRET_ACCESS_KEY" : null,
      ].flatMap((name) => (name === null ? [] : [`${name} is required with OSTRA_BLOB_STORE=s3`]));
      return { ok: false, errors: missing };
    }
    blobStore = {
      kind: "s3",
      maxBytes,
      endpoint: value.OSTRA_S3_ENDPOINT ?? null,
      bucket,
      region: value.OSTRA_S3_REGION ?? null,
      accessKeyId,
      secretAccessKey,
    };
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
      githubApiUrl: value.OSTRA_GITHUB_API_URL.replace(/\/+$/, ""),
      githubLfsHosts: value.OSTRA_GITHUB_LFS_HOSTS,
      dataDir: value.OSTRA_DATA_DIR ?? (production ? "/var/lib/ostra" : path.join(devDataDir, "server")),
      secretsKey: value.OSTRA_SECRETS_KEY ?? null,
      runnerTokenKey: value.OSTRA_RUNNER_TOKEN_KEY === undefined ? null : decodeKey32(value.OSTRA_RUNNER_TOKEN_KEY),
      catalogFetch: value.OSTRA_CATALOG_FETCH,
      modelEndpointAllowPrivate: value.OSTRA_MODEL_ENDPOINT_ALLOW_PRIVATE,
      openSignupAccounts: value.OSTRA_OPEN_SIGNUP_ACCOUNTS,
      openSignupOrganizations: value.OSTRA_OPEN_SIGNUP_ORGANIZATIONS,
      betterAuthSecret: value.BETTER_AUTH_SECRET ?? null,
      firstAdmin: {
        email: value.OSTRA_ADMIN_EMAIL.toLowerCase(),
        username: value.OSTRA_ADMIN_USERNAME,
        password: value.OSTRA_ADMIN_PASSWORD ?? null,
        organizationName: value.OSTRA_ORGANIZATION_NAME,
      },
      allowDefaultPassword: value.OSTRA_ALLOW_DEFAULT_PASSWORD,
      boxIdleMinutes: value.OSTRA_BOX_IDLE_MINUTES,
      sessionMaxMinutes: value.OSTRA_SESSION_MAX_MINUTES,
      sessionStallMinutes: value.OSTRA_SESSION_STALL_MINUTES,
      taskSpendCapMicroUsd: Math.round(value.OSTRA_TASK_SPEND_CAP_USD * 1_000_000),
      taskTokenCap: value.OSTRA_TASK_TOKEN_CAP,
      trackerPollSeconds: value.OSTRA_TRACKER_POLL_SECONDS,
      reconcileMinutes: value.OSTRA_RECONCILE_MINUTES,
      webhookInsertDeadlineMs: value.OSTRA_WEBHOOK_INSERT_DEADLINE_MS,
      boxReleaseIdleDays: value.OSTRA_BOX_RELEASE_IDLE_DAYS,
      retentionDays: value.OSTRA_RETENTION_DAYS ?? null,
      blobStore,
    },
  };
};
