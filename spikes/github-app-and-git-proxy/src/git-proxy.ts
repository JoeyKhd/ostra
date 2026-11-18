import http, { type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { isIP, type AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { z } from 'zod';
import type { Logger } from './log.ts';
import { encodeRefusal, parseReceivePackHead, type ReceivePackHead } from './pkt-line.ts';
import { decidePush, describeRefusal, sameRepo, type RefusalCode, type TaskGitPolicy } from './policy.ts';
import { trackServer } from './proc.ts';

// The sidecar's git proxy (ADR 0030, F-090). The agent's own git reaches it
// through `url.<proxy>/.insteadOf https://github.com/`. It:
//  - serves one repo only, and only the smart-HTTP and LFS endpoints;
//  - drops every credential the client sends and adds the task's token upstream;
//  - parses a git-receive-pack command list before forwarding any byte, and
//    refuses deletes and any ref but the task's branches and hidden ref;
//  - rewrites LFS batch actions so their signed URLs and headers stay in the
//    proxy too.
// It streams every body: no pack is buffered.

export type UpstreamConfig = {
  // e.g. https://github.com/ ; a repo is served at <baseUrl><owner>/<name>.git/...
  readonly baseUrl: URL;
  // Returns the current token for the task's one repo. Never logged.
  readonly getToken: () => Promise<string>;
  // Hosts an LFS action may point at besides the upstream's own origin.
  // "*.example.com" matches any subdomain. Defaults to GitHub's LFS storage.
  readonly lfsActionHosts?: readonly string[];
};

// GitHub's LFS batch answers point at its storage hosts. As github.com
// answered on 2026-11-18: an upload's `upload` action goes to its S3 bucket,
// and its `verify` action to lfs.github.com. The S3 bucket is named exactly,
// since anyone can own a bucket under s3.amazonaws.com. For GitHub Enterprise
// Server, list its own storage host in lfsActionHosts.
export const DEFAULT_LFS_ACTION_HOSTS = [
  'github-cloud.githubusercontent.com',
  '*.githubusercontent.com',
  'github-cloud.s3.amazonaws.com',
  'lfs.github.com',
] as const;

// An object with an action the proxy won't call gets this per-object error
// instead of its actions. An object with no actions tells git-lfs the server
// already has it, so an upload would "succeed" with nothing uploaded.
export const LFS_ACTION_REFUSED_MESSAGE = "ostra: the LFS server sent this object's transfer to a host the proxy doesn't allow";

// What the proxy answers, word for word, so a test can tell the proxy's own
// refusal from any other failure.
export const OTHER_REPO_MESSAGE = "ostra: this task's proxy serves only its own repo";
export const CREDENTIAL_REFUSED_PREFIX = "ostra: GitHub refused the task's credential";

const hostMatches = (host: string, pattern: string): boolean =>
  pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1 : host === pattern;

// An LFS action URL the proxy will call with the action's own headers: the
// upstream's origin, or https on an allowlisted host name. Never an IP
// literal, never localhost, never a user:password@ or an odd port.
export const isAllowedLfsActionHref = (href: URL, upstreamOrigin: string, hosts: readonly string[]): boolean => {
  if (href.origin === upstreamOrigin) return true;
  if (href.protocol !== 'https:' || href.username !== '' || href.password !== '') return false;
  if (href.port !== '' && href.port !== '443') return false;
  const host = href.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isIP(host) !== 0 || host === 'localhost' || host.endsWith('.localhost')) return false;
  return hosts.some((p) => hostMatches(host, p.toLowerCase()));
};

export type GitProxyOptions = {
  readonly policy: TaskGitPolicy;
  readonly upstream: UpstreamConfig;
  readonly logger: Logger;
  readonly host?: string;
  readonly port?: number;
};

type UpstreamEndpoint = 'info-refs' | 'upload-pack' | 'receive-pack' | 'lfs-batch' | 'lfs-locks' | 'lfs-action';

export type GitProxyStats = {
  readonly requests: number;
  readonly refusedPushes: number;
  readonly refusedRequests: number;
  readonly upstreamRequests: Readonly<Record<UpstreamEndpoint, number>>;
  readonly bytesToUpstream: number;
  readonly bytesFromUpstream: number;
};

export type GitProxy = {
  readonly url: string;
  readonly stats: () => GitProxyStats;
  readonly close: () => Promise<void>;
};

const MAX_DISCARD_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const LFS_ACTION_MAX_TTL_S = 3600;

const ROUTE =
  /^\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack|info\/lfs\/objects\/batch|info\/lfs\/locks\/verify)$/;

type Route = { readonly repo: string; readonly endpoint: Exclude<UpstreamEndpoint, 'lfs-action'> };

const matchRoute = (pathname: string): Route | null => {
  const m = ROUTE.exec(pathname);
  if (m === null) return null;
  const [, owner, name, rest] = m;
  if (owner === undefined || name === undefined || rest === undefined) return null;
  const repo = `${owner}/${name}`;
  switch (rest) {
    case 'info/refs':
      return { repo, endpoint: 'info-refs' };
    case 'git-upload-pack':
      return { repo, endpoint: 'upload-pack' };
    case 'git-receive-pack':
      return { repo, endpoint: 'receive-pack' };
    case 'info/lfs/objects/batch':
      return { repo, endpoint: 'lfs-batch' };
    case 'info/lfs/locks/verify':
      return { repo, endpoint: 'lfs-locks' };
    default:
      return null;
  }
};

const headerOne = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

// Only these client headers go upstream. Authorization, Cookie and anything
// else the agent sets are dropped.
const CLIENT_HEADERS = ['content-type', 'accept', 'git-protocol', 'user-agent', 'accept-encoding'] as const;
const RESPONSE_HEADERS = ['content-type', 'content-encoding', 'content-length', 'cache-control', 'expires', 'pragma'] as const;

const pickClientHeaders = (req: IncomingMessage, keepLength: boolean, keepEncoding: boolean): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const name of CLIENT_HEADERS) {
    const v = headerOne(req, name);
    if (v !== undefined) out[name] = v;
  }
  if (keepLength) {
    const v = headerOne(req, 'content-length');
    if (v !== undefined) out['content-length'] = v;
  }
  if (keepEncoding) {
    const v = headerOne(req, 'content-encoding');
    if (v !== undefined) out['content-encoding'] = v;
  }
  return out;
};

// GitHub refuses a request with no User-Agent: lfs.github.com answers an LFS
// verify without one with a 403, "Request forbidden by administrative rules"
// (seen 2026-11-18). git-lfs always sends one, so pass it on, with a fallback.
const userAgentOf = (req: IncomingMessage): { readonly 'user-agent': string } => ({
  'user-agent': headerOne(req, 'user-agent') ?? 'ostra-git-proxy',
});

const basicAuth = (token: string): string => `Basic ${Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')}`;

const LfsBatchRequestSchema = z
  .object({
    operation: z.enum(['upload', 'download']),
    objects: z
      .array(z.object({ oid: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().nonnegative() }).loose())
      .max(1000),
  })
  .loose();

const LfsActionSchema = z
  .object({
    href: z.url(),
    header: z.record(z.string(), z.string()).optional(),
    expires_in: z.number().optional(),
    expires_at: z.string().optional(),
  })
  .loose();

const LfsBatchResponseSchema = z
  .object({
    objects: z.array(
      z
        .object({
          oid: z.string(),
          size: z.number(),
          actions: z.record(z.string(), LfsActionSchema).optional(),
        })
        .loose(),
    ),
  })
  .loose();

type LfsAction = {
  readonly href: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly addToken: boolean;
  readonly expiresAt: number;
};

const readAll = async (stream: Readable, limit: number): Promise<Buffer | null> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const value: unknown = chunk;
    if (!Buffer.isBuffer(value)) return null;
    total += value.length;
    if (total > limit) return null;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
};

export const startGitProxy = async (options: GitProxyOptions): Promise<GitProxy> => {
  const { policy, upstream, logger } = options;
  const upstreamCounts: Record<UpstreamEndpoint, number> = {
    'info-refs': 0,
    'upload-pack': 0,
    'receive-pack': 0,
    'lfs-batch': 0,
    'lfs-locks': 0,
    'lfs-action': 0,
  };
  let requests = 0;
  let refusedPushes = 0;
  let refusedRequests = 0;
  let bytesToUpstream = 0;
  let bytesFromUpstream = 0;
  const lfsActions = new Map<string, LfsAction>();
  let selfUrl = '';
  const upstreamOrigin = upstream.baseUrl.origin;

  const deny = (res: ServerResponse, status: number, code: string, message: string): void => {
    refusedRequests += 1;
    logger.info('proxy.request.refused', { taskId: policy.taskId, repo: policy.repo, status, code });
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(`${message}\n`);
  };

  const upstreamUrl = (rest: string, search: string): URL => {
    const base = upstream.baseUrl.href.endsWith('/') ? upstream.baseUrl.href : `${upstream.baseUrl.href}/`;
    return new URL(`${policy.repo}.git/${rest}${search}`, base);
  };

  // Open one upstream request. The body is streamed, never buffered.
  const sendUpstream = async (
    endpoint: UpstreamEndpoint,
    target: URL,
    method: string,
    headers: OutgoingHttpHeaders,
    body: Readable | Buffer | null,
  ): Promise<IncomingMessage> => {
    upstreamCounts[endpoint] += 1;
    const transport = target.protocol === 'https:' ? https : http;
    return new Promise<IncomingMessage>((resolve, reject) => {
      const upReq = transport.request(target, { method, headers });
      upReq.once('response', resolve);
      upReq.once('error', reject);
      if (body === null) {
        upReq.end();
      } else if (Buffer.isBuffer(body)) {
        bytesToUpstream += body.length;
        upReq.end(body);
      } else {
        body.on('data', (chunk: Buffer) => {
          bytesToUpstream += chunk.length;
        });
        pipeline(body, upReq).catch(reject);
      }
    });
  };

  // Stream an upstream answer back. Auth challenges and redirects never reach
  // the agent: a challenge would make git ask for a credential, and a redirect
  // could send the agent somewhere the policy never saw.
  const relay = async (upRes: IncomingMessage, res: ServerResponse, endpoint: UpstreamEndpoint): Promise<void> => {
    const status = upRes.statusCode ?? 502;
    if (status === 401 || status === 403 || status === 407 || (status >= 300 && status < 400)) {
      upRes.resume();
      logger.info('proxy.upstream.refused', { taskId: policy.taskId, repo: policy.repo, endpoint, status });
      deny(res, 502, 'upstream-auth', `${CREDENTIAL_REFUSED_PREFIX} (status ${String(status)})`);
      return;
    }
    const headers: Record<string, string> = {};
    for (const name of RESPONSE_HEADERS) {
      const v = upRes.headers[name];
      if (typeof v === 'string') headers[name] = v;
    }
    res.writeHead(status, headers);
    upRes.on('data', (chunk: Buffer) => {
      bytesFromUpstream += chunk.length;
    });
    await pipeline(upRes, res);
  };

  const withToken = async (headers: Record<string, string>): Promise<Record<string, string>> => ({
    ...headers,
    authorization: basicAuth(await upstream.getToken()),
  });

  const handleInfoRefs = async (req: IncomingMessage, res: ServerResponse, search: URLSearchParams): Promise<void> => {
    const service = search.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      deny(res, 403, 'dumb-http', 'ostra: only the smart HTTP protocol is served');
      return;
    }
    if (service === 'git-receive-pack' && policy.mode === 'read-only') {
      refusedPushes += 1;
      deny(res, 403, 'read-only', describeRefusal('read-only'));
      return;
    }
    const target = upstreamUrl('info/refs', `?service=${service}`);
    const upRes = await sendUpstream('info-refs', target, 'GET', await withToken(pickClientHeaders(req, false, false)), null);
    await relay(upRes, res, 'info-refs');
  };

  const handleUploadPack = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const headers = await withToken(pickClientHeaders(req, true, true));
    const upRes = await sendUpstream('upload-pack', upstreamUrl('git-upload-pack', ''), 'POST', headers, req);
    await relay(upRes, res, 'upload-pack');
  };

  const refusePush = async (
    req: IncomingMessage,
    res: ServerResponse,
    iterator: AsyncIterator<unknown>,
    head: ReceivePackHead,
    codes: readonly RefusalCode[],
    codeFor: (ref: string) => RefusalCode,
  ): Promise<void> => {
    refusedPushes += 1;
    logger.info('proxy.push.refused', {
      taskId: policy.taskId,
      repo: policy.repo,
      refCount: head.commands.length,
      codes: [...codes],
    });
    // Read the rest of the body and drop it, so git gets to read the answer.
    // Nothing of it goes upstream.
    let discarded = 0;
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) break;
      const value: unknown = next.value;
      if (Buffer.isBuffer(value)) discarded += value.length;
      if (discarded > MAX_DISCARD_BYTES) {
        req.destroy();
        return;
      }
    }
    const firstCode = codes[0] ?? 'ref-not-allowed';
    const payload = encodeRefusal(head, (c) => describeRefusal(codeFor(c.ref)), describeRefusal(firstCode));
    if (payload === null) {
      deny(res, 403, firstCode, describeRefusal(firstCode));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' });
    res.end(payload);
  };

  const handleReceivePack = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (policy.mode === 'read-only') {
      refusedPushes += 1;
      deny(res, 403, 'read-only', describeRefusal('read-only'));
      return;
    }
    const encoding = headerOne(req, 'content-encoding');
    let body: Readable = req;
    if (encoding === 'gzip') {
      const gunzip = createGunzip();
      req.on('error', (err) => gunzip.destroy(err));
      body = req.pipe(gunzip);
    } else if (encoding !== undefined && encoding !== 'identity') {
      deny(res, 415, 'content-encoding', 'ostra: unsupported content encoding');
      return;
    }
    const iterator: AsyncIterator<unknown> = body[Symbol.asyncIterator]();
    let buffered: Buffer = Buffer.alloc(0);
    let head: ReceivePackHead;
    for (;;) {
      const parsed = parseReceivePackHead(buffered);
      if (parsed.kind === 'parsed') {
        head = parsed.head;
        break;
      }
      if (parsed.kind === 'error') {
        refusedPushes += 1;
        deny(res, 400, parsed.reason, 'ostra: could not read the push command list');
        req.destroy();
        return;
      }
      const next = await iterator.next();
      if (next.done === true) {
        deny(res, 400, 'truncated', 'ostra: the push command list was cut short');
        return;
      }
      const value: unknown = next.value;
      if (!Buffer.isBuffer(value)) {
        deny(res, 400, 'bad-body', 'ostra: unreadable push body');
        return;
      }
      buffered = buffered.length === 0 ? value : Buffer.concat([buffered, value]);
    }
    const verdict = decidePush(policy, head.commands);
    if (!verdict.allowed) {
      const byRef = new Map(verdict.verdicts.map((v) => [v.ref, v.allowed ? 'other-ref-refused' : v.code] as const));
      await refusePush(req, res, iterator, head, verdict.codes, (ref) => byRef.get(ref) ?? 'ref-not-allowed');
      return;
    }
    logger.info('proxy.push.allowed', { taskId: policy.taskId, repo: policy.repo, refCount: head.commands.length });
    // The bytes already read, then the rest of the body, as one stream.
    let pending: Buffer | null = buffered;
    const rest: AsyncIterable<Buffer> = {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<Buffer, undefined>> => {
          if (pending !== null) {
            const value = pending;
            pending = null;
            return { done: false, value };
          }
          for (;;) {
            const next = await iterator.next();
            if (next.done === true) return { done: true, value: undefined };
            const value: unknown = next.value;
            if (Buffer.isBuffer(value)) return { done: false, value };
          }
        },
        return: async (): Promise<IteratorResult<Buffer, undefined>> => {
          await iterator.return?.();
          return { done: true, value: undefined };
        },
      }),
    };
    // Same bytes as the client sent (decompressed if it was gzip), so the
    // length header only survives when nothing was decompressed.
    const plain = encoding === undefined || encoding === 'identity';
    const headers = await withToken(pickClientHeaders(req, plain, false));
    const upRes = await sendUpstream('receive-pack', upstreamUrl('git-receive-pack', ''), 'POST', headers, Readable.from(rest));
    await relay(upRes, res, 'receive-pack');
  };

  const lfsError = (res: ServerResponse, status: number, code: string, message: string): void => {
    refusedRequests += 1;
    logger.info('proxy.lfs.refused', { taskId: policy.taskId, repo: policy.repo, status, code });
    res.writeHead(status, { 'content-type': 'application/vnd.git-lfs+json' });
    res.end(JSON.stringify({ message }));
  };

  const lfsHosts = upstream.lfsActionHosts ?? DEFAULT_LFS_ACTION_HOSTS;

  const handleLfsBatch = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const raw = await readAll(req, MAX_JSON_BYTES);
    if (raw === null) {
      lfsError(res, 413, 'too-large', 'ostra: LFS batch request too large');
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      lfsError(res, 400, 'bad-json', 'ostra: LFS batch request is not JSON');
      return;
    }
    const request = LfsBatchRequestSchema.safeParse(json);
    if (!request.success) {
      lfsError(res, 422, 'bad-batch', 'ostra: unreadable LFS batch request');
      return;
    }
    if (request.data.operation === 'upload' && policy.mode === 'read-only') {
      lfsError(res, 403, 'read-only', describeRefusal('read-only'));
      return;
    }
    const headers = await withToken({
      ...userAgentOf(req),
      accept: 'application/vnd.git-lfs+json',
      'content-type': 'application/vnd.git-lfs+json',
    });
    const upRes = await sendUpstream('lfs-batch', upstreamUrl('info/lfs/objects/batch', ''), 'POST', headers, raw);
    const status = upRes.statusCode ?? 502;
    const upBody = await readAll(upRes, MAX_JSON_BYTES);
    if (upBody === null) {
      lfsError(res, 502, 'upstream-too-large', 'ostra: LFS batch answer too large');
      return;
    }
    bytesFromUpstream += upBody.length;
    if (status !== 200) {
      if (status === 401 || status === 403) {
        lfsError(res, 502, 'upstream-auth', "ostra: GitHub refused the task's credential for LFS");
        return;
      }
      res.writeHead(status, { 'content-type': 'application/vnd.git-lfs+json' });
      res.end(upBody);
      return;
    }
    let upJson: unknown;
    try {
      upJson = JSON.parse(upBody.toString('utf8'));
    } catch {
      lfsError(res, 502, 'upstream-bad-json', 'ostra: unreadable LFS batch answer');
      return;
    }
    const answer = LfsBatchResponseSchema.safeParse(upJson);
    if (!answer.success) {
      lfsError(res, 502, 'upstream-bad-batch', 'ostra: unreadable LFS batch answer');
      return;
    }
    const now = Date.now();
    for (const [nonce, action] of lfsActions) if (action.expiresAt < now) lfsActions.delete(nonce);
    let rewritten = 0;
    let dropped = 0;
    let refusedObjects = 0;
    // Host names only: an action's path and query carry its signature.
    const droppedHosts = new Set<string>();
    const objects = answer.data.objects.map((object) => {
      if (object.actions === undefined) return object;
      const entries = Object.entries(object.actions).map(([name, action]) => ({ name, action, href: new URL(action.href) }));
      const refused = entries.filter((e) => !isAllowedLfsActionHref(e.href, upstreamOrigin, lfsHosts));
      if (refused.length > 0) {
        // All or nothing per object: an upload without its verify, or an
        // object with no actions left, would read to git-lfs as done.
        dropped += entries.length;
        refusedObjects += 1;
        for (const e of refused) droppedHosts.add(e.href.host.toLowerCase());
        return { oid: object.oid, size: object.size, error: { code: 403, message: LFS_ACTION_REFUSED_MESSAGE } };
      }
      const actions: Record<string, { href: string; expires_in: number }> = {};
      for (const { name, action, href } of entries) {
        const ttl = Math.min(action.expires_in ?? LFS_ACTION_MAX_TTL_S, LFS_ACTION_MAX_TTL_S);
        const nonce = randomBytes(24).toString('base64url');
        const actionHeaders = action.header ?? {};
        const hasAuth = Object.keys(actionHeaders).some((k) => k.toLowerCase() === 'authorization');
        lfsActions.set(nonce, {
          href,
          headers: actionHeaders,
          addToken: !hasAuth && href.origin === upstreamOrigin,
          expiresAt: now + ttl * 1000,
        });
        actions[name] = { href: `${selfUrl}/_ostra/lfs/${nonce}`, expires_in: ttl };
        rewritten += 1;
      }
      return { ...object, actions, authenticated: true };
    });
    logger.info('proxy.lfs.batch', {
      taskId: policy.taskId,
      repo: policy.repo,
      operation: request.data.operation,
      objects: objects.length,
      actions: rewritten,
      dropped,
      refusedObjects,
      droppedHosts: [...droppedHosts],
    });
    res.writeHead(200, { 'content-type': 'application/vnd.git-lfs+json' });
    res.end(JSON.stringify({ ...answer.data, objects }));
  };

  const handleLfsLocks = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (policy.mode === 'read-only') {
      lfsError(res, 403, 'read-only', describeRefusal('read-only'));
      return;
    }
    const raw = await readAll(req, MAX_JSON_BYTES);
    if (raw === null) {
      lfsError(res, 413, 'too-large', 'ostra: LFS locks request too large');
      return;
    }
    const headers = await withToken({
      ...userAgentOf(req),
      accept: 'application/vnd.git-lfs+json',
      'content-type': 'application/vnd.git-lfs+json',
    });
    const upRes = await sendUpstream('lfs-locks', upstreamUrl('info/lfs/locks/verify', ''), 'POST', headers, raw);
    await relay(upRes, res, 'lfs-locks');
  };

  const handleLfsAction = async (req: IncomingMessage, res: ServerResponse, nonce: string): Promise<void> => {
    const action = lfsActions.get(nonce);
    if (action === undefined || action.expiresAt < Date.now()) {
      lfsError(res, 404, 'unknown-action', 'ostra: unknown or expired LFS action');
      return;
    }
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'PUT' && method !== 'POST') {
      lfsError(res, 405, 'method', 'ostra: method not allowed');
      return;
    }
    if (method !== 'GET' && policy.mode === 'read-only') {
      lfsError(res, 403, 'read-only', describeRefusal('read-only'));
      return;
    }
    const base: Record<string, string> = { ...action.headers, ...userAgentOf(req) };
    for (const name of ['content-type', 'content-length', 'accept'] as const) {
      const v = headerOne(req, name);
      if (v !== undefined) base[name] = v;
    }
    const headers = action.addToken ? await withToken(base) : base;
    const upRes = await sendUpstream('lfs-action', action.href, method, headers, method === 'GET' ? null : req);
    await relay(upRes, res, 'lfs-action');
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    requests += 1;
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://proxy.invalid');
    res.once('finish', () => {
      logger.info('proxy.request', { taskId: policy.taskId, status: res.statusCode, ms: Date.now() - started });
    });
    const lfsMatch = /^\/_ostra\/lfs\/([A-Za-z0-9_-]{32})$/.exec(url.pathname);
    if (lfsMatch?.[1] !== undefined) {
      await handleLfsAction(req, res, lfsMatch[1]);
      return;
    }
    const route = matchRoute(url.pathname);
    if (route === null) {
      deny(res, 404, 'not-a-git-route', 'ostra: not a git endpoint');
      return;
    }
    if (!sameRepo(route.repo, policy.repo)) {
      const isPush =
        route.endpoint === 'receive-pack' ||
        (route.endpoint === 'info-refs' && url.searchParams.get('service') === 'git-receive-pack');
      if (isPush) refusedPushes += 1;
      deny(res, 403, 'other-repo', OTHER_REPO_MESSAGE);
      return;
    }
    const method = req.method ?? 'GET';
    switch (route.endpoint) {
      case 'info-refs':
        if (method !== 'GET') {
          deny(res, 405, 'method', 'ostra: method not allowed');
          return;
        }
        await handleInfoRefs(req, res, url.searchParams);
        return;
      case 'upload-pack':
        if (method !== 'POST') {
          deny(res, 405, 'method', 'ostra: method not allowed');
          return;
        }
        await handleUploadPack(req, res);
        return;
      case 'receive-pack':
        if (method !== 'POST') {
          deny(res, 405, 'method', 'ostra: method not allowed');
          return;
        }
        await handleReceivePack(req, res);
        return;
      case 'lfs-batch':
        if (method !== 'POST') {
          deny(res, 405, 'method', 'ostra: method not allowed');
          return;
        }
        await handleLfsBatch(req, res);
        return;
      case 'lfs-locks':
        if (method !== 'POST') {
          deny(res, 405, 'method', 'ostra: method not allowed');
          return;
        }
        await handleLfsLocks(req, res);
        return;
      default:
        route.endpoint satisfies never;
        deny(res, 404, 'not-a-git-route', 'ostra: not a git endpoint');
    }
  };

  const server = trackServer(
    http.createServer((req, res) => {
    handle(req, res).catch(() => {
      logger.info('proxy.error', { taskId: policy.taskId, repo: policy.repo });
      if (!res.headersSent) deny(res, 502, 'proxy-error', 'ostra: the git proxy could not reach GitHub');
      else res.destroy();
    });
    }),
  );
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? (address satisfies AddressInfo).port : 0;
  selfUrl = `http://${options.host ?? '127.0.0.1'}:${String(port)}`;

  return {
    url: selfUrl,
    stats: () => ({
      requests,
      refusedPushes,
      refusedRequests,
      upstreamRequests: { ...upstreamCounts },
      bytesToUpstream,
      bytesFromUpstream,
    }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
};
