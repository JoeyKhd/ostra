import path from "node:path";

import type { Logger } from "@ostra/adapter-sdk";
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

/** The published docs site (ADR 0063, ticket 21's `siteUrl`): the default of OSTRA_DOCS_URL. */
export const DOCS_SITE_URL = "https://joeykhd.github.io/ostra/";

const lfsHostPattern =/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Every setting's variable. `settingFields` must hold exactly these: the compiler refuses a missing or an extra one. */
export const settingNames = [
  "NODE_ENV",
  "DATABASE_URL",
  "OSTRA_WEB_PORT",
  "OSTRA_CORE_PORT",
  "OSTRA_PUBLIC_URL",
  "OSTRA_CORE_PUBLIC_URL",
  "OSTRA_CORE_INTERNAL_URL",
  "OSTRA_GITHUB_API_URL",
  "OSTRA_GITHUB_LFS_HOSTS",
  "OSTRA_LINEAR_API_URL",
  "OSTRA_DATA_DIR",
  "OSTRA_SECRETS_KEY",
  "OSTRA_RUNNER_TOKEN_KEY",
  "OSTRA_CATALOG_FETCH",
  "OSTRA_MODEL_ENDPOINT_ALLOW_PRIVATE",
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
  // ---- milestone 3 (spec section 5.4) ----
  "OSTRA_EMAIL_PROVIDER",
  "OSTRA_EMAIL_FROM",
  "OSTRA_EMAIL_FROM_NAME",
  "OSTRA_RESEND_API_KEY",
  "OSTRA_SMTP_HOST",
  "OSTRA_SMTP_PORT",
  "OSTRA_SMTP_SECURE",
  "OSTRA_SMTP_USER",
  "OSTRA_SMTP_PASSWORD",
  "OSTRA_EMAIL_DELAY_SECONDS",
  "OSTRA_TRACKER_NOTIFY_COALESCE_MINUTES",
  "OSTRA_CHECK_TIMEOUT_SECONDS",
  "OSTRA_CHECKS_TOTAL_MINUTES",
  "OSTRA_CLI_SESSION_DAYS",
  "OSTRA_SNAPSHOT_NIGHTLY_HOUR",
  "OSTRA_DIFF_MAX_FILES",
  "OSTRA_DIFF_MAX_PATCH_KIB",
  // Milestone 4.
  "OSTRA_INVITATION_DAYS",
  "OSTRA_RESET_LINK_HOURS",
  "OSTRA_BUDGET_WARN_PERCENT",
  "OSTRA_INSIGHTS_INTERVAL_MINUTES",
  "OSTRA_MEMORY_INDEX_MAX_NOTES",
  "OSTRA_MEMORY_INDEX_MAX_KIB",
  "OSTRA_MEMORY_ALWAYS_MAX_KIB",
  "OSTRA_MEMORY_PROPOSALS_PER_TASK",
  "OSTRA_PROJECT_MAX_REPOS",
  "OSTRA_SEARCH_ENTRY_MAX_KIB",
  // Milestone 5 (spec section 5.4).
  "OSTRA_JOIN_TOKEN_DAYS",
  "OSTRA_BOOTSTRAP_JOIN_TOKEN",
  "OSTRA_PERSONAL_RUNNER_CAPACITY",
  "OSTRA_QUEUE_SWEEP_SECONDS",
  "OSTRA_DEV_HOST_POOL_SAME_USER",
  // Milestone 7 (spec section 5.4).
  "OSTRA_DOCS_URL",
  // Milestone 6 (spec section 5.4).
  "OSTRA_SCHEDULE_MIN_INTERVAL_MINUTES",
  "OSTRA_SCHEDULE_MISSED_HOURS",
  "OSTRA_INTAKE_STARTS_PER_HOUR",
  "OSTRA_BULK_START_MAX",
  "OSTRA_SUB_ISSUES_MAX",
  "OSTRA_SUB_ISSUES_DEPTH",
  "OSTRA_LINEAR_HEARTBEAT_MINUTES",
  "OSTRA_LINEAR_HEARTBEAT_KIND",
  "OSTRA_CI_NONE_SECONDS",
  "OSTRA_CI_WAIT_MINUTES",
  "OSTRA_CI_LOG_TAIL_KIB",
  "OSTRA_CI_LOG_CHECKS",
  "OSTRA_CI_ROUNDS",
  "OSTRA_REVIEW_ROUNDS",
  "OSTRA_AUTOMATIC_TURNS",
  "OSTRA_REVIEW_FINDINGS_MAX",
  "OSTRA_DRAFT_IMAGES_MAX",
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
  OSTRA_CORE_INTERNAL_URL: {
    default: "http://127.0.0.1:<OSTRA_CORE_PORT>",
    description: "Core's address as the panel reaches it, to hand it the files a member uploads (a skill's files). Set it only when the panel and core run apart.",
  },
  OSTRA_GITHUB_API_URL: {
    default: "https://api.github.com",
    description: "The GitHub REST API the panel and core talk to: a GitHub Enterprise Server's, or a fake GitHub in tests.",
  },
  OSTRA_LINEAR_API_URL: {
    default: "https://api.linear.app/graphql",
    description: "Linear's GraphQL API the panel and core read and write tickets through: a fake Linear in tests.",
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
    description: "The S3-compatible store's endpoint, such as a MinIO, Garage or R2 URL. Set, the bucket is addressed by path. Read only with OSTRA_BLOB_STORE=s3.",
  },
  OSTRA_S3_BUCKET: {
    default: "unset; required with OSTRA_BLOB_STORE=s3",
    description: "The bucket blobs are kept in. Read only with OSTRA_BLOB_STORE=s3.",
  },
  OSTRA_S3_REGION: {
    default: "unset: us-east-1",
    description: "The store's region, which AWS S3 needs and most other stores ignore. Read only with OSTRA_BLOB_STORE=s3.",
  },
  OSTRA_S3_ACCESS_KEY_ID: {
    default: "unset; required with OSTRA_BLOB_STORE=s3",
    description: "The access key's ID. Read only with OSTRA_BLOB_STORE=s3.",
  },
  OSTRA_S3_SECRET_ACCESS_KEY: {
    default: "unset; required with OSTRA_BLOB_STORE=s3",
    description: "The access key's secret. Never logged. Read only with OSTRA_BLOB_STORE=s3.",
  },
  // ---- milestone 3 ----
  OSTRA_EMAIL_PROVIDER: {
    default: "unset: the panel decides, and mail is off until an admin sets it",
    description: "The install's email (F-115): resend, smtp or off. Set, it locks the panel's email settings to it; unset, an instance admin chooses in the panel, and mail stays off until they do. Everything else works without email.",
  },
  OSTRA_EMAIL_FROM: {
    default: "unset; required with OSTRA_EMAIL_PROVIDER=resend or smtp",
    description: "The address mail comes from, such as ostra@example.com. Its domain must be one the provider sends for.",
  },
  OSTRA_EMAIL_FROM_NAME: {
    default: "ostra",
    description: "The name mail comes from.",
  },
  OSTRA_RESEND_API_KEY: {
    default: "unset; required with OSTRA_EMAIL_PROVIDER=resend",
    description: "Resend's API key. Never logged. Read only when the provider is resend.",
  },
  OSTRA_SMTP_HOST: {
    default: "unset; required with OSTRA_EMAIL_PROVIDER=smtp",
    description: "The SMTP server's host. Read only when the provider is smtp.",
  },
  OSTRA_SMTP_PORT: {
    default: "587",
    description: "The SMTP server's port. Read only when the provider is smtp.",
  },
  OSTRA_SMTP_SECURE: {
    default: "starttls",
    description: "How SMTP is secured: starttls (upgrade a plain connection, port 587), tls (TLS from the start, port 465) or none (a local relay only). Read only when the provider is smtp.",
  },
  OSTRA_SMTP_USER: {
    default: "unset: no sign-in",
    description: "The SMTP user, when the server wants a sign-in. Read only when the provider is smtp.",
  },
  OSTRA_SMTP_PASSWORD: {
    default: "unset",
    description: "The SMTP user's password. Never logged. Read only when the provider is smtp.",
  },
  OSTRA_EMAIL_DELAY_SECONDS: {
    default: "120",
    description: "How long a needs-you mail waits after its moment. It isn't sent if the member read it in the panel meanwhile, or the item closed (ADR 0050).",
  },
  OSTRA_TRACKER_NOTIFY_COALESCE_MINUTES: {
    default: "10",
    description: "Within this many minutes of a task's last notification comment on its ticket, a later moment edits that comment instead of posting a new one (ADR 0050).",
  },
  OSTRA_CHECK_TIMEOUT_SECONDS: {
    default: "600",
    description: "A check's timeout, unless the check sets its own (F-054). At most 3600.",
  },
  OSTRA_CHECKS_TOTAL_MINUTES: {
    default: "30",
    description: "All of a turn's checks together; past it, the rest are timed out (F-054).",
  },
  OSTRA_CLI_SESSION_DAYS: {
    default: "30",
    description: "How long an ostra login session lasts (F-103). A member can revoke one sooner in Account.",
  },
  OSTRA_SNAPSHOT_NIGHTLY_HOUR: {
    default: "3",
    description: "The hour, in UTC (0 to 23), at which projects whose default branch moved get a fresh snapshot (F-051).",
  },
  OSTRA_DIFF_MAX_FILES: {
    default: "300",
    description: "Past this many changed files, the Changes tab links to the code host instead of drawing the diff (F-027).",
  },
  OSTRA_DIFF_MAX_PATCH_KIB: {
    default: "1024",
    description: "A file whose diff is over this many KiB shows \"Too large to show here\", with a link to the code host (F-027).",
  },
  OSTRA_INVITATION_DAYS: {
    default: "7",
    description: "How many days an invitation's link works (F-002). It works once.",
  },
  OSTRA_RESET_LINK_HOURS: {
    default: "24",
    description: "How many hours a password reset link works (F-002). It works once.",
  },
  OSTRA_BUDGET_WARN_PERCENT: {
    default: "80",
    description: "At this share of a monthly budget, its admins are told once, in the panel and by mail (F-037). At 100% new tasks and turns wait.",
  },
  OSTRA_INSIGHTS_INTERVAL_MINUTES: {
    default: "5",
    description: "How often Insights are recomputed (F-108). The page says when they were.",
  },
  OSTRA_MEMORY_INDEX_MAX_NOTES: {
    default: "100",
    description: "The most notes the memory index an agent starts with lists (F-110). The rest are found with search.",
  },
  OSTRA_MEMORY_INDEX_MAX_KIB: {
    default: "8",
    description: "The memory index's size, in KiB (F-110).",
  },
  OSTRA_MEMORY_ALWAYS_MAX_KIB: {
    default: "8",
    description: "The \"always\" notes' size together, in KiB (F-110). An \"always\" note past it is listed in the index instead.",
  },
  OSTRA_MEMORY_PROPOSALS_PER_TASK: {
    default: "20",
    description: "The most memory notes one task's agent may propose (F-111).",
  },
  OSTRA_PROJECT_MAX_REPOS: {
    default: "10",
    description: "The most repos one project holds (F-098). Every task checks them all out side by side.",
  },
  OSTRA_SEARCH_ENTRY_MAX_KIB: {
    default: "8",
    description: "The most text, in KiB, search keeps of one message, tool input or PR (F-080). Longer text is cut.",
  },
  OSTRA_JOIN_TOKEN_DAYS: {
    default: "30",
    description: "A new join token's lifetime in days, for a pool that names none (F-091). 0: tokens never expire.",
  },
  OSTRA_BOOTSTRAP_JOIN_TOKEN: {
    default: "true",
    description:
      "Make the bootstrap join token at first start: one token for the default pool, written to OSTRA_DATA_DIR for the compose file's pool runner (F-013). Made once; one an admin revokes stays revoked. false: make none (the Helm chart sets it).",
  },
  OSTRA_PERSONAL_RUNNER_CAPACITY: {
    default: "2",
    description: "How many tasks a personal runner runs at once, unless its member sets another number on the runner (F-014, F-067).",
  },
  OSTRA_QUEUE_SWEEP_SECONDS: {
    default: "5",
    description: "How often each pool's queue is swept for tasks that now fit, besides the admission every change of room starts (F-067).",
  },
  OSTRA_DEV_HOST_POOL_SAME_USER: {
    default: "false",
    description: "Development and tests only: lets a host pool runner run the agent as its own OS user, labelled \"not isolated, same user (development only)\". Refused as true unless NODE_ENV is development or test.",
  },
  OSTRA_SCHEDULE_MIN_INTERVAL_MINUTES: {
    default: "60",
    description: "The fewest minutes between two occurrences of a schedule (F-106). A schedule that fires more often is refused when it's saved.",
  },
  OSTRA_SCHEDULE_MISSED_HOURS: {
    default: "6",
    description: "How late an occurrence may be and still fire, after the install was down (F-106). Only the latest due one fires; older ones are skipped and audited.",
  },
  OSTRA_INTAKE_STARTS_PER_HOUR: {
    default: "20",
    description: "The most tasks one intake rule starts in an hour (F-011). The next match pauses the rule and tells the project's admins.",
  },
  OSTRA_BULK_START_MAX: {
    default: "50",
    description: "The most tickets a member starts at once, from the Inbox or a dry run's \"Start all\" (F-107).",
  },
  OSTRA_SUB_ISSUES_MAX: {
    default: "50",
    description: "The most sub-issues one start on a parent ticket runs (F-077). More than that starts nothing, and the member is told.",
  },
  OSTRA_SUB_ISSUES_DEPTH: {
    default: "3",
    description: "How many levels of sub-issues below a parent a start reaches (F-077).",
  },
  OSTRA_LINEAR_HEARTBEAT_MINUTES: {
    default: "20",
    description: "How long a Linear agent session may go without a post before ostra posts a heartbeat, so it doesn't look stale (F-012).",
  },
  OSTRA_LINEAR_HEARTBEAT_KIND: {
    default: "ephemeral",
    description: "The heartbeat's kind: `ephemeral` (it replaces itself) or `thought` (it stays in the session).",
  },
  OSTRA_CI_NONE_SECONDS: {
    default: "120",
    description: "How long after a push ostra waits for any check before it decides the repo has no CI (F-035).",
  },
  OSTRA_CI_WAIT_MINUTES: {
    default: "60",
    description: "How long CI may stay pending before the AI review starts anyway, with no fixing round (F-035).",
  },
  OSTRA_CI_LOG_TAIL_KIB: {
    default: "64",
    description: "The most of each failing check's log, in KiB, that reaches the agent as a file (F-035). The tail is kept.",
  },
  OSTRA_CI_LOG_CHECKS: {
    default: "5",
    description: "The most failing checks whose logs reach the agent in one CI round (F-035).",
  },
  OSTRA_CI_ROUNDS: {
    default: "2",
    description: "The most CI rounds a task gets before a person acts (F-035).",
  },
  OSTRA_REVIEW_ROUNDS: {
    default: "2",
    description: "The most findings rounds a task gets before a person acts (F-101).",
  },
  OSTRA_AUTOMATIC_TURNS: {
    default: "4",
    description: "The most automatic turns, CI and findings rounds together, a task gets before a person acts (F-101).",
  },
  OSTRA_REVIEW_FINDINGS_MAX: {
    default: "30",
    description: "The most findings one AI review hands in (F-100).",
  },
  OSTRA_DRAFT_IMAGES_MAX: {
    default: "10",
    description: "The most images a refine draft holds, 10 MiB each (F-099).",
  },
  OSTRA_DOCS_URL: {
    default: DOCS_SITE_URL,
    description: "The docs site's address, which the panel's help links point at. Set it to a copy you host yourself, such as one for your own version.",
  },
} as const satisfies Record<SettingName, { readonly default: string; readonly description: string }>;

/**
 * Settings ostra no longer reads (docs/configuration.md, "Removed settings"). An install upgraded
 * with one still in its environment starts anyway: the variable is ignored, and core and the panel
 * each log one warning for it at start (`warnIgnoredSettings`), so an old env file never stops an
 * upgrade. Unlike an unknown `OSTRA_*` name, which is refused as a typo.
 */
export const retiredSettingNames = ["OSTRA_OPEN_SIGNUP_ACCOUNTS", "OSTRA_OPEN_SIGNUP_ORGANIZATIONS"] as const;

export type RetiredSettingName = (typeof retiredSettingNames)[number];

/** When each retired setting was removed, and why: what its warning says. */
export const retiredSettingFields = {
  OSTRA_OPEN_SIGNUP_ACCOUNTS: {
    removedOn: "2026-11-19",
    reason: "ostra is self-hosted only: sign-up is closed, and accounts join by an admin's invitation (F-002). Remove the variable.",
  },
  OSTRA_OPEN_SIGNUP_ORGANIZATIONS: {
    removedOn: "2026-11-19",
    reason: "ostra is self-hosted only: only the instance admin creates organizations (ADR 0026). Remove the variable.",
  },
} as const satisfies Record<RetiredSettingName, { readonly removedOn: string; readonly reason: string }>;

/** Variables ostra's development setup reads, which the settings don't refuse (docs/development.md). */
export const devOnlyEnvNames = [
  "OSTRA_DEV_MODEL_BASE_URL",
  "OSTRA_DEV_MODEL_API_KEY",
  "OSTRA_DEV_MODEL_ID",
  "OSTRA_DEV_GITHUB_ORG",
  "OSTRA_DEV_GITHUB_REPOS",
  "OSTRA_DEV_PUBLIC_URL",
  "OSTRA_DEV_BLOCK_WEBHOOKS",
  // Milestone 5's dev tools (ticket 36): `pnpm dev`'s core replicas and the fakes' ports.
  "OSTRA_DEV_CORE_REPLICAS",
  "OSTRA_DEV_DATA_DIR",
  "OSTRA_DEV_FAKE_KUBE_PORT",
  "OSTRA_DEV_REGISTRY_PORT",
  "OSTRA_DEV_REGISTRY_AUTH",
  "OSTRA_DEV_NPM_REGISTRY_PORT",
  "OSTRA_DEV_NET_PROXIES_PORT",
  // Milestone 7 (F-083, ticket 20): the panel's pseudo-locale build, for its e2e pass.
  "OSTRA_PSEUDO_LOCALE",
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
  OSTRA_CORE_INTERNAL_URL: url.optional().describe(describe("OSTRA_CORE_INTERNAL_URL")),
  OSTRA_GITHUB_API_URL: url.default("https://api.github.com").describe(describe("OSTRA_GITHUB_API_URL")),
  OSTRA_LINEAR_API_URL: url.default("https://api.linear.app/graphql").describe(describe("OSTRA_LINEAR_API_URL")),
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
  // ---- milestone 3 ----
  OSTRA_EMAIL_PROVIDER: z.enum(["resend", "smtp", "off"]).optional().describe(describe("OSTRA_EMAIL_PROVIDER")),
  OSTRA_EMAIL_FROM: z.email().max(320).optional().describe(describe("OSTRA_EMAIL_FROM")),
  OSTRA_EMAIL_FROM_NAME: z.string().trim().min(1).max(100).regex(/^[^\r\n<>"]+$/, "one line, no angle brackets or quotes").default("ostra").describe(describe("OSTRA_EMAIL_FROM_NAME")),
  OSTRA_RESEND_API_KEY: z.string().min(1).max(512).optional().describe(describe("OSTRA_RESEND_API_KEY")),
  OSTRA_SMTP_HOST: z.string().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/, "a host name").optional().describe(describe("OSTRA_SMTP_HOST")),
  OSTRA_SMTP_PORT: port.default(587).describe(describe("OSTRA_SMTP_PORT")),
  OSTRA_SMTP_SECURE: z.enum(["starttls", "tls", "none"]).default("starttls").describe(describe("OSTRA_SMTP_SECURE")),
  OSTRA_SMTP_USER: z.string().min(1).max(320).optional().describe(describe("OSTRA_SMTP_USER")),
  OSTRA_SMTP_PASSWORD: z.string().min(1).max(512).optional().describe(describe("OSTRA_SMTP_PASSWORD")),
  OSTRA_EMAIL_DELAY_SECONDS: whole(0, 24 * 3600).default(120).describe(describe("OSTRA_EMAIL_DELAY_SECONDS")),
  OSTRA_TRACKER_NOTIFY_COALESCE_MINUTES: whole(0, 24 * 60).default(10).describe(describe("OSTRA_TRACKER_NOTIFY_COALESCE_MINUTES")),
  OSTRA_CHECK_TIMEOUT_SECONDS: whole(1, 3600).default(600).describe(describe("OSTRA_CHECK_TIMEOUT_SECONDS")),
  OSTRA_CHECKS_TOTAL_MINUTES: whole(1, 24 * 60).default(30).describe(describe("OSTRA_CHECKS_TOTAL_MINUTES")),
  OSTRA_CLI_SESSION_DAYS: whole(1, 365).default(30).describe(describe("OSTRA_CLI_SESSION_DAYS")),
  OSTRA_SNAPSHOT_NIGHTLY_HOUR: whole(0, 23).default(3).describe(describe("OSTRA_SNAPSHOT_NIGHTLY_HOUR")),
  OSTRA_DIFF_MAX_FILES: whole(1, 3000).default(300).describe(describe("OSTRA_DIFF_MAX_FILES")),
  OSTRA_DIFF_MAX_PATCH_KIB: whole(1, 16 * 1024).default(1024).describe(describe("OSTRA_DIFF_MAX_PATCH_KIB")),
  OSTRA_INVITATION_DAYS: whole(1, 90).default(7).describe(describe("OSTRA_INVITATION_DAYS")),
  OSTRA_RESET_LINK_HOURS: whole(1, 168).default(24).describe(describe("OSTRA_RESET_LINK_HOURS")),
  OSTRA_BUDGET_WARN_PERCENT: whole(1, 99).default(80).describe(describe("OSTRA_BUDGET_WARN_PERCENT")),
  OSTRA_INSIGHTS_INTERVAL_MINUTES: whole(1, 1440).default(5).describe(describe("OSTRA_INSIGHTS_INTERVAL_MINUTES")),
  OSTRA_MEMORY_INDEX_MAX_NOTES: whole(0, 1000).default(100).describe(describe("OSTRA_MEMORY_INDEX_MAX_NOTES")),
  OSTRA_MEMORY_INDEX_MAX_KIB: whole(1, 8).default(8).describe(describe("OSTRA_MEMORY_INDEX_MAX_KIB")),
  OSTRA_MEMORY_ALWAYS_MAX_KIB: whole(0, 8).default(8).describe(describe("OSTRA_MEMORY_ALWAYS_MAX_KIB")),
  OSTRA_MEMORY_PROPOSALS_PER_TASK: whole(0, 200).default(20).describe(describe("OSTRA_MEMORY_PROPOSALS_PER_TASK")),
  OSTRA_PROJECT_MAX_REPOS: whole(1, 10).default(10).describe(describe("OSTRA_PROJECT_MAX_REPOS")),
  OSTRA_SEARCH_ENTRY_MAX_KIB: whole(1, 8).default(8).describe(describe("OSTRA_SEARCH_ENTRY_MAX_KIB")),
  // Milestone 5.
  OSTRA_JOIN_TOKEN_DAYS: whole(0, 3650).default(30).describe(describe("OSTRA_JOIN_TOKEN_DAYS")),
  OSTRA_BOOTSTRAP_JOIN_TOKEN: flag.default(true).describe(describe("OSTRA_BOOTSTRAP_JOIN_TOKEN")),
  OSTRA_PERSONAL_RUNNER_CAPACITY: whole(1, 64).default(2).describe(describe("OSTRA_PERSONAL_RUNNER_CAPACITY")),
  OSTRA_QUEUE_SWEEP_SECONDS: whole(1, 3600).default(5).describe(describe("OSTRA_QUEUE_SWEEP_SECONDS")),
  OSTRA_DEV_HOST_POOL_SAME_USER: flag.default(false).describe(describe("OSTRA_DEV_HOST_POOL_SAME_USER")),
  // Milestone 7.
  OSTRA_DOCS_URL: url.default(DOCS_SITE_URL).describe(describe("OSTRA_DOCS_URL")),
  // Milestone 6.
  OSTRA_SCHEDULE_MIN_INTERVAL_MINUTES: whole(1, 10_080).default(60).describe(describe("OSTRA_SCHEDULE_MIN_INTERVAL_MINUTES")),
  OSTRA_SCHEDULE_MISSED_HOURS: whole(0, 168).default(6).describe(describe("OSTRA_SCHEDULE_MISSED_HOURS")),
  OSTRA_INTAKE_STARTS_PER_HOUR: whole(1, 1000).default(20).describe(describe("OSTRA_INTAKE_STARTS_PER_HOUR")),
  OSTRA_BULK_START_MAX: whole(1, 500).default(50).describe(describe("OSTRA_BULK_START_MAX")),
  OSTRA_SUB_ISSUES_MAX: whole(1, 500).default(50).describe(describe("OSTRA_SUB_ISSUES_MAX")),
  OSTRA_SUB_ISSUES_DEPTH: whole(1, 10).default(3).describe(describe("OSTRA_SUB_ISSUES_DEPTH")),
  OSTRA_LINEAR_HEARTBEAT_MINUTES: whole(1, 29).default(20).describe(describe("OSTRA_LINEAR_HEARTBEAT_MINUTES")),
  OSTRA_LINEAR_HEARTBEAT_KIND: z.enum(["ephemeral", "thought"]).default("ephemeral").describe(describe("OSTRA_LINEAR_HEARTBEAT_KIND")),
  OSTRA_CI_NONE_SECONDS: whole(10, 3600).default(120).describe(describe("OSTRA_CI_NONE_SECONDS")),
  OSTRA_CI_WAIT_MINUTES: whole(1, 1440).default(60).describe(describe("OSTRA_CI_WAIT_MINUTES")),
  OSTRA_CI_LOG_TAIL_KIB: whole(1, 64).default(64).describe(describe("OSTRA_CI_LOG_TAIL_KIB")),
  OSTRA_CI_LOG_CHECKS: whole(1, 5).default(5).describe(describe("OSTRA_CI_LOG_CHECKS")),
  OSTRA_CI_ROUNDS: whole(0, 10).default(2).describe(describe("OSTRA_CI_ROUNDS")),
  OSTRA_REVIEW_ROUNDS: whole(0, 10).default(2).describe(describe("OSTRA_REVIEW_ROUNDS")),
  OSTRA_AUTOMATIC_TURNS: whole(0, 20).default(4).describe(describe("OSTRA_AUTOMATIC_TURNS")),
  OSTRA_REVIEW_FINDINGS_MAX: whole(1, 30).default(30).describe(describe("OSTRA_REVIEW_FINDINGS_MAX")),
  OSTRA_DRAFT_IMAGES_MAX: whole(0, 50).default(10).describe(describe("OSTRA_DRAFT_IMAGES_MAX")),
});

/** The server's settings, resolved: every default filled in. Holds secrets: never logged whole. */
export type ServerSettings = {
  readonly mode: "development" | "production" | "test";
  /** The retired settings the environment still sets: ignored, and logged once at start (`warnIgnoredSettings`). */
  readonly ignoredSettings: readonly RetiredSettingName[];
  /** Holds credentials: never log it. */
  readonly databaseUrl: string;
  readonly webPort: number;
  readonly corePort: number;
  readonly publicUrl: string;
  readonly corePublicUrl: string;
  /** OSTRA_CORE_INTERNAL_URL: core as the panel reaches it, without a trailing slash. */
  readonly coreInternalUrl: string;
  /** OSTRA_GITHUB_API_URL: the GitHub REST API, without a trailing slash. */
  readonly githubApiUrl: string;
  /** OSTRA_LINEAR_API_URL: Linear's GraphQL endpoint the trackers use (ticket 34: the e2e stack's fake Linear). */
  readonly linearApiUrl: string;
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
  // ---- milestone 3 ----
  /** OSTRA_EMAIL_*: the install's email when settings set it, which locks the panel's; `panel` when they don't. Holds secrets: never logged. */
  readonly email: EmailFromSettings;
  /** OSTRA_EMAIL_DELAY_SECONDS. */
  readonly emailDelaySeconds: number;
  /** OSTRA_TRACKER_NOTIFY_COALESCE_MINUTES. */
  readonly trackerNotifyCoalesceMinutes: number;
  /** OSTRA_CHECK_TIMEOUT_SECONDS. */
  readonly checkTimeoutSeconds: number;
  /** OSTRA_CHECKS_TOTAL_MINUTES. */
  readonly checksTotalMinutes: number;
  /** OSTRA_CLI_SESSION_DAYS. */
  readonly cliSessionDays: number;
  /** OSTRA_SNAPSHOT_NIGHTLY_HOUR, in UTC. */
  readonly snapshotNightlyHour: number;
  /** OSTRA_DIFF_MAX_FILES. */
  readonly diffMaxFiles: number;
  /** OSTRA_DIFF_MAX_PATCH_KIB, in bytes. */
  readonly diffMaxPatchBytes: number;
  /** OSTRA_INVITATION_DAYS. */
  readonly invitationDays: number;
  /** OSTRA_RESET_LINK_HOURS. */
  readonly resetLinkHours: number;
  /** OSTRA_BUDGET_WARN_PERCENT. */
  readonly budgetWarnPercent: number;
  /** OSTRA_INSIGHTS_INTERVAL_MINUTES. */
  readonly insightsIntervalMinutes: number;
  /** OSTRA_MEMORY_INDEX_MAX_NOTES. */
  readonly memoryIndexMaxNotes: number;
  /** OSTRA_MEMORY_INDEX_MAX_KIB, in bytes. */
  readonly memoryIndexMaxBytes: number;
  /** OSTRA_MEMORY_ALWAYS_MAX_KIB, in bytes. */
  readonly memoryAlwaysMaxBytes: number;
  /** OSTRA_MEMORY_PROPOSALS_PER_TASK. */
  readonly memoryProposalsPerTask: number;
  /** OSTRA_PROJECT_MAX_REPOS. */
  readonly projectMaxRepos: number;
  /** OSTRA_SEARCH_ENTRY_MAX_KIB, in bytes. */
  readonly searchEntryMaxBytes: number;
  /** OSTRA_JOIN_TOKEN_DAYS; 0: no expiry. */
  readonly joinTokenDays: number;
  /** OSTRA_BOOTSTRAP_JOIN_TOKEN: whether core makes the bootstrap join token (F-013). */
  readonly bootstrapJoinToken: boolean;
  /** OSTRA_PERSONAL_RUNNER_CAPACITY. */
  readonly personalRunnerCapacity: number;
  /** OSTRA_QUEUE_SWEEP_SECONDS. */
  readonly queueSweepSeconds: number;
  /** OSTRA_DEV_HOST_POOL_SAME_USER: only ever true in development and tests. */
  readonly devHostPoolSameUser: boolean;
  /** OSTRA_DOCS_URL: the docs site, always ending in one slash, so a page's path is appended to it. */
  readonly docsUrl: string;
  /** Milestone 6's working values (spec section 5.4): automations, Linear's agent mode and the review loop. */
  readonly team: TeamSettings;
};

/** Milestone 6's settings, resolved. The rounds are per install in v1. */
export type TeamSettings = {
  /** OSTRA_SCHEDULE_MIN_INTERVAL_MINUTES. */
  readonly scheduleMinIntervalMinutes: number;
  /** OSTRA_SCHEDULE_MISSED_HOURS. */
  readonly scheduleMissedHours: number;
  /** OSTRA_INTAKE_STARTS_PER_HOUR. */
  readonly intakeStartsPerHour: number;
  /** OSTRA_BULK_START_MAX. */
  readonly bulkStartMax: number;
  /** OSTRA_SUB_ISSUES_MAX and OSTRA_SUB_ISSUES_DEPTH. */
  readonly subIssuesMax: number;
  readonly subIssuesDepth: number;
  /** OSTRA_LINEAR_HEARTBEAT_MINUTES, in ms, and OSTRA_LINEAR_HEARTBEAT_KIND. */
  readonly linearHeartbeatMs: number;
  readonly linearHeartbeatKind: "ephemeral" | "thought";
  /** OSTRA_CI_NONE_SECONDS and OSTRA_CI_WAIT_MINUTES, in ms. */
  readonly ciWaits: { readonly noneMs: number; readonly waitMs: number };
  /** OSTRA_CI_LOG_TAIL_KIB, in bytes, and OSTRA_CI_LOG_CHECKS. */
  readonly ciLogTailBytes: number;
  readonly ciLogChecks: number;
  /** OSTRA_CI_ROUNDS, OSTRA_REVIEW_ROUNDS and OSTRA_AUTOMATIC_TURNS. */
  readonly roundLimits: { readonly ciRounds: number; readonly reviewRounds: number; readonly automaticTurns: number };
  /** OSTRA_REVIEW_FINDINGS_MAX. */
  readonly reviewFindingsMax: number;
  /** OSTRA_DRAFT_IMAGES_MAX. */
  readonly draftImagesMax: number;
};

/**
 * The install's email as the settings give it (F-115, ADR 0050). `panel`: no `OSTRA_EMAIL_PROVIDER`,
 * so an instance admin chooses in the panel. The others lock the panel's choice to it.
 */
export type EmailFromSettings =
  | { readonly source: "panel"; readonly fromName: string }
  | { readonly source: "settings"; readonly provider: "off" }
  | {
      readonly source: "settings";
      readonly provider: "resend";
      readonly from: string;
      readonly fromName: string;
      /** Never logged. */
      readonly apiKey: string;
    }
  | {
      readonly source: "settings";
      readonly provider: "smtp";
      readonly from: string;
      readonly fromName: string;
      readonly host: string;
      readonly port: number;
      readonly secure: "starttls" | "tls" | "none";
      readonly user: string | null;
      /** Never logged. */
      readonly password: string | null;
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

const retiredOstraNames: ReadonlySet<string> = new Set<string>(retiredSettingNames);

/** Reads the server's settings from the environment. Never throws; the errors name variables, never values. */
export const parseServerSettings = (env: Readonly<Record<string, string | undefined>>): SettingsResult => {
  const unknown = Object.keys(env).filter(
    (name) => name.startsWith("OSTRA_") && !name.startsWith(SPIKE_PREFIX) && !knownOstraNames.has(name) && !retiredOstraNames.has(name),
  );
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
  if (production && value.OSTRA_DEV_HOST_POOL_SAME_USER) {
    return {
      ok: false,
      errors: ["OSTRA_DEV_HOST_POOL_SAME_USER is for development and tests only: a host pool runs the agent as its own OS user (OSTRA_HOST_POOL_AGENT_USER)"],
    };
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
  const email = emailFromSettings(value);
  if (!email.ok) {
    return { ok: false, errors: email.errors };
  }
  return {
    ok: true,
    settings: {
      mode: value.NODE_ENV,
      // Set as any other setting is: present and not empty. Never read past this.
      ignoredSettings: retiredSettingNames.filter((name) => {
        const set = env[name];
        return set !== undefined && set !== "";
      }),
      databaseUrl: value.DATABASE_URL ?? devDatabaseUrl(devPgPort(env)),
      webPort: value.OSTRA_WEB_PORT,
      corePort: value.OSTRA_CORE_PORT,
      publicUrl: value.OSTRA_PUBLIC_URL,
      corePublicUrl: value.OSTRA_CORE_PUBLIC_URL,
      coreInternalUrl: (value.OSTRA_CORE_INTERNAL_URL ?? `http://127.0.0.1:${String(value.OSTRA_CORE_PORT)}`).replace(/\/+$/, ""),
      githubApiUrl: value.OSTRA_GITHUB_API_URL.replace(/\/+$/, ""),
      linearApiUrl: value.OSTRA_LINEAR_API_URL,
      githubLfsHosts: value.OSTRA_GITHUB_LFS_HOSTS,
      dataDir: value.OSTRA_DATA_DIR ?? (production ? "/var/lib/ostra" : path.join(devDataDir, "server")),
      secretsKey: value.OSTRA_SECRETS_KEY ?? null,
      runnerTokenKey: value.OSTRA_RUNNER_TOKEN_KEY === undefined ? null : decodeKey32(value.OSTRA_RUNNER_TOKEN_KEY),
      catalogFetch: value.OSTRA_CATALOG_FETCH,
      modelEndpointAllowPrivate: value.OSTRA_MODEL_ENDPOINT_ALLOW_PRIVATE,
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
      email: email.value,
      emailDelaySeconds: value.OSTRA_EMAIL_DELAY_SECONDS,
      trackerNotifyCoalesceMinutes: value.OSTRA_TRACKER_NOTIFY_COALESCE_MINUTES,
      checkTimeoutSeconds: value.OSTRA_CHECK_TIMEOUT_SECONDS,
      checksTotalMinutes: value.OSTRA_CHECKS_TOTAL_MINUTES,
      cliSessionDays: value.OSTRA_CLI_SESSION_DAYS,
      snapshotNightlyHour: value.OSTRA_SNAPSHOT_NIGHTLY_HOUR,
      diffMaxFiles: value.OSTRA_DIFF_MAX_FILES,
      diffMaxPatchBytes: value.OSTRA_DIFF_MAX_PATCH_KIB * 1024,
      invitationDays: value.OSTRA_INVITATION_DAYS,
      resetLinkHours: value.OSTRA_RESET_LINK_HOURS,
      budgetWarnPercent: value.OSTRA_BUDGET_WARN_PERCENT,
      insightsIntervalMinutes: value.OSTRA_INSIGHTS_INTERVAL_MINUTES,
      memoryIndexMaxNotes: value.OSTRA_MEMORY_INDEX_MAX_NOTES,
      memoryIndexMaxBytes: value.OSTRA_MEMORY_INDEX_MAX_KIB * 1024,
      memoryAlwaysMaxBytes: value.OSTRA_MEMORY_ALWAYS_MAX_KIB * 1024,
      memoryProposalsPerTask: value.OSTRA_MEMORY_PROPOSALS_PER_TASK,
      projectMaxRepos: value.OSTRA_PROJECT_MAX_REPOS,
      searchEntryMaxBytes: value.OSTRA_SEARCH_ENTRY_MAX_KIB * 1024,
      joinTokenDays: value.OSTRA_JOIN_TOKEN_DAYS,
      bootstrapJoinToken: value.OSTRA_BOOTSTRAP_JOIN_TOKEN,
      personalRunnerCapacity: value.OSTRA_PERSONAL_RUNNER_CAPACITY,
      queueSweepSeconds: value.OSTRA_QUEUE_SWEEP_SECONDS,
      devHostPoolSameUser: value.OSTRA_DEV_HOST_POOL_SAME_USER,
      docsUrl: `${value.OSTRA_DOCS_URL.replace(/\/+$/, "")}/`,
      team: {
        scheduleMinIntervalMinutes: value.OSTRA_SCHEDULE_MIN_INTERVAL_MINUTES,
        scheduleMissedHours: value.OSTRA_SCHEDULE_MISSED_HOURS,
        intakeStartsPerHour: value.OSTRA_INTAKE_STARTS_PER_HOUR,
        bulkStartMax: value.OSTRA_BULK_START_MAX,
        subIssuesMax: value.OSTRA_SUB_ISSUES_MAX,
        subIssuesDepth: value.OSTRA_SUB_ISSUES_DEPTH,
        linearHeartbeatMs: value.OSTRA_LINEAR_HEARTBEAT_MINUTES * 60_000,
        linearHeartbeatKind: value.OSTRA_LINEAR_HEARTBEAT_KIND,
        ciWaits: { noneMs: value.OSTRA_CI_NONE_SECONDS * 1000, waitMs: value.OSTRA_CI_WAIT_MINUTES * 60_000 },
        ciLogTailBytes: value.OSTRA_CI_LOG_TAIL_KIB * 1024,
        ciLogChecks: value.OSTRA_CI_LOG_CHECKS,
        roundLimits: { ciRounds: value.OSTRA_CI_ROUNDS, reviewRounds: value.OSTRA_REVIEW_ROUNDS, automaticTurns: value.OSTRA_AUTOMATIC_TURNS },
        reviewFindingsMax: value.OSTRA_REVIEW_FINDINGS_MAX,
        draftImagesMax: value.OSTRA_DRAFT_IMAGES_MAX,
      },
    },
  };
};

/**
 * One warning per retired setting the environment still sets: its name, when it was removed and
 * why, never its value. Core (`startCore`) and the panel (`createApiRuntime`) call it once at start.
 */
export const warnIgnoredSettings = (logger: Logger, settings: Pick<ServerSettings, "ignoredSettings">): void => {
  for (const name of settings.ignoredSettings) {
    const { removedOn, reason } = retiredSettingFields[name];
    logger.warn("settings.retired_ignored", { setting: name, removedOn, reason });
  }
};

/** The email settings, checked: a locked provider needs what it sends with. The errors name variables, never values. */
const emailFromSettings = (
  value: z.infer<typeof rawSettingsSchema>,
): { readonly ok: true; readonly value: EmailFromSettings } | { readonly ok: false; readonly errors: readonly string[] } => {
  const provider = value.OSTRA_EMAIL_PROVIDER;
  const fromName = value.OSTRA_EMAIL_FROM_NAME;
  if (provider === undefined) {
    return { ok: true, value: { source: "panel", fromName } };
  }
  if (provider === "off") {
    return { ok: true, value: { source: "settings", provider: "off" } };
  }
  const from = value.OSTRA_EMAIL_FROM;
  if (provider === "resend") {
    const apiKey = value.OSTRA_RESEND_API_KEY;
    if (from === undefined || apiKey === undefined) {
      const missing = [from === undefined ? "OSTRA_EMAIL_FROM" : null, apiKey === undefined ? "OSTRA_RESEND_API_KEY" : null];
      return { ok: false, errors: missing.flatMap((name) => (name === null ? [] : [`${name} is required with OSTRA_EMAIL_PROVIDER=resend`])) };
    }
    return { ok: true, value: { source: "settings", provider, from, fromName, apiKey } };
  }
  const host = value.OSTRA_SMTP_HOST;
  if (from === undefined || host === undefined) {
    const missing = [from === undefined ? "OSTRA_EMAIL_FROM" : null, host === undefined ? "OSTRA_SMTP_HOST" : null];
    return { ok: false, errors: missing.flatMap((name) => (name === null ? [] : [`${name} is required with OSTRA_EMAIL_PROVIDER=smtp`])) };
  }
  return {
    ok: true,
    value: {
      source: "settings",
      provider,
      from,
      fromName,
      host,
      port: value.OSTRA_SMTP_PORT,
      secure: value.OSTRA_SMTP_SECURE,
      user: value.OSTRA_SMTP_USER ?? null,
      password: value.OSTRA_SMTP_PASSWORD ?? null,
    },
  };
};
