import { z } from 'zod';
import { startGitProxy } from '../git-proxy.ts';
import { httpStatus } from '../github/errors.ts';
import { RepoSlugSchema, type RepoSlug } from '../ids.ts';
import type { SpikeEnv } from '../inputs.ts';
import type { Logger } from '../log.ts';
import { findInstallationId, mintRepoToken, tokenOctokit, tokenProvider, type AppCredentials, type MintedToken } from '../github/app-auth.ts';
import type { GitTarget, PushActivity } from './target.ts';

// github.com as the upstream. The proxy gets an installation token for the
// one sandbox repo, contents: write only. The harness reads refs and GitHub's
// activity log with a separate read-only token for both sandbox repos, and
// cleans up with a third, never through the agent's side.

const apiRef = (ref: string): string => ref.replace(/^refs\//, '');

// GET /repos/{owner}/{repo}/activity. A vendor format: unknown fields are
// tolerated.
const ActivitySchema = z.array(
  z.object({ id: z.number(), ref: z.string(), after: z.string(), timestamp: z.string(), activity_type: z.string() }).loose(),
);

export const startGitHubTarget = async (creds: AppCredentials, env: SpikeEnv, logger: Logger): Promise<GitTarget> => {
  const org = env.GITHUB_TEST_ORG;
  const name = env.GITHUB_TEST_REPO;
  const otherName = env.GITHUB_TEST_OTHER_REPO;
  if (org === undefined || name === undefined || otherName === undefined) {
    throw new Error('GITHUB_TEST_ORG, GITHUB_TEST_REPO and GITHUB_TEST_OTHER_REPO are required');
  }
  const installationId = await findInstallationId(creds, org, env.GITHUB_APP_INSTALLATION_ID);
  const repo = RepoSlugSchema.parse(`${org}/${name}`);
  const otherRepo = RepoSlugSchema.parse(`${org}/${otherName}`);
  const minted: string[] = [];
  const mint = async (): Promise<MintedToken> => {
    const t = await mintRepoToken(creds, installationId, [name], { contents: 'write' });
    minted.push(t.token);
    return t;
  };
  const getToken = tokenProvider(mint);
  // The harness's reads: both repos, read only. Minting it fails unless the
  // App is installed on the other repo too, so a 404 there later means the
  // ref is absent, not that the repo can't be seen.
  const reader = await mintRepoToken(creds, installationId, [name, otherName], { contents: 'read' }).catch((err: unknown) => {
    throw new Error(
      `could not mint a read token for ${repo} and ${otherRepo} (status ${String(httpStatus(err) ?? 'none')}): is the App installed on both?`,
    );
  });
  minted.push(reader.token);
  const read = tokenOctokit(creds.apiUrl, reader.token);
  // The harness's cleanup: the task repo only.
  const admin = await mintRepoToken(creds, installationId, [name], { contents: 'write' });
  minted.push(admin.token);
  const api = tokenOctokit(creds.apiUrl, admin.token);
  const { data: repoData } = await read.rest.repos.get({ owner: org, repo: name });
  await read.rest.repos.get({ owner: org, repo: otherName });
  logger.info('github.target.ready', { repo, otherRepo, installationId });
  const webBase = env.GITHUB_WEB_URL.endsWith('/') ? env.GITHUB_WEB_URL : `${env.GITHUB_WEB_URL}/`;
  const split = (slug: RepoSlug): { owner: string; repo: string } => {
    const [owner, repoName] = slug.split('/');
    if (owner === undefined || repoName === undefined) throw new Error('bad repo slug');
    return { owner, repo: repoName };
  };

  return {
    label: 'GitHub',
    repo,
    otherRepo,
    defaultBranch: repoData.default_branch,
    publicBase: webBase,
    secrets: () => [...minted],
    startProxy: (policy, override) => startGitProxy({ policy, upstream: { baseUrl: new URL(webBase), getToken: override ?? getToken }, logger }),
    expiringTokens: (validForMs) => {
      let mints = 0;
      // Real tokens, re-minted for real; only the expiry the provider sees is
      // brought forward, since GitHub's last an hour.
      const provider = tokenProvider(async () => {
        const t = await mint();
        mints += 1;
        return { token: t.token, expiresAt: new Date(Date.now() + 5 * 60_000 + validForMs).toISOString() };
      });
      return { getToken: provider, mints: () => mints };
    },
    expiredToken: null,
    refOnUpstream: async (slug, ref) => {
      try {
        const { data } = await read.rest.git.getRef({ ...split(slug), ref: apiRef(ref) });
        return data.object.sha;
      } catch (err: unknown) {
        if (httpStatus(err) === 404) return null;
        throw err;
      }
    },
    upstreamStats: null,
    pushActivity: async (slug): Promise<readonly PushActivity[]> => {
      const { data } = await read.request('GET /repos/{owner}/{repo}/activity', { ...split(slug), per_page: 100, direction: 'desc' });
      return ActivitySchema.parse(data).map((a) => ({ id: a.id, ref: a.ref, after: a.after, at: a.timestamp, type: a.activity_type }));
    },
    lfsRedirectProbe: false,
    direct: null,
    largeFileMb: 50,
    cleanupRefs: async (refs) => {
      if (env.SPIKE_KEEP === '1') return [];
      const left: string[] = [];
      for (const ref of refs) {
        try {
          await api.rest.git.deleteRef({ owner: org, repo: name, ref: apiRef(ref) });
        } catch (err: unknown) {
          const status = httpStatus(err);
          // 422: the ref doesn't exist, which is what cleanup wants.
          if (status === 422 || status === 404) continue;
          left.push(`${repo}:${ref}`);
          logger.info('cleanup.failed', { repo, ref, status: status ?? null });
        }
      }
      return left;
    },
    close: () => Promise.resolve(),
  };
};
