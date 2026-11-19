import { createHmac, createHash, timingSafeEqual } from "node:crypto";

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { adapterError, CodeHostAdapter, idempotencyKey, ok, parseVendor } from "@ostra/adapter-sdk";
import type {
  AdapterContext,
  AdapterResult,
  AppInfo,
  AppManifest,
  AppManifestInput,
  CodeHostAppCredentials,
  CodeHostCapabilities,
  CreatedApp,
  HealthReport,
  HostRepo,
  Installation,
  OpenPullRequestInput,
  PermissionLevel,
  PullRequest,
  ReadFilesResult,
  RepoAccess,
  RepoFile,
  RepoPermission,
  RepoToken,
  WebhookInput,
} from "@ostra/adapter-sdk";
import { gitPersonSchema, repoFullNameSchema } from "@ostra/protocol";
import type { GitPerson } from "@ostra/protocol";
import { z } from "zod";

import { readHttpFailure, retryDecision, toAdapterError } from "./errors.ts";
import { buildAppManifest } from "./manifest.ts";
import {
  appSchema,
  branchSchema,
  contentFileSchema,
  conversionSchema,
  installationSchema,
  pullRequestListSchema,
  pullRequestSchema,
  repoSchema,
  treeSchema,
  userSchema,
} from "./schemas.ts";

// The GitHub code host adapter (ADR 0040, ADR 0030, ADR 0025). The organization's own GitHub App
// opens every PR. Tokens are minted for one repo at a time, with named permissions. Ported from
// spikes/github-app-and-git-proxy/src/github/ (app-auth.ts, manifest.ts, pr-flow.ts, errors.ts).
//
// Never in a log line or an error message: a token, the App's private key, a secret, the
// manifest's one-time code, a vendor payload or a PR's text. Logs carry IDs and statuses.

export type GitHubAdapterOptions = {
  /** The REST API. Default `https://api.github.com`; a GitHub Enterprise Server's, or a test's. */
  readonly apiUrl?: string;
  /** The website, where the manifest form is posted. Default `https://github.com`. */
  readonly webUrl?: string;
  /** Sent with every request: GitHub refuses a request with no `User-Agent`. */
  readonly userAgent?: string;
  /**
   * The hosts an LFS batch answer may send the git proxy to, besides the clone URL's own origin
   * (Q119). Default: GitHub.com's storage hosts. A GitHub Enterprise Server install lists its own
   * (`OSTRA_GITHUB_LFS_HOSTS`).
   */
  readonly lfsActionHosts?: readonly string[];
};

/** Where GitHub.com's LFS batch answers send uploads and downloads (Q119, spike 4). */
export const GITHUB_COM_LFS_ACTION_HOSTS = ["github-cloud.githubusercontent.com", "github-cloud.s3.amazonaws.com", "lfs.github.com"] as const;

const DEFAULT_API_URL = "https://api.github.com";
const DEFAULT_WEB_URL = "https://github.com";
const DEFAULT_USER_AGENT = "ostra-github-adapter/0.0.0";

/** Re-mint a cached token when it has less than this left. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const RETRY = { attempts: 3, baseMs: 250, maxMs: 4000 } as const;
const MAX_TITLE_CHARS = 256;
const MAX_BODY_CHARS = 65_536;
const FILE_READ_CONCURRENCY = 4;

/** Where GitHub looks for a PR template, in its order. */
const PR_TEMPLATE_PATHS = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
] as const;

const quietLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const stringifyPermissions = (permissions: Readonly<Partial<Record<RepoPermission, PermissionLevel>>>): string =>
  Object.entries(permissions)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, level]) => `${name}=${level}`)
    .join(",");

const isSafeRepoPath = (path: string): boolean =>
  path.length > 0 &&
  path.length <= 1024 &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !path.split("/").some((part) => part === ".." || part === "." || part === "");

const splitRepo = (repo: string): { readonly owner: string; readonly name: string } => {
  const [owner = "", name = ""] = repo.split("/");
  return { owner, name };
};

export class GitHubAdapter extends CodeHostAdapter {
  readonly name = "github";
  readonly capabilities: CodeHostCapabilities;

  readonly #apiUrl: string;
  readonly #webUrl: string;
  readonly #userAgent: string;
  /** Minted tokens, in memory only, until they near their expiry. */
  readonly #tokens = new Map<string, RepoToken>();
  readonly #botIdentities = new Map<string, GitPerson>();

  constructor(options: GitHubAdapterOptions = {}, context?: AdapterContext) {
    super(context);
    this.#apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
    this.#webUrl = (options.webUrl ?? DEFAULT_WEB_URL).replace(/\/+$/, "");
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    // Where an LFS batch answer may send the git proxy (Q119, spike 4).
    // `branchRules` turns on with ticket 09, which builds `readBranchRules` (and the PR state, webhooks and refs).
    this.capabilities = { checkRuns: true, prTemplates: true, lfsActionHosts: [...(options.lfsActionHosts ?? GITHUB_COM_LFS_ACTION_HOSTS)], branchRules: false };
  }

  // ---------- health ----------

  async health(): Promise<HealthReport> {
    try {
      await this.#anonymous().request("GET /rate_limit");
      return { status: "ok" };
    } catch (error) {
      const failed = toAdapterError("the GitHub health check", error, this.plumbing.clock.now());
      return { status: "down", reason: failed.error.message };
    }
  }

  // ---------- the App ----------

  appManifest(input: AppManifestInput): AppManifest {
    return buildAppManifest(input, this.#webUrl);
  }

  async convertManifestCode(code: string): Promise<AdapterResult<CreatedApp>> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(code)) {
      return adapterError("invalid-input", "the manifest code is not in GitHub's format");
    }
    try {
      // Octokit's request log would print the path, and the path carries the one-time code.
      const response = await this.#anonymous().rest.apps.createFromManifest({ code });
      const parsed = parseVendor(conversionSchema, response.data, "GitHub's manifest conversion");
      if (!parsed.ok) {
        // GitHub made the App by now, and its key exists nowhere else.
        return adapterError(
          "invalid-response",
          "GitHub created the App, but its answer could not be read: regenerate its private key and secrets in its settings",
        );
      }
      const app = parsed.value;
      this.plumbing.logger.info("github.app.created", { appId: app.id, slug: app.slug });
      return ok({
        appId: String(app.id),
        privateKey: app.pem,
        slug: app.slug,
        name: app.name,
        // GitHub sends none when the manifest had no webhook.
        webhookSecret: app.webhook_secret ?? "",
        clientId: app.client_id,
        clientSecret: app.client_secret,
      });
    } catch (error) {
      return toAdapterError("exchanging the manifest code", error, this.plumbing.clock.now());
    }
  }

  async readApp(app: CodeHostAppCredentials): Promise<AdapterResult<AppInfo>> {
    return this.#guarded("reading the App", `app:${app.appId}`, async () => {
      const response = await this.#asApp(app).request("GET /app");
      const parsed = parseVendor(appSchema, response.data, "GitHub's App");
      if (!parsed.ok) {
        return parsed;
      }
      return ok({
        appId: String(parsed.value.id),
        slug: parsed.value.slug,
        name: parsed.value.name,
        permissions: parsed.value.permissions,
        events: parsed.value.events,
      });
    });
  }

  async listInstallations(app: CodeHostAppCredentials): Promise<AdapterResult<readonly Installation[]>> {
    return this.#guarded("listing installations", `app:${app.appId}`, async () => {
      const octokit = this.#asApp(app);
      const raw = await octokit.paginate(octokit.rest.apps.listInstallations, { per_page: 100 });
      const parsed = parseVendor(z.array(installationSchema), raw, "GitHub's installations");
      if (!parsed.ok) {
        return parsed;
      }
      const installations: Installation[] = [];
      for (const item of parsed.value) {
        const login = item.account?.login;
        if (login === undefined) {
          continue;
        }
        installations.push({
          installationId: String(item.id),
          accountLogin: login,
          accountKind: item.account?.type === "Organization" ? "organization" : "user",
          repositorySelection: item.repository_selection,
        });
      }
      return ok(installations);
    });
  }

  async listRepos(app: CodeHostAppCredentials, installationId: string): Promise<AdapterResult<readonly HostRepo[]>> {
    return this.#guarded("listing repos", `inst:${app.appId}:${installationId}`, async () => {
      const octokit = this.#asInstallation(app, installationId);
      const raw = await octokit.paginate(octokit.rest.apps.listReposAccessibleToInstallation, { per_page: 100 });
      const parsed = parseVendor(z.array(repoSchema), raw, "GitHub's repos");
      if (!parsed.ok) {
        return parsed;
      }
      const repos: HostRepo[] = [];
      for (const item of parsed.value) {
        const fullName = repoFullNameSchema.safeParse(item.full_name);
        if (!fullName.success) {
          continue;
        }
        repos.push({
          hostRepoId: String(item.id),
          fullName: fullName.data,
          defaultBranch: item.default_branch,
          private: item.private,
          cloneUrl: item.clone_url,
        });
      }
      return ok(repos);
    });
  }

  // ---------- tokens ----------

  async mintRepoToken(
    access: RepoAccess,
    permissions: Readonly<Partial<Record<RepoPermission, PermissionLevel>>>,
  ): Promise<AdapterResult<RepoToken>> {
    const names = Object.keys(permissions);
    if (names.length === 0) {
      return adapterError("invalid-input", "a repo token needs at least one permission");
    }
    const { name } = splitRepo(access.repo);
    try {
      const token = await this.#mint(access, name, permissions, true);
      this.plumbing.logger.info("github.token.minted", {
        repo: access.repo,
        installationId: access.installationId,
        permissions: names,
      });
      return ok(token);
    } catch (error) {
      return toAdapterError("minting a repo token", error, this.plumbing.clock.now());
    }
  }

  // ---------- reading a repo ----------

  async getDefaultBranch(access: RepoAccess): Promise<AdapterResult<string>> {
    return this.#guarded("reading the default branch", this.#budgetKey(access), async () => {
      const octokit = await this.#asRepo(access, { contents: "read", metadata: "read" });
      const { owner, name } = splitRepo(access.repo);
      const response = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo: name });
      const parsed = parseVendor(branchSchema, response.data, "GitHub's repo");
      return parsed.ok ? ok(parsed.value.default_branch) : parsed;
    });
  }

  async readFiles(access: RepoAccess, ref: string, paths: readonly string[]): Promise<AdapterResult<ReadFilesResult>> {
    const unsafe = paths.find((path) => !isSafeRepoPath(path));
    if (unsafe !== undefined) {
      return adapterError("invalid-input", "a path to read must be repo-relative, with no `..`");
    }
    return this.#guarded("reading files", this.#budgetKey(access), async () => {
      const octokit = await this.#asRepo(access, { contents: "read", metadata: "read" });
      const found: RepoFile[] = [];
      const missing: string[] = [];
      const results = new Map<string, string | null>();
      for (let start = 0; start < paths.length; start += FILE_READ_CONCURRENCY) {
        const batch = paths.slice(start, start + FILE_READ_CONCURRENCY);
        const read = await Promise.all(batch.map(async (path) => [path, await this.#readFile(octokit, access, ref, path)] as const));
        for (const [path, content] of read) {
          results.set(path, content);
        }
      }
      for (const path of paths) {
        const content = results.get(path);
        if (content === undefined || content === null) {
          missing.push(path);
        } else {
          found.push({ path, content });
        }
      }
      return ok({ files: found, missing });
    });
  }

  override async listTree(access: RepoAccess, ref: string): Promise<AdapterResult<readonly string[]>> {
    return this.#guarded("listing a repo's files", this.#budgetKey(access), async () => {
      const octokit = await this.#asRepo(access, { contents: "read", metadata: "read" });
      const { owner, name } = splitRepo(access.repo);
      const response = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
        owner,
        repo: name,
        tree_sha: ref,
        recursive: "1",
      });
      const parsed = parseVendor(treeSchema, response.data, "GitHub's tree");
      if (!parsed.ok) {
        return parsed;
      }
      if (parsed.value.truncated === true) {
        this.plumbing.logger.warn("github.tree.truncated", { repo: access.repo });
      }
      return ok(parsed.value.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path));
    });
  }

  async getPullRequestTemplate(access: RepoAccess, ref: string): Promise<AdapterResult<string | null>> {
    const read = await this.readFiles(access, ref, PR_TEMPLATE_PATHS);
    if (!read.ok) {
      return read;
    }
    for (const path of PR_TEMPLATE_PATHS) {
      const file = read.value.files.find((candidate) => candidate.path === path);
      if (file !== undefined) {
        return ok(file.content);
      }
    }
    return ok(null);
  }

  // ---------- the bot ----------

  async getBotIdentity(app: CodeHostAppCredentials): Promise<AdapterResult<GitPerson>> {
    const cached = this.#botIdentities.get(app.appId);
    if (cached !== undefined) {
      return ok(cached);
    }
    return this.#guarded("reading the App's bot", `app:${app.appId}`, async () => {
      const info = await this.readApp(app);
      if (!info.ok) {
        return info;
      }
      const login = `${info.value.slug}[bot]`;
      // A public profile. It's read as an installation when the App has one, since anonymous calls
      // share 60 an hour per address; an App with no install yet can still name its bot.
      const installations = await this.listInstallations(app);
      const first = installations.ok ? installations.value[0] : undefined;
      const reader = first === undefined ? this.#anonymous() : this.#asInstallation(app, first.installationId);
      const response = await reader.request("GET /users/{username}", { username: login });
      const parsed = parseVendor(userSchema, response.data, "GitHub's bot user");
      if (!parsed.ok) {
        return parsed;
      }
      const person = gitPersonSchema.safeParse({
        name: login,
        email: `${String(parsed.value.id)}+${login}@users.noreply.github.com`,
      });
      if (!person.success) {
        return adapterError("invalid-response", "GitHub's bot identity could not be used as a commit author");
      }
      this.#botIdentities.set(app.appId, person.data);
      return ok(person.data);
    });
  }

  // ---------- pull requests ----------

  async findPullRequest(access: RepoAccess, head: string): Promise<AdapterResult<PullRequest | null>> {
    return this.#guarded("finding a PR", this.#budgetKey(access), async () => {
      const octokit = await this.#asRepo(access, { pull_requests: "read", metadata: "read" });
      const { owner, name } = splitRepo(access.repo);
      const response = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
        owner,
        repo: name,
        head: `${owner}:${head}`,
        state: "all",
        sort: "created",
        direction: "desc",
        per_page: 30,
      });
      const parsed = parseVendor(pullRequestListSchema, response.data, "GitHub's PRs");
      if (!parsed.ok) {
        return parsed;
      }
      const forHead = parsed.value.filter((item) => item.head.ref === head);
      // The open one is the task's PR; else the newest that closed or merged.
      const chosen = forHead.find((item) => item.state === "open") ?? forHead[0];
      return ok(chosen === undefined ? null : toPullRequest(chosen));
    });
  }

  async openPullRequest(input: OpenPullRequestInput): Promise<AdapterResult<PullRequest>> {
    const { access } = input;
    const title = input.title.trim().slice(0, MAX_TITLE_CHARS);
    if (title.length === 0) {
      return adapterError("invalid-input", "a PR needs a title");
    }
    // The vendor is the source of truth: a PR for this head that's open already is a conflict, so
    // a retry after a crash finds it with `findPullRequest` instead of opening a second.
    const existing = await this.findPullRequest(access, input.head);
    if (!existing.ok) {
      return existing;
    }
    if (existing.value?.state === "open") {
      return adapterError("conflict", "a PR for this branch is open already");
    }
    // Not retried: a second POST after a lost answer could open a second PR.
    try {
      const octokit = await this.#asRepo(access, { pull_requests: "write", contents: "read", metadata: "read" });
      const { owner, name } = splitRepo(access.repo);
      // The body is the agent's text: untrusted, sent as data in the JSON body.
      const response = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
        owner,
        repo: name,
        head: input.head,
        base: input.base,
        title,
        body: input.body.slice(0, MAX_BODY_CHARS),
        draft: input.draft,
      });
      const parsed = parseVendor(pullRequestSchema, response.data, "GitHub's new PR");
      if (!parsed.ok) {
        return parsed;
      }
      this.plumbing.logger.info("github.pr.opened", { repo: access.repo, prNumber: parsed.value.number });
      return ok(toPullRequest(parsed.value));
    } catch (error) {
      return toAdapterError("opening a PR", error, this.plumbing.clock.now());
    }
  }

  // ---------- webhooks ----------

  verifyWebhook(input: WebhookInput): boolean {
    const header = Object.entries(input.headers).find(([name]) => name.toLowerCase() === "x-hub-signature-256")?.[1];
    if (header === undefined || !header.startsWith("sha256=") || input.secret.length === 0) {
      return false;
    }
    const given = Buffer.from(header.slice("sha256=".length), "hex");
    const expected = createHmac("sha256", input.secret).update(input.body, "utf8").digest();
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  // ---------- internals ----------

  #budgetKey(access: RepoAccess): string {
    return `inst:${access.app.appId}:${access.installationId}`;
  }

  /** `budgetKey`: the credential whose rate limit this client's answers report. */
  #newOctokit(options: ConstructorParameters<typeof Octokit>[0] = {}, budgetKey?: string): Octokit {
    const octokit = new Octokit({ baseUrl: this.#apiUrl, userAgent: this.#userAgent, log: quietLog, ...options });
    const guard = this.plumbing.rateBudget;
    if (guard !== undefined && budgetKey !== undefined) {
      octokit.hook.after("request", async (response) => {
        const header = (name: string): string | null => {
          const value: unknown = response.headers[name];
          return typeof value === "string" || typeof value === "number" ? String(value) : null;
        };
        await guard.record(budgetKey, {
          remaining: header("x-ratelimit-remaining"),
          limit: header("x-ratelimit-limit"),
          reset: header("x-ratelimit-reset"),
        });
      });
    }
    return octokit;
  }

  /** No credentials: the manifest exchange (the code is the credential) and public reads. */
  #anonymous(): Octokit {
    return this.#newOctokit();
  }

  /** Authenticated as the App itself, with a JWT: `GET /app` and the installations. */
  #asApp(app: CodeHostAppCredentials): Octokit {
    return this.#newOctokit(
      { authStrategy: createAppAuth, auth: { appId: app.appId, privateKey: app.privateKey, log: quietLog } },
      `app:${app.appId}`,
    );
  }

  /** Authenticated as one installation, with every permission it was granted. */
  #asInstallation(app: CodeHostAppCredentials, installationId: string): Octokit {
    return this.#newOctokit(
      { authStrategy: createAppAuth, auth: { appId: app.appId, privateKey: app.privateKey, installationId, log: quietLog } },
      `inst:${app.appId}:${installationId}`,
    );
  }

  /** A client holding a token narrowed to this one repo and these permissions (ADR 0030). */
  async #asRepo(access: RepoAccess, permissions: Readonly<Partial<Record<RepoPermission, PermissionLevel>>>): Promise<Octokit> {
    const { name } = splitRepo(access.repo);
    const token = await this.#mint(access, name, permissions, false);
    return this.#newOctokit({ auth: token.token }, this.#budgetKey(access));
  }

  async #mint(
    access: RepoAccess,
    repoName: string,
    permissions: Readonly<Partial<Record<RepoPermission, PermissionLevel>>>,
    fresh: boolean,
  ): Promise<RepoToken> {
    // The key hash keeps a token minted with one private key from answering for another's.
    const keyHash = createHash("sha256").update(access.app.privateKey).digest("hex").slice(0, 16);
    const cacheKey = idempotencyKey(access.app.appId, keyHash, access.installationId, access.repo, stringifyPermissions(permissions));
    const cached = this.#tokens.get(cacheKey);
    if (!fresh && cached !== undefined && cached.expiresAt - this.plumbing.clock.now() > TOKEN_REFRESH_MARGIN_MS) {
      return cached;
    }
    const auth = createAppAuth({
      appId: access.app.appId,
      privateKey: access.app.privateKey,
      request: this.#anonymous().request,
      log: quietLog,
    });
    const granted: Record<string, PermissionLevel> = {};
    for (const [permission, level] of Object.entries(permissions)) {
      granted[permission] = level;
    }
    const result = await auth({
      type: "installation",
      installationId: access.installationId,
      repositoryNames: [repoName],
      permissions: granted,
      refresh: true,
    }).catch((error: unknown): never => {
      // GitHub answers 422 when the repo isn't one of the installation's: to a caller, not found.
      if (readHttpFailure(error, this.plumbing.clock.now())?.status === 422) {
        throw Object.assign(new Error("the repo is not part of the installation"), { status: 404 });
      }
      throw error;
    });
    const token: RepoToken = { token: result.token, expiresAt: Date.parse(result.expiresAt) };
    this.#tokens.set(cacheKey, token);
    return token;
  }

  async #readFile(octokit: Octokit, access: RepoAccess, ref: string, path: string): Promise<string | null> {
    const { owner, name } = splitRepo(access.repo);
    try {
      const response = await this.plumbing.retry(
        () => octokit.request("GET /repos/{owner}/{repo}/contents/{path}", { owner, repo: name, path, ref }),
        { ...RETRY, retryError: (error) => retryDecision(error, this.plumbing.clock.now()) },
      );
      // A directory answers with a list: not a file.
      const file = contentFileSchema.safeParse(response.data);
      if (!file.success) {
        return null;
      }
      if (file.data.encoding === "base64" && file.data.content !== undefined) {
        return Buffer.from(file.data.content, "base64").toString("utf8");
      }
      // Over 1 MB GitHub sends no content: ask for the raw bytes.
      const raw = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner,
        repo: name,
        path,
        ref,
        mediaType: { format: "raw" },
      });
      return typeof raw.data === "string" ? raw.data : null;
    } catch (error) {
      const status: unknown = Reflect.get(Object(error), "status");
      if (status === 404) {
        return null;
      }
      throw error;
    }
  }

  /** Runs a read with the rate budget checked first and failures retried, and maps what it throws. */
  async #guarded<T>(operation: string, budgetKey: string, call: () => Promise<AdapterResult<T>>): Promise<AdapterResult<T>> {
    const budget = this.plumbing.rateBudget;
    if (budget !== undefined) {
      const decision = await budget.check(budgetKey);
      if (!decision.go) {
        return adapterError("rate-limited", `${operation} waits for GitHub's rate limit to reset`, decision.waitMs);
      }
    }
    try {
      return await this.plumbing.retry(call, {
        ...RETRY,
        retryError: (error) => retryDecision(error, this.plumbing.clock.now()),
      });
    } catch (error) {
      this.plumbing.logger.warn("github.call.failed", { operation });
      return toAdapterError(operation, error, this.plumbing.clock.now());
    }
  }
}

const toPullRequest = (pr: z.infer<typeof pullRequestSchema>): PullRequest => ({
  number: pr.number,
  url: pr.html_url,
  state: pr.state === "open" ? "open" : pr.merged_at === null || pr.merged_at === undefined ? "closed" : "merged",
  headBranch: pr.head.ref,
  baseBranch: pr.base.ref,
  title: pr.title,
});
