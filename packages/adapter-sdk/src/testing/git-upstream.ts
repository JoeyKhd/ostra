import { execFile, spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Transform } from "node:stream";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createGunzip } from "node:zlib";
import { z } from "zod";

// A stand-in for github.com, for the git proxy's and the executors' tests (spec section 8):
// git's smart HTTP protocol over local bare repos (the answers git-http-backend gives), and a
// small LFS server whose object URLs need their own credential, like GitHub's signed ones. It
// takes `Authorization: Basic x-access-token:<token>` with a token it knows and that hasn't
// expired, refuses a request with no User-Agent as GitHub does, and records every request, so a
// test can prove a refused push sent nothing. An executor's tests, which run without the git proxy,
// start it with `requireToken: false`.
//
// Ported from spikes/github-app-and-git-proxy/src/upstream-stub.ts.

const run = promisify(execFile);

export type UpstreamRequest = {
  readonly repo: string;
  readonly endpoint: string;
  readonly method: string;
  readonly authorized: boolean;
  readonly userAgent: string | undefined;
};

export type GitUpstream = {
  /** `http://127.0.0.1:<port>`: clone URLs are `<origin>/<owner>/<name>.git`. */
  readonly origin: string;
  readonly cloneUrl: (fullName: string) => string;
  readonly requests: UpstreamRequest[];
  /** Tokens the upstream accepts, with their expiry. Add one per task's repo. */
  readonly tokens: Map<string, number>;
  /** The LFS objects' own credential: it must never reach the agent. */
  readonly lfsCredential: string;
  /** Makes a bare repo with one commit on `main` holding the given files. */
  readonly createRepo: (fullName: string, files?: Readonly<Record<string, string>>) => Promise<void>;
  /** A ref's SHA in the bare repo, or null. */
  readonly refSha: (fullName: string, ref: string) => Promise<string | null>;
  /** The paths in a ref's tree. */
  readonly treeFiles: (fullName: string, ref: string) => Promise<readonly string[]>;
  readonly fileAt: (fullName: string, ref: string, file: string) => Promise<string | null>;
  /** The full commit message of a ref's head. */
  readonly commitMessage: (fullName: string, ref: string) => Promise<string | null>;
  /** The author and committer of a ref's head, as `Name <email>`, or null. */
  readonly commitPeople: (fullName: string, ref: string) => Promise<{ readonly author: string; readonly committer: string } | null>;
  readonly close: () => Promise<void>;
};

const ROUTE =
  /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9._-]+?)\.git\/(info\/refs|git-upload-pack|git-receive-pack|info\/lfs\/objects\/batch|info\/lfs\/locks\/verify)$/;
const LFS_OBJECT = /^\/_lfs\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9._-]+)\/([0-9a-f]{64})(\/verify)?$/;

/** A ref whose LFS batch answer points at hosts the proxy must refuse, and one it allows. */
export const LFS_HOSTILE_PROBE_REF = "refs/heads/ostra-lfs-hostile-probe";
export const LFS_HOSTILE_HREFS = [
  "https://169.254.169.254/latest/meta-data/iam/",
  "https://127.0.0.1/internal",
  "https://localhost/internal",
  "http://lfs.example.test/objects",
  "https://lfs.example.test.evil.invalid/objects",
] as const;

const batchSchema = z.looseObject({
  operation: z.enum(["upload", "download"]),
  objects: z.array(z.looseObject({ oid: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().nonnegative() })),
  ref: z.looseObject({ name: z.string() }).optional(),
});
const verifySchema = z.looseObject({ oid: z.string(), size: z.number() });

const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const exists = async (file: string): Promise<boolean> => {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
};

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const value: unknown = chunk;
    if (Buffer.isBuffer(value)) {
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
};

const git = async (args: readonly string[], cwd?: string): Promise<string> => {
  // core.longpaths: a seed repo or a test tree can pass Windows' 260 characters.
  const { stdout } = await run("git", ["-c", "core.longpaths=true", ...args], { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
};

export type GitUpstreamOptions = {
  /** Take requests with no token: for an executor's tests, which run without the git proxy. Default true. */
  readonly requireToken?: boolean;
  /**
   * Refuse a push whose new commits change `.github/workflows/`, with GitHub's words, as GitHub does
   * for an App without the `workflows` permission (ADR 0040, Q122). Default false.
   */
  readonly refuseWorkflowChanges?: boolean;
};

/** GitHub's reason for refusing a workflow change from an App without the `workflows` permission. */
export const WORKFLOWS_REFUSAL_REASON = "refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission";

/** The pre-receive hook that stands in for that refusal: run by git-http-backend, in sh. */
const workflowsHook = (): string =>
  [
    "#!/bin/sh",
    "zero=0000000000000000000000000000000000000000",
    "while read old new ref; do",
    '  [ "$new" = "$zero" ] && continue',
    '  for commit in $(git rev-list "$new" --not --all); do',
    '    if git diff-tree -r --no-commit-id --name-only --root "$commit" | grep -q "^.github/workflows/"; then',
    `      echo '${WORKFLOWS_REFUSAL_REASON}' >&2`,
    "      exit 1",
    "    fi",
    "  done",
    "done",
    "exit 0",
    "",
  ].join("\n");

export const startGitUpstream = async (root: string, options: GitUpstreamOptions = {}): Promise<GitUpstream> => {
  const requireToken = options.requireToken ?? true;
  const reposDir = path.join(root, "repos");
  const lfsDir = path.join(root, "lfs");
  await mkdir(reposDir, { recursive: true });
  await mkdir(lfsDir, { recursive: true });
  const requests: UpstreamRequest[] = [];
  const tokens = new Map<string, number>();
  const lfsCredential = `RemoteAuth lfs-signed-${createHash("sha256").update(root).digest("hex").slice(0, 32)}`;
  let origin = "";

  const checkAuth = (header: string | undefined): boolean => {
    if (!requireToken) {
      return true;
    }
    if (header?.startsWith("Basic ") !== true) {
      return false;
    }
    const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon < 0 || decoded.slice(0, colon) !== "x-access-token") {
      return false;
    }
    const expiresAt = tokens.get(decoded.slice(colon + 1));
    return expiresAt !== undefined && expiresAt > Date.now();
  };

  const repoDir = (fullName: string): string => path.join(reposDir, ...fullName.split("/").map((part, index) => (index === 1 ? `${part}.git` : part)));

  const runService = async (
    service: "upload-pack" | "receive-pack",
    dir: string,
    advertise: boolean,
    gitProtocol: string | undefined,
    input: Readable | null,
    response: ServerResponse,
  ): Promise<void> => {
    const args = [service, "--stateless-rpc", ...(advertise ? ["--advertise-refs"] : []), dir];
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (gitProtocol !== undefined) {
      env["GIT_PROTOCOL"] = gitProtocol;
    }
    const child = spawn("git", args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    child.stderr.resume();
    const feeding =
      input === null
        ? Promise.resolve(child.stdin.end())
        : pipeline(input, child.stdin).catch(() => {
            // The service may stop reading early; its exit status tells.
          });
    await Promise.all([pipeline(child.stdout, response, { end: true }), feeding]);
  };

  const handleGit = async (request: IncomingMessage, response: ServerResponse, url: URL, match: RegExpExecArray): Promise<void> => {
    const [, owner, name, rest] = match;
    if (owner === undefined || name === undefined || rest === undefined) {
      return;
    }
    const fullName = `${owner}/${name}`;
    const authorized = checkAuth(request.headers.authorization);
    requests.push({ repo: fullName, endpoint: rest, method: request.method ?? "GET", authorized, userAgent: request.headers["user-agent"] });
    if (!authorized) {
      request.resume();
      response.writeHead(401, { "www-authenticate": 'Basic realm="upstream"', "content-type": "text/plain" });
      response.end("upstream: credentials required\n");
      return;
    }
    const dir = repoDir(fullName);
    if (!(await exists(dir))) {
      request.resume();
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("upstream: no such repo\n");
      return;
    }
    const protocolHeader = request.headers["git-protocol"];
    const gitProtocol = typeof protocolHeader === "string" ? protocolHeader : undefined;
    const isV2 = gitProtocol?.split(":").includes("version=2") ?? false;
    if (rest === "info/refs") {
      const service = url.searchParams.get("service");
      if (service !== "git-upload-pack" && service !== "git-receive-pack") {
        response.writeHead(403, { "content-type": "text/plain" });
        response.end("upstream: dumb http not served\n");
        return;
      }
      response.writeHead(200, { "content-type": `application/x-${service}-advertisement`, "cache-control": "no-cache" });
      if (!isV2 || service === "git-receive-pack") {
        const line = `# service=${service}\n`;
        response.write(`${(line.length + 4).toString(16).padStart(4, "0")}${line}0000`);
      }
      await runService(service === "git-upload-pack" ? "upload-pack" : "receive-pack", dir, true, gitProtocol, null, response);
      return;
    }
    if (rest === "git-upload-pack" || rest === "git-receive-pack") {
      const service = rest === "git-upload-pack" ? "upload-pack" : "receive-pack";
      response.writeHead(200, { "content-type": `application/x-git-${service}-result`, "cache-control": "no-cache" });
      const input = request.headers["content-encoding"] === "gzip" ? request.pipe(createGunzip()) : request;
      await runService(service, dir, false, gitProtocol, input, response);
      return;
    }
    if (rest === "info/lfs/locks/verify") {
      await readBody(request);
      response.writeHead(200, { "content-type": "application/vnd.git-lfs+json" });
      response.end(JSON.stringify({ ours: [], theirs: [] }));
      return;
    }
    const parsed = batchSchema.safeParse(JSON.parse((await readBody(request)).toString("utf8")));
    if (!parsed.success) {
      response.writeHead(422, { "content-type": "application/vnd.git-lfs+json" });
      response.end(JSON.stringify({ message: "bad batch" }));
      return;
    }
    const header = { Authorization: lfsCredential };
    if (parsed.data.ref?.name === LFS_HOSTILE_PROBE_REF) {
      response.writeHead(200, { "content-type": "application/vnd.git-lfs+json" });
      response.end(
        JSON.stringify({
          transfer: "basic",
          objects: parsed.data.objects.map(({ oid, size }, index) => ({
            oid,
            size,
            actions: { download: { href: LFS_HOSTILE_HREFS[index % LFS_HOSTILE_HREFS.length], header, expires_in: 3600 } },
          })),
        }),
      );
      return;
    }
    const objects = await Promise.all(
      parsed.data.objects.map(async ({ oid, size }) => {
        const href = `${origin}/_lfs/${owner}/${name}/${oid}`;
        const present = await exists(path.join(lfsDir, owner, name, oid));
        if (parsed.data.operation === "download") {
          return present
            ? { oid, size, actions: { download: { href, header, expires_in: 3600 } } }
            : { oid, size, error: { code: 404, message: "not found" } };
        }
        return present
          ? { oid, size }
          : { oid, size, actions: { upload: { href, header, expires_in: 3600 }, verify: { href: `${href}/verify`, header, expires_in: 3600 } } };
      }),
    );
    response.writeHead(200, { "content-type": "application/vnd.git-lfs+json" });
    response.end(JSON.stringify({ transfer: "basic", objects, hash_algo: "sha256" }));
  };

  const handleLfsObject = async (request: IncomingMessage, response: ServerResponse, match: RegExpExecArray): Promise<void> => {
    const [, owner, name, oid, verify] = match;
    if (owner === undefined || name === undefined || oid === undefined) {
      return;
    }
    const auth = request.headers.authorization;
    const authorized = typeof auth === "string" && safeEqual(auth, lfsCredential);
    requests.push({
      repo: `${owner}/${name}`,
      endpoint: verify === undefined ? "lfs-object" : "lfs-verify",
      method: request.method ?? "GET",
      authorized,
      userAgent: request.headers["user-agent"],
    });
    if (!authorized) {
      request.resume();
      response.writeHead(401, { "content-type": "text/plain" });
      response.end("upstream: lfs credential required\n");
      return;
    }
    const dir = path.join(lfsDir, owner, name);
    const objectPath = path.join(dir, oid);
    if (verify !== undefined) {
      const body = verifySchema.safeParse(JSON.parse((await readBody(request)).toString("utf8")));
      const ok = body.success && body.data.oid === oid && (await exists(objectPath)) && (await stat(objectPath)).size === body.data.size;
      response.writeHead(ok ? 200 : 422, { "content-type": "application/vnd.git-lfs+json" });
      response.end(ok ? "{}" : JSON.stringify({ message: "verify failed" }));
      return;
    }
    if (request.method === "GET") {
      if (!(await exists(objectPath))) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String((await stat(objectPath)).size) });
      await pipeline(createReadStream(objectPath), response);
      return;
    }
    if (request.method === "PUT") {
      await mkdir(dir, { recursive: true });
      const temporary = `${objectPath}.${String(process.pid)}.tmp`;
      const hash = createHash("sha256");
      await pipeline(
        request,
        new Transform({
          transform: (chunk: Buffer, _encoding, done) => {
            hash.update(chunk);
            done(null, chunk);
          },
        }),
        createWriteStream(temporary),
      );
      if (hash.digest("hex") !== oid) {
        await rm(temporary, { force: true });
        response.writeHead(422);
        response.end();
        return;
      }
      await rename(temporary, objectPath);
      response.writeHead(200);
      response.end();
      return;
    }
    response.writeHead(405);
    response.end();
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://upstream.invalid");
    const handle = async (): Promise<void> => {
      // As GitHub does: no User-Agent, no answer.
      if (request.headers["user-agent"] === undefined || request.headers["user-agent"] === "") {
        requests.push({ repo: "", endpoint: url.pathname, method: request.method ?? "GET", authorized: false, userAgent: undefined });
        request.resume();
        response.writeHead(403, { "content-type": "text/plain" });
        response.end("upstream: Request forbidden by administrative rules. Please make sure your request has a User-Agent header\n");
        return;
      }
      const gitMatch = ROUTE.exec(url.pathname);
      if (gitMatch !== null) {
        await handleGit(request, response, url, gitMatch);
        return;
      }
      const lfsMatch = LFS_OBJECT.exec(url.pathname);
      if (lfsMatch !== null) {
        await handleLfsObject(request, response, lfsMatch);
        return;
      }
      request.resume();
      response.writeHead(404);
      response.end();
    };
    handle().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    });
  });
  server.requestTimeout = 0;
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address: AddressInfo | string | null = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  origin = `http://127.0.0.1:${String(port)}`;

  const refSha = async (fullName: string, ref: string): Promise<string | null> => {
    try {
      return (await git(["--git-dir", repoDir(fullName), "rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim();
    } catch {
      return null;
    }
  };

  return {
    origin,
    cloneUrl: (fullName) => `${origin}/${fullName}.git`,
    requests,
    tokens,
    lfsCredential,
    createRepo: async (fullName, files = { "README.md": `# ${fullName}\n` }) => {
      const dir = repoDir(fullName);
      await mkdir(dir, { recursive: true });
      await git(["init", "--quiet", "--bare", "--initial-branch=main", dir]);
      const seed = `${dir}.seed`;
      await git(["init", "--quiet", "--initial-branch=main", seed]);
      for (const [file, content] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(seed, file)), { recursive: true });
        await writeFile(path.join(seed, file), content);
      }
      await git(["add", "--all"], seed);
      await git(["-c", "user.name=Seed", "-c", "user.email=seed@example.test", "commit", "--quiet", "-m", "first commit"], seed);
      await git(["push", "--quiet", dir, "main:main"], seed);
      await rm(seed, { recursive: true, force: true });
      if (options.refuseWorkflowChanges === true) {
        await writeFile(path.join(dir, "hooks", "pre-receive"), workflowsHook(), { mode: 0o755 });
      }
    },
    refSha,
    treeFiles: async (fullName, ref) =>
      (await git(["--git-dir", repoDir(fullName), "ls-tree", "-r", "--name-only", ref])).split("\n").filter((line) => line.length > 0),
    fileAt: async (fullName, ref, file) => {
      try {
        return await git(["--git-dir", repoDir(fullName), "show", `${ref}:${file}`]);
      } catch {
        return null;
      }
    },
    commitMessage: async (fullName, ref) => {
      try {
        return await git(["--git-dir", repoDir(fullName), "log", "-1", "--format=%B", ref]);
      } catch {
        return null;
      }
    },
    commitPeople: async (fullName, ref) => {
      try {
        const [author = "", committer = ""] = (await git(["--git-dir", repoDir(fullName), "log", "-1", "--format=%an <%ae>%n%cn <%ce>", ref])).trim().split("\n");
        return { author, committer };
      } catch {
        return null;
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
};
