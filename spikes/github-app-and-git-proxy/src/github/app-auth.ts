import { readFile } from 'node:fs/promises';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import type { SpikeEnv } from '../inputs.ts';

// The App's credentials, from the environment and the key file it names.
// Tokens are minted per repo with only the permissions a step needs.

export type AppCredentials = {
  readonly appId: number;
  readonly privateKey: string;
  readonly apiUrl: string;
};

export type RepoPermissions = Readonly<
  Partial<Record<'contents' | 'pull_requests' | 'checks' | 'issues' | 'metadata', 'read' | 'write'>>
>;

export type MintedToken = { readonly token: string; readonly expiresAt: string };

export const loadAppCredentials = async (env: SpikeEnv): Promise<AppCredentials | null> => {
  if (env.GITHUB_APP_ID === undefined || env.GITHUB_APP_PRIVATE_KEY_PATH === undefined) return null;
  const privateKey = await readFile(env.GITHUB_APP_PRIVATE_KEY_PATH, 'utf8');
  return { appId: env.GITHUB_APP_ID, privateKey, apiUrl: env.GITHUB_API_URL };
};

// Authenticated as the App itself (a JWT): GET /app, installations.
export const appOctokit = (creds: AppCredentials): Octokit =>
  new Octokit({ baseUrl: creds.apiUrl, authStrategy: createAppAuth, auth: { appId: creds.appId, privateKey: creds.privateKey } });

export const findInstallationId = async (creds: AppCredentials, org: string, explicit: number | undefined): Promise<number> => {
  if (explicit !== undefined) return explicit;
  const { data } = await appOctokit(creds).rest.apps.getOrgInstallation({ org });
  return data.id;
};

export const mintRepoToken = async (
  creds: AppCredentials,
  installationId: number,
  repoNames: readonly string[],
  permissions: RepoPermissions,
): Promise<MintedToken> => {
  const auth = createAppAuth({ appId: creds.appId, privateKey: creds.privateKey });
  const result = await auth({ type: 'installation', installationId, repositoryNames: [...repoNames], permissions: { ...permissions } });
  return { token: result.token, expiresAt: result.expiresAt };
};

// A token provider for the git proxy: re-mints five minutes before expiry.
export const tokenProvider = (mint: () => Promise<MintedToken>): (() => Promise<string>) => {
  let current: MintedToken | null = null;
  let inflight: Promise<MintedToken> | null = null;
  return async () => {
    if (current !== null && Date.parse(current.expiresAt) - Date.now() > 5 * 60_000) return current.token;
    inflight ??= mint().finally(() => {
      inflight = null;
    });
    current = await inflight;
    return current.token;
  };
};

export const tokenOctokit = (apiUrl: string, token: string): Octokit => new Octokit({ baseUrl: apiUrl, auth: token });
