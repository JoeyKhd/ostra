import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { mintFakeToken } from '../fake-token.ts';
import { startGitProxy } from '../git-proxy.ts';
import { tokenProvider } from '../github/app-auth.ts';
import { runGit } from '../git.ts';
import { RepoSlugSchema, type RepoSlug } from '../ids.ts';
import type { Logger } from '../log.ts';
import { killTree, spawnTracked } from '../proc.ts';
import { StubStatsSchema, type StubStats } from '../upstream-stub.ts';
import type { GitTarget } from './target.ts';

export const STUB_MAIN = fileURLToPath(new URL('../upstream-stub-main.ts', import.meta.url));

// The stub's first line on stdout. Ours, so unknown fields are refused.
const StubStartSchema = z.object({ port: z.number().int().min(1).max(65535) }).strict();

const TOKEN_LIFETIME_MS = 60 * 60_000;

const seedEnv = (home: string): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR', 'TEMP', 'TMP'] as const) {
    const v = process.env[name];
    if (v !== undefined) env[name] = v;
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'seed',
    GIT_AUTHOR_EMAIL: 'seed@example.invalid',
    GIT_COMMITTER_NAME: 'seed',
    GIT_COMMITTER_EMAIL: 'seed@example.invalid',
  };
};

const must = async (args: readonly string[], cwd: string, env: Record<string, string>): Promise<string> => {
  const r = await runGit(args, { cwd, env });
  if (r.code !== 0) throw new Error(`seed git ${args[0] ?? ''} failed: ${r.stderr.slice(-400)}`);
  return r.stdout.trim();
};

export const startLocalTarget = async (root: string, logger: Logger): Promise<GitTarget> => {
  const owner = 'ostra-sandbox';
  const repo = RepoSlugSchema.parse(`${owner}/spike-repo`);
  const otherRepo = RepoSlugSchema.parse(`${owner}/other-repo`);
  const reposDir = path.join(root, 'upstream', 'repos');
  const lfsDir = path.join(root, 'upstream', 'lfs');
  const seedHome = path.join(root, 'seed-home');
  const seedWork = path.join(root, 'seed-work');
  await mkdir(seedHome, { recursive: true });
  await mkdir(lfsDir, { recursive: true });
  const env = seedEnv(seedHome);
  const bareOf = (slug: RepoSlug): string => {
    const [o, n] = slug.split('/');
    return path.join(reposDir, o ?? '', `${n ?? ''}.git`);
  };
  for (const slug of [repo, otherRepo]) {
    const bare = bareOf(slug);
    await mkdir(bare, { recursive: true });
    await must(['init', '--bare', '-b', 'main', bare], root, env);
    await must(['-C', bare, 'config', 'uploadpack.allowFilter', 'true'], root, env);
    await must(['-C', bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true'], root, env);
    // GitHub does not deny deletes for an unprotected branch either, so a
    // refused delete below is the proxy's doing.
    await must(['-C', bare, 'config', 'receive.denyDeletes', 'false'], root, env);
  }
  await must(['init', '-b', 'main', seedWork], root, env);
  for (let i = 1; i <= 3; i += 1) {
    await writeFile(path.join(seedWork, 'README.md'), `# spike repo\n\nseed commit ${String(i)}\n`, 'utf8');
    await must(['-C', seedWork, 'add', 'README.md'], root, env);
    await must(['-C', seedWork, 'commit', '-m', `seed ${String(i)}`], root, env);
  }
  for (const slug of [repo, otherRepo]) await must(['-C', seedWork, 'push', bareOf(slug), 'main:main'], root, env);

  // Fake credentials in GitHub's shapes (fake-token.ts). Not secrets, but the
  // agent must never see them, exactly as if they were.
  const tokenKey = randomBytes(30).toString('base64url');
  const lfsToken = randomBytes(30).toString('base64url');
  const minted: string[] = [];
  const mint = (validForMs: number): { token: string; expiresAt: string } => {
    const t = mintFakeToken(tokenKey, validForMs);
    minted.push(t.token);
    return t;
  };
  const getToken = tokenProvider(() => Promise.resolve(mint(TOKEN_LIFETIME_MS)));

  const stub = spawnTracked(process.execPath, [STUB_MAIN], { stdio: ['pipe', 'pipe', 'inherit'] });
  const { stdin, stdout } = stub;
  if (stdin === null || stdout === null) throw new Error('stub has no stdio');
  const port = await new Promise<number>((resolve, reject) => {
    let data = '';
    const timer = setTimeout(() => {
      reject(new Error('stub did not start'));
    }, 15_000);
    stdout.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
      const nl = data.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      try {
        resolve(StubStartSchema.parse(JSON.parse(data.slice(0, nl))).port);
      } catch {
        reject(new Error('stub sent a bad start line'));
      }
    });
    stdin.write(`${JSON.stringify({ reposDir, lfsDir, tokenKey, lfsToken })}\n`);
  });
  const base = `http://127.0.0.1:${String(port)}`;
  logger.info('local.upstream.started', { port });

  const stats = async (): Promise<StubStats> => {
    const res = await fetch(`${base}/_stub/stats`);
    return StubStatsSchema.parse(await res.json());
  };

  return {
    label: 'local stand-in',
    repo,
    otherRepo,
    defaultBranch: 'main',
    publicBase: 'https://github.com/',
    secrets: () => [tokenKey, lfsToken, ...minted],
    startProxy: (policy, override) =>
      startGitProxy({ policy, upstream: { baseUrl: new URL(`${base}/`), getToken: override ?? getToken }, logger }),
    expiringTokens: (validForMs) => {
      let mints = 0;
      // The token itself is valid for an hour; the provider is told it
      // expires in five minutes plus validForMs, so it re-mints that soon.
      const provider = tokenProvider(() => {
        mints += 1;
        const t = mint(TOKEN_LIFETIME_MS);
        return Promise.resolve({ token: t.token, expiresAt: new Date(Date.now() + 5 * 60_000 + validForMs).toISOString() });
      });
      return { getToken: provider, mints: () => mints };
    },
    expiredToken: () => mint(-1000).token,
    refOnUpstream: async (slug, ref) => {
      const r = await runGit(['--git-dir', bareOf(slug), 'rev-parse', '--verify', '--quiet', ref], { cwd: root, env });
      return r.code === 0 ? r.stdout.trim() : null;
    },
    upstreamStats: stats,
    pushActivity: null,
    lfsRedirectProbe: true,
    // The baseline's credential goes through the environment
    // (GIT_CONFIG_COUNT), never argv, where any process listing would show it.
    direct: () => ({
      url: `${base}/${repo}.git`,
      env: {
        ...env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.extraHeader',
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${mint(TOKEN_LIFETIME_MS).token}`).toString('base64')}`,
      },
    }),
    largeFileMb: 50,
    cleanupRefs: () => Promise.resolve([]),
    close: async () => {
      stdin.end();
      await killTree(stub);
    },
  };
};
