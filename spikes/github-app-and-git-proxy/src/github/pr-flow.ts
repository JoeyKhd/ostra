import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { startGitProxy } from '../git-proxy.ts';
import { makeAgentWorld, runGit, type GitResult } from '../git.ts';
import { RepoSlugSchema, TaskIdSchema } from '../ids.ts';
import type { SpikeEnv } from '../inputs.ts';
import type { Logger } from '../log.ts';
import type { TaskGitPolicy } from '../policy.ts';
import type { Check, GroupResult } from '../harness/git-scenarios.ts';
import { archiveIssue, createIssue, issueAttachmentUrls, type LinearClient, type LinearIssue } from '../linear/linear-api.ts';
import { trackServer } from '../proc.ts';
import { httpStatus } from './errors.ts';
import { appOctokit, findInstallationId, mintRepoToken, tokenOctokit, tokenProvider, type AppCredentials } from './app-auth.ts';
import { CHECK_NAME, evaluateIndependentReview, readWebhook, type ReviewLite, type ReviewState } from './independent-review.ts';

// On the sandbox org: the box commits as the App's bot with a co-author
// trailer and pushes through the proxy, the App opens the PR, posts a
// comment-type review with line comments on it, and publishes the
// independent-review check, which flips when a second user approves.

export type PrFlowReport = {
  readonly coAuthor: GroupResult;
  readonly review: GroupResult;
  readonly checkFlip: GroupResult;
  readonly linear: GroupResult;
  readonly metrics: Readonly<Record<string, number | string>>;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// The webhook receiver sits behind a public tunnel: bodies are capped, and a
// slow request is cut off.
const MAX_WEBHOOK_BYTES = 1024 * 1024;
const WEBHOOK_REQUEST_TIMEOUT_MS = 10_000;

const AuthorsSchema = z
  .object({
    repository: z
      .object({
        object: z
          .object({
            authors: z
              .object({
                nodes: z.array(z.object({ name: z.string().nullable(), user: z.object({ login: z.string() }).loose().nullable() }).loose()),
              })
              .loose(),
          })
          .loose()
          .nullable(),
      })
      .loose(),
  })
  .loose();

const REVIEW_STATES = ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING'] as const satisfies readonly ReviewState[];
const ReviewStateSchema = z.enum(REVIEW_STATES);

export const runPrFlow = async (
  creds: AppCredentials,
  env: SpikeEnv,
  root: string,
  logger: Logger,
): Promise<PrFlowReport> => {
  const org = env.GITHUB_TEST_ORG;
  const name = env.GITHUB_TEST_REPO;
  if (org === undefined || name === undefined) throw new Error('GITHUB_TEST_ORG and GITHUB_TEST_REPO are required');
  const metrics: Record<string, number | string> = {};
  const repo = RepoSlugSchema.parse(`${org}/${name}`);
  const installationId = await findInstallationId(creds, org, env.GITHUB_APP_INSTALLATION_ID);
  const { data: app } = await appOctokit(creds).rest.apps.getAuthenticated();
  if (app === null) throw new Error('GET /app returned nothing');
  const slug = app.slug ?? '';
  const minted = await mintRepoToken(creds, installationId, [name], { contents: 'write', pull_requests: 'write', checks: 'write' });
  const api = tokenOctokit(creds.apiUrl, minted.token);
  const botLogin = `${slug}[bot]`;
  const { data: bot } = await api.rest.users.getByUsername({ username: botLogin });
  const botEmail = `${String(bot.id)}+${botLogin}@users.noreply.github.com`;
  const { data: repoData } = await api.rest.repos.get({ owner: org, repo: name });
  const base = repoData.default_branch;

  // The member credited as co-author, and the task's driver.
  const memberLogin = env.GITHUB_TEST_MEMBER_LOGIN;
  let trailer: string | null = null;
  if (memberLogin !== undefined) {
    const { data: member } = await api.rest.users.getByUsername({ username: memberLogin });
    const display = (member.name ?? member.login).replace(/[\r\n<>]/g, ' ').trim();
    trailer = `Co-authored-by: ${display} <${String(member.id)}+${member.login}@users.noreply.github.com>`;
  }

  // An optional Linear issue, so one PR also serves the link check.
  let issue: LinearIssue | null = null;
  const linearClient: LinearClient | null = env.LINEAR_API_KEY === undefined ? null : { apiKey: env.LINEAR_API_KEY, url: env.LINEAR_API_URL };
  if (linearClient !== null && env.LINEAR_TEST_TEAM_ID !== undefined) {
    issue = await createIssue(linearClient, env.LINEAR_TEST_TEAM_ID, 'ostra spike 4: link probe');
  }

  const taskId = TaskIdSchema.parse(`spike4-pr-${randomBytes(3).toString('hex')}`);
  const branch = issue === null ? `ostra/${taskId}` : `ostra/${issue.identifier.toLowerCase()}-${taskId}`;
  const policy: TaskGitPolicy = { taskId, repo, branches: [branch], mode: 'read-write' };
  const getToken = tokenProvider(() => mintRepoToken(creds, installationId, [name], { contents: 'write' }));
  const webBase = env.GITHUB_WEB_URL.endsWith('/') ? env.GITHUB_WEB_URL : `${env.GITHUB_WEB_URL}/`;
  const proxy = await startGitProxy({ policy, upstream: { baseUrl: new URL(webBase), getToken }, logger });
  const world = await makeAgentWorld(path.join(root, 'pr-agent'), proxy.url, { trace: false, publicBase: webBase });
  const work = path.join(world.workspace, 'work');
  const git = (args: readonly string[], cwd: string): Promise<GitResult> => runGit(args, { cwd, env: world.env });

  const coAuthor: Check[] = [];
  const review: Check[] = [];
  const flip: Check[] = [];
  const linear: Check[] = [];
  let prNumber: number | null = null;
  try {
    const clone = await git(['clone', '-q', `${webBase}${repo}.git`, work], world.workspace);
    if (clone.code !== 0) throw new Error('clone through the proxy failed');
    await git(['switch', '-q', '-c', branch], work);
    const rel = `spike-4/${taskId}.md`;
    await mkdir(path.join(work, 'spike-4'), { recursive: true });
    await writeFile(
      path.join(work, rel),
      ['# Spike 4 probe', '', 'Line three.', 'Line four.', 'Line five has a review comment.', 'Line six.', 'Line seven.', ''].join('\n'),
      'utf8',
    );
    await git(['add', rel], work);
    const message = `spike 4: probe ${taskId}${trailer === null ? '' : `\n\n${trailer}`}`;
    const commit = await git(['-c', `user.name=${botLogin}`, '-c', `user.email=${botEmail}`, 'commit', '-q', '-m', message], work);
    if (commit.code !== 0) throw new Error('commit failed');
    const push = await git(['push', 'origin', `HEAD:refs/heads/${branch}`], work);
    if (push.code !== 0) throw new Error('push through the proxy failed');
    const headSha = (await git(['rev-parse', 'HEAD'], work)).stdout.trim();

    const { data: pr } = await api.rest.pulls.create({
      owner: org,
      repo: name,
      head: branch,
      base,
      title: `${issue === null ? '' : `${issue.identifier} `}spike 4 probe ${taskId}`,
      body: `${issue === null ? '' : `Fixes ${issue.identifier}\n\n`}Opened by the ostra spike 4 harness on the sandbox org. Safe to close.`,
    });
    prNumber = pr.number;
    metrics['prNumber'] = pr.number;
    const openedByApp = pr.user.login === botLogin;
    coAuthor.push({ name: 'the App opened the PR', ok: openedByApp, detail: `#${String(pr.number)} by ${openedByApp ? botLogin : 'someone else'}` });

    // ---- co-author
    if (memberLogin === undefined) {
      coAuthor.push({ name: 'the member shows as co-author', ok: false, detail: 'GITHUB_TEST_MEMBER_LOGIN is missing' });
    } else {
      let logins: string[] = [];
      for (let attempt = 0; attempt < 10 && !logins.some((l) => l.toLowerCase() === memberLogin.toLowerCase()); attempt += 1) {
        const raw: unknown = await api.graphql(
          'query($owner: String!, $name: String!, $oid: GitObjectID!) { repository(owner: $owner, name: $name) { object(oid: $oid) { ... on Commit { authors(first: 10) { nodes { name user { login } } } } } } }',
          { owner: org, name, oid: headSha },
        );
        const parsed = AuthorsSchema.parse(raw);
        logins = (parsed.repository.object?.authors.nodes ?? []).flatMap((n) => (n.user === null ? [] : [n.user.login]));
        if (!logins.some((l) => l.toLowerCase() === memberLogin.toLowerCase())) await sleep(2000);
      }
      const ok = logins.some((l) => l.toLowerCase() === memberLogin.toLowerCase());
      coAuthor.push({
        name: 'the member shows as co-author of the commit (GraphQL Commit.authors)',
        ok,
        detail: `authors resolved to users: ${logins.join(', ') || 'none'}`,
      });
    }

    // ---- a comment-type review with line comments, on the App's own PR
    const { data: posted } = await api.rest.pulls.createReview({
      owner: org,
      repo: name,
      pull_number: pr.number,
      commit_id: headSha,
      event: 'COMMENT',
      body: 'ostra spike 4: a comment-type review on the App\'s own PR.',
      comments: [
        { path: rel, line: 3, side: 'RIGHT', body: 'A line comment on line 3.' },
        { path: rel, line: 5, side: 'RIGHT', body: 'A line comment on line 5.' },
      ],
    });
    const { data: lineComments } = await api.rest.pulls.listCommentsForReview({ owner: org, repo: name, pull_number: pr.number, review_id: posted.id });
    review.push({
      name: "the App posted a comment-type review on its own PR",
      ok: posted.state === 'COMMENTED' && posted.user?.login === botLogin,
      detail: `state ${posted.state}`,
    });
    review.push({ name: 'the review carries its line comments', ok: lineComments.length === 2, detail: `${String(lineComments.length)} of 2 line comments` });

    // ---- the independent-review check
    const { data: check } = await api.rest.checks.create({
      owner: org,
      repo: name,
      name: CHECK_NAME,
      head_sha: headSha,
      status: 'in_progress',
      output: { title: 'Waiting for an independent approval', summary: 'Passes when someone who did not drive this task approves the PR.' },
    });
    const reevaluate = async (): Promise<boolean> => {
      const { data: reviews } = await api.rest.pulls.listReviews({ owner: org, repo: name, pull_number: pr.number, per_page: 100 });
      const lite: ReviewLite[] = reviews.flatMap((r) => {
        const state = ReviewStateSchema.safeParse(r.state);
        if (!state.success || r.user === null || r.commit_id === null) return [];
        return [{ login: r.user.login, isBot: r.user.type === 'Bot', state: state.data, commitId: r.commit_id, submittedAt: r.submitted_at ?? '' }];
      });
      const verdict = evaluateIndependentReview({ reviews: lite, drivers: memberLogin === undefined ? [] : [memberLogin], headSha });
      if (verdict.conclusion !== 'success') return false;
      await api.rest.checks.update({
        owner: org,
        repo: name,
        check_run_id: check.id,
        status: 'completed',
        conclusion: 'success',
        output: { title: 'Independently approved', summary: `Approved by ${verdict.approvers.join(', ')}, who did not drive this task.` },
      });
      return true;
    };
    flip.push({ name: 'the check starts in progress', ok: check.status === 'in_progress', detail: `status ${check.status}` });
    const flippedEarly = await reevaluate();
    flip.push({ name: "the App's own comment review doesn't flip it", ok: !flippedEarly, detail: flippedEarly ? 'flipped too early' : 'still pending' });

    if (env.GITHUB_TEST_REVIEWER_TOKEN === undefined || memberLogin === undefined) {
      flip.push({ name: 'a check run flips when someone approves', ok: false, detail: 'needs GITHUB_TEST_REVIEWER_TOKEN and GITHUB_TEST_MEMBER_LOGIN' });
    } else {
      const reviewer = tokenOctokit(creds.apiUrl, env.GITHUB_TEST_REVIEWER_TOKEN);
      const { data: me } = await reviewer.rest.users.getAuthenticated();
      if (me.login.toLowerCase() === memberLogin.toLowerCase()) {
        flip.push({ name: 'the reviewer is not the driver', ok: false, detail: 'GITHUB_TEST_REVIEWER_TOKEN belongs to the driver; use a second sandbox user' });
      } else {
        // Re-evaluate from the webhook when one is wired up, else by polling.
        let wake: () => void = () => undefined;
        let webhook: http.Server | null = null;
        const secret = env.GITHUB_WEBHOOK_SECRET;
        if (secret !== undefined && env.OSTRA_DEV_WEBHOOK_PORT !== undefined) {
          const server = trackServer(
            http.createServer((req, res) => {
              const chunks: Buffer[] = [];
              let size = 0;
              let tooLarge = false;
              req.on('data', (c: Buffer) => {
                if (tooLarge) return;
                size += c.length;
                if (size > MAX_WEBHOOK_BYTES) {
                  tooLarge = true;
                  res.writeHead(413, { connection: 'close' });
                  res.end();
                  req.destroy();
                  return;
                }
                chunks.push(c);
              });
              req.on('end', () => {
                if (tooLarge) return;
                const event = req.headers['x-github-event'];
                const signature = req.headers['x-hub-signature-256'];
                readWebhook(
                  secret,
                  { event: typeof event === 'string' ? event : undefined, signature: typeof signature === 'string' ? signature : undefined },
                  Buffer.concat(chunks).toString('utf8'),
                )
                  .then((outcome) => {
                    res.writeHead(outcome.kind === 'rejected' ? outcome.status : 204);
                    res.end();
                    if (outcome.kind === 'review' && outcome.event.pull_request.number === pr.number) wake();
                  })
                  .catch(() => {
                    res.writeHead(500);
                    res.end();
                  });
              });
            }),
          );
          server.requestTimeout = WEBHOOK_REQUEST_TIMEOUT_MS;
          server.headersTimeout = WEBHOOK_REQUEST_TIMEOUT_MS;
          webhook = server;
          await new Promise<void>((resolve) => {
            server.listen(env.OSTRA_DEV_WEBHOOK_PORT, '127.0.0.1', resolve);
          });
        }
        const approvedAt = Date.now();
        await reviewer.rest.pulls.createReview({ owner: org, repo: name, pull_number: pr.number, commit_id: headSha, event: 'APPROVE', body: 'Approved by a second sandbox user (spike 4).' });
        let flipped = false;
        let via = webhook === null ? 'poll' : 'webhook';
        while (!flipped && Date.now() - approvedAt < 120_000) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, webhook === null ? 3000 : 15_000);
          });
          flipped = await reevaluate();
        }
        if (webhook !== null && !flipped) via = 'webhook (no event arrived)';
        const open = webhook;
        if (open !== null) {
          open.closeAllConnections();
          await new Promise<void>((resolve) => {
            open.close(() => {
              resolve();
            });
          });
        }
        const { data: after } = await api.rest.checks.get({ owner: org, repo: name, check_run_id: check.id });
        metrics['checkFlipMs'] = Date.now() - approvedAt;
        metrics['checkFlipVia'] = via;
        flip.push({
          name: 'a check run flips when someone approves',
          ok: after.status === 'completed' && after.conclusion === 'success',
          detail: `${after.status}/${after.conclusion ?? 'none'} ${((Date.now() - approvedAt) / 1000).toFixed(1)} s after the approval, via ${via}`,
        });
      }
    }

    // ---- Linear's GitHub integration
    if (issue !== null && linearClient !== null) {
      const started = Date.now();
      let linked = false;
      while (!linked && Date.now() - started < 120_000) {
        const urls = await issueAttachmentUrls(linearClient, issue.id);
        linked = urls.some((u) => u.includes(`/${org}/${name}/pull/${String(pr.number)}`));
        if (!linked) await sleep(5000);
      }
      metrics['linearLinkMs'] = Date.now() - started;
      linear.push({
        name: "Linear's GitHub integration links a PR the App opened",
        ok: linked,
        detail: linked ? `linked in ${((Date.now() - started) / 1000).toFixed(0)} s` : 'no link after 120 s (is Linear\'s GitHub app installed on the sandbox org?)',
      });
    }
  } finally {
    await proxy.close();
    if (env.SPIKE_KEEP !== '1') {
      // A failed cleanup is logged (IDs and status only) and listed at the end
      // of the run, never swallowed.
      const failed = (what: string, id: string) => (err: unknown): void => {
        logger.info('cleanup.failed', { repo, ref: `${what}:${id}`, status: httpStatus(err) ?? null });
      };
      if (prNumber !== null) {
        await api.rest.pulls.update({ owner: org, repo: name, pull_number: prNumber, state: 'closed' }).catch(failed('pr', String(prNumber)));
      }
      const pushed = await api.rest.git.getRef({ owner: org, repo: name, ref: `heads/${branch}` }).then(
        () => true,
        () => false,
      );
      if (pushed) await api.rest.git.deleteRef({ owner: org, repo: name, ref: `heads/${branch}` }).catch(failed('branch', `refs/heads/${branch}`));
      if (issue !== null && linearClient !== null) await archiveIssue(linearClient, issue.id).catch(failed('linear-issue', issue.identifier));
    }
    logger.info('pr-flow.done', { taskId, pr: prNumber });
  }

  const ran = (checks: Check[]): GroupResult => ({ kind: 'ran', checks });
  return {
    coAuthor: ran(coAuthor),
    review: ran(review),
    checkFlip: ran(flip),
    linear: issue === null ? { kind: 'skipped', reason: 'needs LINEAR_API_KEY and LINEAR_TEST_TEAM_ID' } : ran(linear),
    metrics,
  };
};
