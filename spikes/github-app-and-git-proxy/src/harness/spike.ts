import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appOctokit, loadAppCredentials, type AppCredentials } from '../github/app-auth.ts';
import { describePermissions, MANIFEST_RESULT_FILE, ManifestResultSchema, permissionGaps, PermissionsSchema } from '../github/manifest.ts';
import { runPrFlow, type PrFlowReport } from '../github/pr-flow.ts';
import { configDir, missing, NEEDS, readEnv, type InputName, type SpikeEnv } from '../inputs.ts';
import { createLogger } from '../log.ts';
import { killAllTracked, listeningServers, strayProcesses } from '../proc.ts';
import { runGitScenarios, type Check, type GroupResult, type ScenarioGroup, type ScenarioReport } from './git-scenarios.ts';
import { startGitHubTarget } from './github-target.ts';
import { startLocalTarget, STUB_MAIN } from './local-target.ts';
import { runManifestLocal } from './manifest-local.ts';
import { runReviewLocal } from './review-local.ts';

// `pnpm spike`: every pass-bar criterion it can run, worded as the pass bar
// words them (context/build-order.md, spike 4).
//  - PASS / FAIL / SKIPPED: on GitHub (or the agent's container).
//  - LOCAL-ONLY: passed against the local stand-in. Evidence for the design,
//    never for the criterion: every bullet names GitHub.
// Exit 0 only when all five bullets are met on GitHub; 1 on any FAIL; 2 when
// nothing failed but a bullet is unmet. `--local` turns 2 into 0, for a run
// that only means to exercise the local half.

type Status = 'PASS' | 'LOCAL-ONLY' | 'FAIL' | 'SKIPPED';
type Where = 'GitHub' | 'local stand-in' | "the agent's container" | 'harness';

// The five bullets of the pass bar, and what each needs.
const PASS_BAR = [
  { id: 1, text: 'The manifest flow creates the App from a local server, with the permissions v1 needs, `checks: write` among them.' },
  {
    id: 2,
    text: "Through the proxy, stock git clones, fetches and pushes the task's branch. A push to the default branch, a delete and a push to another repo are refused before a byte reaches GitHub. The token never appears in the agent's container.",
  },
  { id: 3, text: 'LFS, a shallow clone and a 500 MB pack work, or their limits are written down.' },
  {
    id: 4,
    text: 'A PR the App opened with a co-author trailer shows the member as co-author. The App can post a comment-type review with line comments on its own PR. A check run flips when someone approves.',
  },
  { id: 5, text: "Linear's GitHub integration links a PR the App opened." },
] as const;
type BulletId = (typeof PASS_BAR)[number]['id'];

type Part =
  | 'manifest'
  | 'git'
  | 'hidden-ref'
  | 'refusals'
  | 'token'
  | 'token-container'
  | 'token-renewal'
  | 'lfs'
  | 'shallow'
  | 'large'
  | 'co-author'
  | 'review'
  | 'check'
  | 'linear'
  | 'processes'
  | 'left-behind';

// Each part's wording, from the pass bar, and the bullet it belongs to (null:
// not in the pass bar). `local` rewords a part whose stand-in run covers less
// than the criterion says.
const PARTS: Readonly<Record<Part, { readonly bullet: BulletId | null; readonly text: string; readonly local?: string }>> = {
  manifest: {
    bullet: 1,
    text: 'The manifest flow creates the App from a local server, with the permissions v1 needs, `checks: write` among them.',
    local: "The manifest flow's local server, against a stub of the conversion endpoint (no App is created).",
  },
  git: { bullet: 2, text: "Through the proxy, stock git clones, fetches and pushes the task's branch." },
  'hidden-ref': { bullet: null, text: "Through the proxy, stock git pushes the task's hidden ref (ADR 0039). Not in the pass bar." },
  refusals: { bullet: 2, text: 'A push to the default branch, a delete and a push to another repo are refused before a byte reaches GitHub.' },
  token: {
    bullet: 2,
    text: "The token never appears in the agent's container: here, no token in the agent's git on this host (container: not tested).",
  },
  'token-container': { bullet: 2, text: "The token never appears in the agent's container: the container itself." },
  'token-renewal': { bullet: null, text: 'Through the proxy, git keeps working across a token re-mint. Not in the pass bar.' },
  lfs: { bullet: 3, text: 'LFS, a shallow clone and a 500 MB pack work, or their limits are written down: LFS.' },
  shallow: { bullet: 3, text: 'LFS, a shallow clone and a 500 MB pack work, or their limits are written down: a shallow clone.' },
  large: { bullet: 3, text: 'LFS, a shallow clone and a 500 MB pack work, or their limits are written down: a 500 MB pack.' },
  'co-author': { bullet: 4, text: 'A PR the App opened with a co-author trailer shows the member as co-author.' },
  review: { bullet: 4, text: 'The App can post a comment-type review with line comments on its own PR.' },
  check: {
    bullet: 4,
    text: 'A check run flips when someone approves.',
    local: 'A check run flips when someone approves: here, the approver rule and the webhook signature only (no check run).',
  },
  linear: { bullet: 5, text: "Linear's GitHub integration links a PR the App opened." },
  processes: { bullet: null, text: 'No process or server is left running after the run.' },
  'left-behind': { bullet: null, text: 'Nothing the run made on GitHub or Linear is left behind.' },
};

// What a bullet needs to be met: each part, on GitHub (the container for the
// container part).
const REQUIRED: Readonly<Record<BulletId, readonly { readonly part: Part; readonly where: Where }[]>> = {
  1: [{ part: 'manifest', where: 'GitHub' }],
  2: [
    { part: 'git', where: 'GitHub' },
    { part: 'refusals', where: 'GitHub' },
    { part: 'token', where: 'GitHub' },
    { part: 'token-container', where: "the agent's container" },
  ],
  3: [
    { part: 'lfs', where: 'GitHub' },
    { part: 'shallow', where: 'GitHub' },
    { part: 'large', where: 'GitHub' },
  ],
  4: [
    { part: 'co-author', where: 'GitHub' },
    { part: 'review', where: 'GitHub' },
    { part: 'check', where: 'GitHub' },
  ],
  5: [{ part: 'linear', where: 'GitHub' }],
};

type Row = {
  readonly part: Part;
  readonly where: Where;
  readonly status: Status;
  readonly note: string;
  readonly checks: readonly Check[];
};

const passStatus = (where: Where): Status => (where === 'local stand-in' ? 'LOCAL-ONLY' : 'PASS');

const fromChecks = (part: Part, where: Where, checks: readonly Check[], note = ''): Row => ({
  part,
  where,
  status: checks.length > 0 && checks.every((c) => c.ok) ? passStatus(where) : 'FAIL',
  note,
  checks,
});

const fromGroup = (part: Part, where: Where, group: GroupResult, note = ''): Row =>
  group.kind === 'skipped' ? { part, where, status: 'SKIPPED', note: group.reason, checks: [] } : fromChecks(part, where, group.checks, note);

const skipped = (part: Part, where: Where, needs: readonly InputName[] | string): Row => ({
  part,
  where,
  status: 'SKIPPED',
  note: typeof needs === 'string' ? needs : `needs ${needs.join(', ')}`,
  checks: [],
});

const failed = (part: Part, where: Where, err: unknown): Row => ({
  part,
  where,
  status: 'FAIL',
  note: err instanceof Error ? err.message.slice(0, 300) : 'error',
  checks: [],
});

const gitRows = (report: ScenarioReport, where: Where): Row[] => {
  const g = (k: ScenarioGroup): GroupResult => report.groups[k];
  const readOnly = g('read-only');
  const refusalsGroup = g('refusals');
  const refusals: GroupResult =
    refusalsGroup.kind === 'ran' && readOnly.kind === 'ran' ? { kind: 'ran', checks: [...refusalsGroup.checks, ...readOnly.checks] } : refusalsGroup;
  return [
    fromGroup('git', where, g('clone-fetch-push')),
    fromGroup('hidden-ref', where, g('hidden-ref'), 'spike 2 checks that GitHub starts no CI for it'),
    fromGroup('refusals', where, refusals, 'read-only (refine and review) proxy included'),
    fromGroup('token', where, g('token')),
    fromGroup('token-renewal', where, g('token-renewal')),
    fromGroup('lfs', where, g('lfs')),
    fromGroup('shallow', where, g('shallow')),
    fromGroup('large', where, g('large-pack')),
  ];
};

const checkManifestOnGitHub = async (creds: AppCredentials, env: SpikeEnv): Promise<Row> => {
  const where = 'GitHub';
  const markerPath = path.join(configDir(env), MANIFEST_RESULT_FILE);
  const raw = await readFile(markerPath, 'utf8').catch(() => null);
  if (raw === null) return skipped('manifest', where, `needs \`pnpm manifest\` run once against GITHUB_TEST_ORG (no ${MANIFEST_RESULT_FILE} yet)`);
  const marker = ManifestResultSchema.parse(JSON.parse(raw));
  const { data: app } = await appOctokit(creds).rest.apps.getAuthenticated();
  if (app === null) throw new Error('GET /app returned nothing');
  const permissions = PermissionsSchema.parse(app.permissions);
  const gaps = permissionGaps(permissions);
  return fromChecks('manifest', where, [
    { name: 'the App the harness authenticates as is the one the manifest flow created', ok: app.id === marker.appId, detail: `app ${String(app.id)}` },
    {
      name: 'GitHub reports every v1 permission, checks: write among them',
      ok: gaps.length === 0 && permissions['checks'] === 'write',
      detail: gaps.length === 0 ? 'all present' : `missing ${gaps.map((x) => `${x.name}:${x.wanted}`).join(', ')}`,
    },
    // Recorded for research S6: the keys as GitHub spells them.
    { name: 'the permission keys GitHub returned (recorded)', ok: true, detail: describePermissions(permissions) },
    { name: 'the events GitHub returned (recorded)', ok: true, detail: [...app.events].sort().join(', ') },
  ]);
};

// Set once the scratch directory exists, for the signal handler.
let scratchDir: string | null = null;

const onSignal = (): void => {
  void killAllTracked()
    .then(() => (scratchDir === null ? undefined : rm(scratchDir, { recursive: true, force: true }).catch(() => undefined)))
    .then(() => {
      process.exit(130);
    });
};
process.once('SIGINT', onSignal);
process.once('SIGTERM', onSignal);

const main = async (): Promise<number> => {
  const localOnly = process.argv.includes('--local');
  const env = readEnv();
  const logger = createLogger({ echo: false });
  const spikeDir = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const dataDir = path.join(spikeDir, '.data');
  await mkdir(dataDir, { recursive: true });
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'ostra-spike4-'));
  scratchDir = scratch;
  const keep = env.SPIKE_KEEP === '1';
  const rows: Row[] = [];
  const metrics: Record<string, Readonly<Record<string, number | string>>> = {};
  const started = Date.now();
  console.log(`spike 4: github-app-and-git-proxy, ${new Date().toISOString()}`);
  try {
    // ---- local half: everything that can run on this machine
    console.log('Running the manifest flow against a stub of the conversion endpoint...');
    rows.push(fromChecks('manifest', 'local stand-in', await runManifestLocal(scratch)));

    console.log(`Running git through the proxy against the local upstream (large pack ${String(env.SPIKE_LARGE_PACK_MB)} MiB)...`);
    const local = await startLocalTarget(path.join(scratch, 'local'), logger);
    try {
      const report = await runGitScenarios(local, {
        root: path.join(scratch, 'local'),
        logger,
        largePackMb: env.SPIKE_LARGE_PACK_MB,
        largePackSkipReason: 'SPIKE_LARGE_PACK_MB=0',
        keep,
      });
      rows.push(...gitRows(report, 'local stand-in'));
      metrics['local'] = report.metrics;
    } catch (err: unknown) {
      rows.push(failed('git', 'local stand-in', err));
    } finally {
      await local.close();
    }
    rows.push(
      skipped('token-container', "the agent's container", "needs spike 3's box (the agent's container beside its sidecar): Docker on Linux, which this machine doesn't have"),
    );
    rows.push(fromChecks('check', 'local stand-in', await runReviewLocal()));

    // ---- GitHub half: runs once the sandbox org's inputs are set
    const appMissing = missing(NEEDS.githubApp);
    const creds = appMissing.length === 0 ? await loadAppCredentials(env) : null;
    if (creds === null) {
      rows.push(skipped('manifest', 'GitHub', `needs ${appMissing.join(', ')}, from \`pnpm manifest\` run in a browser signed in as an owner of the sandbox org`));
    } else {
      rows.push(await checkManifestOnGitHub(creds, env).catch((err: unknown) => failed('manifest', 'GitHub', err)));
    }

    const gitMissing = missing(NEEDS.githubGit);
    const gitParts: readonly Part[] = ['git', 'hidden-ref', 'refusals', 'token', 'token-renewal', 'lfs', 'shallow', 'large'];
    if (creds === null || gitMissing.length > 0) {
      for (const p of gitParts) rows.push(skipped(p, 'GitHub', gitMissing.length > 0 ? gitMissing : NEEDS.githubGit));
    } else {
      console.log('Running git through the proxy against the sandbox repos on GitHub...');
      try {
        const gh = await startGitHubTarget(creds, env, logger);
        try {
          const report = await runGitScenarios(gh, {
            root: path.join(scratch, 'github'),
            logger,
            largePackMb: env.SPIKE_GITHUB_LARGE_PACK === '1' ? env.SPIKE_LARGE_PACK_MB : 0,
            largePackSkipReason: 'needs SPIKE_GITHUB_LARGE_PACK=1 (pushes the large pack to the sandbox repo)',
            keep,
          });
          rows.push(...gitRows(report, 'GitHub'));
          metrics['github'] = report.metrics;
        } finally {
          await gh.close();
        }
      } catch (err: unknown) {
        rows.push(failed('git', 'GitHub', err));
      }
    }

    const prMissing = missing(NEEDS.githubPr);
    if (creds === null || prMissing.length > 0) {
      rows.push(skipped('co-author', 'GitHub', missing(NEEDS.coAuthor)));
      rows.push(skipped('review', 'GitHub', prMissing.length > 0 ? prMissing : NEEDS.githubPr));
      rows.push(skipped('check', 'GitHub', missing(NEEDS.checkFlip)));
      rows.push(skipped('linear', 'GitHub', missing(NEEDS.linear)));
    } else {
      console.log('Opening a PR as the App on the sandbox repo...');
      let pr: PrFlowReport | null = null;
      try {
        pr = await runPrFlow(creds, env, path.join(scratch, 'pr'), logger);
      } catch (err: unknown) {
        rows.push(failed('co-author', 'GitHub', err));
      }
      if (pr !== null) {
        const coMissing = missing(NEEDS.coAuthor);
        rows.push(coMissing.length > 0 ? skipped('co-author', 'GitHub', coMissing) : fromGroup('co-author', 'GitHub', pr.coAuthor));
        rows.push(fromGroup('review', 'GitHub', pr.review));
        const flipMissing = missing(NEEDS.checkFlip);
        rows.push(flipMissing.length > 0 ? skipped('check', 'GitHub', flipMissing) : fromGroup('check', 'GitHub', pr.checkFlip));
        rows.push(fromGroup('linear', 'GitHub', pr.linear, "needs Linear's own GitHub app installed on the sandbox org"));
        metrics['pr'] = pr.metrics;
      }
    }
  } finally {
    // Measured before cleaning up: whatever is still alive now is a leak.
    const servers = listeningServers();
    const killed = await killAllTracked();
    if (!keep) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    // And from the OS's side, not the tracked set's.
    const markers = [scratch, scratch.replace(/\\/g, '/'), STUB_MAIN, 'upstream-stub-main'];
    const strays = await strayProcesses(markers).catch(() => null);
    const strayNote = strays === null ? 'the OS process list could not be read' : `${String(strays.length)} stray in the OS process list${strays.length === 0 ? '' : ` (${strays.map((p) => `${p.name} ${String(p.pid)}`).join(', ')})`}`;
    rows.push({
      part: 'processes',
      where: 'harness',
      status: killed === 0 && servers === 0 && strays !== null && strays.length === 0 ? 'PASS' : 'FAIL',
      note: `left behind: ${String(killed)} tracked child processes (killed now), ${String(servers)} listening servers; ${strayNote}`,
      checks: [],
    });
  }

  const leftBehind = logger
    .records()
    .filter((r) => r.event === 'cleanup.failed')
    .map((r) => `${String(r['repo'])} ${String(r['ref'])} (status ${String(r['status'])})`);
  if (leftBehind.length > 0) {
    rows.push({ part: 'left-behind', where: 'harness', status: 'FAIL', note: `left behind: ${leftBehind.join('; ')}`, checks: [] });
  }

  console.log('');
  for (const row of rows) {
    const spec = PARTS[row.part];
    const text = row.where === 'local stand-in' && spec.local !== undefined ? spec.local : spec.text;
    console.log(`${row.status.padEnd(10)} [${row.where}] ${text}${row.note === '' ? '' : `\n           ${row.note}`}`);
    for (const c of row.checks) console.log(`           ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
  }
  console.log('\nMetrics:', JSON.stringify(metrics, null, 2));

  // The verdict, bullet by bullet: met only on GitHub's (and the container's) evidence.
  console.log('\nPass bar (context/build-order.md, spike 4), on GitHub:');
  let met = 0;
  let withLocal = 0;
  const verdicts: { readonly bullet: BulletId; readonly met: boolean; readonly missing: readonly string[]; readonly localOnly: readonly Part[] }[] = [];
  for (const bullet of PASS_BAR) {
    const needs = REQUIRED[bullet.id];
    const unmet = needs.flatMap(({ part, where }) => {
      const row = rows.find((r) => r.part === part && r.where === where);
      return row?.status === 'PASS' ? [] : [`${part} on ${where}: ${row?.status ?? 'not run'}`];
    });
    const localOnly = needs.flatMap(({ part }) => (rows.some((r) => r.part === part && r.status === 'LOCAL-ONLY') ? [part] : []));
    if (unmet.length === 0) met += 1;
    if (localOnly.length > 0) withLocal += 1;
    verdicts.push({ bullet: bullet.id, met: unmet.length === 0, missing: unmet, localOnly });
    console.log(`  ${unmet.length === 0 ? 'MET    ' : 'NOT MET'} ${String(bullet.id)}. ${bullet.text}`);
    if (unmet.length > 0) console.log(`            missing: ${unmet.join('; ')}`);
    if (localOnly.length > 0) console.log(`            local-only evidence: ${localOnly.join(', ')}`);
  }
  const counts: Record<Status, number> = { PASS: 0, 'LOCAL-ONLY': 0, FAIL: 0, SKIPPED: 0 };
  for (const row of rows) counts[row.status] += 1;
  console.log(`\npass bar: ${String(met)} of ${String(PASS_BAR.length)} bullets met on GitHub (${String(withLocal)} with local-only evidence)`);
  console.log(`left behind on GitHub or Linear: ${leftBehind.length === 0 ? 'nothing' : leftBehind.join('; ')}`);
  console.log(
    `${String(counts.PASS)} PASS, ${String(counts['LOCAL-ONLY'])} LOCAL-ONLY, ${String(counts.FAIL)} FAIL, ${String(counts.SKIPPED)} SKIPPED in ${((Date.now() - started) / 1000).toFixed(0)} s`,
  );
  await writeFile(
    path.join(dataDir, 'last-run.json'),
    `${JSON.stringify({ at: new Date().toISOString(), rows, verdicts, metrics, logs: logger.records() }, null, 2)}\n`,
  );
  if (counts.FAIL > 0) return 1;
  if (met < PASS_BAR.length) {
    console.log(localOnly ? '--local: exit 0 although the pass bar is not met on GitHub.' : 'Exit 2: the pass bar is not met on GitHub (use --local to exit 0 on a local-only run).');
    return localOnly ? 0 : 2;
  }
  return 0;
};

main().then(
  (code) => process.exit(code),
  async (err: unknown) => {
    await killAllTracked();
    console.error(err instanceof Error ? err.message : 'spike failed');
    process.exit(1);
  },
);
