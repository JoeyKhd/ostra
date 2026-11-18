import { generateKeyPair, randomBytes } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  MANIFEST_RESULT_FILE,
  ManifestResultSchema,
  V1_PERMISSIONS,
  permissionGaps,
  startManifestServer,
  type ManifestServer,
} from '../github/manifest.ts';
import { writeCredentials, writeFallbackKey } from '../github/manifest-store.ts';
import { trackServer } from '../proc.ts';
import type { Check } from './git-scenarios.ts';

// The manifest flow's local half, against a stub of GitHub's conversion
// endpoint: the page, the state check, the one-time exchange, where the
// credentials land, and what happens when the exchange or the store fails.
// It can't stand in for GitHub creating the App.

const generateKeyPairAsync = promisify(generateKeyPair);

const unescapeHtml = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Ours: what the page must post, exactly.
const ManifestSchema = z
  .object({
    name: z.string(),
    url: z.string(),
    redirect_url: z.string(),
    callback_urls: z.array(z.string()).max(10),
    hook_attributes: z.object({ url: z.string(), active: z.boolean() }).strict(),
    public: z.boolean(),
    default_permissions: z.record(z.string(), z.enum(['read', 'write'])),
    default_events: z.array(z.string()),
  })
  .strict();
type Manifest = z.infer<typeof ManifestSchema>;

type StubMode = 'ok' | 'fail';

const within = <T,>(p: Promise<T>, ms: number): Promise<{ kind: 'resolved'; value: T } | { kind: 'rejected'; error: unknown } | { kind: 'timeout' }> =>
  Promise.race([
    p.then(
      (value) => ({ kind: 'resolved' as const, value }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    ),
    new Promise<{ kind: 'timeout' }>((resolve) => {
      setTimeout(() => {
        resolve({ kind: 'timeout' });
      }, ms);
    }),
  ]);

const closeServer = (s: http.Server): Promise<void> =>
  new Promise<void>((resolve) => {
    s.closeAllConnections();
    s.close(() => {
      resolve();
    });
  });

export const runManifestLocal = async (root: string): Promise<Check[]> => {
  const checks: Check[] = [];
  let manifestSeen: Manifest | null = null;
  let conversions = 0;
  let mode: StubMode = 'ok';
  const { privateKey } = await generateKeyPairAsync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const stub = trackServer(
    http.createServer((req, res) => {
      const m = /^\/app-manifests\/([^/]+)\/conversions$/.exec(new URL(req.url ?? '/', 'http://stub.invalid').pathname);
      req.resume();
      if (req.method !== 'POST' || m === null || manifestSeen === null) {
        res.writeHead(404);
        res.end();
        return;
      }
      conversions += 1;
      if (mode === 'fail') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'stub: conversion failed' }));
        return;
      }
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 424242,
          slug: manifestSeen.name,
          client_id: `Iv1.${randomBytes(8).toString('hex')}`,
          client_secret: randomBytes(20).toString('hex'),
          webhook_secret: randomBytes(20).toString('hex'),
          pem,
          html_url: `https://github.example.invalid/apps/${manifestSeen.name}`,
          owner: { login: 'ostra-sandbox' },
          // GitHub creates the App with what the manifest asked for.
          permissions: manifestSeen.default_permissions,
          events: manifestSeen.default_events,
          node_id: 'unknown-field-tolerated',
        }),
      );
    }),
  );
  await new Promise<void>((resolve) => {
    stub.listen(0, '127.0.0.1', resolve);
  });
  const stubAddress = stub.address();
  const stubPort = typeof stubAddress === 'object' && stubAddress !== null ? (stubAddress satisfies AddressInfo).port : 0;
  const dir = path.join(root, 'manifest-config');
  const servers: ManifestServer[] = [];
  const start = async (configDir: string, failStore: boolean): Promise<ManifestServer> => {
    const s = await startManifestServer({
      org: 'ostra-sandbox',
      appName: 'ostra-sandbox-local',
      webUrl: 'https://github.example.invalid',
      apiUrl: `http://127.0.0.1:${String(stubPort)}`,
      publicUrl: null,
      port: 0,
      onCreated: (c) => (failStore ? Promise.reject(new Error('disk full (simulated)')) : writeCredentials(configDir, c, 'ostra-sandbox')),
      onStoreFailed: (salvage) => writeFallbackKey(configDir, salvage),
    });
    servers.push(s);
    return s;
  };
  // Opens the page and returns the callback state from its form.
  const openPage = async (s: ManifestServer): Promise<{ page: string; state: string; action: URL | null; manifest: Manifest | null }> => {
    const page = await (await fetch(s.url)).text();
    const action = /action="([^"]+)"/.exec(page)?.[1];
    const value = /name="manifest" value="([^"]+)"/.exec(page)?.[1];
    const parsed = value === undefined ? null : ManifestSchema.safeParse(JSON.parse(unescapeHtml(value)));
    manifestSeen = parsed?.success === true ? parsed.data : null;
    const actionUrl = action === undefined ? null : new URL(unescapeHtml(action));
    return { page, state: actionUrl?.searchParams.get('state') ?? '', action: actionUrl, manifest: manifestSeen };
  };
  try {
    const server = await start(dir, false);
    const { page, state, action, manifest: seen } = await openPage(server);
    checks.push({
      name: 'the local page posts a manifest to the org\'s "new App" form with a random state',
      ok: action?.pathname === '/organizations/ostra-sandbox/settings/apps/new' && state.length >= 32 && seen !== null,
      detail: seen === null ? 'no manifest in the page' : 'form and manifest found',
    });
    const gaps = seen === null ? Object.keys(V1_PERMISSIONS) : permissionGaps(seen.default_permissions).map((g) => g.name);
    checks.push({
      name: 'the manifest asks for every v1 permission, checks: write among them',
      ok: gaps.length === 0 && seen?.default_permissions['checks'] === 'write',
      detail:
        gaps.length === 0
          ? Object.entries(V1_PERMISSIONS)
              .map(([k, v]) => `${k}:${v}`)
              .join(', ')
          : `missing ${gaps.join(', ')}`,
    });
    checks.push({
      name: 'with no public URL, the webhook is off and the redirect comes back to the local server',
      ok: seen?.hook_attributes.active === false && seen.redirect_url === `${server.url}/callback` && seen.callback_urls.length === 1,
      detail: seen === null ? 'no manifest' : `hook active: ${String(seen.hook_attributes.active)}, ${String(seen.callback_urls.length)} OAuth callback URL`,
    });
    const bad = await fetch(`${server.url}/callback?code=abc123&state=${'x'.repeat(state.length)}`);
    checks.push({ name: 'a callback with the wrong state is refused, and no exchange happens', ok: bad.status === 400 && conversions === 0, detail: `status ${String(bad.status)}` });
    const good = await fetch(`${server.url}/callback?code=abc123&state=${encodeURIComponent(state)}`);
    const created = await within(server.done, 5000);
    checks.push({
      name: 'the right state exchanges the code once',
      ok: good.status === 200 && created.kind === 'resolved' && conversions === 1,
      detail: `status ${String(good.status)}, setup ${created.kind}`,
    });
    const again = await fetch(`${server.url}/callback?code=abc123&state=${encodeURIComponent(state)}`);
    checks.push({ name: 'the setup refuses to run a second time', ok: again.status === 410 && conversions === 1, detail: `status ${String(again.status)}` });
    const envText = await readFile(path.join(dir, 'github.env'), 'utf8').catch(() => '');
    const pemStat = await stat(path.join(dir, 'github-app-424242.pem')).catch(() => null);
    const result = ManifestResultSchema.safeParse(JSON.parse(await readFile(path.join(dir, MANIFEST_RESULT_FILE), 'utf8').catch(() => '{}')));
    const hasAll = ['GITHUB_APP_ID=', 'GITHUB_APP_PRIVATE_KEY_PATH=', 'GITHUB_WEBHOOK_SECRET=', 'GITHUB_APP_CLIENT_SECRET='].every((k) => envText.includes(k));
    checks.push({
      name: 'the key, the env file and the non-secret result land in the config directory, outside the repo',
      ok: hasAll && pemStat !== null && result.success && result.data.permissions['checks'] === 'write',
      detail: `env file ${envText.length > 0 ? 'written' : 'missing'}, key ${pemStat === null ? 'missing' : 'written'}, result ${result.success ? 'valid' : 'invalid'}`,
    });
    const shown = page + (await good.text().catch(() => ''));
    const leaks = [pem.slice(40, 80)].filter((s) => shown.includes(s)).length;
    checks.push({ name: 'no secret is shown in the pages', ok: leaks === 0, detail: `${String(leaks)} leaks` });

    // A failed exchange ends the setup with an error; it doesn't hang.
    mode = 'fail';
    const failing = await start(path.join(root, 'manifest-config-fail'), false);
    const f = await openPage(failing);
    const failRes = await fetch(`${failing.url}/callback?code=abc123&state=${encodeURIComponent(f.state)}`);
    const failed = await within(failing.done, 5000);
    checks.push({
      name: 'a failed exchange ends the setup with an error instead of waiting forever',
      ok: failRes.status === 502 && failed.kind === 'rejected',
      detail: `status ${String(failRes.status)}, setup ${failed.kind}`,
    });

    // GitHub made the App but the credentials can't be written: the one-time
    // key is saved on its own, and the setup ends with an error.
    mode = 'ok';
    const lostDir = path.join(root, 'manifest-config-lost');
    const losing = await start(lostDir, true);
    const l = await openPage(losing);
    const lostRes = await fetch(`${losing.url}/callback?code=abc123&state=${encodeURIComponent(l.state)}`);
    const lost = await within(losing.done, 5000);
    const recovered = (await readdir(lostDir).catch(() => [])).filter((x) => /^github-app-424242-recovered-[0-9a-f]{8}\.pem$/.test(x));
    const recoveredPem = recovered[0] === undefined ? '' : await readFile(path.join(lostDir, recovered[0]), 'utf8');
    checks.push({
      name: "when the credentials can't be written, the one-time key is saved to a fallback file and the setup ends with an error",
      ok: lostRes.status === 500 && lost.kind === 'rejected' && recoveredPem === pem,
      detail: `status ${String(lostRes.status)}, setup ${lost.kind}, ${String(recovered.length)} recovered key file`,
    });
  } finally {
    for (const s of servers) await s.close();
    await closeServer(stub);
  }
  return checks;
};
