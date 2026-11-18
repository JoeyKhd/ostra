import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { z } from 'zod';
import { verifyFakeToken } from './fake-token.ts';
import { spawnTracked } from './proc.ts';

// A stand-in for github.com: git's smart HTTP protocol over local bare repos
// (the same answers git-http-backend gives), plus a minimal LFS server whose
// object URLs need their own per-object style credential, like GitHub's.
// It requires `Authorization: Basic x-access-token:<token>` with a valid,
// unexpired fake installation token (fake-token.ts), so a clone works only
// through the proxy, and it counts every request so the harness can prove a
// refused push sent nothing.

export const StubConfigSchema = z
  .object({
    reposDir: z.string().min(1),
    lfsDir: z.string().min(1),
    // The HMAC key the fake installation tokens are signed with.
    tokenKey: z.string().min(20),
    lfsToken: z.string().min(20),
  })
  .strict();

// An LFS batch request naming this ref gets an answer whose actions point
// outside the upstream: the harness checks the proxy drops all but the one
// on an allowlisted GitHub storage host.
export const LFS_REDIRECT_PROBE_REF = 'refs/heads/ostra-spike4-lfs-redirect-probe';
export const LFS_REDIRECT_PROBE_HREFS = [
  'https://169.254.169.254/latest/meta-data/iam/',
  'https://[::1]/internal',
  'https://127.0.0.1/internal',
  'https://localhost/internal',
  'https://internal.example.invalid/objects',
  'http://github-cloud.githubusercontent.com/objects',
  'https://github-cloud.githubusercontent.com.evil.example.invalid/objects',
  'https://github-cloud.githubusercontent.com:8443/objects',
  // The one that is allowed: GitHub's own LFS storage host.
  'https://github-cloud.githubusercontent.com/alambic/media/objects',
] as const;
export type StubConfig = z.infer<typeof StubConfigSchema>;

export type StubRequestRecord = {
  readonly repo: string;
  readonly endpoint: string;
  readonly method: string;
  readonly authorized: boolean;
  readonly bytesIn: number;
};

export const StubStatsSchema = z
  .object({
    requests: z.array(
      z
        .object({
          repo: z.string(),
          endpoint: z.string(),
          method: z.string(),
          authorized: z.boolean(),
          bytesIn: z.number(),
        })
        .strict(),
    ),
    unauthorized: z.number(),
    expired: z.number(),
    // The IDs (jti) of every valid token the upstream accepted. Not secrets.
    tokenIds: z.array(z.string()),
  })
  .strict();
export type StubStats = z.infer<typeof StubStatsSchema>;

const GIT_ROUTE =
  /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)\.git\/(info\/refs|git-upload-pack|git-receive-pack|info\/lfs\/objects\/batch|info\/lfs\/locks\/verify)$/;
const LFS_OBJECT = /^\/_lfs\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/([0-9a-f]{64})(\/verify)?$/;

const BatchSchema = z
  .object({
    operation: z.enum(['upload', 'download']),
    objects: z.array(z.object({ oid: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().nonnegative() }).loose()),
    ref: z.object({ name: z.string() }).loose().optional(),
  })
  .loose();
const VerifySchema = z.object({ oid: z.string(), size: z.number() }).loose();

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

const readBody = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const value: unknown = chunk;
    if (Buffer.isBuffer(value)) chunks.push(value);
  }
  return Buffer.concat(chunks);
};

export const startUpstreamStub = async (config: StubConfig): Promise<{ port: number; close: () => Promise<void> }> => {
  const records: StubRequestRecord[] = [];
  let unauthorized = 0;
  let expired = 0;
  const tokenIds = new Set<string>();
  // Basic x-access-token:<fake installation token>, signed and unexpired.
  const checkAuth = (auth: string | undefined): boolean => {
    if (auth?.startsWith('Basic ') !== true) return false;
    const decoded = Buffer.from(auth.slice('Basic '.length), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0 || decoded.slice(0, colon) !== 'x-access-token') return false;
    const check = verifyFakeToken(config.tokenKey, decoded.slice(colon + 1));
    if (check.ok) {
      tokenIds.add(check.jti);
      return true;
    }
    if (check.reason === 'expired') expired += 1;
    return false;
  };
  const expectedLfsAuth = `RemoteAuth ${config.lfsToken}`;
  let base = '';

  const counter = (record: { bytesIn: number }): Transform =>
    new Transform({
      transform(chunk: Buffer, _enc, done) {
        record.bytesIn += chunk.length;
        done(null, chunk);
      },
    });

  const runService = async (
    service: 'upload-pack' | 'receive-pack',
    repoDir: string,
    advertise: boolean,
    gitProtocol: string | undefined,
    input: Readable | null,
    res: ServerResponse,
  ): Promise<void> => {
    const args = [service, '--stateless-rpc', ...(advertise ? ['--advertise-refs'] : []), repoDir];
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (gitProtocol !== undefined) env['GIT_PROTOCOL'] = gitProtocol;
    const child = spawnTracked('git', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const { stdin, stdout, stderr } = child;
    if (stdin === null || stdout === null || stderr === null) throw new Error('git service has no stdio');
    stderr.resume();
    const feeding =
      input === null
        ? Promise.resolve(stdin.end())
        : pipeline(input, stdin).catch(() => {
            // the service may stop reading early; its exit status tells.
          });
    await Promise.all([pipeline(stdout, res, { end: true }), feeding]);
  };

  const handleGit = async (req: IncomingMessage, res: ServerResponse, url: URL, m: RegExpExecArray): Promise<void> => {
    const [, owner, name, rest] = m;
    if (owner === undefined || name === undefined || rest === undefined) return;
    const repo = `${owner}/${name}`;
    const authorized = checkAuth(req.headers.authorization);
    const record = { repo, endpoint: rest, method: req.method ?? 'GET', authorized, bytesIn: 0 };
    records.push(record);
    if (!authorized) {
      unauthorized += 1;
      req.resume();
      res.writeHead(401, { 'www-authenticate': 'Basic realm="upstream-stub"', 'content-type': 'text/plain' });
      res.end('stub: credentials required\n');
      return;
    }
    const repoDir = path.join(config.reposDir, owner, `${name}.git`);
    if (!(await exists(repoDir))) {
      req.resume();
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('stub: no such repo\n');
      return;
    }
    const gitProtocolHeader = req.headers['git-protocol'];
    const gitProtocol = typeof gitProtocolHeader === 'string' ? gitProtocolHeader : undefined;
    const isV2 = gitProtocol?.split(':').includes('version=2') ?? false;
    if (rest === 'info/refs') {
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('stub: dumb http not served\n');
        return;
      }
      res.writeHead(200, {
        'content-type': `application/x-${service}-advertisement`,
        'cache-control': 'no-cache, max-age=0, must-revalidate',
      });
      if (!isV2 || service === 'git-receive-pack') {
        const line = `# service=${service}\n`;
        res.write(`${(line.length + 4).toString(16).padStart(4, '0')}${line}0000`);
      }
      await runService(service === 'git-upload-pack' ? 'upload-pack' : 'receive-pack', repoDir, true, gitProtocol, null, res);
      return;
    }
    if (rest === 'git-upload-pack' || rest === 'git-receive-pack') {
      const service = rest === 'git-upload-pack' ? 'upload-pack' : 'receive-pack';
      res.writeHead(200, { 'content-type': `application/x-git-${service}-result`, 'cache-control': 'no-cache' });
      const counted = req.pipe(counter(record));
      const input = req.headers['content-encoding'] === 'gzip' ? counted.pipe(createGunzip()) : counted;
      await runService(service, repoDir, false, gitProtocol, input, res);
      return;
    }
    if (rest === 'info/lfs/locks/verify') {
      await readBody(req);
      res.writeHead(200, { 'content-type': 'application/vnd.git-lfs+json' });
      res.end(JSON.stringify({ ours: [], theirs: [] }));
      return;
    }
    // LFS batch
    const body = await readBody(req);
    record.bytesIn = body.length;
    const parsed = BatchSchema.safeParse(JSON.parse(body.toString('utf8')));
    if (!parsed.success) {
      res.writeHead(422, { 'content-type': 'application/vnd.git-lfs+json' });
      res.end(JSON.stringify({ message: 'bad batch' }));
      return;
    }
    if (parsed.data.ref?.name === LFS_REDIRECT_PROBE_REF) {
      res.writeHead(200, { 'content-type': 'application/vnd.git-lfs+json' });
      res.end(
        JSON.stringify({
          transfer: 'basic',
          objects: parsed.data.objects.map(({ oid, size }, i) => ({
            oid,
            size,
            actions: { download: { href: LFS_REDIRECT_PROBE_HREFS[i % LFS_REDIRECT_PROBE_HREFS.length], header: { Authorization: expectedLfsAuth }, expires_in: 3600 } },
          })),
        }),
      );
      return;
    }
    const objects = await Promise.all(
      parsed.data.objects.map(async ({ oid, size }) => {
        const objectPath = path.join(config.lfsDir, owner, name, oid);
        const href = `${base}/_lfs/${owner}/${name}/${oid}`;
        const header = { Authorization: expectedLfsAuth };
        const present = await exists(objectPath);
        if (parsed.data.operation === 'download') {
          return present
            ? { oid, size, actions: { download: { href, header, expires_in: 3600 } } }
            : { oid, size, error: { code: 404, message: 'not found' } };
        }
        return present
          ? { oid, size }
          : {
              oid,
              size,
              actions: {
                upload: { href, header, expires_in: 3600 },
                verify: { href: `${href}/verify`, header, expires_in: 3600 },
              },
            };
      }),
    );
    res.writeHead(200, { 'content-type': 'application/vnd.git-lfs+json' });
    res.end(JSON.stringify({ transfer: 'basic', objects, hash_algo: 'sha256' }));
  };

  const handleLfsObject = async (req: IncomingMessage, res: ServerResponse, m: RegExpExecArray): Promise<void> => {
    const [, owner, name, oid, verify] = m;
    if (owner === undefined || name === undefined || oid === undefined) return;
    const auth = req.headers.authorization;
    const authorized = typeof auth === 'string' && safeEqual(auth, expectedLfsAuth);
    const record = { repo: `${owner}/${name}`, endpoint: verify === undefined ? 'lfs-object' : 'lfs-verify', method: req.method ?? 'GET', authorized, bytesIn: 0 };
    records.push(record);
    if (!authorized) {
      unauthorized += 1;
      req.resume();
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('stub: lfs credential required\n');
      return;
    }
    const dir = path.join(config.lfsDir, owner, name);
    const objectPath = path.join(dir, oid);
    if (verify !== undefined) {
      const body = VerifySchema.safeParse(JSON.parse((await readBody(req)).toString('utf8')));
      const ok = body.success && body.data.oid === oid && (await exists(objectPath)) && (await stat(objectPath)).size === body.data.size;
      res.writeHead(ok ? 200 : 422, { 'content-type': 'application/vnd.git-lfs+json' });
      res.end(ok ? '{}' : JSON.stringify({ message: 'verify failed' }));
      return;
    }
    if (req.method === 'GET') {
      if (!(await exists(objectPath))) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String((await stat(objectPath)).size) });
      await pipeline(createReadStream(objectPath), res);
      return;
    }
    if (req.method === 'PUT') {
      await mkdir(dir, { recursive: true });
      const temp = `${objectPath}.${String(process.pid)}.tmp`;
      const hash = createHash('sha256');
      await pipeline(
        req,
        new Transform({
          transform(chunk: Buffer, _enc, done) {
            hash.update(chunk);
            record.bytesIn += chunk.length;
            done(null, chunk);
          },
        }),
        createWriteStream(temp),
      );
      if (hash.digest('hex') !== oid) {
        await rm(temp, { force: true });
        res.writeHead(422);
        res.end();
        return;
      }
      await rename(temp, objectPath);
      res.writeHead(200);
      res.end();
      return;
    }
    res.writeHead(405);
    res.end();
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub.invalid');
    const run = async (): Promise<void> => {
      if (url.pathname === '/_stub/stats') {
        const stats: StubStats = { requests: records, unauthorized, expired, tokenIds: [...tokenIds] };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(stats));
        return;
      }
      // As GitHub does (lfs.github.com, seen 2026-11-18): no User-Agent, no
      // answer.
      if (req.headers['user-agent'] === undefined || req.headers['user-agent'] === '') {
        req.resume();
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('stub: Request forbidden by administrative rules. Please make sure your request has a User-Agent header\n');
        return;
      }
      const git = GIT_ROUTE.exec(url.pathname);
      if (git !== null) return handleGit(req, res, url, git);
      const lfs = LFS_OBJECT.exec(url.pathname);
      if (lfs !== null) return handleLfsObject(req, res, lfs);
      req.resume();
      res.writeHead(404);
      res.end();
    };
    run().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.requestTimeout = 0;
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? (address satisfies AddressInfo).port : 0;
  base = `http://127.0.0.1:${String(port)}`;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
};
