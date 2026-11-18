import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { z } from 'zod';
import { CREDENTIAL_REFUSED_PREFIX, LFS_ACTION_REFUSED_MESSAGE, OTHER_REPO_MESSAGE, type GitProxy } from '../git-proxy.ts';
import { makeAgentWorld, runGit, scanForSecrets, secretVariants, type AgentWorld, type GitResult } from '../git.ts';
import { TaskIdSchema, type RepoSlug, type TaskId } from '../ids.ts';
import type { Logger } from '../log.ts';
import { describeRefusal, hiddenRefFor, type TaskGitPolicy } from '../policy.ts';
import { LFS_REDIRECT_PROBE_HREFS, LFS_REDIRECT_PROBE_REF } from '../upstream-stub.ts';
import type { GitTarget, TargetLabel } from './target.ts';

export type Check = { readonly name: string; readonly ok: boolean; readonly detail: string };

export type GroupResult =
  | { readonly kind: 'ran'; readonly checks: readonly Check[] }
  | { readonly kind: 'skipped'; readonly reason: string };

export type ScenarioGroup =
  | 'clone-fetch-push'
  | 'hidden-ref'
  | 'refusals'
  | 'token'
  | 'token-renewal'
  | 'read-only'
  | 'lfs'
  | 'shallow'
  | 'large-pack';

export type ScenarioReport = {
  readonly target: TargetLabel;
  readonly groups: Readonly<Record<ScenarioGroup, GroupResult>>;
  readonly metrics: Readonly<Record<string, number | string>>;
};

export type ScenarioOptions = {
  readonly root: string;
  readonly logger: Logger;
  // 0 skips the large pack.
  readonly largePackMb: number;
  readonly largePackSkipReason: string;
  readonly keep: boolean;
};

const sha256File = async (file: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    const value: unknown = chunk;
    if (Buffer.isBuffer(value)) hash.update(value);
  }
  return hash.digest('hex');
};

// Writes `mib` MiB of incompressible bytes.
const writeRandomFile = async (file: string, mib: number): Promise<void> => {
  const out = createWriteStream(file);
  for (let i = 0; i < mib; i += 1) {
    if (!out.write(randomBytes(MIB))) await once(out, 'drain');
  }
  out.end();
  await finished(out);
};

// The RSS of this process: the harness, which also hosts the proxy.
const memorySampler = (): { stop: () => number } => {
  let peak = process.memoryUsage().rss;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 100);
  return {
    stop: () => {
      clearInterval(timer);
      return Math.max(peak, process.memoryUsage().rss);
    },
  };
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// Sizes are binary: 1 MiB = 1024 * 1024 bytes.
const MIB = 1024 * 1024;
const mib = (bytes: number): string => `${(bytes / MIB).toFixed(1)} MiB`;
const n = (x: number): string => String(x);

// What stock git prints when the proxy refuses a ref in its report-status:
// "! [remote rejected] <src> -> <dst> (ostra: <reason>)".
const PUSH_REJECTED = /\[remote rejected\][^\n]*\(ostra: [^\n)]*\)/;

// Which of the proxy's own refusals a step expects.
type Refusal =
  | 'push-rejected' // a receive-pack command list refused, answered in report-status
  | 'other-repo' // a 403 for a repo other than the task's
  | 'read-only'; // a 403 on info/refs?service=git-receive-pack from a read-only proxy

const LfsBatchAnswerSchema = z
  .object({
    objects: z.array(
      z
        .object({
          actions: z.record(z.string(), z.object({ href: z.string() }).loose()).optional(),
          error: z.object({ code: z.number(), message: z.string() }).loose().optional(),
        })
        .loose(),
    ),
  })
  .loose();

export const runGitScenarios = async (target: GitTarget, options: ScenarioOptions): Promise<ScenarioReport> => {
  const { root, logger } = options;
  const taskId: TaskId = TaskIdSchema.parse(`spike4-${randomBytes(4).toString('hex')}`);
  const branch = `ostra/${taskId}`;
  const branchRef = `refs/heads/${branch}`;
  const hiddenRef = hiddenRefFor(taskId);
  const policy: TaskGitPolicy = { taskId, repo: target.repo, branches: [branch], mode: 'read-write' };
  const metrics: Record<string, number | string> = { taskId };
  const outputs: string[] = [];
  const proxies: GitProxy[] = [];

  const redact = (s: string): string =>
    target.secrets().reduce((acc, secret) => secretVariants(secret).reduce((a, v) => a.split(v).join('[redacted]'), acc), s);
  const brief = (r: GitResult): string => redact(`exit ${String(r.code)}: ${r.stderr.trim().split('\n').slice(-3).join(' | ')}`).slice(0, 400);

  const startProxy = async (p: TaskGitPolicy, getToken?: () => Promise<string>): Promise<GitProxy> => {
    const proxy = await target.startProxy(p, getToken);
    proxies.push(proxy);
    return proxy;
  };

  try {
    const proxy = await startProxy(policy);
    const world = await makeAgentWorld(path.join(root, 'agent'), proxy.url, { trace: true, publicBase: target.publicBase });
    const ws = world.workspace;
    const remote = `${target.publicBase}${target.repo}.git`;

    const git = async (args: readonly string[], cwd: string, w: AgentWorld = world, extraEnv: Record<string, string> = {}): Promise<GitResult> => {
      const r = await runGit(args, { cwd, env: { ...w.env, ...extraEnv } });
      outputs.push(r.stdout, r.stderr);
      return r;
    };
    const head = async (cwd: string, rev = 'HEAD'): Promise<string> => (await git(['rev-parse', rev], cwd)).stdout.trim();
    const commitFile = async (cwd: string, rel: string, content: string, message: string): Promise<GitResult> => {
      await mkdir(path.dirname(path.join(cwd, rel)), { recursive: true });
      await writeFile(path.join(cwd, rel), content, 'utf8');
      await git(['add', '--', rel], cwd);
      return git(['commit', '-q', '-m', message], cwd);
    };
    const upstreamPosts = async (repo: RepoSlug): Promise<number | null> => {
      if (target.upstreamStats === null) return null;
      const s = await target.upstreamStats();
      return s.requests.filter((r) => r.repo === repo && r.endpoint === 'git-receive-pack').length;
    };
    const upstreamRequests = async (repo: RepoSlug): Promise<number | null> => {
      if (target.upstreamStats === null) return null;
      return (await target.upstreamStats()).requests.filter((r) => r.repo === repo).length;
    };

    // A refusal counts only on the proxy's own evidence: git printed the
    // proxy's refusal, word for word, and the proxy's counters moved by
    // exactly this one refusal, with no receive-pack request forwarded.
    const refusal = async (
      name: string,
      via: GitProxy,
      expect: Refusal,
      kind: 'push' | 'fetch',
      run: () => Promise<GitResult>,
      watch: { readonly label: string; readonly repo: RepoSlug; readonly ref: string } | null,
      after?: () => Promise<{ readonly ok: boolean; readonly detail: string }>,
    ): Promise<Check> => {
      // Read before and after, not assumed: on a case-insensitive disk the
      // stand-in resolves refs/heads/OSTRA/x to refs/heads/ostra/x.
      const watchedBefore = watch === null ? null : await target.refOnUpstream(watch.repo, watch.ref);
      const before = via.stats();
      const r = await run();
      const now = via.stats();
      const watchedAfter = watch === null ? null : await target.refOnUpstream(watch.repo, watch.ref);
      const watchOk = watchedAfter === watchedBefore;
      let signal: string | null;
      switch (expect) {
        case 'push-rejected':
          signal = PUSH_REJECTED.exec(r.stderr)?.[0] ?? null;
          break;
        case 'other-repo':
          signal = r.stderr.includes(OTHER_REPO_MESSAGE) ? OTHER_REPO_MESSAGE : null;
          break;
        case 'read-only':
          signal = r.stderr.includes(describeRefusal('read-only')) ? describeRefusal('read-only') : null;
          break;
        default:
          expect satisfies never;
          signal = null;
      }
      const dPushes = now.refusedPushes - before.refusedPushes;
      const dRequests = now.refusedRequests - before.refusedRequests;
      const dForwarded = now.upstreamRequests['receive-pack'] - before.upstreamRequests['receive-pack'];
      const wantPushes = kind === 'push' ? 1 : 0;
      const wantRequests = expect === 'push-rejected' ? 0 : 1;
      const extra = after === undefined ? { ok: true, detail: '' } : await after();
      const ok = r.code !== 0 && signal !== null && dPushes === wantPushes && dRequests === wantRequests && dForwarded === 0 && watchOk && extra.ok;
      const parts = [
        signal === null ? `no ostra refusal in git's output (${brief(r)})` : `exit ${String(r.code)}, git printed "${redact(signal).slice(0, 160)}"`,
        `proxy: refused pushes +${n(dPushes)} (want ${n(wantPushes)}), refused requests +${n(dRequests)} (want ${n(wantRequests)}), receive-pack forwarded +${n(dForwarded)}`,
      ];
      if (watch !== null) parts.push(`${watch.label} ${watchOk ? 'unchanged' : 'CHANGED'} upstream`);
      if (extra.detail !== '') parts.push(extra.detail);
      return { name, ok, detail: parts.join('; ') };
    };

    // ---- clone, fetch and push the task's branch
    const cfp: Check[] = [];
    const work = path.join(ws, 'work');
    const cloneV2 = await git(['-c', 'protocol.version=2', 'clone', remote, work], ws);
    cfp.push({ name: 'clone (protocol v2)', ok: cloneV2.code === 0, detail: cloneV2.code === 0 ? `${n(cloneV2.ms)} ms` : brief(cloneV2) });
    const cloneV0 = await git(['-c', 'protocol.version=0', 'clone', remote, path.join(ws, 'work-v0')], ws);
    cfp.push({ name: 'clone (protocol v0)', ok: cloneV0.code === 0, detail: cloneV0.code === 0 ? `${n(cloneV0.ms)} ms` : brief(cloneV0) });
    const defaultHeadBefore = await target.refOnUpstream(target.repo, `refs/heads/${target.defaultBranch}`);

    await git(['switch', '-q', '-c', branch], work);
    await commitFile(work, `spike-4/${taskId}.txt`, `first change for ${taskId}\n`, 'spike 4: first change');
    const push1 = await git(['push', 'origin', `HEAD:${branchRef}`], work);
    const local1 = await head(work);
    const up1 = await target.refOnUpstream(target.repo, branchRef);
    cfp.push({
      name: "push the task's branch",
      ok: push1.code === 0 && up1 === local1,
      detail: push1.code === 0 ? `${n(push1.ms)} ms, upstream ref ${up1 === local1 ? 'matches' : 'differs'}` : brief(push1),
    });

    // The hidden ref: the working tree, untracked files included, as a commit
    // outside the branch (ADR 0039).
    await writeFile(path.join(work, 'untracked-note.txt'), 'not committed yet\n', 'utf8');
    const tmpIndex = path.join(world.home, 'wip-index');
    await git(['read-tree', 'HEAD'], work, world, { GIT_INDEX_FILE: tmpIndex });
    await git(['add', '-A'], work, world, { GIT_INDEX_FILE: tmpIndex });
    const tree = (await git(['write-tree'], work, world, { GIT_INDEX_FILE: tmpIndex })).stdout.trim();
    const wip = (await git(['commit-tree', tree, '-p', 'HEAD', '-m', `wip ${taskId}`], work)).stdout.trim();
    const pushWip = await git(['push', 'origin', `${wip}:${hiddenRef}`], work);
    const upWip = await target.refOnUpstream(target.repo, hiddenRef);
    const wipChecks: Check[] = [];
    wipChecks.push({
      name: "push the task's hidden ref",
      ok: pushWip.code === 0 && upWip === wip,
      detail: pushWip.code === 0 ? `${hiddenRef.replace(taskId, '<task>')} accepted, upstream ref ${upWip === wip ? 'matches' : 'differs'}` : brief(pushWip),
    });

    const work2 = path.join(ws, 'work2');
    await git(['clone', '-q', remote, work2], ws);
    const sw = await git(['switch', '-q', branch], work2);
    await commitFile(work2, `spike-4/${taskId}-2.txt`, 'second change\n', 'spike 4: second change');
    const push2 = await git(['push', 'origin', `HEAD:${branchRef}`], work2);
    const fetch1 = await git(['fetch', 'origin'], work);
    const fetched = await head(work, `refs/remotes/origin/${branch}`);
    const local2 = await head(work2);
    cfp.push({
      name: "fetch the task's branch after another push",
      ok: sw.code === 0 && push2.code === 0 && fetch1.code === 0 && fetched === local2,
      detail: fetch1.code === 0 ? `${n(fetch1.ms)} ms, fetched ${fetched === local2 ? 'the new head' : 'a stale head'}` : brief(fetch1),
    });
    const fetchV0 = await git(['-c', 'protocol.version=0', 'fetch', 'origin'], work);
    cfp.push({ name: 'fetch (protocol v0)', ok: fetchV0.code === 0, detail: fetchV0.code === 0 ? `${n(fetchV0.ms)} ms` : brief(fetchV0) });
    await git(['merge', '-q', '--ff-only', `origin/${branch}`], work);

    // ---- refusals, before a byte reaches the upstream
    const ref: Check[] = [];
    const postsBefore = await upstreamPosts(target.repo);
    const otherBefore = await upstreamRequests(target.otherRepo);
    const proxyPostsBefore = proxy.stats().upstreamRequests['receive-pack'];
    const activityBefore = target.pushActivity === null ? null : new Set((await target.pushActivity(target.repo)).map((a) => a.id));
    const otherActivityBefore = target.pushActivity === null ? null : new Set((await target.pushActivity(target.otherRepo)).map((a) => a.id));
    await commitFile(work, `spike-4/${taskId}-3.txt`, 'third change\n', 'spike 4: a commit the agent tries to push elsewhere');
    const watch = (label: string, refName: string, repo: RepoSlug = target.repo): { label: string; repo: RepoSlug; ref: string } => ({ label, repo, ref: refName });
    const defaultRef = `refs/heads/${target.defaultBranch}`;

    ref.push(
      await refusal(
        'push to the default branch is refused',
        proxy,
        'push-rejected',
        'push',
        () => git(['push', 'origin', `HEAD:${defaultRef}`], work),
        watch('default branch', defaultRef),
      ),
    );
    // A history rewrite: a parentless commit force-pushed over the default branch.
    const rewrite = (await git(['commit-tree', 'HEAD^{tree}', '-m', 'spike 4: rewritten history'], work)).stdout.trim();
    ref.push(
      await refusal(
        'force push (a history rewrite) to the default branch is refused',
        proxy,
        'push-rejected',
        'push',
        () => git(['push', '--force', 'origin', `${rewrite}:${defaultRef}`], work),
        watch('default branch', defaultRef),
      ),
    );
    ref.push(
      await refusal(
        "delete of the task's own branch is refused",
        proxy,
        'push-rejected',
        'push',
        () => git(['push', 'origin', `:${branchRef}`], work),
        watch("task's branch", branchRef),
      ),
    );
    ref.push(
      await refusal(
        'delete of the hidden ref is refused',
        proxy,
        'push-rejected',
        'push',
        () => git(['push', 'origin', `:${hiddenRef}`], work),
        watch('hidden ref', hiddenRef),
      ),
    );
    ref.push(
      await refusal(
        'delete of the default branch is refused',
        proxy,
        'push-rejected',
        'push',
        () => git(['push', 'origin', `:${defaultRef}`], work),
        watch('default branch', defaultRef),
      ),
    );
    const otherRemote = `${target.publicBase}${target.otherRepo}.git`;
    ref.push(
      await refusal(
        'push to another repo is refused',
        proxy,
        'other-repo',
        'push',
        () => git(['push', otherRemote, `HEAD:${branchRef}`], work),
        watch("the other repo's branch", branchRef, target.otherRepo),
        async () => {
          // The other repo exists and the harness can read it, so null means
          // the ref really is absent there.
          const otherRef = await target.refOnUpstream(target.otherRepo, branchRef);
          return { ok: otherRef === null, detail: `the branch ${otherRef === null ? 'is absent from' : 'EXISTS in'} the other repo` };
        },
      ),
    );
    ref.push(
      await refusal(
        'clone of another repo is refused',
        proxy,
        'other-repo',
        'fetch',
        () => git(['clone', otherRemote, path.join(ws, 'other-clone')], ws),
        null,
      ),
    );
    await git(['tag', `spike4-${taskId}`], work);
    ref.push(
      await refusal(
        'push of a tag is refused',
        proxy,
        'push-rejected',
        'push',
        () => git(['push', 'origin', `refs/tags/spike4-${taskId}`], work),
        watch('tag', `refs/tags/spike4-${taskId}`),
      ),
    );
    ref.push(
      await refusal(
        "a ref that only starts with the task's branch name is refused",
        proxy,
        'push-rejected',
        'push',
        () => git(['push', 'origin', `HEAD:${branchRef}-evil`], work),
        watch('the -evil ref', `${branchRef}-evil`),
      ),
    );
    ref.push(
      await refusal(
        "the task's branch in other case is refused",
        proxy,
        'push-rejected',
        'push',
        () => git(['push', 'origin', `HEAD:refs/heads/OSTRA/${taskId}`], work),
        watch('the other-case ref', `refs/heads/OSTRA/${taskId}`),
      ),
    );
    ref.push(
      await refusal(
        "a push of the task's branch together with the default branch is refused whole",
        proxy,
        'push-rejected',
        'push',
        () => git(['push', 'origin', `HEAD:${branchRef}`, `HEAD:${defaultRef}`], work),
        watch("task's branch", branchRef),
      ),
    );
    const postsAfter = await upstreamPosts(target.repo);
    const otherAfter = await upstreamRequests(target.otherRepo);
    const proxyPostsAfter = proxy.stats().upstreamRequests['receive-pack'];
    ref.push({
      name: 'no git-receive-pack request was forwarded for any refused push (proxy counter)',
      ok: proxyPostsAfter === proxyPostsBefore,
      detail: `${n(proxyPostsAfter - proxyPostsBefore)} forwarded`,
    });
    if (postsBefore !== null && postsAfter !== null && otherBefore !== null && otherAfter !== null) {
      ref.push({
        name: 'the upstream received no git-receive-pack request and nothing for the other repo (upstream counter)',
        ok: postsAfter === postsBefore && otherAfter === otherBefore,
        detail: `${n(postsAfter - postsBefore)} receive-pack POSTs, ${n(otherAfter - otherBefore)} requests for the other repo`,
      });
    }
    const defaultHeadAfter = await target.refOnUpstream(target.repo, defaultRef);
    ref.push({
      name: 'the default branch is where it was before the refusals',
      ok: defaultHeadAfter === defaultHeadBefore && defaultHeadBefore !== null,
      detail: defaultHeadAfter === defaultHeadBefore ? 'unchanged' : 'CHANGED',
    });
    const pushOk = await git(['push', 'origin', `HEAD:${branchRef}`], work);
    ref.push({ name: "after the refusals, the task's branch still pushes", ok: pushOk.code === 0, detail: pushOk.code === 0 ? 'pushed' : brief(pushOk) });

    // On GitHub, the upstream's own record: its activity log. The allowed push
    // just made is the positive control: once it shows, the log has caught up,
    // and every refused push would be in it too.
    if (target.pushActivity !== null && activityBefore !== null && otherActivityBefore !== null) {
      const pushedHead = await head(work);
      let seen = false;
      let fresh: readonly { ref: string; type: string }[] = [];
      const started = Date.now();
      while (!seen && Date.now() - started < 90_000) {
        const entries = (await target.pushActivity(target.repo)).filter((a) => !activityBefore.has(a.id));
        seen = entries.some((a) => a.ref === branchRef && a.after === pushedHead);
        fresh = entries.filter((a) => !(a.ref === branchRef && a.after === pushedHead));
        if (!seen) await sleep(5000);
      }
      const otherFresh = (await target.pushActivity(target.otherRepo)).filter((a) => !otherActivityBefore.has(a.id));
      ref.push({
        name: "GitHub's activity log: since the refusals began, only the allowed push, and nothing in the other repo",
        ok: seen && fresh.length === 0 && otherFresh.length === 0,
        detail: seen
          ? `${n(fresh.length)} other entries (${fresh.map((a) => `${a.type} ${a.ref.replace(taskId, '<task>')}`).join(', ') || 'none'}), ${n(otherFresh.length)} in the other repo`
          : 'the allowed push never showed in the log within 90 s, so the absence of the others proves nothing',
      });
    }

    // A credential the agent adds itself is dropped, and the proxy's is used.
    const unauthBefore = target.upstreamStats === null ? null : (await target.upstreamStats()).unauthorized;
    const bogus = await git(['-c', 'http.extraHeader=Authorization: Basic Ym9ndXM6Ym9ndXM=', 'fetch', 'origin'], work);
    const unauthAfter = target.upstreamStats === null ? null : (await target.upstreamStats()).unauthorized;
    ref.push({
      name: "the agent's own Authorization header is dropped",
      ok: bogus.code === 0 && unauthBefore === unauthAfter,
      detail: bogus.code === 0 ? 'fetch went through with the proxy token' : brief(bogus),
    });

    // ---- read-only proxy (refine and review tasks)
    const ro: Check[] = [];
    const roProxy = await startProxy({ ...policy, mode: 'read-only' });
    const roRemote = `${roProxy.url}/${target.repo}.git`;
    const roClone = await git(['clone', '-q', roRemote, path.join(ws, 'ro')], ws);
    ro.push({ name: 'a read-only proxy clones', ok: roClone.code === 0, detail: roClone.code === 0 ? 'cloned' : brief(roClone) });
    ro.push(
      await refusal(
        "a read-only proxy refuses a push to the task's branch",
        roProxy,
        'read-only',
        'push',
        () => git(['push', roRemote, `HEAD:${branchRef}`], work),
        watch("task's branch", branchRef),
      ),
    );

    // ---- shallow and partial clones
    // Of the task's branch, which has history by now: the sandbox repos'
    // default branch can be a single commit, and a --depth 1 clone of that is
    // complete, not shallow.
    const sh: Check[] = [];
    const shallow = path.join(ws, 'shallow');
    const isShallow = async (cwd: string): Promise<string> => (await git(['rev-parse', '--is-shallow-repository'], cwd)).stdout.trim();
    const count = async (cwd: string, rev = 'HEAD'): Promise<string> => (await git(['rev-list', '--count', rev], cwd)).stdout.trim();
    // The full clone has every commit, so it can count the shallow clone's
    // history in full.
    await git(['fetch', '-q', 'origin'], work);
    const sc =await git(['clone', '--depth', '1', '--branch', branch, remote, shallow], ws);
    const scHead = sc.code === 0 ? await head(shallow) : '?';
    const scFull = sc.code === 0 ? await count(work, scHead) : '?';
    const depth = sc.code === 0 ? await count(shallow) : '?';
    const scShallow = sc.code === 0 ? await isShallow(shallow) : '?';
    sh.push({
      name: 'shallow clone --depth 1 (protocol v2)',
      ok: sc.code === 0 && depth === '1' && scShallow === 'true' && Number(scFull) > 1,
      detail: sc.code === 0 ? `${depth} of ${scFull} commits, shallow: ${scShallow}` : brief(sc),
    });
    const shallowV0 = path.join(ws, 'shallow-v0');
    const sc0 = await git(['-c', 'protocol.version=0', 'clone', '--depth', '1', '--branch', branch, remote, shallowV0], ws);
    const depth0 = sc0.code === 0 ? await count(shallowV0) : '?';
    const sc0Shallow = sc0.code === 0 ? await isShallow(shallowV0) : '?';
    sh.push({
      name: 'shallow clone --depth 1 (protocol v0)',
      ok: sc0.code === 0 && depth0 === '1' && sc0Shallow === 'true',
      detail: sc0.code === 0 ? `${depth0} commit, shallow: ${sc0Shallow}` : brief(sc0),
    });
    const deepen = await git(['fetch', '--deepen', '1'], shallow);
    const deepened = deepen.code === 0 ? await count(shallow) : '?';
    sh.push({
      name: 'fetch --deepen 1',
      ok: deepen.code === 0 && deepened === '2',
      detail: deepen.code === 0 ? `${deepened} commits, shallow: ${await isShallow(shallow)}` : brief(deepen),
    });
    const shBranch = path.join(ws, 'shallow-branch');
    const scb = await git(['clone', '--depth', '1', '--branch', branch, remote, shBranch], ws);
    await commitFile(shBranch, `spike-4/${taskId}-shallow.txt`, 'from a shallow clone\n', 'spike 4: push from a shallow clone');
    const shPush = await git(['push', 'origin', `HEAD:${branchRef}`], shBranch);
    const shUp = await target.refOnUpstream(target.repo, branchRef);
    const shLocal = await head(shBranch);
    sh.push({
      name: "push the task's branch from a shallow clone",
      ok: scb.code === 0 && shPush.code === 0 && shUp === shLocal,
      detail: shPush.code === 0 ? 'pushed' : brief(shPush),
    });
    const unshallow = await git(['fetch', '--unshallow'], shallow);
    const unCount = unshallow.code === 0 ? await count(shallow) : '?';
    const unShallow = unshallow.code === 0 ? await isShallow(shallow) : '?';
    sh.push({
      name: 'fetch --unshallow',
      ok: unshallow.code === 0 && unShallow === 'false' && unCount === scFull,
      detail: unshallow.code === 0 ? `${unCount} of ${scFull} commits, shallow: ${unShallow}` : brief(unshallow),
    });
    const partial = await git(['clone', '--filter=blob:none', remote, path.join(ws, 'partial')], ws);
    sh.push({ name: 'partial clone --filter=blob:none (recorded, not in the pass bar)', ok: partial.code === 0, detail: partial.code === 0 ? 'cloned' : brief(partial) });

    // ---- token renewal: the provider re-mints, and git keeps working
    const tr: Check[] = [];
    const validForMs = 2000;
    const expiring = target.expiringTokens(validForMs);
    const rnProxy = await startProxy(policy, expiring.getToken);
    const rnRemote = `${rnProxy.url}/${target.repo}.git`;
    const idsBefore = target.upstreamStats === null ? null : (await target.upstreamStats()).tokenIds.length;
    const renew = path.join(ws, 'renew');
    const rnClone = await git(['clone', '-q', '--branch', branch, rnRemote, renew], ws);
    const mintsForClone = expiring.mints();
    await sleep(validForMs + 1000);
    const rnFetch = await git(['fetch', 'origin'], renew);
    await commitFile(renew, `spike-4/${taskId}-renew.txt`, 'after a re-mint\n', 'spike 4: push after the token was re-minted');
    await sleep(validForMs + 1000);
    const rnPush = await git(['push', 'origin', `HEAD:${branchRef}`], renew);
    const rnUp = await target.refOnUpstream(target.repo, branchRef);
    const rnLocal = await head(renew);
    const idsAfter = target.upstreamStats === null ? null : (await target.upstreamStats()).tokenIds.length;
    const distinct = idsBefore === null || idsAfter === null ? null : idsAfter - idsBefore;
    tr.push({
      name: 'clone, fetch and push keep working while the proxy re-mints its token',
      ok: rnClone.code === 0 && rnFetch.code === 0 && rnPush.code === 0 && rnUp === rnLocal && expiring.mints() >= 3 && (distinct === null || distinct >= 3),
      detail:
        rnClone.code !== 0 || rnFetch.code !== 0 || rnPush.code !== 0
          ? brief(rnClone.code !== 0 ? rnClone : rnFetch.code !== 0 ? rnFetch : rnPush)
          : `${n(expiring.mints())} tokens minted (${n(mintsForClone)} for the clone)${distinct === null ? '' : `, the upstream accepted ${n(distinct)} distinct new tokens`}`,
    });
    if (target.expiredToken !== null && target.upstreamStats !== null) {
      const expired = target.expiredToken();
      const exProxy = await startProxy(policy, () => Promise.resolve(expired));
      const expiredBefore = (await target.upstreamStats()).expired;
      const ls = await git(['ls-remote', `${exProxy.url}/${target.repo}.git`], ws);
      const expiredAfter = (await target.upstreamStats()).expired;
      tr.push({
        name: "an expired token is refused upstream, and git gets the proxy's error, not a credential prompt",
        ok: ls.code !== 0 && ls.stderr.includes(CREDENTIAL_REFUSED_PREFIX) && expiredAfter > expiredBefore,
        detail: `exit ${String(ls.code)}, ${ls.stderr.includes(CREDENTIAL_REFUSED_PREFIX) ? "the proxy's message shown" : brief(ls)}, upstream refused ${n(expiredAfter - expiredBefore)} expired token(s)`,
      });
    }
    await git(['pull', '-q', '--ff-only', 'origin', branch], work);

    // ---- LFS
    const lfs: Check[] = [];
    const lfsMib = 3;
    await git(['lfs', 'install', '--local'], work);
    await git(['lfs', 'track', '*.bin'], work);
    const blob = path.join(work, 'assets', `${taskId}.bin`);
    await mkdir(path.dirname(blob), { recursive: true });
    await writeRandomFile(blob, lfsMib);
    const blobHash = await sha256File(blob);
    await git(['add', '.gitattributes', path.join('assets', `${taskId}.bin`)], work);
    await git(['commit', '-q', '-m', 'spike 4: an LFS object'], work);
    const lfsBefore = proxy.stats().upstreamRequests;
    const lfsPush = await git(['push', 'origin', `HEAD:${branchRef}`], work);
    const lfsMid = proxy.stats().upstreamRequests;
    lfs.push({
      name: `push an LFS object (${n(lfsMib)} MiB) through the proxy`,
      ok: lfsPush.code === 0 && lfsMid['lfs-batch'] > lfsBefore['lfs-batch'] && lfsMid['lfs-action'] > lfsBefore['lfs-action'],
      detail:
        lfsPush.code === 0
          ? `batch ${n(lfsMid['lfs-batch'] - lfsBefore['lfs-batch'])}, actions ${n(lfsMid['lfs-action'] - lfsBefore['lfs-action'])}`
          : brief(lfsPush),
    });
    const lfsClone = path.join(ws, 'lfs-clone');
    const lfsc = await git(['clone', '--branch', branch, remote, lfsClone], ws);
    let lfsHash = '';
    try {
      lfsHash = await sha256File(path.join(lfsClone, 'assets', `${taskId}.bin`));
    } catch {
      lfsHash = 'missing';
    }
    lfs.push({
      name: 'clone downloads the LFS object through the proxy',
      ok: lfsc.code === 0 && lfsHash === blobHash,
      detail: lfsc.code === 0 ? (lfsHash === blobHash ? 'content matches' : `content ${lfsHash === 'missing' ? 'missing' : 'differs (pointer only?)'}`) : brief(lfsc),
    });
    if (target.lfsRedirectProbe) {
      // A batch answer whose actions point outside the upstream: the proxy
      // must keep only the one on GitHub's LFS storage host, and call none.
      const actionsBefore = proxy.stats().upstreamRequests['lfs-action'];
      const objects = LFS_REDIRECT_PROBE_HREFS.map(() => ({ oid: randomBytes(32).toString('hex'), size: 1 }));
      const res = await fetch(`${proxy.url}/${target.repo}.git/info/lfs/objects/batch`, {
        method: 'POST',
        headers: { accept: 'application/vnd.git-lfs+json', 'content-type': 'application/vnd.git-lfs+json' },
        body: JSON.stringify({ operation: 'download', ref: { name: LFS_REDIRECT_PROBE_REF }, objects }),
      });
      const answer = LfsBatchAnswerSchema.safeParse(await res.json().catch(() => null));
      const kept = answer.success ? answer.data.objects.flatMap((o) => Object.values(o.actions ?? {})) : [];
      const allowedIndex = LFS_REDIRECT_PROBE_HREFS.findIndex((h) => h.startsWith('https://github-cloud.githubusercontent.com/'));
      const keptRightOne = answer.success && Object.keys(answer.data.objects[allowedIndex]?.actions ?? {}).length === 1;
      const allViaProxy = kept.every((a) => a.href.startsWith(`${proxy.url}/_ostra/lfs/`));
      // Every object that lost its action carries the proxy's error, so
      // git-lfs fails rather than reading "no actions" as "already there".
      const refusedWithError = answer.success
        ? answer.data.objects.filter((o, i) => i !== allowedIndex && o.error?.message === LFS_ACTION_REFUSED_MESSAGE).length
        : 0;
      const actionsAfter = proxy.stats().upstreamRequests['lfs-action'];
      lfs.push({
        name: "an LFS action that points at an IP, localhost, plain http, an odd port or a look-alike host is dropped, and its object gets the proxy's error",
        ok:
          res.status === 200 &&
          kept.length === 1 &&
          keptRightOne &&
          allViaProxy &&
          refusedWithError === LFS_REDIRECT_PROBE_HREFS.length - 1 &&
          actionsAfter === actionsBefore,
        detail: `${n(LFS_REDIRECT_PROBE_HREFS.length)} actions offered, ${n(kept.length)} kept (want 1: GitHub's storage host), ${n(refusedWithError)} objects refused with the proxy's error, ${n(actionsAfter - actionsBefore)} called`,
      });
    }

    // ---- large pack
    let large: GroupResult = { kind: 'skipped', reason: options.largePackSkipReason };
    let bigWorld: AgentWorld | null = null;
    if (options.largePackMb > 0) {
      const lp: Check[] = [];
      bigWorld = await makeAgentWorld(path.join(root, 'agent-big'), proxy.url, { trace: false, publicBase: target.publicBase });
      const big = path.join(bigWorld.workspace, 'big');
      await git(['clone', '-q', '--branch', branch, remote, big], bigWorld.workspace, bigWorld);
      const files = Math.ceil(options.largePackMb / target.largeFileMb);
      const genStart = Date.now();
      await mkdir(path.join(big, 'large'), { recursive: true });
      for (let i = 0; i < files; i += 1) {
        const size = Math.min(target.largeFileMb, options.largePackMb - i * target.largeFileMb);
        await writeRandomFile(path.join(big, 'large', `part-${String(i).padStart(2, '0')}.dat`), size);
      }
      await git(['add', 'large'], big, bigWorld);
      await git(['commit', '-q', '-m', `spike 4: ${n(options.largePackMb)} MiB of incompressible data`], big, bigWorld);
      metrics['largePackPrepareMs'] = Date.now() - genStart;
      const before = proxy.stats();
      const memPush = memorySampler();
      const rssStart = process.memoryUsage().rss;
      const bigPush = await git(['push', 'origin', `HEAD:${branchRef}`], big, bigWorld);
      const pushPeak = memPush.stop();
      const mid = proxy.stats();
      const sent = mid.bytesToUpstream - before.bytesToUpstream;
      const bigHead = await head(big);
      const upBig = await target.refOnUpstream(target.repo, branchRef);
      metrics['largePackPushMs'] = bigPush.ms;
      metrics['largePackBytesToUpstream'] = sent;
      metrics['largePackPushPeakRssMiB'] = Math.round(pushPeak / MIB);
      lp.push({
        name: `push a ${n(options.largePackMb)} MiB pack through the proxy`,
        ok: bigPush.code === 0 && upBig === bigHead && sent >= options.largePackMb * MIB * 0.95,
        detail:
          bigPush.code === 0
            ? `${mib(sent)} (${n(sent)} bytes) forwarded in ${(bigPush.ms / 1000).toFixed(1)} s (${(sent / MIB / (bigPush.ms / 1000)).toFixed(1)} MiB/s)`
            : brief(bigPush),
      });
      const memClone = memorySampler();
      const bigClone = path.join(bigWorld.workspace, 'big-clone');
      const bc = await git(['clone', '-q', '--single-branch', '--branch', branch, remote, bigClone], bigWorld.workspace, bigWorld);
      const clonePeak = memClone.stop();
      const after = proxy.stats();
      const received = after.bytesFromUpstream - mid.bytesFromUpstream;
      metrics['largePackCloneMs'] = bc.ms;
      metrics['largePackBytesFromUpstream'] = received;
      metrics['largePackClonePeakRssMiB'] = Math.round(clonePeak / MIB);
      let sizeOk = false;
      if (bc.code === 0) {
        const s = await stat(path.join(bigClone, 'large', 'part-00.dat')).catch(() => null);
        sizeOk = s?.size === Math.min(target.largeFileMb, options.largePackMb) * MIB;
      }
      lp.push({
        name: `clone the ${n(options.largePackMb)} MiB pack through the proxy`,
        ok: bc.code === 0 && sizeOk && received >= options.largePackMb * MIB * 0.95,
        detail: bc.code === 0 ? `${mib(received)} (${n(received)} bytes) in ${(bc.ms / 1000).toFixed(1)} s` : brief(bc),
      });
      // Baseline, outside the agent's world: the same clone without the proxy.
      if (target.direct !== null) {
        const d = target.direct();
        const directDir = path.join(root, 'direct-clone');
        const dc = await runGit(['clone', '-q', '--single-branch', '--branch', branch, d.url, directDir], { cwd: root, env: d.env });
        if (dc.code === 0) metrics['largePackDirectCloneMs'] = dc.ms;
        await rm(directDir, { recursive: true, force: true });
      }
      const peakDelta = Math.max(pushPeak, clonePeak) - rssStart;
      lp.push({
        name: 'the proxy streams the pack (the harness process, which hosts the proxy, grows by under 200 MiB)',
        ok: peakDelta < 200 * MIB,
        detail: `peak RSS ${mib(Math.max(pushPeak, clonePeak))}, +${mib(peakDelta)} over the start of the push`,
      });
      large = { kind: 'ran', checks: lp };
    }

    // ---- the token never reaches the agent's side (both agent worlds)
    const tok: Check[] = [];
    const needles = target.secrets().flatMap(secretVariants);
    const roots = [world.home, world.workspace, ...(bigWorld === null ? [] : [bigWorld.home, bigWorld.workspace])];
    const scan = await scanForSecrets(roots, needles);
    tok.push({
      name: "no credential in the agent's files, git config, LFS files or git/curl/packet traces (redaction off)",
      ok: scan.hits.length === 0 && scan.files > 0,
      detail: `${n(scan.files)} files, ${mib(scan.bytes)} scanned (${bigWorld === null ? 'the main agent world' : 'both agent worlds, the large pack included'}), ${n(needles.length)} needles, ${n(scan.hits.length)} hits`,
    });
    const outputHits = outputs.filter((o) => needles.some((x) => o.includes(x))).length;
    tok.push({ name: "no credential in the agent's git output (GIT_CURL_VERBOSE on)", ok: outputHits === 0, detail: `${n(outputs.length)} streams, ${n(outputHits)} hits` });
    const envs = [world.env, ...(bigWorld === null ? [] : [bigWorld.env])];
    const envHits = envs.flatMap((e) => Object.values(e)).filter((v) => needles.some((x) => v.includes(x))).length;
    const envNames = envs.flatMap((e) => Object.keys(e)).filter((k) => /TOKEN|GITHUB|GH_/i.test(k));
    tok.push({ name: "no credential in the agent's environment", ok: envHits === 0 && envNames.length === 0, detail: `${n(Object.keys(world.env).length)} variables, allowlist only` });
    // With GIT_CURL_VERBOSE and GIT_TRACE_CURL on, git and git-lfs print the
    // Host header of every request they make: all of them must be a proxy.
    const traceText = (
      await Promise.all(['curl.log', 'trace.log'].map((f) => readFile(path.join(world.traceDir, f), 'utf8').catch(() => '')))
    ).join('\n');
    const hosts = new Set([...[...outputs, traceText].join('\n').matchAll(/Host: (\S+)/gi)].map((m) => (m[1] ?? '').toLowerCase()));
    const proxyHosts = new Set(proxies.map((p) => new URL(p.url).host.toLowerCase()));
    const foreign = [...hosts].filter((h) => !proxyHosts.has(h));
    tok.push({
      name: "the agent's git and git-lfs sent every request to a proxy, LFS object transfers included",
      ok: hosts.size > 0 && foreign.length === 0,
      detail: `${n(hosts.size)} distinct Host headers, ${n(foreign.length)} not a proxy`,
    });
    const logHits = logger.records().filter((r) => needles.some((x) => JSON.stringify(r).includes(x))).length;
    tok.push({ name: "no credential in the proxy's logs", ok: logHits === 0, detail: `${n(logger.records().length)} records, ${n(logHits)} hits` });
    const tokenLengths = target.secrets().map((s) => s.length);
    metrics['credentialLengths'] = `${n(Math.min(...tokenLengths))}-${n(Math.max(...tokenLengths))}`;
    metrics['proxyRequests'] = proxy.stats().requests;
    if (bigWorld !== null && !options.keep) await rm(bigWorld.workspace, { recursive: true, force: true });

    return {
      target: target.label,
      groups: {
        'clone-fetch-push': { kind: 'ran', checks: cfp },
        'hidden-ref': { kind: 'ran', checks: wipChecks },
        refusals: { kind: 'ran', checks: ref },
        token: { kind: 'ran', checks: tok },
        'token-renewal': { kind: 'ran', checks: tr },
        'read-only': { kind: 'ran', checks: ro },
        lfs: { kind: 'ran', checks: lfs },
        shallow: { kind: 'ran', checks: sh },
        'large-pack': large,
      },
      metrics,
    };
  } finally {
    for (const p of proxies) await p.close();
    // A failed delete is logged as cleanup.failed and listed at the end.
    await target.cleanupRefs([branchRef, hiddenRef]).catch((err: unknown) => {
      logger.info('cleanup.failed', { taskId, target: target.label, ref: 'all', error: err instanceof Error ? err.name : 'unknown' });
    });
    logger.info('scenarios.done', { taskId, target: target.label });
  }
};
