// A stub of the git proxy (ADR 0030; spike 4 builds the real one). It's here
// so the box has its real shape: the agent's own `git` talks smart HTTP to
// the sidecar through a `url.<sidecar>.insteadOf` rule, and the token is added
// in the sidecar, never in the agent's container.
//
// What the stub enforces, because spike 3's attack checklist probes it:
//   - only the task's repo, only the three smart-HTTP routes, only origin-form
//     request targets (no absolute URLs, no CONNECT): it can't be turned into
//     an open proxy that carries the token somewhere else
//   - pushes: only the task's branch and its hidden ref, no deletes, refused
//     before a byte goes upstream
//   - the client's own Authorization header is dropped
//
// The request body is buffered (up to a limit) to read the push commands.
// Streaming and large packs are spike 4's question.

import { spawn } from "node:child_process";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";

const gunzipAsync = promisify(gunzip);

const ZERO_ID = /^0{40}$|^0{64}$/;
const MAX_BODY = 256 * 1024 * 1024;

export type PushCommand = { readonly oldId: string; readonly newId: string; readonly ref: string };

export type ParsedPush = { readonly ok: true; readonly commands: readonly PushCommand[] } | { readonly ok: false; readonly reason: string };

/** Reads the command list at the head of a `git-receive-pack` request body (pkt-lines up to the flush). */
export const parsePushCommands = (body: Buffer): ParsedPush => {
  const commands: PushCommand[] = [];
  let offset = 0;
  for (;;) {
    if (offset + 4 > body.length) return { ok: false, reason: "truncated pkt-line" };
    const lengthText = body.subarray(offset, offset + 4).toString("ascii");
    if (!/^[0-9a-f]{4}$/.test(lengthText)) return { ok: false, reason: "bad pkt-line length" };
    const length = Number.parseInt(lengthText, 16);
    if (length === 0) break;
    if (length < 4 || offset + length > body.length) return { ok: false, reason: "bad pkt-line length" };
    const payload = body.subarray(offset + 4, offset + length).toString("utf8");
    offset += length;
    const line = (payload.split("\0")[0] ?? "").replace(/\n$/, "");
    if (line.startsWith("shallow ")) continue;
    if (line.startsWith("push-cert")) return { ok: false, reason: "signed pushes are not supported" };
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) (refs\/[^\s]+)$/.exec(line);
    if (match === null) return { ok: false, reason: "bad command" };
    const [, oldId = "", newId = "", ref = ""] = match;
    commands.push({ oldId, newId, ref });
  }
  return { ok: true, commands };
};

export type PushPolicy = { readonly allowedRefs: readonly string[] };

/**
 * Why a push was refused. `code` is what a log line may carry; `message`
 * names the agent's own ref, so it goes only in the HTTP body back to git.
 */
export type PushRefusal = { readonly code: "no_commands" | "delete_refused" | "ref_refused"; readonly message: string };

export const checkPush = (commands: readonly PushCommand[], policy: PushPolicy): PushRefusal | undefined => {
  if (commands.length === 0) return { code: "no_commands", message: "no commands" };
  for (const command of commands) {
    if (ZERO_ID.test(command.newId)) return { code: "delete_refused", message: `delete refused: ${command.ref}` };
    if (!policy.allowedRefs.includes(command.ref)) return { code: "ref_refused", message: `ref refused: ${command.ref}` };
  }
  return undefined;
};

export type GitProxyOptions = {
  readonly host: string;
  readonly port: number;
  /** A random path segment for this task. Not a credential: the agent sees it in its git config. */
  readonly pathToken: string;
  /** `owner/name` */
  readonly repo: string;
  readonly taskBranch: string;
  readonly hiddenRef: string;
  /** Upstream base, e.g. https://github.com; or a local stub's origin. */
  readonly upstream: string;
  /** Held in memory only. */
  readonly token: string;
  readonly log: (line: Readonly<Record<string, string | number | boolean | null>>) => void;
};

export type GitProxy = {
  readonly origin: string;
  /** The URL prefix the agent's insteadOf rule rewrites `https://github.com/` to. */
  readonly agentPrefix: (agentHost: string) => string;
  readonly stats: () => { readonly forwarded: number; readonly refused: number };
  readonly close: () => Promise<void>;
};

const ROUTE = /^\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

const readBody = async (req: IncomingMessage): Promise<Buffer | undefined> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
};

export const startGitProxy = async (options: GitProxyOptions): Promise<GitProxy> => {
  let forwarded = 0;
  let refused = 0;
  const upstream = new URL(options.upstream);
  const send = upstream.protocol === "https:" ? httpsRequest : httpRequest;
  const allowedRefs = [`refs/heads/${options.taskBranch}`, options.hiddenRef];

  // Logs carry a fixed code and counts only; the message (which may name the
  // agent's ref) goes back to git in the body.
  const refuse = (res: ServerResponse, status: number, code: string, message: string = code, commands = 0): void => {
    refused += 1;
    options.log({ event: "git_proxy_refused", status, reason: code, commands });
    res.writeHead(status, { "content-type": "text/plain" });
    res.end(`ostra git proxy: ${message}\n`);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const target = req.url ?? "";
    // Origin-form only: an absolute URL or CONNECT would make this an open proxy.
    if (!target.startsWith("/") || req.method === "CONNECT") {
      refuse(res, 400, "origin_form_only", "origin-form requests only");
      return;
    }
    const url = new URL(target, "http://git-proxy.local");
    const match = ROUTE.exec(url.pathname);
    if (match === null) {
      refuse(res, 404, "unknown_route", "unknown route");
      return;
    }
    const [, token = "", repo = "", route = ""] = match;
    if (token !== options.pathToken || repo !== options.repo) {
      refuse(res, 404, "unknown_repo", "unknown repo");
      return;
    }
    const service = url.searchParams.get("service");
    if (route === "info/refs" && service !== "git-upload-pack" && service !== "git-receive-pack") {
      refuse(res, 403, "dumb_protocol", "dumb protocol refused");
      return;
    }
    const body = req.method === "POST" ? await readBody(req) : Buffer.alloc(0);
    if (body === undefined) {
      refuse(res, 413, "body_too_large", "body too large for the stub");
      return;
    }
    if (route === "git-receive-pack") {
      const plain = req.headers["content-encoding"] === "gzip" ? await gunzipAsync(body) : body;
      const parsed = parsePushCommands(plain);
      if (!parsed.ok) {
        refuse(res, 400, "bad_push", parsed.reason);
        return;
      }
      const problem = checkPush(parsed.commands, { allowedRefs });
      if (problem !== undefined) {
        refuse(res, 403, problem.code, problem.message, parsed.commands.length);
        return;
      }
    }
    const headers: Record<string, string> = {
      authorization: `Basic ${Buffer.from(`x-access-token:${options.token}`).toString("base64")}`,
      "user-agent": req.headers["user-agent"] ?? "git",
    };
    for (const name of ["content-type", "content-encoding", "accept", "git-protocol"] as const) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const upstreamPath = `${upstream.pathname.replace(/\/+$/, "")}/${options.repo}.git/${route}${url.search}`;
    const outgoing = send(
      { protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port, method: req.method ?? "GET", path: upstreamPath, headers: { ...headers, "content-length": String(body.length) } },
      (upstreamRes) => {
        forwarded += 1;
        const passHeaders: Record<string, string> = {};
        for (const name of ["content-type", "cache-control", "expires", "pragma", "content-encoding"]) {
          const value = upstreamRes.headers[name];
          if (typeof value === "string") passHeaders[name] = value;
        }
        res.writeHead(upstreamRes.statusCode ?? 502, passHeaders);
        upstreamRes.pipe(res);
      },
    );
    outgoing.on("error", () => {
      if (!res.headersSent) refuse(res, 502, "upstream_unreachable", "upstream unreachable");
      else res.destroy();
    });
    outgoing.end(body);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) refuse(res, 500, "proxy_error", "proxy error");
      else res.destroy();
    });
  });
  server.on("connect", (_req, socket) => {
    refused += 1;
    socket.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? (address satisfies AddressInfo).port : options.port;
  return {
    origin: `http://${options.host === "0.0.0.0" ? "127.0.0.1" : options.host}:${String(port)}`,
    agentPrefix: (agentHost) => `http://${agentHost}:${String(port)}/${options.pathToken}/`,
    stats: () => ({ forwarded, refused }),
    close: async () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
};

/**
 * A stand-in for GitHub: `git http-backend` over a bare repo, which accepts
 * only the expected token. It records whether each request carried it, so the
 * harness can tell that the proxy, not the agent, added it.
 */
export type GitStubUpstream = {
  readonly origin: string;
  readonly stats: () => { readonly withToken: number; readonly withoutToken: number };
  readonly close: () => Promise<void>;
};

export const startGitStubUpstream = async (options: { readonly projectRoot: string; readonly token: string }): Promise<GitStubUpstream> => {
  let withToken = 0;
  let withoutToken = 0;
  const expected = `Basic ${Buffer.from(`x-access-token:${options.token}`).toString("base64")}`;
  const server = createServer((req, res) => {
    if (req.headers.authorization !== expected) {
      withoutToken += 1;
      res.writeHead(401, { "www-authenticate": 'Basic realm="stub"' });
      res.end();
      return;
    }
    withToken += 1;
    const url = new URL(req.url ?? "/", "http://stub.local");
    const cgi = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env["PATH"] ?? "",
        GIT_PROJECT_ROOT: options.projectRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        REMOTE_USER: "ostra-stub",
        REQUEST_METHOD: req.method ?? "GET",
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.replace(/^\?/, ""),
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
        GIT_PROTOCOL: typeof req.headers["git-protocol"] === "string" ? req.headers["git-protocol"] : "",
      },
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0);
    let headerDone = false;
    cgi.stdout.on("data", (chunk: Buffer) => {
      if (headerDone) {
        res.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      headerDone = true;
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head.subarray(0, end).toString("utf8").split("\r\n")) {
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (name === "status") status = Number.parseInt(value, 10) || 200;
        else headers[name] = value;
      }
      res.writeHead(status, headers);
      res.write(head.subarray(end + 4));
    });
    cgi.stdout.on("end", () => res.end());
    cgi.on("error", () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve();
  }));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? (address satisfies AddressInfo).port : 0;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    stats: () => ({ withToken, withoutToken }),
    close: async () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
};
