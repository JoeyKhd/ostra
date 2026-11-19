import { createHmac, createVerify, generateKeyPair, randomBytes } from "node:crypto";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";

import { z } from "zod";

// A fake GitHub for this package's tests: enough of the REST API for the code host contract suite
// and the adapter's own cases. Like the real one it refuses a request with no `User-Agent`, checks
// an App's JWT against the App's public key, and refuses a token a repo or a permission it was not
// minted for.

const generate = promisify(generateKeyPair);

export type FakeRepo = {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly files: Readonly<Record<string, string>>;
  readonly branches: readonly string[];
  /** Defaults to true. */
  readonly private?: boolean;
};

export type FakePullRequest = {
  readonly number: number;
  readonly repo: string;
  readonly head: string;
  readonly base: string;
  readonly title: string;
  body: string;
  readonly draft: boolean;
  state: "open" | "closed";
  merged: boolean;
};

type TokenScope = {
  readonly installationId: number;
  /** `null`: every repo of the installation. */
  readonly repos: readonly string[] | null;
  readonly permissions: Readonly<Record<string, string>>;
  readonly expiresAt: number;
};

export type FakeRequest = {
  readonly method: string;
  readonly path: string;
  readonly userAgent: string | undefined;
};

/** A failure to answer instead of the real answer, for the next requests whose path matches. */
export type InjectedFailure = {
  readonly pathPattern: RegExp;
  readonly method?: string;
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** How many requests it answers; default 1. */
  times?: number;
};

export type FakeGitHub = {
  readonly apiUrl: string;
  readonly webUrl: string;
  readonly appId: string;
  readonly appSlug: string;
  readonly botId: number;
  readonly privateKey: string;
  /** A different valid key: the App's credentials, wrong. */
  readonly wrongPrivateKey: string;
  readonly installationId: string;
  readonly org: string;
  readonly requests: FakeRequest[];
  readonly pulls: FakePullRequest[];
  readonly tokens: Map<string, TokenScope>;
  readonly failures: InjectedFailure[];
  readonly webhookSecret: string;
  readonly signWebhook: (body: string) => string;
  readonly close: () => Promise<void>;
};

const base64url = (text: string): Buffer => Buffer.from(text, "base64url");

const bearer = (request: IncomingMessage): string | undefined => {
  const header = request.headers.authorization;
  const match = typeof header === "string" ? /^(?:Bearer|token) (.+)$/i.exec(header) : null;
  return match?.[1];
};

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : JSON.parse(text);
};

const bodySchema = z.looseObject({
  repositories: z.array(z.string()).optional(),
  permissions: z.record(z.string(), z.string()).optional(),
  head: z.string().optional(),
  base: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  draft: z.boolean().optional(),
});

export const createFakeGitHub = async (options: {
  readonly repos: readonly FakeRepo[];
  /** The installation's account login. Defaults to `fake-org`. */
  readonly org?: string;
}): Promise<FakeGitHub> => {
  const pair = await generate("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    // GitHub hands out PKCS#1.
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const other = await generate("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const appId = "4242";
  const appSlug = "ostra-fake";
  const botId = 777_001;
  const installationId = 7;
  const org = options.org ?? "fake-org";
  const webhookSecret = "fake-webhook-secret";
  const requests: FakeRequest[] = [];
  const pulls: FakePullRequest[] = [];
  const tokens = new Map<string, TokenScope>();
  const failures: InjectedFailure[] = [];

  const send = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    response.writeHead(status, {
      "content-type": "application/json",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4990",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      ...headers,
    });
    response.end(JSON.stringify(body));
  };

  const jwtValid = (token: string): boolean => {
    const [header, payload, signature] = token.split(".");
    if (header === undefined || payload === undefined || signature === undefined) {
      return false;
    }
    try {
      const claims = z.looseObject({ iss: z.union([z.string(), z.number()]) }).parse(JSON.parse(base64url(payload).toString("utf8")));
      return (
        String(claims.iss) === appId &&
        createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(pair.publicKey, signature, "base64url")
      );
    } catch {
      return false;
    }
  };

  const repoOf = (owner: string, name: string): FakeRepo | undefined =>
    options.repos.find((repo) => repo.owner === owner && repo.name === name);

  const repoJson = (repo: FakeRepo) => ({
    id: repo.id,
    full_name: `${repo.owner}/${repo.name}`,
    default_branch: repo.defaultBranch,
    private: repo.private ?? true,
    clone_url: `https://github.example/${repo.owner}/${repo.name}.git`,
  });

  const prJson = (pr: FakePullRequest) => ({
    number: pr.number,
    html_url: `https://github.example/${pr.repo}/pull/${String(pr.number)}`,
    state: pr.state,
    merged_at: pr.merged ? "2026-01-01T00:00:00Z" : null,
    title: pr.title,
    head: { ref: pr.head },
    base: { ref: pr.base },
  });

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://fake");
    const method = request.method ?? "GET";
    const userAgent = request.headers["user-agent"];
    requests.push({ method, path: url.pathname, userAgent });
    if (userAgent === undefined || userAgent === "") {
      send(response, 403, { message: "Request forbidden by administrative rules. Please make sure your request has a User-Agent header." });
      return;
    }
    const injected = failures.find(
      (failure) => (failure.times ?? 1) > 0 && failure.pathPattern.test(url.pathname) && (failure.method ?? method) === method,
    );
    if (injected !== undefined) {
      injected.times = (injected.times ?? 1) - 1;
      send(response, injected.status, { message: "an injected failure, with a secret-looking value ghp_0123456789abcdefghijklmnop" }, { ...injected.headers });
      return;
    }
    const path = url.pathname;
    const auth = bearer(request);

    if (method === "GET" && path === "/rate_limit") {
      send(response, 200, { resources: {} });
      return;
    }
    const conversion = /^\/app-manifests\/([^/]+)\/conversions$/.exec(path);
    if (method === "POST" && conversion !== null) {
      if (conversion[1] !== "good-code") {
        send(response, 404, { message: "Not Found" });
        return;
      }
      send(response, 201, {
        id: Number(appId),
        slug: appSlug,
        name: "ostra fake",
        client_id: "Iv1.fakeclient",
        client_secret: "fake-client-secret-value",
        webhook_secret: webhookSecret,
        pem: pair.privateKey,
        permissions: {},
        events: [],
      });
      return;
    }
    const botUser = /^\/users\/([^/]+)$/.exec(path);
    if (method === "GET" && botUser !== null) {
      const login = decodeURIComponent(botUser[1] ?? "");
      if (login !== `${appSlug}[bot]`) {
        send(response, 404, { message: "Not Found" });
        return;
      }
      send(response, 200, { id: botId, login });
      return;
    }

    // ---- as the App: a JWT
    if (path === "/app" || path.startsWith("/app/")) {
      if (auth === undefined || !jwtValid(auth)) {
        send(response, 401, { message: "A JSON web token could not be decoded" });
        return;
      }
      if (method === "GET" && path === "/app") {
        send(response, 200, {
          id: Number(appId),
          slug: appSlug,
          name: "ostra fake",
          permissions: { contents: "write", checks: "write", actions: "read", metadata: "read", pull_requests: "write" },
          events: ["pull_request"],
        });
        return;
      }
      if (method === "GET" && path === "/app/installations") {
        send(response, 200, [
          { id: installationId, account: { login: org, type: "Organization" }, repository_selection: "selected" },
        ]);
        return;
      }
      const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
      if (method === "POST" && mint !== null) {
        if (Number(mint[1]) !== installationId) {
          send(response, 404, { message: "Not Found" });
          return;
        }
        const body = bodySchema.parse(await readBody(request));
        if (body.repositories?.some((wanted) => !options.repos.some((repo) => repo.name === wanted)) === true) {
          send(response, 422, { message: "There is at least one repository that does not exist or is not accessible to the parent installation." });
          return;
        }
        const token = `ghs_${randomBytes(18).toString("hex")}`;
        const expiresAt = Date.now() + 3_600_000;
        tokens.set(token, {
          installationId,
          repos: body.repositories ?? null,
          permissions: body.permissions ?? { contents: "write", pull_requests: "write", metadata: "read" },
          expiresAt,
        });
        send(response, 201, {
          token,
          expires_at: new Date(expiresAt).toISOString(),
          permissions: body.permissions ?? {},
          repository_selection: body.repositories === undefined ? "all" : "selected",
        });
        return;
      }
      send(response, 404, { message: "Not Found" });
      return;
    }

    // ---- as an installation: a token
    const scope = auth === undefined ? undefined : tokens.get(auth);
    if (scope === undefined || scope.expiresAt < Date.now()) {
      send(response, 401, { message: "Bad credentials" });
      return;
    }
    if (method === "GET" && path === "/installation/repositories") {
      const visible = options.repos.filter((repo) => scope.repos === null || scope.repos.includes(repo.name));
      send(response, 200, { total_count: visible.length, repositories: visible.map(repoJson) });
      return;
    }
    const repoRoute = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (repoRoute === null) {
      send(response, 404, { message: "Not Found" });
      return;
    }
    const [, owner = "", name = "", rest = ""] = repoRoute;
    const repo = repoOf(owner, name);
    // A token narrowed to one repo sees no other: GitHub answers 404, not 403.
    if (repo === undefined || (scope.repos !== null && !scope.repos.includes(repo.name))) {
      send(response, 404, { message: "Not Found" });
      return;
    }
    const needs = (permission: string, level: "read" | "write"): boolean => {
      const granted = scope.permissions[permission];
      return granted === "write" || (granted === "read" && level === "read");
    };
    const forbid = (): void => {
      send(response, 403, { message: "Resource not accessible by integration" });
    };

    if (method === "GET" && rest === "") {
      if (!needs("metadata", "read") && !needs("contents", "read")) {
        forbid();
        return;
      }
      send(response, 200, repoJson(repo));
      return;
    }
    const contents = /^\/contents\/(.+)$/.exec(rest);
    if (method === "GET" && contents !== null) {
      if (!needs("contents", "read")) {
        forbid();
        return;
      }
      const filePath = decodeURIComponent(contents[1] ?? "");
      const content = repo.files[filePath];
      if (content !== undefined) {
        send(response, 200, {
          type: "file",
          path: filePath,
          encoding: "base64",
          // GitHub wraps base64 at 60 columns.
          content: (Buffer.from(content, "utf8").toString("base64").match(/.{1,60}/g) ?? []).join("\n"),
        });
        return;
      }
      const children = Object.keys(repo.files).filter((file) => file.startsWith(`${filePath}/`));
      if (children.length > 0) {
        send(response, 200, children.map((child) => ({ type: "file", path: child })));
        return;
      }
      send(response, 404, { message: "Not Found" });
      return;
    }
    if (method === "GET" && rest.startsWith("/git/trees/")) {
      if (!needs("contents", "read")) {
        forbid();
        return;
      }
      send(response, 200, {
        tree: [
          ...Object.keys(repo.files).map((file) => ({ path: file, type: "blob" })),
          { path: "src", type: "tree" },
        ],
        truncated: false,
      });
      return;
    }
    if (method === "GET" && rest === "/pulls") {
      if (!needs("pull_requests", "read")) {
        forbid();
        return;
      }
      const head = url.searchParams.get("head") ?? "";
      const branch = head.slice(head.indexOf(":") + 1);
      const matching = pulls.filter((pr) => pr.repo === `${owner}/${name}` && pr.head === branch).sort((a, b) => b.number - a.number);
      send(response, 200, matching.map(prJson));
      return;
    }
    if (method === "POST" && rest === "/pulls") {
      if (!needs("pull_requests", "write")) {
        forbid();
        return;
      }
      const body = bodySchema.parse(await readBody(request));
      const head = body.head ?? "";
      if (!repo.branches.includes(head)) {
        send(response, 422, { message: "Validation Failed", errors: [{ resource: "PullRequest", field: "head", code: "invalid" }] });
        return;
      }
      if (pulls.some((pr) => pr.repo === `${owner}/${name}` && pr.head === head && pr.state === "open")) {
        send(response, 422, { message: "Validation Failed", errors: [{ message: `A pull request already exists for ${owner}:${head}.` }] });
        return;
      }
      const pr: FakePullRequest = {
        number: pulls.length + 1,
        repo: `${owner}/${name}`,
        head,
        base: body.base ?? repo.defaultBranch,
        title: body.title ?? "",
        body: body.body ?? "",
        draft: body.draft ?? false,
        state: "open",
        merged: false,
      };
      pulls.push(pr);
      send(response, 201, prJson(pr));
      return;
    }
    const patched = /^\/pulls\/(\d+)$/.exec(rest);
    if (method === "PATCH" && patched?.[1] !== undefined) {
      if (!needs("pull_requests", "write")) {
        forbid();
        return;
      }
      const pr = pulls.find((item) => item.repo === `${owner}/${name}` && item.number === Number(patched[1]));
      if (pr === undefined) {
        send(response, 404, { message: "Not Found" });
        return;
      }
      const body = bodySchema.parse(await readBody(request));
      if (body.body !== undefined) {
        pr.body = body.body;
      }
      send(response, 200, prJson(pr));
      return;
    }
    send(response, 404, { message: "Not Found" });
  };

  const server = http.createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) {
        send(response, 500, { message: "the fake failed" });
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address: AddressInfo | string | null = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    apiUrl: `http://127.0.0.1:${String(port)}`,
    webUrl: "https://github.example",
    appId,
    appSlug,
    botId,
    privateKey: pair.privateKey,
    wrongPrivateKey: other.privateKey,
    installationId: String(installationId),
    org,
    requests,
    pulls,
    tokens,
    failures,
    webhookSecret,
    signWebhook: (body) => `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
};
