import { createHmac, createVerify, generateKeyPair, randomBytes } from "node:crypto";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

import type { FakeRepoTrees, FakeTree } from "@ostra/adapter-sdk/testing";
import { tarOf } from "@ostra/adapter-sdk/testing/net";
import type { TarEntry } from "@ostra/adapter-sdk/testing/net";
import { repoFullNameSchema } from "@ostra/protocol";
import { z } from "zod";

// A fake GitHub for this package's tests: enough of the REST API for the code host contract suite
// and the adapter's own cases. Like the real one it refuses a request with no `User-Agent`, checks
// an App's JWT against the App's public key, and refuses a token a repo or a permission it was not
// minted for.

const generate = promisify(generateKeyPair);
const gzipped = promisify(gzip);

export type FakeRepo = {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly files: Readonly<Record<string, string>>;
  readonly branches: readonly string[];
  /** Defaults to true. */
  readonly private?: boolean;
  /** Branches with classic branch protection. Its `required_signatures` needs `administration`, which the App lacks. */
  readonly protectedBranches?: readonly string[];
  /** Branch to the rule types of the rulesets that apply to it (`required_signatures`, `deletion`, …). */
  readonly rulesets?: Readonly<Record<string, readonly string[]>>;
  /**
   * `free`: like a private repo in a free organization, rulesets and rules answer 403 "Upgrade to
   * GitHub Pro or make this repository public". Only a private repo is limited.
   */
  readonly plan?: "free" | "paid";
  /** The rules endpoint answers 403 "Resource not accessible by integration", as for a missing permission. */
  readonly rulesRefused?: boolean;
  /** Refs that exist besides the branches, in full: `refs/ostra/wip/<taskId>`. */
  readonly refs?: readonly string[];
  /** Milestone 3: what a compare of `base...head` answers. Two branches not listed compare as identical. */
  readonly compares?: readonly FakeCompare[];
  /**
   * Milestone 6: the files at a ref, where they differ from `files` (`CODEOWNERS` in another
   * place on a branch). A ref not listed reads `files`.
   */
  readonly filesAt?: Readonly<Record<string, Readonly<Record<string, string>>>>;
};

/** A compare the fake answers (F-027): GitHub's limits are applied to its files when it's read. */
export type FakeCompare = {
  readonly base: string;
  readonly head: string;
  readonly aheadBy: number;
  readonly behindBy: number;
  readonly mergeBase?: string;
  /** F-030/c2: the head's commits the base lacks, oldest first, by their messages. None by default. */
  readonly commits?: readonly string[];
  readonly files?: readonly {
    readonly path: string;
    readonly previousPath?: string;
    readonly status: string;
    readonly additions: number;
    readonly deletions: number;
    /** Absent for a binary file. Over 500 KB, the fake leaves it out, as GitHub does. */
    readonly patch?: string;
  }[];
};

/** A member's GitHub account, as the verified link's sign-in reads it (F-119). */
export type FakeGitHubUser = { readonly userId: string; readonly login: string };

export type FakePullRequest = {
  readonly number: number;
  readonly repo: string;
  readonly head: string;
  readonly base: string;
  title: string;
  body: string;
  draft: boolean;
  state: "open" | "closed";
  merged: boolean;
  headSha: string;
  /** ISO times, as GitHub sends them. */
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
};

/** Milestone 4 (F-104): a review on a PR, as a person or a bot made it on the host. */
export type FakeReview = {
  readonly id: number;
  readonly repo: string;
  readonly number: number;
  readonly userId: number;
  readonly login: string;
  /** GitHub's author type: `Bot` for an App's bot. */
  readonly userType: "User" | "Bot";
  /** As the REST API writes it: `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`, `PENDING`. */
  state: string;
  readonly commitId: string;
  /** ISO, or `null` for a pending review. */
  readonly submittedAt: string | null;
  /** Milestone 6: the review's body; empty when not given. */
  readonly body?: string;
};

/** Milestone 6 (F-100): a line comment of a review the App posted. */
export type FakeReviewComment = {
  readonly id: number;
  readonly reviewId: number;
  readonly path: string;
  readonly line: number;
  /** `RIGHT` the head's side, `LEFT` the base's. */
  readonly side: "LEFT" | "RIGHT";
  readonly body: string;
};

/** Milestone 4 (F-104): a check run, as the Checks API keeps it. */
export type FakeCheckRun = {
  readonly id: number;
  readonly repo: string;
  readonly appId: number;
  readonly name: string;
  readonly headSha: string;
  status: string;
  conclusion: string | null;
  title: string | null;
  summary: string | null;
  externalId: string | null;
  // ---- milestone 6 (F-035): other apps' runs, with their logs ----
  /** The app that made it; default the fake's own App. */
  readonly appSlug?: string;
  readonly detailsUrl?: string | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
  /** The run's `output.text`, besides its summary. */
  readonly text?: string | null;
  /** An Actions job's log: its text, `expired` (GitHub answers 410), or none. */
  readonly log?: string | null;
  readonly logExpired?: boolean;
};

/** Milestone 6 (F-035): a commit status, as the older CI API keeps it, by context. */
export type FakeStatus = {
  readonly context: string;
  readonly state: "error" | "failure" | "pending" | "success";
  readonly targetUrl: string | null;
  readonly description: string | null;
};

/**
 * Milestone 4 (F-136, ADR 0065): an account other than the App's owner with the App installed on
 * it, such as a client's organization. Its repos are the fake's repos whose `owner` is its login.
 */
export type FakeAccount = {
  readonly login: string;
  readonly id: number;
  readonly type: "Organization" | "User";
  readonly installationId: number;
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
  /** The answer's body; default an error message. GraphQL refuses with 200 and `errors`. */
  readonly body?: unknown;
  /** How many requests it answers; default 1. */
  times?: number;
  /**
   * Ticket 38: the request is applied first, then answered with this failure instead of its real
   * answer, as a write that committed and lost its reply. Off by default.
   */
  readonly afterWrite?: boolean;
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
  /** Milestone 4 (F-136): the owner's account ID: the App's owner, and its own installation's account. */
  readonly orgId: number;
  readonly requests: FakeRequest[];
  readonly pulls: FakePullRequest[];
  /**
   * Ticket 38: the head branch of every `POST /pulls` that reached the handler, accepted or not, in
   * order: the count of creates per key (spike 8's counting device), which a lookup keeps at one.
   */
  readonly pullCreates: string[];
  /** Refs besides branches, per `owner/name`. */
  readonly refs: Map<string, Set<string>>;
  /** Merges or closes a PR, as a person on the host would, and stamps its times. */
  readonly finishPullRequest: (repo: string, number: number, outcome: "merged" | "closed") => FakePullRequest;
  /** Reopens a closed PR (not a merged one). */
  readonly reopenPullRequest: (repo: string, number: number) => FakePullRequest;
  readonly tokens: Map<string, TokenScope>;
  readonly failures: InjectedFailure[];
  readonly webhookSecret: string;
  readonly signWebhook: (body: string) => string;
  // ---- milestone 3 ----
  /** Adds a comment on a PR's conversation (`issue`) or on a line (`review`), as a person; its ID. */
  readonly addComment: (repo: string, kind: "issue" | "review") => string;
  /** Reactions made so far, as `<repo>:<kind>:<commentId>:<content>`. */
  readonly reactions: () => readonly string[];
  /** How many times a draft mutation changed a PR. */
  readonly draftChanges: () => number;
  /** The App's OAuth client, which the verified link's exchange must send. */
  readonly oauthClient: { readonly clientId: string; readonly clientSecret: string };
  /** A sign-in's code for this user: reusable unless `singleUse`, and bound to `redirectUri` when given. */
  readonly issueUserCode: (user: FakeGitHubUser, options?: { readonly singleUse?: boolean; readonly redirectUri?: string }) => string;
  /** User tokens revoked so far. */
  readonly revokedUserTokens: () => number;
  /** User tokens handed out and not revoked. */
  readonly liveUserTokens: () => number;
  /** The next revocations fail, with this status (default 500). */
  readonly failRevocations: (count: number, status?: number) => void;
  // ---- milestone 4 (F-104) ----
  /** Adds a review to a PR, after the ones it has; its ID. */
  readonly addReview: (repo: string, number: number, review: Omit<FakeReview, "id" | "repo" | "number">) => FakeReview;
  /** Dismisses a review, as a maintainer does: it stays listed, as `DISMISSED`. */
  readonly dismissReview: (reviewId: number) => FakeReview;
  /** Every check run, in the order they were made. */
  readonly checkRuns: readonly FakeCheckRun[];
  // ---- milestone 4 (ticket 47, F-136) ----
  /** The accounts besides the owner's with the App installed, as the fake was started. */
  readonly otherAccounts: readonly FakeAccount[];
  /** Installations `DELETE /app/installations/{id}` removed, in order. */
  readonly removedInstallations: () => readonly number[];
  /**
   * An `installation` webhook's body for one of the fake's installations, as GitHub documents it
   * (`created`, `deleted`, `suspend`, `unsuspend`, `new_permissions_accepted`), with its repos.
   */
  readonly installationPayload: (action: string, installationId: number) => string;
  /** An `installation_repositories` webhook's body: repos added to an installation, or removed from it. */
  readonly installationRepositoriesPayload: (action: "added" | "removed", installationId: number, repoNames: readonly string[]) => string;
  /**
   * Milestone 4 (F-136): a second App, owned by `secondApp.owner` and installed on that account
   * only, with its own ID and key; `null` unless the fake was started with one.
   */
  readonly secondApp: { readonly appId: string; readonly appSlug: string; readonly privateKey: string; readonly installationId: number; readonly owner: FakeAccount } | null;
  // ---- milestone 6 (ticket 08, ADR 0058) ----
  /** Adds another app's check run on a head (GitHub Actions', a deploy preview's), with its log. */
  readonly addCheckRun: (
    repo: string,
    run: Omit<FakeCheckRun, "id" | "repo" | "appId" | "title" | "summary" | "externalId"> & { readonly appId?: number; readonly summary?: string | null },
  ) => FakeCheckRun;
  /** Sets a head's status for a context, as a CI that uses the older API does. */
  readonly setStatus: (repo: string, headSha: string, status: FakeStatus) => void;
  /** Requests reviewers on a PR, as a person or CODEOWNERS does. */
  readonly requestReviewers: (repo: string, number: number, reviewers: { readonly users: readonly { readonly id: number; readonly login: string }[]; readonly teams: readonly string[] }) => void;
  /** The line comments of the reviews the App posted on a PR. */
  readonly reviewComments: (repo: string, number: number) => readonly FakeReviewComment[];
  /** How many reviews a PR holds, any author's. */
  readonly reviewCount: (repo: string, number: number) => number;
  /** Log downloads that carried an `Authorization` header: the token must never go there. */
  readonly authorizedLogDownloads: () => number;
  /** The events the App subscribes to (default: `pull_request` only, as an App made before milestone 6). */
  readonly setAppEvents: (events: readonly string[]) => void;
  // ---- milestone 8 (ticket 02, F-145) ----
  /** The requests left in the anonymous rate limit (60 an hour, as GitHub's per address); 0 refuses the next. */
  readonly setAnonymousRemaining: (remaining: number) => void;
  /** Archive downloads that carried an `Authorization` header: the token must never go there. */
  readonly authorizedArchiveDownloads: () => number;
  /** The repos read at a commit, as the fake was started with them. */
  readonly trees: FakeRepoTrees | undefined;
  readonly close: () => Promise<void>;
};

/** GitHub's diff limits, which the fake applies to a compare's files. */
const COMPARE_MAX_FILES = 300;
const MAX_FILE_DIFF_BYTES = 500 * 1024;
const REACTIONS: ReadonlySet<string> = new Set(["+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"]);
const oauthBodySchema = z.looseObject({ client_id: z.string(), client_secret: z.string(), code: z.string(), redirect_uri: z.string().optional() });

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

/** A Checks API body: GitHub owns the format, so unknown fields are let through. */
const checkRunBodySchema = z.looseObject({
  name: z.string().optional(),
  head_sha: z.string().optional(),
  status: z.string().optional(),
  conclusion: z.string().nullish(),
  external_id: z.string().optional(),
  output: z.looseObject({ title: z.string().optional(), summary: z.string().optional() }).optional(),
});

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
  /** Milestone 4 (F-136): other accounts with the App installed, such as a stranger's. None by default. */
  readonly otherAccounts?: readonly FakeAccount[];
  /**
   * Milestone 4 (F-136): a second App ("Connect another App"), owned by this account and installed
   * on it alone; its repos are the fake's repos whose `owner` is the account's login. None by default.
   */
  readonly secondApp?: { readonly slug: string; readonly owner: FakeAccount };
  /**
   * Milestone 8 (ticket 02, F-145): repos read at a commit, through the commits API and the
   * commit's tarball. Each must also be in `repos`, which says whether it's private and which
   * installation covers it. A public one reads anonymously, under the anonymous rate limit.
   */
  readonly trees?: FakeRepoTrees;
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
  const orgId = 6_001;
  const otherAccounts = options.otherAccounts ?? [];
  const second = options.secondApp === undefined ? null : { appId: "4343", appSlug: options.secondApp.slug, owner: options.secondApp.owner, pair: await generate("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  }) };
  /** The accounts whose repos the owner's own installation doesn't reach. */
  const notOwners = [...otherAccounts, ...(second === null ? [] : [second.owner])];
  const removedInstallations: number[] = [];
  /** The account an installation is on, or `undefined` for one the fake never had or removed. */
  const accountOf = (id: number): { readonly login: string; readonly id: number; readonly type: "Organization" | "User" } | undefined => {
    if (removedInstallations.includes(id)) {
      return undefined;
    }
    if (id === installationId) {
      return { login: org, id: orgId, type: "Organization" };
    }
    if (second !== null && id === second.owner.installationId) {
      return second.owner;
    }
    return otherAccounts.find((account) => account.installationId === id);
  };
  /** Whether an installation belongs to the App a JWT was signed for. */
  const ofApp = (app: "first" | "second", id: number): boolean => (second !== null && id === second.owner.installationId) === (app === "second");
  /** Whether an installation can reach a repo: another account's reaches its own repos, the owner's every other. */
  const installationSees = (id: number, repo: FakeRepo): boolean => {
    const account = accountOf(id);
    if (account === undefined) {
      return false;
    }
    return id === installationId ? !notOwners.some((other) => other.login === repo.owner) : repo.owner === account.login;
  };
  const accountJson = (account: { readonly login: string; readonly id: number; readonly type: string }) => ({
    login: account.login,
    id: account.id,
    node_id: `O_fake_${String(account.id)}`,
    type: account.type,
    site_admin: false,
  });
  const webhookSecret = "fake-webhook-secret";
  const requests: FakeRequest[] = [];
  const pulls: FakePullRequest[] = [];
  const refs = new Map<string, Set<string>>(options.repos.map((repo) => [`${repo.owner}/${repo.name}`, new Set(repo.refs ?? [])]));
  const tokens = new Map<string, TokenScope>();
  const failures: InjectedFailure[] = [];
  const pullCreates: string[] = [];
  /** Answers whose real reply is replaced by an injected failure after the write (`afterWrite`). */
  const failAfterWrite = new WeakMap<ServerResponse, InjectedFailure>();
  const comments: { readonly repo: string; readonly kind: "issue" | "review"; readonly id: string }[] = [];
  const reactions = new Map<string, number>();
  let draftChanges = 0;
  const oauthClient = { clientId: "Iv1.fakeclient", clientSecret: "fake-client-secret-value" };
  const userCodes = new Map<string, { readonly user: FakeGitHubUser; readonly singleUse: boolean; readonly redirectUri: string | null }>();
  const userTokens = new Map<string, FakeGitHubUser>();
  let revokedUserTokens = 0;
  let failRevocations = 0;
  let failRevocationStatus = 500;
  const reviews: FakeReview[] = [];
  const checkRuns: FakeCheckRun[] = [];
  let reviewCounter = 0;
  let checkRunCounter = 0;
  let baseUrl = "";
  const apiBase = (): string => baseUrl;
  const statuses = new Map<string, FakeStatus[]>();
  const requestedReviewers = new Map<string, { readonly users: readonly { readonly id: number; readonly login: string }[]; readonly teams: readonly string[] }>();
  const postedComments = new Map<string, FakeReviewComment[]>();
  let reviewCommentCounter = 0;
  let authorizedLogDownloads = 0;
  /** The events the App subscribes to, as GET /app lists them: an App made before milestone 6 by default. */
  let appEvents: readonly string[] = ["pull_request"];
  // ---- milestone 8 (ticket 02): reading a repo at a commit ----
  let anonymousRemaining = 60;
  let authorizedArchiveDownloads = 0;
  /** A private archive's one-time download tokens, as codeload's `?token=`, to the repo they're for. */
  const archiveTokens = new Map<string, string>();
  /** The commit a ref names in a repo of `trees`, as the commits API reads it. */
  const commitOf = (fullName: string, ref: string): string | undefined => {
    const repoName = repoFullNameSchema.safeParse(fullName);
    return repoName.success ? options.trees?.resolve(repoName.data, ref) : undefined;
  };
  /** `GET /repos/{owner}/{repo}/commits/{ref}`: GitHub answers 422 for a ref the repo doesn't have. */
  const sendCommit = (response: ServerResponse, fullName: string, ref: string, headers: Record<string, string>): void => {
    const sha = commitOf(fullName, ref);
    if (sha === undefined) {
      send(response, 422, { message: `No commit found for SHA: ${ref}`, documentation_url: "https://docs.github.com/rest/commits/commits#get-a-commit", status: "422" }, headers);
      return;
    }
    send(response, 200, { sha, node_id: `C_fake_${sha.slice(0, 8)}`, commit: { message: "a commit", tree: { sha: sha.split("").reverse().join("") } }, files: [] }, headers);
  };
  /** `GET /repos/{owner}/{repo}/tarball/{ref}`: a redirect to codeload's download, with a one-time token for a private repo. */
  const sendTarballRedirect = (response: ServerResponse, repo: FakeRepo, ref: string, headers: Record<string, string>): void => {
    const fullName = `${repo.owner}/${repo.name}`;
    const sha = commitOf(fullName, ref);
    if (sha === undefined) {
      send(response, 404, { message: "Not Found" }, headers);
      return;
    }
    let query = "";
    if (repo.private ?? true) {
      const token = `ARCHIVE${randomBytes(12).toString("hex").toUpperCase()}`;
      archiveTokens.set(token, fullName);
      query = `?token=${token}`;
    }
    response.writeHead(302, { location: `${apiBase()}/codeload/${fullName}/legacy.tar.gz/${sha}${query}`, ...headers });
    response.end();
  };
  /** A commit's tarball as `git archive` writes it: its commit as the global comment, every path under `<owner>-<repo>-<sha7>/`, folders first. */
  const archiveOf = async (repo: FakeRepo, sha: string, tree: FakeTree): Promise<Buffer> => {
    const root = `${repo.owner}-${repo.name}-${sha.slice(0, 7)}`;
    const entries: TarEntry[] = [{ name: `${root}/`, content: Buffer.alloc(0), type: "directory", mode: 0o775 }];
    const folders = new Set<string>();
    for (const [path, entry] of Object.entries(tree).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const parts = path.split("/");
      for (let depth = 1; depth < parts.length; depth += 1) {
        const folder = parts.slice(0, depth).join("/");
        if (!folders.has(folder)) {
          folders.add(folder);
          entries.push({ name: `${root}/${folder}/`, content: Buffer.alloc(0), type: "directory", mode: 0o775 });
        }
      }
      entries.push(
        entry.kind === "symlink"
          ? { name: `${root}/${path}`, content: Buffer.alloc(0), type: "symlink", linkTarget: entry.target, mode: 0o777 }
          : { name: `${root}/${path}`, content: typeof entry.content === "string" ? Buffer.from(entry.content, "utf8") : Buffer.from(entry.content), mode: entry.executable === true ? 0o775 : 0o664 },
      );
    }
    return gzipped(tarOf(entries, { comment: sha }));
  };
  /** The anonymous rate limit's headers, after this request. */
  const anonymousHeaders = (): Record<string, string> => ({
    "x-ratelimit-limit": "60",
    "x-ratelimit-remaining": String(Math.max(0, anonymousRemaining)),
    "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
  });
  const reviewJson = (review: FakeReview) => ({
    id: review.id,
    node_id: `PRR_fake_${String(review.id)}`,
    user: { id: review.userId, login: review.login, type: review.userType },
    body: review.body ?? "",
    html_url: `https://github.example/${review.repo}/pull/${String(review.number)}#pullrequestreview-${String(review.id)}`,
    state: review.state,
    commit_id: review.commitId,
    author_association: review.userType === "Bot" ? "NONE" : "MEMBER",
    ...(review.submittedAt === null ? {} : { submitted_at: review.submittedAt }),
  });
  const checkRunJson = (run: FakeCheckRun) => ({
    id: run.id,
    name: run.name,
    head_sha: run.headSha,
    status: run.status,
    conclusion: run.conclusion,
    external_id: run.externalId,
    details_url: run.detailsUrl ?? null,
    started_at: run.startedAt ?? null,
    completed_at: run.completedAt ?? null,
    output: { title: run.title, summary: run.summary, text: run.text ?? null },
    app: { id: run.appId, slug: run.appSlug ?? appSlug },
  });
  /** The lines each side of a scripted compare's file covers, as GitHub's review API reads its diff. */
  const diffRanges = (repo: FakeRepo, pr: FakePullRequest): Map<string, { readonly right: [number, number][]; readonly left: [number, number][] }> => {
    const ranges = new Map<string, { readonly right: [number, number][]; readonly left: [number, number][] }>();
    const scripted = repo.compares?.find((candidate) => candidate.base === pr.base && candidate.head === pr.headSha);
    for (const file of scripted?.files ?? []) {
      const right: [number, number][] = [];
      const left: [number, number][] = [];
      for (const match of (file.patch ?? "").matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
        const oldCount = match[2] === undefined ? 1 : Number(match[2]);
        const newCount = match[4] === undefined ? 1 : Number(match[4]);
        if (oldCount > 0) left.push([Number(match[1]), Number(match[1]) + oldCount - 1]);
        if (newCount > 0) right.push([Number(match[3]), Number(match[3]) + newCount - 1]);
      }
      ranges.set(file.path, { right, left });
    }
    return ranges;
  };
  const nodeIdOf = (pr: FakePullRequest): string => `PR_fake_${Buffer.from(`${pr.repo}#${String(pr.number)}`).toString("base64url")}`;

  const send = (response: ServerResponse, realStatus: number, realBody: unknown, realHeaders: Record<string, string> = {}): void => {
    const after = failAfterWrite.get(response);
    failAfterWrite.delete(response);
    const status = after?.status ?? realStatus;
    const body = after === undefined ? realBody : (after.body ?? { message: "an injected failure after the write" });
    const headers = after === undefined ? realHeaders : { ...after.headers };
    response.writeHead(status, {
      "content-type": "application/json",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4990",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      ...headers,
    });
    response.end(JSON.stringify(body));
  };

  /** The App a JWT was validly signed for, or `null`. */
  const jwtApp = (token: string): "first" | "second" | null => {
    const [header, payload, signature] = token.split(".");
    if (header === undefined || payload === undefined || signature === undefined) {
      return null;
    }
    try {
      const claims = z.looseObject({ iss: z.union([z.string(), z.number()]) }).parse(JSON.parse(base64url(payload).toString("utf8")));
      const verifies = (publicKey: string): boolean => createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, signature, "base64url");
      if (String(claims.iss) === appId && verifies(pair.publicKey)) {
        return "first";
      }
      if (second !== null && String(claims.iss) === second.appId && verifies(second.pair.publicKey)) {
        return "second";
      }
      return null;
    } catch {
      return null;
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
    node_id: nodeIdOf(pr),
    draft: pr.draft,
    number: pr.number,
    html_url: `https://github.example/${pr.repo}/pull/${String(pr.number)}`,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    closed_at: pr.closedAt,
    updated_at: pr.updatedAt,
    title: pr.title,
    head: { ref: pr.head, sha: pr.headSha },
    base: { ref: pr.base },
    body: pr.body,
  });

  const findPull = (repo: string, number: number): FakePullRequest => {
    const pr = pulls.find((item) => item.repo === repo && item.number === number);
    if (pr === undefined) {
      throw new Error(`the fake has no PR ${repo}#${String(number)}`);
    }
    return pr;
  };
  let clock = Date.parse("2026-01-01T00:00:00Z");
  /** Each change moves the fake's clock on, so a later change always has a later time. */
  const tick = (): string => {
    clock += 1000;
    return new Date(clock).toISOString();
  };
  const finishPullRequest = (repo: string, number: number, outcome: "merged" | "closed"): FakePullRequest => {
    const pr = findPull(repo, number);
    const at = tick();
    pr.state = "closed";
    pr.merged = outcome === "merged";
    pr.mergedAt = outcome === "merged" ? at : null;
    pr.closedAt = at;
    pr.updatedAt = at;
    return pr;
  };
  const reopenPullRequest = (repo: string, number: number): FakePullRequest => {
    const pr = findPull(repo, number);
    if (pr.merged) {
      throw new Error("a merged PR can't be reopened");
    }
    pr.state = "open";
    pr.closedAt = null;
    pr.updatedAt = tick();
    return pr;
  };

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
    if (injected?.afterWrite === true) {
      injected.times = (injected.times ?? 1) - 1;
      failAfterWrite.set(response, injected);
    } else if (injected !== undefined) {
      injected.times = (injected.times ?? 1) - 1;
      send(response, injected.status, injected.body ?? { message: "an injected failure, with a secret-looking value ghp_0123456789abcdefghijklmnop" }, { ...injected.headers });
      return;
    }
    const path = url.pathname;
    const auth = bearer(request);

    const jobLog = /^\/job-logs\/(\d+)$/.exec(path);
    if (method === "GET" && jobLog?.[1] !== undefined) {
      if (request.headers.authorization !== undefined) {
        authorizedLogDownloads += 1;
      }
      const run = checkRuns.find((candidate) => candidate.id === Number(jobLog[1]));
      if (run?.log === undefined || run.log === null) {
        send(response, 404, { message: "Not Found" });
        return;
      }
      const bytes = Buffer.from(run.log, "utf8");
      const suffix = /^bytes=-(\d+)$/.exec(request.headers.range ?? "");
      if (suffix?.[1] !== undefined) {
        const start = Math.max(0, bytes.length - Number(suffix[1]));
        response.writeHead(206, { "content-type": "text/plain", "content-range": `bytes ${String(start)}-${String(bytes.length - 1)}/${String(bytes.length)}` });
        response.end(bytes.subarray(start));
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(bytes);
      return;
    }
    // ---- milestone 8 (ticket 02): codeload's archive download, which carries no token of the App's
    const archive = /^\/codeload\/([^/]+)\/([^/]+)\/legacy\.tar\.gz\/([0-9a-f]{40})$/.exec(path);
    if (method === "GET" && archive !== null) {
      if (request.headers.authorization !== undefined) {
        authorizedArchiveDownloads += 1;
      }
      const [, archiveOwner = "", archiveName = "", sha = ""] = archive;
      const repo = repoOf(archiveOwner, archiveName);
      const fullName = `${archiveOwner}/${archiveName}`;
      const token = url.searchParams.get("token") ?? "";
      const tree = options.trees === undefined || repo === undefined ? undefined : options.trees.tree(repoFullNameSchema.parse(fullName), sha);
      if (repo === undefined || tree === undefined || ((repo.private ?? true) && archiveTokens.get(token) !== fullName)) {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("404: Not Found");
        return;
      }
      archiveTokens.delete(token);
      response.writeHead(200, { "content-type": "application/x-gzip", "content-disposition": `attachment; filename=${archiveOwner}-${archiveName}-${sha.slice(0, 7)}.tar.gz` });
      response.end(await archiveOf(repo, sha, tree));
      return;
    }
    // ---- milestone 8 (ticket 02): a public repo's commits and tarball, read with no credentials
    const anonymousRead = auth === undefined ? /^\/repos\/([^/]+)\/([^/]+)\/(commits|tarball)\/(.+)$/.exec(path) : null;
    if (method === "GET" && anonymousRead !== null) {
      if (anonymousRemaining <= 0) {
        send(response, 403, { message: "API rate limit exceeded for 127.0.0.1. (But here's the good news: Authenticated requests get a higher rate limit.)" }, anonymousHeaders());
        return;
      }
      anonymousRemaining -= 1;
      const [, readOwner = "", readName = "", kind = "", rawRef = ""] = anonymousRead;
      const repo = repoOf(readOwner, readName);
      // A private repo, read anonymously, is no repo at all.
      if (repo === undefined || (repo.private ?? true)) {
        send(response, 404, { message: "Not Found" }, anonymousHeaders());
        return;
      }
      const ref = decodeURIComponent(rawRef);
      if (kind === "commits") {
        sendCommit(response, `${readOwner}/${readName}`, ref, anonymousHeaders());
      } else {
        sendTarballRedirect(response, repo, ref, anonymousHeaders());
      }
      return;
    }
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
      if (second !== null && login === `${second.appSlug}[bot]`) {
        send(response, 200, { id: botId + 1, login });
        return;
      }
      if (login !== `${appSlug}[bot]`) {
        send(response, 404, { message: "Not Found" });
        return;
      }
      send(response, 200, { id: botId, login });
      return;
    }

    // ---- milestone 3: the verified link's OAuth (F-119), on the website and the API
    if (method === "POST" && path === "/login/oauth/access_token") {
      const body = oauthBodySchema.safeParse(await readBody(request));
      if (!body.success || body.data.client_id !== oauthClient.clientId || body.data.client_secret !== oauthClient.clientSecret) {
        // GitHub answers a wrong client with 200 and an error, as it does a wrong code.
        send(response, 200, { error: "incorrect_client_credentials", error_description: "The client_id and/or client_secret passed are incorrect." });
        return;
      }
      const grant = userCodes.get(body.data.code);
      if (grant === undefined || (grant.redirectUri !== null && grant.redirectUri !== body.data.redirect_uri)) {
        send(response, 200, { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." });
        return;
      }
      if (grant.singleUse) {
        userCodes.delete(body.data.code);
      }
      const accessToken = `ghu_${randomBytes(18).toString("hex")}`;
      userTokens.set(accessToken, grant.user);
      send(response, 200, { access_token: accessToken, token_type: "bearer", scope: "" });
      return;
    }
    if (method === "GET" && path === "/user") {
      const user = auth === undefined ? undefined : userTokens.get(auth);
      if (user === undefined) {
        send(response, 401, { message: "Bad credentials" });
        return;
      }
      send(response, 200, { id: Number(user.userId), login: user.login, type: "User" });
      return;
    }
    const revoke = /^\/applications\/([^/]+)\/token$/.exec(path);
    if (method === "DELETE" && revoke !== null) {
      const basic = /^Basic (.+)$/i.exec(request.headers.authorization ?? "")?.[1];
      const [clientId = "", clientSecret = ""] = Buffer.from(basic ?? "", "base64").toString("utf8").split(":");
      if (decodeURIComponent(revoke[1] ?? "") !== oauthClient.clientId || clientId !== oauthClient.clientId || clientSecret !== oauthClient.clientSecret) {
        send(response, 404, { message: "Not Found" });
        return;
      }
      if (failRevocations > 0) {
        failRevocations -= 1;
        send(response, failRevocationStatus, { message: "the fake's revocation failed" });
        return;
      }
      const body = z.looseObject({ access_token: z.string() }).safeParse(await readBody(request));
      if (!body.success || !userTokens.delete(body.data.access_token)) {
        send(response, 404, { message: "Not Found" });
        return;
      }
      revokedUserTokens += 1;
      response.writeHead(204);
      response.end();
      return;
    }

    // ---- as the App: a JWT
    if (path === "/app" || path.startsWith("/app/")) {
      const app = auth === undefined ? null : jwtApp(auth);
      if (app === null) {
        send(response, 401, { message: "A JSON web token could not be decoded" });
        return;
      }
      if (app === "second" && second !== null && method === "GET" && path === "/app") {
        send(response, 200, {
          id: Number(second.appId),
          slug: second.appSlug,
          name: second.appSlug,
          permissions: { contents: "write", checks: "write", actions: "read", metadata: "read", pull_requests: "write" },
          events: ["pull_request"],
          client_id: "Iv1.fakesecond",
          owner: accountJson(second.owner),
        });
        return;
      }
      if (app === "second" && second !== null && method === "GET" && path === "/app/installations") {
        const live = accountOf(second.owner.installationId) === undefined ? [] : [second.owner];
        send(
          response,
          200,
          live.map((item) => ({ id: item.installationId, account: accountJson(item), repository_selection: "selected", app_id: Number(second.appId), target_type: item.type })),
        );
        return;
      }
      if (method === "GET" && path === "/app") {
        send(response, 200, {
          id: Number(appId),
          slug: appSlug,
          name: "ostra fake",
          permissions: { contents: "write", checks: "write", actions: "read", metadata: "read", pull_requests: "write" },
          events: [...appEvents],
          client_id: oauthClient.clientId,
          owner: accountJson({ login: org, id: orgId, type: "Organization" }),
        });
        return;
      }
      if (method === "GET" && path === "/app/installations") {
        const live = [{ installationId, login: org, id: orgId, type: "Organization" }, ...otherAccounts].filter((item) => accountOf(item.installationId) !== undefined);
        send(
          response,
          200,
          live.map((item) => ({ id: item.installationId, account: accountJson(item), repository_selection: "selected", app_id: Number(appId), target_type: item.type })),
        );
        return;
      }
      // Milestone 4 (F-136): "Uninstalls a GitHub App on a user, organization, or enterprise account."
      const uninstall = /^\/app\/installations\/(\d+)$/.exec(path);
      if (method === "DELETE" && uninstall !== null) {
        const id = Number(uninstall[1]);
        if (accountOf(id) === undefined || !ofApp(app, id)) {
          send(response, 404, { message: "Not Found" });
          return;
        }
        removedInstallations.push(id);
        response.writeHead(204);
        response.end();
        return;
      }
      const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
      if (method === "POST" && mint !== null) {
        const minting = Number(mint[1]);
        if (accountOf(minting) === undefined || !ofApp(app, minting)) {
          send(response, 404, { message: "Not Found" });
          return;
        }
        const body = bodySchema.parse(await readBody(request));
        if (body.repositories?.some((wanted) => !options.repos.some((repo) => repo.name === wanted && installationSees(minting, repo))) === true) {
          send(response, 422, { message: "There is at least one repository that does not exist or is not accessible to the parent installation." });
          return;
        }
        const token = `ghs_${randomBytes(18).toString("hex")}`;
        const expiresAt = Date.now() + 3_600_000;
        tokens.set(token, {
          installationId: minting,
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
    // ---- milestone 3: GraphQL's draft mutations (F-054)
    if (method === "POST" && path === "/graphql") {
      const body = z.looseObject({ query: z.string(), variables: z.looseObject({ id: z.string().optional() }).optional() }).safeParse(await readBody(request));
      const toDraft = body.success && body.data.query.includes("convertPullRequestToDraft");
      const toReady = body.success && body.data.query.includes("markPullRequestReadyForReview");
      if (!body.success || (!toDraft && !toReady)) {
        send(response, 200, { errors: [{ type: "INVALID", message: "the fake GitHub answers only the draft mutations" }] });
        return;
      }
      const pr = pulls.find((candidate) => nodeIdOf(candidate) === body.data.variables?.id);
      const visible = pr !== undefined && (scope.repos === null || scope.repos.includes(pr.repo.slice(pr.repo.indexOf("/") + 1)));
      if (!visible) {
        send(response, 200, { data: null, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a node with the global id" }] });
        return;
      }
      // As GitHub answers (live, 2026-11-19): both mutations need `contents: write` as well as
      // `pull_requests: write`; with `pull_requests: write` alone they are FORBIDDEN.
      if (scope.permissions["pull_requests"] !== "write" || scope.permissions["contents"] !== "write") {
        send(response, 200, { data: null, errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] });
        return;
      }
      if (pr.state !== "open") {
        send(response, 200, { data: null, errors: [{ type: "UNPROCESSABLE", message: "Pull request is closed" }] });
        return;
      }
      pr.draft = toDraft;
      pr.updatedAt = tick();
      draftChanges += 1;
      const field = toDraft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
      send(response, 200, { data: { [field]: { pullRequest: { isDraft: pr.draft } } } });
      return;
    }
    if (method === "GET" && path === "/installation/repositories") {
      const visible = options.repos.filter((repo) => installationSees(scope.installationId, repo) && (scope.repos === null || scope.repos.includes(repo.name)));
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
    if (repo === undefined || !installationSees(scope.installationId, repo) || (scope.repos !== null && !scope.repos.includes(repo.name))) {
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
      const files = repo.filesAt?.[url.searchParams.get("ref") ?? ""] ?? repo.files;
      const content = files[filePath];
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
      const children = Object.keys(files).filter((file) => file.startsWith(`${filePath}/`));
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
      pullCreates.push(head);
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
        headSha: randomBytes(20).toString("hex"),
        updatedAt: tick(),
        mergedAt: null,
        closedAt: null,
      };
      pulls.push(pr);
      send(response, 201, prJson(pr));
      return;
    }
    const byNumber = /^\/pulls\/(\d+)$/.exec(rest);
    if (method === "GET" && byNumber?.[1] !== undefined) {
      if (!needs("pull_requests", "read")) {
        forbid();
        return;
      }
      const pr = pulls.find((item) => item.repo === `${owner}/${name}` && item.number === Number(byNumber[1]));
      if (pr === undefined) {
        send(response, 404, { message: "Not Found" });
        return;
      }
      send(response, 200, prJson(pr));
      return;
    }
    const branchRoute = /^\/branches\/(.+)$/.exec(rest);
    if (method === "GET" && branchRoute?.[1] !== undefined) {
      if (!needs("contents", "read")) {
        forbid();
        return;
      }
      const branch = decodeURIComponent(branchRoute[1]);
      if (!repo.branches.includes(branch)) {
        send(response, 404, { message: "Branch not found" });
        return;
      }
      send(response, 200, { name: branch, protected: repo.protectedBranches?.includes(branch) ?? false });
      return;
    }
    const rulesRoute = /^\/rules\/branches\/(.+)$/.exec(rest);
    if (method === "GET" && rulesRoute?.[1] !== undefined) {
      if (!needs("metadata", "read")) {
        forbid();
        return;
      }
      if ((repo.plan ?? "paid") === "free" && (repo.private ?? true)) {
        send(response, 403, {
          message: "Upgrade to GitHub Pro or make this repository public to enable this feature.",
          documentation_url: "https://docs.github.com/rest/repos/rules#get-rules-for-a-branch",
        });
        return;
      }
      if (repo.rulesRefused === true) {
        forbid();
        return;
      }
      const branch = decodeURIComponent(rulesRoute[1]);
      send(
        response,
        200,
        (repo.rulesets?.[branch] ?? []).map((type) => ({ type, ruleset_source_type: "Repository", ruleset_source: `${owner}/${name}`, ruleset_id: 1 })),
      );
      return;
    }
    const refRoute = /^\/git\/refs\/(.+)$/.exec(rest);
    if (method === "DELETE" && refRoute?.[1] !== undefined) {
      if (!needs("contents", "write")) {
        forbid();
        return;
      }
      const full = `refs/${decodeURIComponent(refRoute[1])}`;
      const held = refs.get(`${owner}/${name}`);
      if (held?.delete(full) !== true) {
        send(response, 422, { message: "Reference does not exist" });
        return;
      }
      response.writeHead(204, { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4989", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600) });
      response.end();
      return;
    }
    // ---- milestone 3: compare (F-027), reactions (F-053)
    const compareRoute = /^\/compare\/(.+)$/.exec(rest);
    if (method === "GET" && compareRoute?.[1] !== undefined) {
      if (!needs("contents", "read")) {
        forbid();
        return;
      }
      const basehead = decodeURIComponent(compareRoute[1]);
      const split = basehead.indexOf("...");
      const baseRef = split < 0 ? "" : basehead.slice(0, split);
      const headRef = split < 0 ? "" : basehead.slice(split + 3);
      const scripted = repo.compares?.find((candidate) => candidate.base === baseRef && candidate.head === headRef);
      const known = (ref: string): boolean => repo.branches.includes(ref) || /^[0-9a-f]{40}$/.test(ref);
      if (scripted === undefined && !(known(baseRef) && known(headRef))) {
        send(response, 404, { message: "Not Found" });
        return;
      }
      const files = scripted?.files ?? [];
      send(response, 200, {
        status: scripted === undefined ? "identical" : "diverged",
        ahead_by: scripted?.aheadBy ?? 0,
        behind_by: scripted?.behindBy ?? 0,
        total_commits: scripted?.aheadBy ?? 0,
        merge_base_commit: { sha: scripted?.mergeBase ?? "0".repeat(40) },
        // As GitHub: oldest first, one page of `per_page` (30 by default).
        commits: (scripted?.commits ?? [])
          .slice(0, Math.min(Number(url.searchParams.get("per_page") ?? "30"), 250))
          .map((message, index) => ({ sha: (index + 1).toString(16).padStart(40, "c"), commit: { message } })),
        // As GitHub: at most 300 files, and a patch over 500 KB left out.
        files: files.slice(0, COMPARE_MAX_FILES).map((file) => ({
          filename: file.path,
          ...(file.previousPath === undefined ? {} : { previous_filename: file.previousPath }),
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.additions + file.deletions,
          ...(file.patch === undefined || Buffer.byteLength(file.patch) > MAX_FILE_DIFF_BYTES ? {} : { patch: file.patch }),
        })),
      });
      return;
    }
    const reactionRoute = /^\/(issues|pulls)\/comments\/(\d+)\/reactions$/.exec(rest);
    if (method === "POST" && reactionRoute !== null) {
      // GitHub takes either permission for a reaction on a PR's comment.
      if (!needs("pull_requests", "write") && !needs("issues", "write")) {
        forbid();
        return;
      }
      const kind = reactionRoute[1] === "issues" ? "issue" : "review";
      const commentId = reactionRoute[2] ?? "";
      if (!comments.some((comment) => comment.repo === `${owner}/${name}` && comment.kind === kind && comment.id === commentId)) {
        send(response, 404, { message: "Not Found" });
        return;
      }
      const body = z.looseObject({ content: z.string() }).safeParse(await readBody(request));
      if (!body.success || !REACTIONS.has(body.data.content)) {
        send(response, 422, { message: "Validation Failed" });
        return;
      }
      const key = `${owner}/${name}:${kind}:${commentId}:${body.data.content}`;
      const existing = reactions.get(key);
      if (existing !== undefined) {
        // Already reacted so: 200 with the same reaction.
        send(response, 200, { id: existing, content: body.data.content, user: { login: `${appSlug}[bot]` } });
        return;
      }
      const id = reactions.size + 1;
      reactions.set(key, id);
      send(response, 201, { id, content: body.data.content, user: { login: `${appSlug}[bot]` } });
      return;
    }
    // ---- milestone 4: reviews and check runs (F-104)
    const reviewsRoute = /^\/pulls\/(\d+)\/reviews$/.exec(rest);
    if (method === "GET" && reviewsRoute?.[1] !== undefined) {
      if (!needs("pull_requests", "read")) {
        forbid();
        return;
      }
      const number = Number(reviewsRoute[1]);
      const held = reviews.filter((review) => review.repo === `${owner}/${name}` && review.number === number);
      if (held.length === 0 && !pulls.some((pr) => pr.repo === `${owner}/${name}` && pr.number === number)) {
        send(response, 404, { message: "Not Found" });
        return;
      }
      // Paged as GitHub pages it, oldest first, with a `Link` header to the next page.
      const perPage = Math.min(Number(url.searchParams.get("per_page") ?? "30"), 100);
      const page = Number(url.searchParams.get("page") ?? "1");
      const slice = held.slice((page - 1) * perPage, page * perPage);
      const next = page * perPage < held.length ? { link: `<${apiBase()}${path}?per_page=${String(perPage)}&page=${String(page + 1)}>; rel="next"` } : {};
      send(response, 200, slice.map(reviewJson), next);
      return;
    }
    const checkRunsOfRef = /^\/commits\/([^/]+)\/check-runs$/.exec(rest);
    if (method === "GET" && checkRunsOfRef?.[1] !== undefined) {
      if (!needs("checks", "read")) {
        forbid();
        return;
      }
      const ref = decodeURIComponent(checkRunsOfRef[1]);
      const named = url.searchParams.get("check_name");
      const appFilter = url.searchParams.get("app_id");
      const found = checkRuns.filter(
        (run) => run.repo === `${owner}/${name}` && run.headSha === ref && (named === null || run.name === named) && (appFilter === null || String(run.appId) === appFilter),
      );
      // Paged as GitHub pages it (milestone 6 reads every app's runs).
      const perPage = Math.min(Number(url.searchParams.get("per_page") ?? "30"), 100);
      const page = Number(url.searchParams.get("page") ?? "1");
      send(response, 200, { total_count: found.length, check_runs: found.slice((page - 1) * perPage, page * perPage).map(checkRunJson) });
      return;
    }
    // ---- milestone 6: CI (F-035), comment-type reviews (F-100), requested reviewers (F-102)
    const statusOfRef = /^\/commits\/([^/]+)\/status$/.exec(rest);
    if (method === "GET" && statusOfRef?.[1] !== undefined) {
      if (!needs("statuses", "read")) {
        forbid();
        return;
      }
      const held = statuses.get(`${owner}/${name}:${decodeURIComponent(statusOfRef[1])}`) ?? [];
      const perPage = Math.min(Number(url.searchParams.get("per_page") ?? "30"), 100);
      const page = Number(url.searchParams.get("page") ?? "1");
      const state = held.some((status) => status.state === "failure" || status.state === "error") ? "failure" : held.every((status) => status.state === "success") && held.length > 0 ? "success" : "pending";
      send(response, 200, {
        state,
        sha: decodeURIComponent(statusOfRef[1]),
        total_count: held.length,
        statuses: held.slice((page - 1) * perPage, page * perPage).map((status) => ({ context: status.context, state: status.state, target_url: status.targetUrl, description: status.description })),
      });
      return;
    }
    const oneCheckRun = /^\/check-runs\/(\d+)$/.exec(rest);
    if (method === "GET" && oneCheckRun?.[1] !== undefined) {
      if (!needs("checks", "read")) {
        forbid();
        return;
      }
      const run = checkRuns.find((candidate) => candidate.repo === `${owner}/${name}` && candidate.id === Number(oneCheckRun[1]));
      if (run === undefined) {
        send(response, 404, { message: "Not Found" });
        return;
      }
      send(response, 200, checkRunJson(run));
      return;
    }
    // ---- milestone 8 (ticket 02): a repo's commits and tarball, through the installation
    const treeRead = /^\/(commits|tarball)\/(.+)$/.exec(rest);
    if (method === "GET" && treeRead !== null) {
      if (!needs("contents", "read")) {
        forbid();
        return;
      }
      const ref = decodeURIComponent(treeRead[2] ?? "");
      if (treeRead[1] === "commits") {
        sendCommit(response, `${owner}/${name}`, ref, {});
      } else {
        sendTarballRedirect(response, repo, ref, {});
      }
      return;
    }
    const jobLogs = /^\/actions\/jobs\/(\d+)\/logs$/.exec(rest);
    if (method === "GET" && jobLogs?.[1] !== undefined) {
      if (!needs("actions", "read")) {
        forbid();
        return;
      }
      const run = checkRuns.find((candidate) => candidate.repo === `${owner}/${name}` && candidate.id === Number(jobLogs[1]) && candidate.appSlug === "github-actions");
      if (run === undefined) {
        send(response, 404, { message: "Not Found" });
        return;
      }
      if (run.logExpired === true) {
        send(response, 410, { message: "Gone" });
        return;
      }
      // GitHub answers a redirect to a short-lived download URL.
      response.writeHead(302, { location: `${apiBase()}/job-logs/${String(run.id)}`, "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4990", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600) });
      response.end();
      return;
    }
    const postReview = /^\/pulls\/(\d+)\/reviews$/.exec(rest);
    if (method === "POST" && postReview?.[1] !== undefined) {
      if (!needs("pull_requests", "write")) {
        forbid();
        return;
      }
      const pr = pulls.find((item) => item.repo === `${owner}/${name}` && item.number === Number(postReview[1]));
      if (pr === undefined) {
        send(response, 404, { message: "Not Found" });
        return;
      }
      const body = z
        .looseObject({
          commit_id: z.string().optional(),
          body: z.string().optional(),
          event: z.string().optional(),
          comments: z.array(z.looseObject({ path: z.string(), line: z.number().int(), side: z.enum(["LEFT", "RIGHT"]).optional(), body: z.string() })).optional(),
        })
        .safeParse(await readBody(request));
      if (!body.success) {
        send(response, 422, { message: "Validation Failed" });
        return;
      }
      const ranges = diffRanges(repo, pr);
      const offDiff = (body.data.comments ?? []).some((comment) => {
        const file = ranges.get(comment.path);
        const sideRanges = (comment.side ?? "RIGHT") === "RIGHT" ? file?.right : file?.left;
        return !sideRanges?.some(([start, end]) => comment.line >= start && comment.line <= end);
      });
      if (offDiff) {
        // GitHub refuses the whole review, and doesn't say which comment.
        send(response, 422, { message: "Unprocessable Entity", errors: ["Line could not be resolved"] });
        return;
      }
      const states: Readonly<Record<string, string>> = { COMMENT: "COMMENTED", APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED" };
      reviewCounter += 1;
      const posted: FakeReview = {
        id: 80_000_000 + reviewCounter,
        repo: `${owner}/${name}`,
        number: pr.number,
        userId: botId,
        login: `${appSlug}[bot]`,
        userType: "Bot",
        state: states[body.data.event ?? ""] ?? "PENDING",
        commitId: body.data.commit_id ?? pr.headSha,
        submittedAt: tick(),
        body: body.data.body ?? "",
      };
      reviews.push(posted);
      const key = `${posted.repo}#${String(pr.number)}`;
      const held = postedComments.get(key) ?? [];
      for (const comment of body.data.comments ?? []) {
        reviewCommentCounter += 1;
        held.push({ id: 90_000_000 + reviewCommentCounter, reviewId: posted.id, path: comment.path, line: comment.line, side: comment.side ?? "RIGHT", body: comment.body });
      }
      postedComments.set(key, held);
      send(response, 200, reviewJson(posted));
      return;
    }
    const reviewCommentsRoute = /^\/pulls\/(\d+)\/reviews\/(\d+)\/comments$/.exec(rest);
    if (method === "GET" && reviewCommentsRoute?.[1] !== undefined && reviewCommentsRoute[2] !== undefined) {
      if (!needs("pull_requests", "read")) {
        forbid();
        return;
      }
      const reviewId = Number(reviewCommentsRoute[2]);
      if (!reviews.some((review) => review.id === reviewId && review.repo === `${owner}/${name}`)) {
        send(response, 404, { message: "Not Found" });
        return;
      }
      const held = (postedComments.get(`${owner}/${name}#${reviewCommentsRoute[1]}`) ?? []).filter((comment) => comment.reviewId === reviewId);
      // As GitHub answers it (seen live, 2026-11-20): each comment's diff position, and no `line` or `side`.
      send(
        response,
        200,
        held.map((comment) => ({ id: comment.id, pull_request_review_id: comment.reviewId, path: comment.path, position: comment.line, original_position: comment.line, body: comment.body, user: { id: botId, login: `${appSlug}[bot]` } })),
      );
      return;
    }
    const prCommentsRoute = /^\/pulls\/(\d+)\/comments$/.exec(rest);
    if (method === "GET" && prCommentsRoute?.[1] !== undefined) {
      if (!needs("pull_requests", "read")) {
        forbid();
        return;
      }
      if (!pulls.some((pr) => pr.repo === `${owner}/${name}` && pr.number === Number(prCommentsRoute[1]))) {
        send(response, 404, { message: "Not Found" });
        return;
      }
      // A PR's review comments, every review's, each with its line, side and review (`GET /pulls/{n}/comments`).
      const held = postedComments.get(`${owner}/${name}#${prCommentsRoute[1]}`) ?? [];
      const perPage = Number(url.searchParams.get("per_page") ?? "30");
      const page = Number(url.searchParams.get("page") ?? "1");
      send(
        response,
        200,
        held
          .slice((page - 1) * perPage, page * perPage)
          .map((comment) => ({ id: comment.id, pull_request_review_id: comment.reviewId, path: comment.path, line: comment.line, original_line: comment.line, side: comment.side, subject_type: "line", body: comment.body, user: { id: botId, login: `${appSlug}[bot]` } })),
      );
      return;
    }
    const requestedRoute = /^\/pulls\/(\d+)\/requested_reviewers$/.exec(rest);
    if (method === "GET" && requestedRoute?.[1] !== undefined) {
      if (!needs("pull_requests", "read")) {
        forbid();
        return;
      }
      if (!pulls.some((pr) => pr.repo === `${owner}/${name}` && pr.number === Number(requestedRoute[1]))) {
        send(response, 404, { message: "Not Found" });
        return;
      }
      const held = requestedReviewers.get(`${owner}/${name}#${requestedRoute[1]}`) ?? { users: [], teams: [] };
      send(response, 200, { users: held.users.map((user) => ({ id: user.id, login: user.login, type: "User" })), teams: held.teams.map((slug) => ({ slug, name: slug })) });
      return;
    }
    if (method === "POST" && rest === "/check-runs") {
      if (!needs("checks", "write")) {
        forbid();
        return;
      }
      const body = checkRunBodySchema.safeParse(await readBody(request));
      if (!body.success || body.data.name === undefined || body.data.head_sha === undefined || !/^[0-9a-f]{40}$/.test(body.data.head_sha)) {
        send(response, 422, { message: "Validation Failed" });
        return;
      }
      checkRunCounter += 1;
      const run: FakeCheckRun = {
        id: 5_000_000 + checkRunCounter,
        repo: `${owner}/${name}`,
        appId: Number(appId),
        name: body.data.name,
        headSha: body.data.head_sha,
        status: body.data.status ?? "queued",
        conclusion: body.data.conclusion ?? null,
        title: body.data.output?.title ?? null,
        summary: body.data.output?.summary ?? null,
        externalId: body.data.external_id ?? null,
      };
      checkRuns.push(run);
      send(response, 201, checkRunJson(run));
      return;
    }
    const checkRunRoute = /^\/check-runs\/(\d+)$/.exec(rest);
    if (method === "PATCH" && checkRunRoute?.[1] !== undefined) {
      if (!needs("checks", "write")) {
        forbid();
        return;
      }
      const run = checkRuns.find((candidate) => candidate.repo === `${owner}/${name}` && candidate.id === Number(checkRunRoute[1]));
      if (run === undefined) {
        send(response, 404, { message: "Not Found" });
        return;
      }
      const body = checkRunBodySchema.safeParse(await readBody(request));
      if (!body.success) {
        send(response, 422, { message: "Validation Failed" });
        return;
      }
      // As GitHub: a conclusion completes the run; an in-progress status clears it.
      if (body.data.conclusion !== undefined && body.data.conclusion !== null) {
        run.status = "completed";
        run.conclusion = body.data.conclusion;
      } else if (body.data.status !== undefined) {
        run.status = body.data.status;
        run.conclusion = body.data.status === "completed" ? run.conclusion : null;
      }
      run.title = body.data.output?.title ?? run.title;
      run.summary = body.data.output?.summary ?? run.summary;
      run.externalId = body.data.external_id ?? run.externalId;
      send(response, 200, checkRunJson(run));
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
      if (body.title !== undefined) {
        pr.title = body.title;
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
  baseUrl = `http://127.0.0.1:${String(port)}`;

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
    orgId,
    requests,
    pulls,
    pullCreates,
    refs,
    finishPullRequest,
    reopenPullRequest,
    tokens,
    failures,
    webhookSecret,
    signWebhook: (body) => `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`,
    addComment: (repo, kind) => {
      const id = String(9_000_000 + comments.length + 1);
      comments.push({ repo, kind, id });
      return id;
    },
    reactions: () => [...reactions.keys()],
    draftChanges: () => draftChanges,
    oauthClient,
    issueUserCode: (user, codeOptions = {}) => {
      const code = `fakecode_${randomBytes(10).toString("hex")}`;
      userCodes.set(code, { user, singleUse: codeOptions.singleUse ?? false, redirectUri: codeOptions.redirectUri ?? null });
      return code;
    },
    revokedUserTokens: () => revokedUserTokens,
    liveUserTokens: () => userTokens.size,
    failRevocations: (count, status = 500) => {
      failRevocations += count;
      failRevocationStatus = status;
    },
    addReview: (repo, number, review) => {
      reviewCounter += 1;
      const added: FakeReview = { ...review, id: 80_000_000 + reviewCounter, repo, number };
      reviews.push(added);
      return added;
    },
    dismissReview: (reviewId) => {
      const found = reviews.find((review) => review.id === reviewId);
      if (found === undefined) throw new Error("the fake has no such review");
      found.state = "DISMISSED";
      return found;
    },
    checkRuns,
    addCheckRun: (repo, run) => {
      checkRunCounter += 1;
      const added: FakeCheckRun = {
        ...run,
        id: 5_000_000 + checkRunCounter,
        repo,
        appId: run.appId ?? 15_368,
        title: null,
        summary: run.summary ?? null,
        externalId: null,
      };
      checkRuns.push(added);
      return added;
    },
    setStatus: (repo, headSha, status) => {
      const key = `${repo}:${headSha}`;
      const held = (statuses.get(key) ?? []).filter((candidate) => candidate.context !== status.context);
      statuses.set(key, [...held, status]);
    },
    requestReviewers: (repo, number, reviewers) => {
      requestedReviewers.set(`${repo}#${String(number)}`, reviewers);
    },
    reviewComments: (repo, number) => [...(postedComments.get(`${repo}#${String(number)}`) ?? [])],
    reviewCount: (repo, number) => reviews.filter((review) => review.repo === repo && review.number === number).length,
    authorizedLogDownloads: () => authorizedLogDownloads,
    setAnonymousRemaining: (remaining) => {
      anonymousRemaining = remaining;
    },
    authorizedArchiveDownloads: () => authorizedArchiveDownloads,
    trees: options.trees,
    setAppEvents: (events) => {
      appEvents = [...events];
    },
    otherAccounts,
    removedInstallations: () => [...removedInstallations],
    secondApp: second === null ? null : { appId: second.appId, appSlug: second.appSlug, privateKey: second.pair.privateKey, installationId: second.owner.installationId, owner: second.owner },
    installationPayload: (action, id) => {
      const account = id === installationId ? { login: org, id: orgId, type: "Organization" } : otherAccounts.find((item) => item.installationId === id);
      if (account === undefined) throw new Error("the fake has no such installation");
      const repos = options.repos.filter((repo) => (id === installationId ? !notOwners.some((other) => other.login === repo.owner) : repo.owner === account.login));
      return JSON.stringify({
        action,
        installation: {
          id,
          account: accountJson(account),
          repository_selection: "selected",
          access_tokens_url: `${apiBase()}/app/installations/${String(id)}/access_tokens`,
          app_id: Number(appId),
          app_slug: appSlug,
          target_id: account.id,
          target_type: account.type,
          permissions: { contents: "write", metadata: "read", pull_requests: "write", checks: "write" },
          events: ["pull_request"],
          created_at: "2026-11-19T10:00:00Z",
          updated_at: "2026-11-19T10:00:00Z",
          suspended_by: action === "suspend" ? { login: account.login, id: account.id, type: "User" } : null,
          suspended_at: action === "suspend" ? "2026-11-19T10:05:00Z" : null,
        },
        ...(action === "created" || action === "deleted"
          ? { repositories: repos.map((repo) => ({ id: repo.id, node_id: `R_fake_${String(repo.id)}`, name: repo.name, full_name: `${repo.owner}/${repo.name}`, private: repo.private ?? true })) }
          : {}),
        requester: null,
        sender: { login: `${account.login}-admin`, id: account.id + 1, type: "User" },
      });
    },
    installationRepositoriesPayload: (action, id, repoNames) => {
      const account = id === installationId ? { login: org, id: orgId, type: "Organization" } : otherAccounts.find((item) => item.installationId === id);
      if (account === undefined) throw new Error("the fake has no such installation");
      const repos = repoNames.map((name) => {
        const repo = options.repos.find((candidate) => candidate.name === name && candidate.owner === account.login);
        if (repo === undefined) throw new Error("the fake has no such repo on the account");
        return { id: repo.id, node_id: `R_fake_${String(repo.id)}`, name: repo.name, full_name: `${repo.owner}/${repo.name}`, private: repo.private ?? true };
      });
      return JSON.stringify({
        action,
        installation: { id, account: accountJson(account), repository_selection: "selected", app_id: Number(appId), target_type: account.type },
        repository_selection: "selected",
        repositories_added: action === "added" ? repos : [],
        repositories_removed: action === "removed" ? repos : [],
        requester: null,
        sender: { login: `${account.login}-admin`, id: account.id + 1, type: "User" },
      });
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
