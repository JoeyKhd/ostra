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
  BranchRules,
  CheckRunInput,
  CodeHostAppCredentials,
  CodeHostCapabilities,
  CodeHostOAuthClient,
  CodeHostWebhookEvent,
  CommentRef,
  CompareFile,
  CompareFileStatus,
  CompareResult,
  CreatedApp,
  DeleteRefResult,
  HealthReport,
  HostRepo,
  Installation,
  LinkedUser,
  OpenPullRequestInput,
  UpdatePullRequestBodyInput,
  PermissionLevel,
  PullRequest,
  PullRequestComment,
  PullRequestDetails,
  PullRequestReview,
  PullRequestReviewState,
  PublishedCheckRun,
  Reaction,
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

import { isPlanLimit, readHttpFailure, retryDecision, statusOf, toAdapterError } from "./errors.ts";
import { buildAppManifest } from "./manifest.ts";
import {
  appSchema,
  branchProtectionSchema,
  branchRulesSchema,
  branchSchema,
  checkRunListSchema,
  checkRunSchema,
  compareSchema,
  contentFileSchema,
  conversionSchema,
  graphqlAnswerSchema,
  installationSchema,
  issueCommentWebhookSchema,
  pullRequestDetailsSchema,
  pullRequestListSchema,
  pullRequestNodeSchema,
  pullRequestSchema,
  pullRequestWebhookSchema,
  pushWebhookSchema,
  repoSchema,
  reviewCommentWebhookSchema,
  reviewListSchema,
  reviewWebhookSchema,
  treeSchema,
  userSchema,
  userTokenSchema,
} from "./schemas.ts";
import type { GitHubReview } from "./schemas.ts";

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
  /**
   * Where the verified link trades a sign-in's code for a token (`/login/oauth/access_token`).
   * Default: `webUrl`, as on GitHub.com and GitHub Enterprise Server; a test points it at its fake.
   */
  readonly oauthUrl?: string;
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

/** Rule types that protect a branch from being deleted, rewritten, or merged into without review. */
const PROTECTIVE_RULE_TYPES: ReadonlySet<string> = new Set(["deletion", "non_fast_forward", "pull_request", "update"]);
const REASON_NO_RULES_ON_PLAN = "GitHub doesn't offer branch rules on this repo's plan, so none apply.";
const REASON_CLASSIC_SIGNATURES =
  "This branch uses classic branch protection, and its signed-commit rule can only be read with the administration permission, which ostra doesn't ask for.";
const REASON_RULES_REFUSED = "GitHub wouldn't let the App read this branch's rulesets.";
/** Only refs under here are deleted: a branch or a tag is never ostra's to delete through this call. */
const DELETABLE_REF = /^refs\/ostra\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/**
 * GitHub's diff limits for commits, PRs and compares: at most 300 files, and no single file's diff
 * over 500 KB, past which its patch is left out (docs.github.com, "Repository limits", "Diff
 * limits"; the compare endpoint: "includes up to 300 changed files for the entire comparison").
 */
export const GITHUB_COMPARE_MAX_FILES = 300;
export const GITHUB_MAX_FILE_DIFF_BYTES = 500 * 1024;
const OAUTH_TIMEOUT_MS = 15_000;

/** GitHub's file statuses in a compare, as ostra names them; one it adds later reads as `changed`. */
const compareStatusOf = (status: string): CompareFileStatus => {
  switch (status) {
    case "added":
    case "removed":
    case "modified":
    case "renamed":
    case "copied":
    case "changed":
    case "unchanged":
      return status;
    default:
      return "changed";
  }
};

/** A ref (a branch, a tag or a SHA) safe to put on either side of a compare's `...`. */
const isSafeRefName = (ref: string): boolean =>
  ref.length > 0 && ref.length <= 255 && !ref.includes("..") && !/[\u0000- \u007f~^:?*[\\]/.test(ref);

const isHttpUrl = (url: string): boolean => {
  if (!URL.canParse(url)) {
    return false;
  }
  const { protocol } = new URL(url);
  return protocol === "https:" || protocol === "http:";
};

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
  readonly #oauthUrl: string;
  readonly #userAgent: string;
  /** Minted tokens, in memory only, until they near their expiry. */
  readonly #tokens = new Map<string, RepoToken>();
  readonly #botIdentities = new Map<string, GitPerson>();

  constructor(options: GitHubAdapterOptions = {}, context?: AdapterContext) {
    super(context);
    this.#apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
    this.#webUrl = (options.webUrl ?? DEFAULT_WEB_URL).replace(/\/+$/, "");
    this.#oauthUrl = (options.oauthUrl ?? this.#webUrl).replace(/\/+$/, "");
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    // Where an LFS batch answer may send the git proxy (Q119, spike 4).
    // Milestone 3 (ticket 09): compare, drafts, PR comments with reactions, and the verified link.
    this.capabilities = {
      checkRuns: true,
      prTemplates: true,
      lfsActionHosts: [...(options.lfsActionHosts ?? GITHUB_COM_LFS_ACTION_HOSTS)],
      branchRules: true,
      compare: true,
      draftPullRequests: true,
      prComments: true,
      userLink: true,
      // Milestone 4 (ticket 08): `listReviews`, the `pull_request_review` webhook, and check runs.
      reviews: true,
    };
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
        ...(parsed.value.client_id === undefined ? {} : { clientId: parsed.value.client_id }),
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

  override async updatePullRequestBody(input: UpdatePullRequestBodyInput): Promise<AdapterResult<PullRequest>> {
    const { access } = input;
    // A PATCH that sets the same body twice is the same PR: safe to retry.
    return this.#guarded("changing a PR's body", this.#budgetKey(access), async () => {
      const octokit = await this.#asRepo(access, { pull_requests: "write", metadata: "read" });
      const { owner, name } = splitRepo(access.repo);
      // The body holds the agent's text: untrusted, sent as data in the JSON body.
      const response = await octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner,
        repo: name,
        pull_number: input.number,
        body: input.body.slice(0, MAX_BODY_CHARS),
      });
      const parsed = parseVendor(pullRequestSchema, response.data, "GitHub's changed PR");
      if (!parsed.ok) {
        return parsed;
      }
      this.plumbing.logger.info("github.pr.body-updated", { repo: access.repo, prNumber: parsed.value.number });
      return ok(toPullRequest(parsed.value));
    });
  }

  // ---------- milestone 2: branch rules, a PR by number, PR webhooks, refs ----------

  override async readBranchRules(access: RepoAccess, branch: string): Promise<AdapterResult<BranchRules>> {
    if (branch.length === 0 || branch.length > 255 || /[\u0000-\u001f\u007f]/.test(branch)) {
      return adapterError("invalid-input", "a branch name to check is empty, too long or has control characters");
    }
    return this.#guarded<BranchRules>("reading a branch's rules", this.#budgetKey(access), async () => {
      // No `administration` permission: classic protection's signed-commit rule is out of reach (ADR 0040).
      const octokit = await this.#asRepo(access, { contents: "read", metadata: "read" });
      const { owner, name } = splitRepo(access.repo);
      const branchResponse = await octokit.request("GET /repos/{owner}/{repo}/branches/{branch}", { owner, repo: name, branch });
      const branchInfo = parseVendor(branchProtectionSchema, branchResponse.data, "GitHub's branch");
      if (!branchInfo.ok) {
        return branchInfo;
      }
      const flagged = branchInfo.value.protected;

      const rules = await octokit
        .request("GET /repos/{owner}/{repo}/rules/branches/{branch}", { owner, repo: name, branch, per_page: 100 })
        .then(
          (response) => {
            const data: unknown = response.data;
            return { kind: "read" as const, data };
          },
          (error: unknown) => {
            if (isPlanLimit(error)) {
              return { kind: "no-rules-on-plan" as const };
            }
            // A 403 that is the rate limit is retried by the guard, not read as a refusal.
            if (statusOf(error) === 403 && readHttpFailure(error, this.plumbing.clock.now())?.rateLimited !== true) {
              return { kind: "refused" as const };
            }
            throw error;
          },
        );

      if (rules.kind === "no-rules-on-plan") {
        // Classic protection, if any, is all there can be: its signed-commit rule is unreadable.
        return ok(
          flagged
            ? { protected: true, requiresSignedCommits: "unknown", reasons: [REASON_CLASSIC_SIGNATURES] }
            : { protected: false, requiresSignedCommits: false, reasons: [REASON_NO_RULES_ON_PLAN] },
        );
      }
      if (rules.kind === "refused") {
        return ok({ protected: flagged ? true : "unknown", requiresSignedCommits: "unknown", reasons: [REASON_RULES_REFUSED] });
      }
      const parsedRules = parseVendor(branchRulesSchema, rules.data, "GitHub's branch rules");
      if (!parsedRules.ok) {
        return parsedRules;
      }
      const types = new Set(parsedRules.value.map((rule) => rule.type));
      if (types.has("required_signatures")) {
        return ok({ protected: true, requiresSignedCommits: true, reasons: [] });
      }
      const isProtected = flagged || [...types].some((type) => PROTECTIVE_RULE_TYPES.has(type));
      // An unprotected branch can't have classic protection, so nothing requires signatures. A
      // protected one might: only `administration: read` could say.
      return flagged
        ? ok({ protected: isProtected, requiresSignedCommits: "unknown", reasons: [REASON_CLASSIC_SIGNATURES] })
        : ok({ protected: isProtected, requiresSignedCommits: false, reasons: [] });
    });
  }

  override async getPullRequest(access: RepoAccess, number: number): Promise<AdapterResult<PullRequestDetails>> {
    if (!Number.isSafeInteger(number) || number < 1) {
      return adapterError("invalid-input", "a PR number is a positive whole number");
    }
    return this.#guarded("reading a PR", this.#budgetKey(access), async () => {
      const octokit = await this.#asRepo(access, { pull_requests: "read", metadata: "read" });
      const { owner, name } = splitRepo(access.repo);
      const response = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo: name, pull_number: number });
      const parsed = parseVendor(pullRequestDetailsSchema, response.data, "GitHub's PR");
      if (!parsed.ok) {
        return parsed;
      }
      const pr = parsed.value;
      const updatedAt = Date.parse(pr.updated_at);
      const mergedAt = pr.merged_at === null || pr.merged_at === undefined ? null : Date.parse(pr.merged_at);
      const closedAt = pr.closed_at === null || pr.closed_at === undefined ? null : Date.parse(pr.closed_at);
      if (Number.isNaN(updatedAt) || Number.isNaN(mergedAt ?? 0) || Number.isNaN(closedAt ?? 0)) {
        return adapterError("invalid-response", "GitHub's PR has a time that could not be read");
      }
      const merged = pr.merged === true || mergedAt !== null;
      return ok({
        number: pr.number,
        url: pr.html_url,
        state: pr.state === "open" ? "open" : merged ? "merged" : "closed",
        headBranch: pr.head.ref,
        baseBranch: pr.base.ref,
        title: pr.title,
        merged,
        headSha: pr.head.sha,
        updatedAt,
        mergedAt,
        closedAt,
        // Milestone 3 (F-054): a later turn edits its checks section in the description as it is now,
        // and keeps a draft a person made. Untrusted text: never logged.
        body: pr.body ?? null,
        ...(pr.draft === undefined ? {} : { draft: pr.draft }),
      } satisfies PullRequestDetails);
    });
  }

  override parseWebhook(input: WebhookInput): AdapterResult<CodeHostWebhookEvent> {
    const event = Object.entries(input.headers).find(([headerName]) => headerName.toLowerCase() === "x-github-event")?.[1];
    if (event === undefined || event === "") {
      return adapterError("invalid-response", "the webhook has no X-GitHub-Event header");
    }
    if (event !== "pull_request" && event !== "issue_comment" && event !== "pull_request_review_comment" && event !== "push" && event !== "pull_request_review") {
      return ok({ kind: "other", event });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(input.body);
    } catch {
      return adapterError("invalid-response", `the ${event} webhook's body is not JSON`);
    }
    switch (event) {
      case "pull_request":
        return parsePullRequestWebhook(payload);
      case "issue_comment":
        return parseIssueCommentWebhook(payload);
      case "pull_request_review_comment":
        return parseReviewCommentWebhook(payload);
      case "push":
        return parsePushWebhook(payload);
      case "pull_request_review":
        return parseReviewWebhook(payload);
      default:
        return event satisfies never;
    }
  }

  override async deleteRef(access: RepoAccess, ref: string): Promise<AdapterResult<DeleteRefResult>> {
    if (!DELETABLE_REF.test(ref)) {
      return adapterError("invalid-input", "only a ref under refs/ostra/ can be deleted");
    }
    return this.#guarded<DeleteRefResult>("deleting a ref", this.#budgetKey(access), async () => {
      const octokit = await this.#asRepo(access, { contents: "write", metadata: "read" });
      const { owner, name } = splitRepo(access.repo);
      try {
        await octokit.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", { owner, repo: name, ref: ref.slice("refs/".length) });
        this.plumbing.logger.info("github.ref.deleted", { repo: access.repo });
        return ok({ deleted: true });
      } catch (error) {
        // GitHub answers 422 "Reference does not exist" (and 404 for a path it can't resolve):
        // already gone is what was asked for.
        const status = statusOf(error);
        if (status === 404 || status === 422) {
          return ok({ deleted: false });
        }
        throw error;
      }
    });
  }

  // ---------- milestone 3: compare, drafts, PR comments, the verified link (ADR 0051, ADR 0052) ----------

  override async compare(access: RepoAccess, base: string, head: string): Promise<AdapterResult<CompareResult>> {
    if (!isSafeRefName(base) || !isSafeRefName(head)) {
      return adapterError("invalid-input", "a ref to compare is empty, too long, or holds `...` or control characters");
    }
    return this.#guarded<CompareResult>("comparing two refs", this.#budgetKey(access), async () => {
      const octokit = await this.#asRepo(access, { contents: "read", metadata: "read" });
      const { owner, name } = splitRepo(access.repo);
      // The files come on the first page only, up to GitHub's 300, whatever the page size: paging
      // walks the commits, which ostra doesn't read, so one page of one commit is asked for.
      const response = await octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
        owner,
        repo: name,
        basehead: `${base}...${head}`,
        per_page: 1,
        page: 1,
      });
      const parsed = parseVendor(compareSchema, response.data, "GitHub's compare");
      if (!parsed.ok) {
        return parsed;
      }
      const files: CompareFile[] = (parsed.value.files ?? []).map((file) => {
        const patch = file.patch ?? null;
        const changes = file.changes ?? file.additions + file.deletions;
        return {
          path: file.filename,
          previousPath: file.previous_filename ?? null,
          status: compareStatusOf(file.status),
          additions: file.additions,
          deletions: file.deletions,
          patch,
          // GitHub leaves a file's patch out over its diff limit; a binary file has no patch and no line changes.
          truncated: patch === null && changes > 0,
        };
      });
      this.plumbing.logger.debug("github.compare.read", { repo: access.repo, files: files.length });
      return ok({
        aheadBy: parsed.value.ahead_by,
        behindBy: parsed.value.behind_by,
        mergeBase: parsed.value.merge_base_commit?.sha ?? null,
        files,
        filesTruncated: files.length >= GITHUB_COMPARE_MAX_FILES,
        limits: { maxFiles: GITHUB_COMPARE_MAX_FILES, maxPatchBytes: GITHUB_MAX_FILE_DIFF_BYTES },
      });
    });
  }

  override async setPullRequestDraft(access: RepoAccess, number: number, draft: boolean): Promise<AdapterResult<PullRequest>> {
    if (!Number.isSafeInteger(number) || number < 1) {
      return adapterError("invalid-input", "a PR number is a positive whole number");
    }
    const operation = draft ? "making a PR a draft" : "marking a PR ready for review";
    return this.#guarded<PullRequest>(operation, this.#budgetKey(access), async () => {
      // GitHub's two draft mutations need `contents: write` too: with `pull_requests: write` alone
      // they answer FORBIDDEN, "Resource not accessible by integration" (live on the test App, 2026-11-19).
      const octokit = await this.#asRepo(access, { contents: "write", pull_requests: "write", metadata: "read" });
      const { owner, name } = splitRepo(access.repo);
      const read = async (): Promise<AdapterResult<z.infer<typeof pullRequestNodeSchema>>> => {
        const response = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo: name, pull_number: number });
        return parseVendor(pullRequestNodeSchema, response.data, "GitHub's PR");
      };
      const before = await read();
      if (!before.ok) {
        return before;
      }
      // Already as asked: a success, with no write (idempotent).
      if ((before.value.draft ?? false) === draft) {
        return ok(toPullRequest(before.value));
      }
      if (before.value.state !== "open") {
        return adapterError("conflict", "only an open PR can be made a draft or ready for review");
      }
      // REST can't change a PR's draft state; GraphQL's two mutations can.
      const mutation = draft
        ? "mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } } }"
        : "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }";
      const answer = await octokit.request("POST /graphql", { query: mutation, variables: { id: before.value.node_id } });
      const parsed = parseVendor(graphqlAnswerSchema, answer.data, "GitHub's GraphQL answer");
      if (!parsed.ok) {
        return parsed;
      }
      const after = await read();
      if (!after.ok) {
        return after;
      }
      // A refusal is read from the PR's state, not from GitHub's words: another writer may have got there first.
      if ((after.value.draft ?? false) !== draft) {
        // GraphQL refuses with 200 and an error's `type`: FORBIDDEN is the App's permissions, never a race.
        const forbidden = (parsed.value.errors ?? []).some((error) => error.type === "FORBIDDEN");
        this.plumbing.logger.warn("github.pr.draft-refused", { repo: access.repo, prNumber: number, errors: parsed.value.errors?.length ?? 0, forbidden });
        const message = draft ? "GitHub did not make the PR a draft" : "GitHub did not mark the PR ready for review";
        return forbidden ? adapterError("forbidden", `${message}: the App isn't allowed to`) : adapterError("conflict", message);
      }
      this.plumbing.logger.info("github.pr.draft-set", { repo: access.repo, prNumber: number, draft });
      return ok(toPullRequest(after.value));
    });
  }

  override async addReaction(access: RepoAccess, comment: CommentRef, reaction: Reaction): Promise<AdapterResult<{ readonly created: boolean }>> {
    if (!/^[1-9]\d{0,19}$/.test(comment.commentId)) {
      return adapterError("invalid-input", "a comment ID is GitHub's number");
    }
    return this.#guarded("reacting to a PR comment", this.#budgetKey(access), async () => {
      const octokit = await this.#asRepo(access, { pull_requests: "write", metadata: "read" });
      const { owner, name } = splitRepo(access.repo);
      const route =
        comment.kind === "issue"
          ? "POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions"
          : "POST /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions";
      const response = await octokit.request(route, { owner, repo: name, comment_id: Number(comment.commentId), content: reaction });
      // GitHub answers 201 for a new reaction, and 200 when the App had reacted so already.
      const created = response.status === 201;
      this.plumbing.logger.info("github.comment.reacted", { repo: access.repo, kind: comment.kind, created });
      return ok({ created });
    });
  }

  override userAuthorizeUrl(client: CodeHostOAuthClient, state: string, redirectUri: string): AdapterResult<string> {
    if (client.clientId.length === 0 || state.length === 0 || state.length > 512) {
      return adapterError("invalid-input", "a sign-in needs the App's client ID and a state of at most 512 characters");
    }
    if (!isHttpUrl(redirectUri)) {
      return adapterError("invalid-input", "the link's callback is not an http(s) URL");
    }
    // A GitHub App's user sign-in: no scopes (the App's own permissions apply), and no email (ADR 0040).
    const url = new URL(`${this.#webUrl}/login/oauth/authorize`);
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("allow_signup", "false");
    return ok(url.toString());
  }

  override async exchangeUserCode(client: CodeHostOAuthClient, code: string, redirectUri: string): Promise<AdapterResult<LinkedUser>> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(code)) {
      return adapterError("invalid-input", "the sign-in's code is not in GitHub's format");
    }
    if (!isHttpUrl(redirectUri)) {
      return adapterError("invalid-input", "the link's callback is not an http(s) URL");
    }
    const exchanged = await this.#oauthCall("exchanging the sign-in's code", `${this.#oauthUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: client.clientId, client_secret: client.clientSecret, code, redirect_uri: redirectUri }),
    });
    if (!exchanged.ok) {
      return exchanged;
    }
    const token = parseVendor(userTokenSchema, exchanged.value.body, "GitHub's sign-in answer");
    if (!token.ok) {
      return token;
    }
    const accessToken = token.value.access_token;
    if (accessToken === undefined) {
      // An expired, used or wrong code: GitHub says so with 200 and an `error`.
      this.plumbing.logger.warn("github.link.code-refused", { status: exchanged.value.status });
      return adapterError("unauthorized", "GitHub refused the sign-in's code: it may have expired or been used");
    }
    // Who signed in. Whatever this answers, the token is revoked before anything returns.
    const who = await this.#oauthCall("reading who signed in", `${this.#apiUrl}/user`, {
      method: "GET",
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${accessToken}` },
    });
    const revoked = await this.#oauthCall("revoking the sign-in's token", `${this.#apiUrl}/applications/${encodeURIComponent(client.clientId)}/token`, {
      method: "DELETE",
      headers: {
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
      },
      body: JSON.stringify({ access_token: accessToken }),
    });
    if (!revoked.ok) {
      return revoked;
    }
    if (revoked.value.status !== 204) {
      this.plumbing.logger.warn("github.link.revoke-failed", { status: revoked.value.status });
      return adapterError("unavailable", `revoking the sign-in's token failed (HTTP ${String(revoked.value.status)}): nothing was linked`);
    }
    if (!who.ok) {
      return who;
    }
    if (who.value.status !== 200) {
      return adapterError(who.value.status === 401 ? "unauthorized" : "unavailable", `reading who signed in failed (HTTP ${String(who.value.status)})`);
    }
    const user = parseVendor(userSchema, who.value.body, "GitHub's user");
    if (!user.ok) {
      return user;
    }
    this.plumbing.logger.info("github.link.verified", { userId: user.value.id });
    return ok({ userId: String(user.value.id), login: user.value.login });
  }

  // ---------- webhooks ----------

  // ---------- milestone 4 (F-104, ADR 0040): reviews and check runs ----------

  override async listReviews(access: RepoAccess, number: number): Promise<AdapterResult<readonly PullRequestReview[]>> {
    if (!Number.isSafeInteger(number) || number < 1) {
      return adapterError("invalid-input", "a PR number is a positive whole number");
    }
    return this.#guarded("listing a PR's reviews", this.#budgetKey(access), async () => {
      const octokit = await this.#asRepo(access, { pull_requests: "read", metadata: "read" });
      const { owner, name } = splitRepo(access.repo);
      // Every page, oldest first, as GitHub lists them: a dismissed review stays, as `DISMISSED`.
      const raw = await octokit.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", { owner, repo: name, pull_number: number, per_page: 100 });
      const parsed = parseVendor(reviewListSchema, raw, "GitHub's reviews");
      if (!parsed.ok) {
        return parsed;
      }
      const reviews: PullRequestReview[] = [];
      for (const item of parsed.value) {
        const review = toReview(item);
        if (review === null) {
          return adapterError("invalid-response", "GitHub listed a review whose state or time could not be read");
        }
        // A deleted account's review has no author: nobody's approval, so it's left out.
        if (review !== "no-author") {
          reviews.push(review);
        }
      }
      return ok(reviews);
    });
  }

  override async publishCheckRun(access: RepoAccess, input: CheckRunInput): Promise<AdapterResult<PublishedCheckRun>> {
    const refused = checkRunRefusal(input);
    if (refused !== null) {
      return adapterError("invalid-input", refused);
    }
    // Idempotent by `(headSha, name)`: this App's runs on the head under the name are read first, so
    // a retry after a lost answer finds the run it made (ADR 0040).
    return this.#guarded("publishing a check run", this.#budgetKey(access), async () => {
      const octokit = await this.#asRepo(access, { checks: "write", metadata: "read" });
      const { owner, name } = splitRepo(access.repo);
      const listed = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
        owner,
        repo: name,
        ref: input.headSha,
        check_name: input.name,
        app_id: Number(access.app.appId),
        filter: "all",
        per_page: 100,
      });
      const existing = parseVendor(checkRunListSchema, listed.data, "GitHub's check runs");
      if (!existing.ok) {
        return existing;
      }
      const [ours] = existing.value.check_runs
        .filter((run) => run.name === input.name && run.head_sha === input.headSha && (run.app === null || run.app === undefined || String(run.app.id) === access.app.appId))
        .sort((a, b) => a.id - b.id);
      if (ours !== undefined) {
        return ok({ checkRunId: String(ours.id) });
      }
      // The title and summary are ostra's words, sent as data in the JSON body.
      const created = await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
        owner,
        repo: name,
        name: input.name,
        head_sha: input.headSha,
        external_id: input.externalId,
        ...checkRunState(input),
      });
      const parsed = parseVendor(checkRunSchema, created.data, "GitHub's new check run");
      if (!parsed.ok) {
        return parsed;
      }
      this.plumbing.logger.info("github.check-run.published", { repo: access.repo, checkRunId: parsed.value.id, status: input.status });
      return ok({ checkRunId: String(parsed.value.id) });
    });
  }

  override async updateCheckRun(access: RepoAccess, checkRunId: string, input: CheckRunInput): Promise<AdapterResult<void>> {
    if (!/^[1-9]\d{0,19}$/.test(checkRunId)) {
      return adapterError("invalid-input", "a check run ID is GitHub's number");
    }
    const refused = checkRunRefusal(input);
    if (refused !== null) {
      return adapterError("invalid-input", refused);
    }
    // A PATCH that writes the same state twice is the same run: safe to retry.
    return this.#guarded("updating a check run", this.#budgetKey(access), async () => {
      const octokit = await this.#asRepo(access, { checks: "write", metadata: "read" });
      const { owner, name } = splitRepo(access.repo);
      const response = await octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
        owner,
        repo: name,
        check_run_id: Number(checkRunId),
        external_id: input.externalId,
        ...checkRunState(input),
      });
      const parsed = parseVendor(checkRunSchema, response.data, "GitHub's updated check run");
      if (!parsed.ok) {
        return parsed;
      }
      this.plumbing.logger.info("github.check-run.updated", { repo: access.repo, checkRunId: parsed.value.id, status: input.status });
      return ok(undefined);
    });
  }

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

  /**
   * One call of the verified link's OAuth exchange, with `fetch`: the sign-in's token and the App's
   * client secret are in it, so nothing about it is logged but the operation and the status.
   */
  async #oauthCall(
    operation: string,
    url: string,
    init: { readonly method: string; readonly headers: Readonly<Record<string, string>>; readonly body?: string },
  ): Promise<AdapterResult<{ readonly status: number; readonly body: unknown }>> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: init.method,
        headers: { "user-agent": this.#userAgent, ...init.headers },
        ...(init.body === undefined ? {} : { body: init.body }),
        redirect: "manual",
        signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
      });
    } catch {
      this.plumbing.logger.warn("github.link.call-failed", { operation });
      return adapterError("unavailable", `${operation} failed: GitHub could not be reached`);
    }
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      return adapterError(response.status === 429 ? "rate-limited" : "unavailable", `${operation} failed (HTTP ${String(response.status)})`);
    }
    const text = await response.text();
    let body: unknown = null;
    if (text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return ok({ status: response.status, body });
  }

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
  ...(pr.draft === undefined ? {} : { draft: pr.draft }),
});

// ---------- webhooks, read loosely (GitHub owns these formats) ----------
// The PR comment shapes are ported from spikes/github-app-and-git-proxy/src/github/pr-flow.ts
// (spike 4): a conversation comment is an issue comment on the PR's number, and a line comment
// names its `path`, its `line` and its `side` (`RIGHT` the head's, `LEFT` the base's).

const installationIdOf = (installation: { readonly id: number } | null | undefined): string | null =>
  installation === null || installation === undefined ? null : String(installation.id);

const parsePullRequestWebhook = (payload: unknown): AdapterResult<CodeHostWebhookEvent> => {
  const parsed = parseVendor(pullRequestWebhookSchema, payload, "GitHub's pull_request webhook");
  if (!parsed.ok) {
    return parsed;
  }
  const { action, number, installation, repository, pull_request: pr } = parsed.value;
  const fullName = repoFullNameSchema.safeParse(repository.full_name);
  const changedAt = Date.parse(pr.updated_at);
  if (!fullName.success || Number.isNaN(changedAt)) {
    return adapterError("invalid-response", "the pull_request webhook names a repo or a time that could not be read");
  }
  const merged = pr.merged === true || (pr.merged_at !== null && pr.merged_at !== undefined);
  return ok({
    kind: "pull_request",
    action,
    installationId: installationIdOf(installation),
    hostRepoId: String(repository.id),
    repo: fullName.data,
    number,
    state: pr.state === "open" ? "open" : merged ? "merged" : "closed",
    headBranch: pr.head.ref,
    headSha: pr.head.sha,
    changedAt,
  });
};

/** A comment's fields every comment event carries. Its body is untrusted text: data, never logged. */
const toComment = (comment: { readonly id: number; readonly body?: string | null | undefined; readonly html_url: string; readonly user: { readonly id: number; readonly login: string } }): PullRequestComment => ({
  commentId: String(comment.id),
  authorId: String(comment.user.id),
  authorLogin: comment.user.login,
  body: comment.body ?? "",
  url: comment.html_url,
});

const parseIssueCommentWebhook = (payload: unknown): AdapterResult<CodeHostWebhookEvent> => {
  const parsed = parseVendor(issueCommentWebhookSchema, payload, "GitHub's issue_comment webhook");
  if (!parsed.ok) {
    return parsed;
  }
  const { action, installation, repository, issue, comment } = parsed.value;
  const fullName = repoFullNameSchema.safeParse(repository.full_name);
  if (!fullName.success) {
    return adapterError("invalid-response", "the issue_comment webhook names a repo that could not be read");
  }
  return ok({
    kind: "issue_comment",
    action,
    installationId: installationIdOf(installation),
    hostRepoId: String(repository.id),
    repo: fullName.data,
    number: issue.number,
    // GitHub sends PR conversation comments as issue comments: `issue.pull_request` says which.
    onPullRequest: issue.pull_request !== null && issue.pull_request !== undefined,
    comment: toComment(comment),
  });
};

const parseReviewCommentWebhook = (payload: unknown): AdapterResult<CodeHostWebhookEvent> => {
  const parsed = parseVendor(reviewCommentWebhookSchema, payload, "GitHub's pull_request_review_comment webhook");
  if (!parsed.ok) {
    return parsed;
  }
  const { action, installation, repository, pull_request: pr, comment } = parsed.value;
  const fullName = repoFullNameSchema.safeParse(repository.full_name);
  if (!fullName.success) {
    return adapterError("invalid-response", "the pull_request_review_comment webhook names a repo that could not be read");
  }
  // `LEFT` is the base's side of the diff, `RIGHT` the head's; a comment on a whole file has no line.
  const onFile = comment.subject_type === "file";
  return ok({
    kind: "pull_request_review_comment",
    action,
    installationId: installationIdOf(installation),
    hostRepoId: String(repository.id),
    repo: fullName.data,
    number: pr.number,
    comment: toComment(comment),
    path: comment.path,
    side: comment.side === "LEFT" ? "old" : "new",
    line: onFile ? null : (comment.line ?? comment.original_line ?? null),
  });
};

/** GitHub lists at most this many commits in a push's payload: a longer push's paths aren't all there. */
const PUSH_MAX_COMMITS = 2048;

const parsePushWebhook = (payload: unknown): AdapterResult<CodeHostWebhookEvent> => {
  const parsed = parseVendor(pushWebhookSchema, payload, "GitHub's push webhook");
  if (!parsed.ok) {
    return parsed;
  }
  const { ref, before, after, installation, repository, commits } = parsed.value;
  const fullName = repoFullNameSchema.safeParse(repository.full_name);
  if (!fullName.success || !ref.startsWith("refs/")) {
    return adapterError("invalid-response", "the push webhook names a repo or a ref that could not be read");
  }
  const changedPaths =
    commits === null || commits === undefined || commits.length >= PUSH_MAX_COMMITS
      ? null
      : [...new Set(commits.flatMap((commit) => [...(commit.added ?? []), ...(commit.removed ?? []), ...(commit.modified ?? [])]))];
  return ok({
    kind: "push",
    installationId: installationIdOf(installation),
    hostRepoId: String(repository.id),
    repo: fullName.data,
    ref,
    before,
    after,
    changedPaths,
  });
};

// ---------- milestone 4 (F-104, ADR 0040): reviews and check runs ----------

const REVIEW_STATES: Readonly<Partial<Record<string, PullRequestReviewState>>> = {
  approved: "approved",
  changes_requested: "changes_requested",
  commented: "commented",
  dismissed: "dismissed",
  pending: "pending",
};

/**
 * A review as ostra reads it: the author's numeric ID and login, `isBot` from the author's type,
 * the state in small letters (the REST API writes `APPROVED`, the webhook `approved`). `null` for a
 * state or time that can't be read; `no-author` for a review whose account was deleted.
 */
const toReview = (review: GitHubReview): PullRequestReview | "no-author" | null => {
  const state = REVIEW_STATES[review.state.toLowerCase()];
  const submittedAt = review.submitted_at === null || review.submitted_at === undefined ? null : Date.parse(review.submitted_at);
  if (state === undefined || Number.isNaN(submittedAt ?? 0)) {
    return null;
  }
  if (review.user === null || review.user === undefined) {
    return "no-author";
  }
  return {
    reviewId: String(review.id),
    userId: String(review.user.id),
    login: review.user.login,
    isBot: review.user.type === "Bot",
    state,
    commitId: review.commit_id ?? null,
    submittedAt,
  };
};

/** GitHub's limits on a check run's words: a summary of 65,535 characters, and a name, title and external ID kept short. */
const CHECK_SUMMARY_MAX = 65_535;
const CHECK_TEXT_MAX = 1024;

const checkRunRefusal = (input: CheckRunInput): string | null => {
  if (!/^[0-9a-f]{40}$/.test(input.headSha)) {
    return "a check run's head is a 40-character commit SHA";
  }
  if (input.name.trim() === "" || input.name.length > CHECK_TEXT_MAX || input.title.length > CHECK_TEXT_MAX || input.externalId.length > CHECK_TEXT_MAX) {
    return "a check run needs a name, and its name, title and external ID are at most 1,024 characters";
  }
  if (input.summary.length > CHECK_SUMMARY_MAX) {
    return "a check run's summary is at most 65,535 characters";
  }
  return null;
};

/** A check run's status, conclusion and words as the Checks API takes them: no conclusion while in progress. */
const checkRunState = (
  input: CheckRunInput,
): { readonly status: "in_progress" | "completed"; readonly conclusion?: "success" | "action_required"; readonly output: { readonly title: string; readonly summary: string } } =>
  input.status === "completed"
    ? { status: "completed", conclusion: input.conclusion, output: { title: input.title, summary: input.summary } }
    : { status: "in_progress", output: { title: input.title, summary: input.summary } };

const parseReviewWebhook = (payload: unknown): AdapterResult<CodeHostWebhookEvent> => {
  const parsed = parseVendor(reviewWebhookSchema, payload, "GitHub's pull_request_review webhook");
  if (!parsed.ok) {
    return parsed;
  }
  const { action, installation, repository, pull_request: pr, review } = parsed.value;
  const fullName = repoFullNameSchema.safeParse(repository.full_name);
  const read = toReview(review);
  if (!fullName.success || read === null || read === "no-author") {
    return adapterError("invalid-response", "the pull_request_review webhook names a repo, a review state or an author that could not be read");
  }
  return ok({
    kind: "pull_request_review",
    action,
    installationId: installationIdOf(installation),
    hostRepoId: String(repository.id),
    repo: fullName.data,
    number: pr.number,
    headSha: pr.head.sha,
    review: read,
  });
};
