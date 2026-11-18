import { randomBytes } from "node:crypto";
import http from "node:http";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import type { Logger } from "@ostra/adapter-sdk";
import type { RepoFullName, RepoId, TaskId } from "@ostra/protocol";
import { RUNNER_VERSION } from "../../version.ts";
import {
  isAllowedLfsActionHref,
  LFS_ACTION_MAX_TTL_S,
  LFS_ACTION_REFUSED_MESSAGE,
  lfsBatchRequestSchema,
  lfsBatchResponseSchema,
} from "./lfs.ts";
import type { HeldLfsAction } from "./lfs.ts";
import { emptyReceivePackAdvertisement, encodeRefusal, parseReceivePackHead } from "./pkt-line.ts";
import type { ReceivePackHead, RefUpdateCommand } from "./pkt-line.ts";
import { decidePush, describeRefusal, sameRepo } from "./policy.ts";
import type { ProxyMode, RefusalCode, TaskGitPolicy } from "./policy.ts";

// The git proxy (ADR 0030 as amended, F-090). The agent's own git reaches it through an
// `insteadOf` rule the executor writes, on loopback behind a random per-task path segment. It:
//
// - serves the task's repos only, and only git's smart HTTP and LFS endpoints
// - drops every credential the client sends, and adds the repo's own one-repo token upstream,
//   fetched through a provider that refreshes it before it expires
// - reads each git-receive-pack command list before a byte goes upstream, and refuses any ref but
//   the task's branch and its hidden ref, and any delete, in git's own words
// - answers a push to another repo itself, so nothing for that repo ever reaches the code host
// - in read-only mode (refine and review tasks) refuses every push, LFS upload and lock check
// - rewrites LFS batch answers so signed URLs and their headers stay in the proxy
// - sends a User-Agent on every upstream request (GitHub refuses one without)
//
// It streams every body: no pack is buffered. It logs IDs, statuses and counts: never a token, a
// URL's query or a body. Ported from spikes/github-app-and-git-proxy/src/git-proxy.ts.

export type GitProxyRepo = {
  readonly repoId: RepoId;
  readonly fullName: RepoFullName;
  /** The code host's HTTPS clone URL, such as `https://github.com/ostra-test/test1.git`. */
  readonly cloneUrl: string;
  /** Hosts its LFS batch answers may send the proxy to, besides the clone URL's own origin. */
  readonly lfsActionHosts: readonly string[];
  /** The repo's current token. Never logged. */
  readonly token: () => Promise<string>;
};

export type GitProxyOptions = {
  readonly taskId: TaskId;
  /** The task's branch: the same name in every repo. */
  readonly branch: string;
  readonly mode: ProxyMode;
  readonly repos: readonly GitProxyRepo[];
  readonly logger: Logger;
  /** Loopback on `host`, the box network's address on `docker`. */
  readonly listenHost: string;
  /** The address the agent reaches the proxy on, when it differs from `listenHost`. */
  readonly advertiseHost?: string;
  readonly port?: number;
  readonly now?: () => number;
};

type Endpoint = "info-refs" | "upload-pack" | "receive-pack" | "lfs-batch" | "lfs-locks" | "lfs-action";

export type GitProxyStats = {
  readonly requests: number;
  readonly refusedPushes: number;
  readonly refusedRequests: number;
  /** Requests sent to the code host and LFS hosts, by endpoint. */
  readonly upstreamRequests: Readonly<Record<Endpoint, number>>;
};

export type InsteadOfRule = {
  /** What the agent's git sees as the remote, such as `https://github.com/`. */
  readonly from: string;
  /** Where it goes instead: the proxy. */
  readonly to: string;
};

export type GitProxy = {
  /** The proxy's base, with its secret path segment: `http://127.0.0.1:<port>/<secret>`. */
  readonly baseUrl: string;
  /** Where the agent's git clones a repo: `<baseUrl>/<owner>/<name>.git`. */
  readonly urlFor: (fullName: RepoFullName) => string;
  /** `url.<to>.insteadOf <from>` rules, so the code host's own URLs go through the proxy. */
  readonly insteadOf: readonly InsteadOfRule[];
  readonly stats: () => GitProxyStats;
  readonly close: () => Promise<void>;
};

/** The most of a refused push's body the proxy reads and drops before it closes (Q123). */
export const MAX_DISCARD_BYTES = 1024 * 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;

const PROXY_USER_AGENT = `ostra-git-proxy/${RUNNER_VERSION}`;

const ROUTE =
  /^\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack|info\/lfs\/objects\/batch|info\/lfs\/locks\/verify)$/;
const LFS_ACTION_ROUTE = /^\/_ostra\/lfs\/([A-Za-z0-9_-]{32})$/;

type Route = { readonly repo: string; readonly endpoint: Exclude<Endpoint, "lfs-action"> };

const endpointOf = (rest: string): Exclude<Endpoint, "lfs-action"> | null => {
  switch (rest) {
    case "info/refs":
      return "info-refs";
    case "git-upload-pack":
      return "upload-pack";
    case "git-receive-pack":
      return "receive-pack";
    case "info/lfs/objects/batch":
      return "lfs-batch";
    case "info/lfs/locks/verify":
      return "lfs-locks";
    default:
      return null;
  }
};

const matchRoute = (pathname: string): Route | null => {
  const match = ROUTE.exec(pathname);
  const [, owner, name, rest] = match ?? [];
  if (owner === undefined || name === undefined || rest === undefined) {
    return null;
  }
  const endpoint = endpointOf(rest);
  return endpoint === null ? null : { repo: `${owner}/${name}`, endpoint };
};

const headerOne = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

// Only these client headers go upstream. Authorization, Cookie and anything else are dropped.
const CLIENT_HEADERS = ["content-type", "accept", "git-protocol", "accept-encoding"] as const;
const RESPONSE_HEADERS = ["content-type", "content-encoding", "content-length", "cache-control", "expires", "pragma"] as const;

/** Every upstream request carries a User-Agent: the client's own (git's, git-lfs's), or the proxy's. */
const userAgentOf = (request: IncomingMessage): string => {
  const own = headerOne(request, "user-agent");
  return own === undefined || own.trim() === "" ? PROXY_USER_AGENT : own;
};

const pickClientHeaders = (request: IncomingMessage, keepLength: boolean, keepEncoding: boolean): Record<string, string> => {
  const out: Record<string, string> = { "user-agent": userAgentOf(request) };
  for (const name of CLIENT_HEADERS) {
    const value = headerOne(request, name);
    if (value !== undefined) {
      out[name] = value;
    }
  }
  if (keepLength) {
    const value = headerOne(request, "content-length");
    if (value !== undefined) {
      out["content-length"] = value;
    }
  }
  if (keepEncoding) {
    const value = headerOne(request, "content-encoding");
    if (value !== undefined) {
      out["content-encoding"] = value;
    }
  }
  return out;
};

const basicAuth = (token: string): string => `Basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`;

const readAll = async (stream: Readable, limit: number): Promise<Buffer | null> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const value: unknown = chunk;
    if (!Buffer.isBuffer(value)) {
      return null;
    }
    total += value.length;
    if (total > limit) {
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
};

/** Where a refusal came from, so its words say which side said no. */
type UpstreamSource = "code-host" | "lfs-host";

/** A code host's or LFS host's refusal, in words by status and source. Never holds its body. */
export const describeUpstreamRefusal = (status: number, source: UpstreamSource): string => {
  const who = source === "code-host" ? "the code host" : "the LFS storage host";
  if (status === 401 || status === 403) {
    return source === "code-host"
      ? `ostra: the code host refused the task's credential (status ${String(status)})`
      : `ostra: the LFS storage host refused the transfer (status ${String(status)})`;
  }
  if (status === 404) {
    return source === "code-host"
      ? "ostra: the code host has no such repo, or the App can't see it (status 404)"
      : "ostra: the LFS storage host has no such object (status 404)";
  }
  if (status === 407 || (status >= 300 && status < 400)) {
    return `ostra: ${who} answered with a redirect or a proxy challenge (status ${String(status)}), which the proxy doesn't follow`;
  }
  return `ostra: ${who} answered ${String(status)}`;
};

export const startGitProxy = async (options: GitProxyOptions): Promise<GitProxy> => {
  const now = options.now ?? Date.now;
  const log = options.logger.child({ taskId: options.taskId, component: "git-proxy" });
  const policy: TaskGitPolicy = { taskId: options.taskId, branch: options.branch, mode: options.mode };
  const secret = randomBytes(24).toString("base64url");
  const counts: Record<Endpoint, number> = {
    "info-refs": 0,
    "upload-pack": 0,
    "receive-pack": 0,
    "lfs-batch": 0,
    "lfs-locks": 0,
    "lfs-action": 0,
  };
  let requests = 0;
  let refusedPushes = 0;
  let refusedRequests = 0;
  const lfsActions = new Map<string, HeldLfsAction>();
  let baseUrl = "";

  const repoFor = (name: string): GitProxyRepo | undefined => options.repos.find((repo) => sameRepo(name, repo.fullName));

  const deny = (response: ServerResponse, status: number, code: string, message: string): void => {
    refusedRequests += 1;
    log.info("git proxy refused a request", { status, code });
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" });
    response.end(`${message}\n`);
  };

  const upstreamUrl = (repo: GitProxyRepo, rest: string, search: string): URL => {
    const base = repo.cloneUrl.replace(/\/+$/, "").replace(/\.git$/, "");
    return new URL(`${base}.git/${rest}${search}`);
  };

  /** Opens one upstream request. The body is streamed, never buffered. */
  const sendUpstream = (
    endpoint: Endpoint,
    target: URL,
    method: string,
    headers: OutgoingHttpHeaders,
    body: Readable | Buffer | null,
  ): Promise<IncomingMessage> => {
    counts[endpoint] += 1;
    const transport = target.protocol === "https:" ? https : http;
    return new Promise<IncomingMessage>((resolve, reject) => {
      const upstreamRequest = transport.request(target, { method, headers });
      upstreamRequest.once("response", resolve);
      upstreamRequest.once("error", reject);
      if (body === null) {
        upstreamRequest.end();
      } else if (Buffer.isBuffer(body)) {
        upstreamRequest.end(body);
      } else {
        pipeline(body, upstreamRequest).catch(reject);
      }
    });
  };

  // Streams an upstream answer back. Auth challenges and redirects never reach the agent: a
  // challenge would make git ask for a credential, a redirect could send it where the policy never
  // looked.
  const relay = async (upstream: IncomingMessage, response: ServerResponse, endpoint: Endpoint, source: UpstreamSource): Promise<void> => {
    const status = upstream.statusCode ?? 502;
    if (status === 401 || status === 403 || status === 404 || status === 407 || (status >= 300 && status < 400)) {
      upstream.resume();
      log.warn("upstream refused", { endpoint, source, status, reason: upstream.statusMessage ?? null });
      deny(response, status === 404 ? 404 : 502, "upstream-refused", describeUpstreamRefusal(status, source));
      return;
    }
    if (status >= 400) {
      log.warn("upstream failed", { endpoint, source, status, reason: upstream.statusMessage ?? null });
    }
    const headers: Record<string, string> = {};
    for (const name of RESPONSE_HEADERS) {
      const value = upstream.headers[name];
      if (typeof value === "string") {
        headers[name] = value;
      }
    }
    response.writeHead(status, headers);
    await pipeline(upstream, response);
  };

  const withToken = async (repo: GitProxyRepo, headers: Record<string, string>): Promise<Record<string, string>> => ({
    ...headers,
    authorization: basicAuth(await repo.token()),
  });

  const refusePush = async (
    request: IncomingMessage,
    response: ServerResponse,
    iterator: AsyncIterator<unknown>,
    head: ReceivePackHead,
    codes: readonly RefusalCode[],
    codeFor: (command: RefUpdateCommand) => RefusalCode,
  ): Promise<void> => {
    refusedPushes += 1;
    log.info("git proxy refused a push", { refCount: head.commands.length, codes: [...codes] });
    // Read the rest of the body and drop it, so git gets to read the answer. None of it goes upstream.
    let discarded = 0;
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) {
        break;
      }
      const value: unknown = next.value;
      if (Buffer.isBuffer(value)) {
        discarded += value.length;
      }
      if (discarded > MAX_DISCARD_BYTES) {
        request.destroy();
        return;
      }
    }
    const firstCode = codes[0] ?? "ref-not-allowed";
    const payload = encodeRefusal(head, (command) => describeRefusal(codeFor(command)), describeRefusal(firstCode));
    if (payload === null) {
      deny(response, 403, firstCode, describeRefusal(firstCode));
      return;
    }
    response.writeHead(200, { "content-type": "application/x-git-receive-pack-result", "cache-control": "no-cache" });
    response.end(payload);
  };

  const handleInfoRefs = async (repo: GitProxyRepo | undefined, request: IncomingMessage, response: ServerResponse, search: URLSearchParams): Promise<void> => {
    const service = search.get("service");
    if (service !== "git-upload-pack" && service !== "git-receive-pack") {
      deny(response, 403, "dumb-http", "ostra: only git's smart HTTP protocol is served");
      return;
    }
    if (service === "git-receive-pack" && policy.mode === "read-only") {
      refusedPushes += 1;
      deny(response, 403, "read-only", describeRefusal("read-only"));
      return;
    }
    if (repo === undefined) {
      if (service === "git-upload-pack") {
        deny(response, 403, "other-repo", describeRefusal("other-repo"));
        return;
      }
      // A push to another repo: answer as an empty repo, so git sends its push and gets refused
      // in its own words. Nothing for this repo reaches the code host.
      response.writeHead(200, { "content-type": "application/x-git-receive-pack-advertisement", "cache-control": "no-cache" });
      response.end(emptyReceivePackAdvertisement(PROXY_USER_AGENT));
      return;
    }
    const target = upstreamUrl(repo, "info/refs", `?service=${service}`);
    const upstream = await sendUpstream("info-refs", target, "GET", await withToken(repo, pickClientHeaders(request, false, false)), null);
    await relay(upstream, response, "info-refs", "code-host");
  };

  const handleReceivePack = async (repo: GitProxyRepo | undefined, request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (policy.mode === "read-only") {
      refusedPushes += 1;
      request.resume();
      deny(response, 403, "read-only", describeRefusal("read-only"));
      return;
    }
    const encoding = headerOne(request, "content-encoding");
    let body: Readable = request;
    if (encoding === "gzip") {
      const gunzip = createGunzip();
      request.on("error", (error) => gunzip.destroy(error));
      body = request.pipe(gunzip);
    } else if (encoding !== undefined && encoding !== "identity") {
      request.resume();
      deny(response, 415, "content-encoding", "ostra: unsupported content encoding");
      return;
    }
    const iterator: AsyncIterator<unknown> = body[Symbol.asyncIterator]();
    let buffered: Buffer = Buffer.alloc(0);
    let head: ReceivePackHead;
    for (;;) {
      const parsed = parseReceivePackHead(buffered);
      if (parsed.kind === "parsed") {
        head = parsed.head;
        break;
      }
      if (parsed.kind === "error") {
        refusedPushes += 1;
        deny(response, 400, parsed.reason, "ostra: couldn't read the push's command list");
        request.destroy();
        return;
      }
      const next = await iterator.next();
      if (next.done === true) {
        deny(response, 400, "truncated", "ostra: the push's command list was cut short");
        return;
      }
      const value: unknown = next.value;
      if (!Buffer.isBuffer(value)) {
        deny(response, 400, "bad-body", "ostra: unreadable push body");
        return;
      }
      buffered = buffered.length === 0 ? value : Buffer.concat([buffered, value]);
    }
    if (repo === undefined) {
      await refusePush(request, response, iterator, head, ["other-repo"], () => "other-repo");
      return;
    }
    const verdict = decidePush(policy, head.commands);
    if (!verdict.allowed) {
      const byRef = new Map(verdict.verdicts.map((item) => [item.ref, item.allowed ? "other-ref-refused" : item.code] as const));
      await refusePush(request, response, iterator, head, verdict.codes, (command) => byRef.get(command.ref) ?? "ref-not-allowed");
      return;
    }
    log.info("git proxy forwarded a push", { repoId: repo.repoId, refCount: head.commands.length });
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
            if (next.done === true) {
              return { done: true, value: undefined };
            }
            const value: unknown = next.value;
            if (Buffer.isBuffer(value)) {
              return { done: false, value };
            }
          }
        },
        return: async (): Promise<IteratorResult<Buffer, undefined>> => {
          await iterator.return?.();
          return { done: true, value: undefined };
        },
      }),
    };
    // The same bytes the client sent (decompressed if they were gzip), so the length survives only
    // when nothing was decompressed.
    const plain = encoding === undefined || encoding === "identity";
    const headers = await withToken(repo, pickClientHeaders(request, plain, false));
    const upstream = await sendUpstream("receive-pack", upstreamUrl(repo, "git-receive-pack", ""), "POST", headers, Readable.from(rest));
    await relay(upstream, response, "receive-pack", "code-host");
  };

  const lfsError = (response: ServerResponse, status: number, code: string, message: string): void => {
    refusedRequests += 1;
    log.info("git proxy refused an LFS request", { status, code });
    response.writeHead(status, { "content-type": "application/vnd.git-lfs+json" });
    response.end(JSON.stringify({ message }));
  };

  const lfsHeaders = (request: IncomingMessage): Record<string, string> => ({
    "user-agent": userAgentOf(request),
    accept: "application/vnd.git-lfs+json",
    "content-type": "application/vnd.git-lfs+json",
  });

  const handleLfsBatch = async (repo: GitProxyRepo, request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const raw = await readAll(request, MAX_JSON_BYTES);
    if (raw === null) {
      lfsError(response, 413, "too-large", "ostra: the LFS batch request is too large");
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw.toString("utf8"));
    } catch {
      lfsError(response, 400, "bad-json", "ostra: the LFS batch request is not JSON");
      return;
    }
    const batch = lfsBatchRequestSchema.safeParse(json);
    if (!batch.success) {
      lfsError(response, 422, "bad-batch", "ostra: unreadable LFS batch request");
      return;
    }
    if (batch.data.operation === "upload" && policy.mode === "read-only") {
      lfsError(response, 403, "read-only", describeRefusal("read-only"));
      return;
    }
    const headers = await withToken(repo, lfsHeaders(request));
    const upstream = await sendUpstream("lfs-batch", upstreamUrl(repo, "info/lfs/objects/batch", ""), "POST", headers, raw);
    const status = upstream.statusCode ?? 502;
    const upstreamBody = await readAll(upstream, MAX_JSON_BYTES);
    if (upstreamBody === null) {
      lfsError(response, 502, "upstream-too-large", "ostra: the LFS batch answer is too large");
      return;
    }
    if (status !== 200) {
      log.warn("upstream refused an LFS batch", { status, reason: upstream.statusMessage ?? null });
      if (status === 401 || status === 403 || status === 404) {
        lfsError(response, 502, "upstream-refused", describeUpstreamRefusal(status, "code-host"));
        return;
      }
      response.writeHead(status, { "content-type": "application/vnd.git-lfs+json" });
      response.end(upstreamBody);
      return;
    }
    let upstreamJson: unknown;
    try {
      upstreamJson = JSON.parse(upstreamBody.toString("utf8"));
    } catch {
      lfsError(response, 502, "upstream-bad-json", "ostra: unreadable LFS batch answer");
      return;
    }
    const answer = lfsBatchResponseSchema.safeParse(upstreamJson);
    if (!answer.success) {
      lfsError(response, 502, "upstream-bad-batch", "ostra: unreadable LFS batch answer");
      return;
    }
    const at = now();
    for (const [nonce, action] of lfsActions) {
      if (action.expiresAt < at) {
        lfsActions.delete(nonce);
      }
    }
    const upstreamOrigin = new URL(repo.cloneUrl).origin;
    let rewritten = 0;
    let refusedObjects = 0;
    const droppedHosts = new Set<string>();
    const objects = answer.data.objects.map((object) => {
      if (object.actions === undefined) {
        return object;
      }
      const entries = Object.entries(object.actions).map(([name, action]) => ({ name, action, href: new URL(action.href) }));
      const refused = entries.filter((entry) => !isAllowedLfsActionHref(entry.href, upstreamOrigin, repo.lfsActionHosts));
      if (refused.length > 0) {
        // All or nothing per object: an upload without its verify would read to git-lfs as done.
        refusedObjects += 1;
        for (const entry of refused) {
          droppedHosts.add(entry.href.host.toLowerCase());
        }
        return { oid: object.oid, size: object.size, error: { code: 403, message: LFS_ACTION_REFUSED_MESSAGE } };
      }
      const actions: Record<string, { readonly href: string; readonly expires_in: number }> = {};
      for (const { name, action, href } of entries) {
        const ttl = Math.min(action.expires_in ?? LFS_ACTION_MAX_TTL_S, LFS_ACTION_MAX_TTL_S);
        const nonce = randomBytes(24).toString("base64url");
        const actionHeaders = action.header ?? {};
        const hasAuth = Object.keys(actionHeaders).some((key) => key.toLowerCase() === "authorization");
        lfsActions.set(nonce, {
          href,
          headers: actionHeaders,
          addToken: !hasAuth && href.origin === upstreamOrigin,
          repo: repo.fullName,
          expiresAt: at + ttl * 1000,
        });
        actions[name] = { href: `${baseUrl}/_ostra/lfs/${nonce}`, expires_in: ttl };
        rewritten += 1;
      }
      return { ...object, actions, authenticated: true };
    });
    log.info("LFS batch", {
      repoId: repo.repoId,
      operation: batch.data.operation,
      objects: objects.length,
      actions: rewritten,
      refusedObjects,
      droppedHosts: [...droppedHosts],
    });
    response.writeHead(200, { "content-type": "application/vnd.git-lfs+json" });
    response.end(JSON.stringify({ ...answer.data, objects }));
  };

  const handleLfsLocks = async (repo: GitProxyRepo, request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (policy.mode === "read-only") {
      request.resume();
      lfsError(response, 403, "read-only", describeRefusal("read-only"));
      return;
    }
    const raw = await readAll(request, MAX_JSON_BYTES);
    if (raw === null) {
      lfsError(response, 413, "too-large", "ostra: the LFS locks request is too large");
      return;
    }
    const headers = await withToken(repo, lfsHeaders(request));
    const upstream = await sendUpstream("lfs-locks", upstreamUrl(repo, "info/lfs/locks/verify", ""), "POST", headers, raw);
    await relay(upstream, response, "lfs-locks", "code-host");
  };

  const handleLfsAction = async (request: IncomingMessage, response: ServerResponse, nonce: string): Promise<void> => {
    const action = lfsActions.get(nonce);
    const repo = action === undefined ? undefined : repoFor(action.repo);
    if (action === undefined || repo === undefined || action.expiresAt < now()) {
      request.resume();
      lfsError(response, 404, "unknown-action", "ostra: unknown or expired LFS action");
      return;
    }
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "PUT" && method !== "POST") {
      request.resume();
      lfsError(response, 405, "method", "ostra: method not allowed");
      return;
    }
    if (method !== "GET" && policy.mode === "read-only") {
      request.resume();
      lfsError(response, 403, "read-only", describeRefusal("read-only"));
      return;
    }
    const headers: Record<string, string> = { ...action.headers };
    // The action's own User-Agent, in whatever case, wins over the client's.
    if (!Object.keys(headers).some((key) => key.toLowerCase() === "user-agent")) {
      headers["user-agent"] = userAgentOf(request);
    }
    for (const name of ["content-type", "content-length", "accept"] as const) {
      const value = headerOne(request, name);
      if (value !== undefined) {
        headers[name] = value;
      }
    }
    const withAuth = action.addToken ? await withToken(repo, headers) : headers;
    const upstream = await sendUpstream("lfs-action", action.href, method, withAuth, method === "GET" ? null : request);
    await relay(upstream, response, "lfs-action", action.href.origin === new URL(repo.cloneUrl).origin ? "code-host" : "lfs-host");
  };

  const methodIs = (request: IncomingMessage, response: ServerResponse, method: "GET" | "POST"): boolean => {
    if ((request.method ?? "GET") === method) {
      return true;
    }
    request.resume();
    deny(response, 405, "method", "ostra: method not allowed");
    return false;
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    requests += 1;
    const url = new URL(request.url ?? "/", "http://git-proxy.invalid");
    const prefix = `/${secret}`;
    if (!url.pathname.startsWith(`${prefix}/`)) {
      request.resume();
      deny(response, 404, "not-a-git-route", "ostra: not a git endpoint");
      return;
    }
    const path = url.pathname.slice(prefix.length);
    const lfsAction = LFS_ACTION_ROUTE.exec(path);
    if (lfsAction?.[1] !== undefined) {
      await handleLfsAction(request, response, lfsAction[1]);
      return;
    }
    const route = matchRoute(path);
    if (route === null) {
      request.resume();
      deny(response, 404, "not-a-git-route", "ostra: not a git endpoint");
      return;
    }
    const repo = repoFor(route.repo);
    const pushing = route.endpoint === "receive-pack" || (route.endpoint === "info-refs" && url.searchParams.get("service") === "git-receive-pack");
    if (repo === undefined && !pushing) {
      request.resume();
      deny(response, 403, "other-repo", describeRefusal("other-repo"));
      return;
    }
    switch (route.endpoint) {
      case "info-refs":
        if (methodIs(request, response, "GET")) {
          await handleInfoRefs(repo, request, response, url.searchParams);
        }
        return;
      case "upload-pack":
        if (methodIs(request, response, "POST") && repo !== undefined) {
          const upstream = await sendUpstream(
            "upload-pack",
            upstreamUrl(repo, "git-upload-pack", ""),
            "POST",
            await withToken(repo, pickClientHeaders(request, true, true)),
            request,
          );
          await relay(upstream, response, "upload-pack", "code-host");
        }
        return;
      case "receive-pack":
        if (methodIs(request, response, "POST")) {
          await handleReceivePack(repo, request, response);
        }
        return;
      case "lfs-batch":
        if (methodIs(request, response, "POST") && repo !== undefined) {
          await handleLfsBatch(repo, request, response);
        }
        return;
      case "lfs-locks":
        if (methodIs(request, response, "POST") && repo !== undefined) {
          await handleLfsLocks(repo, request, response);
        }
        return;
      default:
        route.endpoint satisfies never;
    }
  };

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      log.warn("git proxy request failed", { error: error instanceof Error ? error.name : "unknown" });
      if (!response.headersSent) {
        deny(response, 502, "proxy-error", "ostra: the git proxy couldn't reach the code host");
      } else {
        response.destroy();
      }
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.listenHost, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address: AddressInfo | string | null = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  baseUrl = `http://${options.advertiseHost ?? options.listenHost}:${String(port)}/${secret}`;
  const origins = [...new Set(options.repos.map((repo) => new URL(repo.cloneUrl).origin))];

  return {
    baseUrl,
    urlFor: (fullName) => `${baseUrl}/${fullName}.git`,
    insteadOf: origins.map((origin) => ({ from: `${origin}/`, to: `${baseUrl}/` })),
    stats: () => ({ requests, refusedPushes, refusedRequests, upstreamRequests: { ...counts } }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
};
