import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

// Every input this spike reads, validated at the boundary. Secrets come from
// the environment only (docs/development.md); values are never printed.

const optionalString = z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional());
const optionalInt = z.preprocess((v) => (v === '' || v === undefined ? undefined : Number(v)), z.number().int().positive().optional());
const flag = z.preprocess((v) => (v === '' || v === undefined ? '0' : v), z.enum(['0', '1']));

export const INPUT_NAMES = [
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY_PATH',
  'GITHUB_APP_INSTALLATION_ID',
  'GITHUB_TEST_ORG',
  'GITHUB_TEST_REPO',
  'GITHUB_TEST_OTHER_REPO',
  'GITHUB_TEST_MEMBER_LOGIN',
  'GITHUB_TEST_REVIEWER_TOKEN',
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_API_URL',
  'GITHUB_WEB_URL',
  'OSTRA_DEV_PUBLIC_URL',
  'OSTRA_DEV_WEBHOOK_PORT',
  'OSTRA_DEV_CONFIG_DIR',
  'OSTRA_DEV_MANIFEST_PORT',
  'LINEAR_API_URL',
  'LINEAR_API_KEY',
  'LINEAR_TEST_TEAM_ID',
  'SPIKE_LARGE_PACK_MB',
  'SPIKE_GITHUB_LARGE_PACK',
  'SPIKE_KEEP',
] as const;
export type InputName = (typeof INPUT_NAMES)[number];

export const EnvSchema = z
  .object({
    GITHUB_APP_ID: optionalInt,
    GITHUB_APP_PRIVATE_KEY_PATH: optionalString,
    GITHUB_APP_INSTALLATION_ID: optionalInt,
    GITHUB_TEST_ORG: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/).optional()),
    GITHUB_TEST_REPO: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^[A-Za-z0-9._-]{1,100}$/).optional()),
    GITHUB_TEST_OTHER_REPO: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^[A-Za-z0-9._-]{1,100}$/).optional()),
    GITHUB_TEST_MEMBER_LOGIN: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/).optional()),
    GITHUB_TEST_REVIEWER_TOKEN: optionalString,
    GITHUB_WEBHOOK_SECRET: optionalString,
    GITHUB_API_URL: z.preprocess((v) => (v === '' || v === undefined ? 'https://api.github.com' : v), z.url()),
    GITHUB_WEB_URL: z.preprocess((v) => (v === '' || v === undefined ? 'https://github.com' : v), z.url()),
    OSTRA_DEV_PUBLIC_URL: z.preprocess((v) => (v === '' ? undefined : v), z.url().optional()),
    OSTRA_DEV_WEBHOOK_PORT: optionalInt,
    OSTRA_DEV_CONFIG_DIR: optionalString,
    OSTRA_DEV_MANIFEST_PORT: z.preprocess((v) => (v === '' || v === undefined ? 3434 : Number(v)), z.number().int().min(1).max(65535)),
    LINEAR_API_URL: z.preprocess((v) => (v === '' || v === undefined ? 'https://api.linear.app/graphql' : v), z.url()),
    LINEAR_API_KEY: optionalString,
    LINEAR_TEST_TEAM_ID: optionalString,
    SPIKE_LARGE_PACK_MB: z.preprocess((v) => (v === '' || v === undefined ? 500 : Number(v)), z.number().int().nonnegative()),
    SPIKE_GITHUB_LARGE_PACK: flag,
    SPIKE_KEEP: flag,
  })
  .strict();
export type SpikeEnv = z.infer<typeof EnvSchema>;

export const readEnv = (): SpikeEnv => {
  const picked: Record<string, string | undefined> = {};
  for (const name of INPUT_NAMES) picked[name] = process.env[name];
  return EnvSchema.parse(picked);
};

export const configDir = (env: SpikeEnv): string => env.OSTRA_DEV_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'ostra-dev');

export const present = (name: InputName): boolean => {
  const v = process.env[name];
  return v !== undefined && v !== '';
};

export const missing = (names: readonly InputName[]): InputName[] => names.filter((n) => !present(n));

// What each GitHub-side criterion needs.
export const NEEDS = {
  githubApp: ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_PATH', 'GITHUB_TEST_ORG'],
  githubPr: ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_PATH', 'GITHUB_TEST_ORG', 'GITHUB_TEST_REPO'],
  githubGit: ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_PATH', 'GITHUB_TEST_ORG', 'GITHUB_TEST_REPO', 'GITHUB_TEST_OTHER_REPO'],
  coAuthor: ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_PATH', 'GITHUB_TEST_ORG', 'GITHUB_TEST_REPO', 'GITHUB_TEST_MEMBER_LOGIN'],
  checkFlip: [
    'GITHUB_APP_ID',
    'GITHUB_APP_PRIVATE_KEY_PATH',
    'GITHUB_TEST_ORG',
    'GITHUB_TEST_REPO',
    'GITHUB_TEST_MEMBER_LOGIN',
    'GITHUB_TEST_REVIEWER_TOKEN',
  ],
  linear: ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_PATH', 'GITHUB_TEST_ORG', 'GITHUB_TEST_REPO', 'LINEAR_API_KEY', 'LINEAR_TEST_TEAM_ID'],
} as const satisfies Record<string, readonly InputName[]>;

export const DESCRIPTIONS: Readonly<Record<InputName, string>> = {
  GITHUB_APP_ID: "the sandbox GitHub App's ID (github.env, written by `pnpm manifest`)",
  GITHUB_APP_PRIVATE_KEY_PATH: "path to the App's private key .pem, outside the repo (github.env)",
  GITHUB_APP_INSTALLATION_ID: 'optional: the installation on the sandbox org; looked up from GITHUB_TEST_ORG when unset',
  GITHUB_TEST_ORG: 'the sandbox GitHub org (never a real team\'s)',
  GITHUB_TEST_REPO: 'a repo in the sandbox org, with at least one commit, that the App is installed on',
  GITHUB_TEST_OTHER_REPO: "a second sandbox repo, with at least one commit, that the App is also installed on: the 'another repo' refusal reads it to prove nothing landed",
  GITHUB_TEST_MEMBER_LOGIN: 'the GitHub login of the member credited as co-author and treated as the driver',
  GITHUB_TEST_REVIEWER_TOKEN: 'a token of a second sandbox user, not the driver, who approves the PR',
  GITHUB_WEBHOOK_SECRET: "optional: the App's webhook secret; with OSTRA_DEV_WEBHOOK_PORT the check flips from the webhook",
  GITHUB_API_URL: 'optional: defaults to https://api.github.com',
  GITHUB_WEB_URL: 'optional: defaults to https://github.com',
  OSTRA_DEV_PUBLIC_URL: "optional: the dev server's public HTTPS address (tunnel.env), for the manifest's webhook URL",
  OSTRA_DEV_WEBHOOK_PORT: 'optional: the local port the tunnel forwards to',
  OSTRA_DEV_CONFIG_DIR: 'optional: defaults to ~/.config/ostra-dev',
  OSTRA_DEV_MANIFEST_PORT: "optional: the port `pnpm manifest` listens on, default 3434",
  LINEAR_API_URL: 'optional: defaults to https://api.linear.app/graphql',
  LINEAR_API_KEY: 'a key for the Linear test workspace (linear.env)',
  LINEAR_TEST_TEAM_ID: "the test workspace's team ID, where the link probe issue is made",
  SPIKE_LARGE_PACK_MB: 'optional: the large pack size, default 500; 0 skips it',
  SPIKE_GITHUB_LARGE_PACK: 'optional: 1 also pushes the large pack to the sandbox repo on GitHub',
  SPIKE_KEEP: 'optional: 1 keeps the scratch directories and the PR open',
};
