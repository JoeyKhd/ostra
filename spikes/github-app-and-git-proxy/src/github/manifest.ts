import { randomBytes, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { trackServer } from '../proc.ts';

// The GitHub App manifest flow (research/platform-auth-github.md §2.2):
// a local page POSTs a manifest to GitHub, the admin clicks Create, GitHub
// redirects back with a one-time code, and the code is exchanged for the
// App's ID, key and secrets. All within an hour.

export const MANIFEST_RESULT_FILE = 'github-app-manifest-result.json';

// The permissions v1 needs (F-006, F-119, ADR 0040, research §2.3). checks:
// write and actions: read are asked for from day one, so no install
// re-approves later.
// email_addresses was here, as an account permission for F-119. GitHub refused
// the manifest with "Default permission records resource is not included in
// the list" (2026-11-18). Linking a member's GitHub account needs only their
// login and ID from the App's OAuth (GET /user), which takes no permission.
// Deliberately left out for this spike:
//  - workflows: write. Optional by policy (research §2.3); left out so the
//    spike tests the default, where a push touching .github/workflows/ fails
//    (S7, not yet tried).
//  - setup_url. GitHub sends the admin there after an install; the spike has
//    no such page. Milestone 1's setup flow sets it.
// The exact key spellings are unverified until GitHub answers (S6): the
// GitHub run prints the keys GitHub returned.
export const V1_PERMISSIONS = {
  contents: 'write',
  pull_requests: 'write',
  checks: 'write',
  actions: 'read',
  issues: 'read',
  statuses: 'read',
  metadata: 'read',
} as const satisfies Record<string, 'read' | 'write'>;

export const V1_EVENTS = [
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'pull_request_review_thread',
  'issue_comment',
  'check_run',
  'check_suite',
  'status',
  'push',
  'workflow_run',
] as const;

export type ManifestInput = {
  readonly name: string;
  readonly homepageUrl: string;
  readonly redirectUrl: string;
  readonly webhookUrl: string | null;
};

// GitHub refuses a manifest whose webhook URL isn't reachable from the public
// internet, even with `active: false` (2026-11-18: "Hook url is not supported
// because it isn't reachable over the public Internet (127.0.0.1)"). So with no
// public URL, the manifest has no webhook and no events. Both are added in the
// App's settings once a tunnel exists.
export const buildManifest = (input: ManifestInput) => ({
  name: input.name,
  url: input.homepageUrl,
  ...(input.webhookUrl === null
    ? {}
    : { hook_attributes: { url: input.webhookUrl, active: true }, default_events: V1_EVENTS }),
  redirect_url: input.redirectUrl,
  // The OAuth callback for "Sign in with GitHub" (research §2.2 sketch).
  callback_urls: [`${input.homepageUrl}/api/auth/callback/github`],
  public: false,
  default_permissions: V1_PERMISSIONS,
});

export const PermissionsSchema = z.record(z.string(), z.enum(['read', 'write', 'admin']));

// A vendor format: unknown fields are tolerated.
export const ConversionSchema = z
  .object({
    id: z.number().int(),
    slug: z.string().min(1),
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
    webhook_secret: z.string().nullable(),
    pem: z.string().min(1),
    html_url: z.url(),
    owner: z.object({ login: z.string() }).loose().nullable(),
    permissions: PermissionsSchema,
    events: z.array(z.string()),
  })
  .loose();
export type Conversion = z.infer<typeof ConversionSchema>;

// Enough of an answer to save the one-time key when the full one doesn't
// parse: GitHub has made the App by then, and the key exists nowhere else.
const SalvageSchema = z.object({ id: z.number().int().nullable().catch(null), pem: z.string().min(1) }).loose();
export type Salvage = { readonly id: number | null; readonly pem: string };

export type PermissionGap = { readonly name: string; readonly wanted: string; readonly got: string | undefined };

const rank = (level: string | undefined): number => (level === 'admin' ? 3 : level === 'write' ? 2 : level === 'read' ? 1 : 0);

export const permissionGaps = (got: Readonly<Record<string, string>>): PermissionGap[] =>
  Object.entries(V1_PERMISSIONS)
    .filter(([name, wanted]) => rank(got[name]) < rank(wanted))
    .map(([name, wanted]) => ({ name, wanted, got: got[name] }));

export const describePermissions = (got: Readonly<Record<string, string>>): string =>
  Object.entries(got)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`)
    .join(', ');

const noop = (): void => undefined;
const SILENT_LOG = { debug: noop, info: noop, warn: noop, error: noop };

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export type ManifestServerOptions = {
  readonly org: string;
  readonly appName: string;
  readonly webUrl: string;
  readonly apiUrl: string;
  readonly publicUrl: string | null;
  readonly port: number;
  // Stores the credentials; returns where they went.
  readonly onCreated: (conversion: Conversion) => Promise<string>;
  // When storing them fails, or GitHub's answer doesn't parse: saves the key
  // somewhere safe; returns where.
  readonly onStoreFailed: (salvage: Salvage) => Promise<string>;
};

export type ManifestServer = { readonly url: string; readonly done: Promise<Conversion>; readonly close: () => Promise<void> };

export const startManifestServer = async (options: ManifestServerOptions): Promise<ManifestServer> => {
  const state = randomBytes(24).toString('base64url');
  let used = false;
  let resolveDone: (c: Conversion) => void = () => undefined;
  let rejectDone: (err: Error) => void = () => undefined;
  const done = new Promise<Conversion>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // Nobody may be awaiting yet; the rejection still reaches whoever does.
  void done.catch(() => undefined);
  let selfUrl = '';

  const page = (res: ServerResponse, status: number, body: string): void => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><meta charset="utf-8"><title>ostra spike 4</title><body style="font-family:sans-serif;max-width:40rem;margin:3rem auto">${body}</body>`);
  };

  // Keeps the one-time key when its normal home can't take it.
  const salvage = async (raw: unknown, res: ServerResponse, why: string): Promise<void> => {
    const s = SalvageSchema.safeParse(raw);
    let where: string | null = null;
    if (s.success) {
      where = await options.onStoreFailed({ id: s.data.id, pem: s.data.pem }).catch(() => null);
    }
    const appId = s.success && s.data.id !== null ? String(s.data.id) : 'unknown';
    page(
      res,
      500,
      `<p>GitHub created App ${escapeHtml(appId)}, but ${escapeHtml(why)}.</p>` +
        (where === null
          ? '<p>Its private key could not be saved. Generate a new one in the App\'s settings on GitHub.</p>'
          : `<p>Its private key was saved to ${escapeHtml(where)}.</p>`) +
        "<p>The client secret and webhook secret were not saved: regenerate them in the App's settings on GitHub.</p>",
    );
    rejectDone(
      new Error(
        `App ${appId} was created, but ${why}. ${where === null ? 'Its key could not be saved: generate a new one on GitHub.' : `Its key is in ${where}.`} Regenerate its client and webhook secrets on GitHub.`,
      ),
    );
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', selfUrl);
    if (url.pathname === '/') {
      const manifest = buildManifest({
        name: options.appName,
        homepageUrl: options.publicUrl ?? selfUrl,
        redirectUrl: `${selfUrl}/callback`,
        webhookUrl: options.publicUrl === null ? null : `${options.publicUrl}/api/github/webhooks`,
      });
      const action = `${options.webUrl}/organizations/${encodeURIComponent(options.org)}/settings/apps/new?state=${state}`;
      page(
        res,
        200,
        `<h1>Create the sandbox GitHub App</h1><p>This posts a manifest to GitHub for <b>${escapeHtml(options.org)}</b>. Review it there and click Create.</p>` +
          `<form id="f" method="post" action="${escapeHtml(action)}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">` +
          `<button type="submit">Continue to GitHub</button></form>`,
      );
      return;
    }
    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const got = url.searchParams.get('state') ?? '';
      const stateOk = got.length === state.length && timingSafeEqual(Buffer.from(got), Buffer.from(state));
      if (!stateOk || code === null || !/^[A-Za-z0-9_-]{1,100}$/.test(code)) {
        page(res, 400, '<p>Bad or missing state. Start again from the first page.</p>');
        return;
      }
      if (used) {
        page(res, 410, '<p>This setup has already run once.</p>');
        return;
      }
      used = true;
      let raw: unknown;
      try {
        // Silent: Octokit's request log would print the path, and the path
        // carries the one-time code.
        const octokit = new Octokit({ baseUrl: options.apiUrl, log: SILENT_LOG });
        raw = (await octokit.rest.apps.createFromManifest({ code })).data;
      } catch (err: unknown) {
        // No App was made, or GitHub didn't say: the setup ends, and the
        // command exits with an error instead of waiting.
        used = false;
        page(res, 502, '<p>The exchange with GitHub failed. Run <code>pnpm manifest</code> again; the code is single-use and lasts an hour.</p>');
        rejectDone(new Error(`exchange failed (${err instanceof Error ? err.name : 'error'})`));
        return;
      }
      const parsed = ConversionSchema.safeParse(raw);
      if (!parsed.success) {
        await salvage(raw, res, "GitHub's answer could not be read");
        return;
      }
      const conversion = parsed.data;
      let where: string;
      try {
        where = await options.onCreated(conversion);
      } catch {
        await salvage(raw, res, 'its credentials could not be written');
        return;
      }
      page(
        res,
        200,
        `<h1>App created</h1><p>App ID ${String(conversion.id)} (${escapeHtml(conversion.slug)}). Its credentials were written to ${escapeHtml(where)}.</p>` +
          `<p>Now <a href="${escapeHtml(conversion.html_url)}/installations/new">install it</a> on the sandbox repos.</p>`,
      );
      resolveDone(conversion);
      return;
    }
    page(res, 404, '<p>Not found.</p>');
  };

  const server = trackServer(
    http.createServer((req, res) => {
      handle(req, res).catch(() => {
        if (!res.headersSent) page(res, 500, '<p>Something went wrong. Run <code>pnpm manifest</code> again.</p>');
      });
    }),
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? (address satisfies AddressInfo).port : options.port;
  selfUrl = `http://127.0.0.1:${String(port)}`;
  return {
    url: selfUrl,
    done,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
};

// The non-secret record of the conversion: lets the harness check later that
// the App it authenticates as is the one the manifest flow made.
export const ManifestResultSchema = z
  .object({
    appId: z.number().int(),
    slug: z.string(),
    owner: z.string().nullable(),
    permissions: PermissionsSchema,
    events: z.array(z.string()),
    createdAt: z.string(),
    via: z.literal('manifest-flow'),
  })
  .strict();
export type ManifestResult = z.infer<typeof ManifestResultSchema>;
