import type { GitPerson, GitSha, RepoFullName } from "@ostra/protocol";

import { createPlumbing, defaultAdapterContext } from "../common/context.ts";
import type { AdapterContext, Plumbing } from "../common/context.ts";
import { adapterError } from "../common/result.ts";
import type { AdapterError, AdapterResult, HealthReport, Result } from "../common/result.ts";
import type { CodeHostCapabilities } from "./capabilities.ts";

// The code host kind (ADR 0025, ADR 0040): GitHub first. The organization's own App opens every
// PR; tokens are minted for one repo at a time, with named permissions (ADR 0030).

/** The App's own credentials, from the secret store. Never logged; passed per call. */
export type CodeHostAppCredentials = {
  readonly appId: string;
  /** The App's private key, PEM. */
  readonly privateKey: string;
};

/** What the manifest flow needs to describe the App (F-006). */
export type AppManifestInput = {
  /** The App's name on the host, unique there. */
  readonly name: string;
  /** The panel's address. */
  readonly homepageUrl: string;
  /** Where the host delivers webhooks: this organization's connection's address (Q102). */
  readonly webhookUrl: string;
  /** Where the host sends the admin back with the manifest's code. */
  readonly redirectUrl: string;
  /** The account the App is created on: an organization's login, or `null` for the admin's own. */
  readonly ownerLogin: string | null;
  /**
   * Milestone 4 (F-136, ADR 0065): whether accounts other than the owner may install the App.
   * Absent is `false`, the default, since a host may not let a public App become private again
   * once another account installed it. A public App's homepage is ostra's project page, so its
   * public page doesn't name the install's address; a private App's stays `homepageUrl`.
   */
  readonly public?: boolean;
};

export type AppManifest = {
  /** The manifest, as the host's form expects it. */
  readonly manifest: Readonly<Record<string, unknown>>;
  /** Where the panel posts it. */
  readonly createUrl: string;
};

/** The App the manifest flow created: its secrets go to the secret store at once. */
export type CreatedApp = CodeHostAppCredentials & {
  readonly slug: string;
  readonly name: string;
  readonly webhookSecret: string;
  readonly clientId: string;
  readonly clientSecret: string;
};

/** What ostra reads about an App. */
export type AppInfo = {
  readonly appId: string;
  readonly slug: string;
  readonly name: string;
  /** Permission name to level, as the host reports them (`checks: write`, `actions: read`). */
  readonly permissions: Readonly<Record<string, string>>;
  readonly events: readonly string[];
  /** The App's OAuth client ID, for the verified link (F-119); absent when the host does not say. */
  readonly clientId?: string;
  /**
   * Milestone 4 (F-136): the account that owns the App. Absent when the host doesn't say (or an
   * adapter from before milestone 4): optional, so the contract only grows.
   */
  readonly owner?: AppOwner;
};

/** The account that owns an App (F-136): a private App installs only there. */
export type AppOwner = {
  readonly login: string;
  /** The host's own ID of the account, which survives a rename. */
  readonly accountId: string;
};

/** The account an installation is on (F-136): the App's owner's own, or another account's. */
export type InstallationAccount = {
  /** The host's own ID of the account, which survives a rename. */
  readonly accountId: string;
  readonly login: string;
  readonly kind: "organization" | "user";
};

export type Installation = {
  readonly installationId: string;
  readonly accountLogin: string;
  /**
   * Milestone 4 (F-136): the account's ID beside its login, which survives a rename. Absent when the
   * host doesn't say (or an adapter from before milestone 4): optional, so the contract only grows.
   */
  readonly accountId?: string;
  readonly accountKind: "organization" | "user";
  readonly repositorySelection: "all" | "selected";
};

/** A repo an `installation_repositories` webhook names as added or removed (F-136). */
export type InstallationRepo = {
  readonly hostRepoId: string;
  readonly fullName: RepoFullName;
};

/** A repo as the host lists it. */
export type HostRepo = {
  /** The host's own ID, which survives a rename. */
  readonly hostRepoId: string;
  readonly fullName: RepoFullName;
  readonly defaultBranch: string;
  readonly private: boolean;
  readonly cloneUrl: string;
};

/** Which repo a call is about, and through which installation. */
export type RepoAccess = {
  readonly app: CodeHostAppCredentials;
  readonly installationId: string;
  readonly repo: RepoFullName;
};

/** Milestone 6 adds `statuses`, which reads a head's commit statuses (F-035). */
export type RepoPermission = "contents" | "pull_requests" | "metadata" | "checks" | "actions" | "workflows" | "statuses";
export type PermissionLevel = "read" | "write";

/** A token for one repo only, with the named permissions (ADR 0030). Never logged. */
export type RepoToken = { readonly token: string; readonly expiresAt: number };

export type RepoFile = { readonly path: string; readonly content: string };

export type ReadFilesResult = {
  readonly files: readonly RepoFile[];
  /** Paths that don't exist at that ref. */
  readonly missing: readonly string[];
};

export type PullRequest = {
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "closed" | "merged";
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly title: string;
  /** Milestone 3: whether it's a draft, when the host says (F-054). */
  readonly draft?: boolean;
};

export type OpenPullRequestInput = {
  readonly access: RepoAccess;
  readonly head: string;
  readonly base: string;
  readonly title: string;
  /** Written by the agent through ostra's MCP tool: untrusted text, sent as data. */
  readonly body: string;
  readonly draft: boolean;
};

export type UpdatePullRequestBodyInput = {
  readonly access: RepoAccess;
  readonly number: number;
  /** The agent's text and ostra's footer: untrusted text, sent as data. */
  readonly body: string;
};

export type WebhookInput = {
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** The raw body, exactly as received: the signature is over these bytes. */
  readonly body: string;
  readonly secret: string;
};

// ---------- milestone 2 ----------

/**
 * Why a host's answer on a branch's rules isn't a plain yes, as a code the panel words (F-083):
 * - `no-rules-on-plan`: the repo's plan offers no branch rules, so none apply;
 * - `classic-signatures`: classic branch protection, whose signed-commit rule the App can't read
 *   without an administration permission ostra doesn't ask for;
 * - `rules-refused`: the host wouldn't let the App read the branch's rules.
 */
export const branchRuleReasons = ["no-rules-on-plan", "classic-signatures", "rules-refused"] as const;
export type BranchRuleReason = (typeof branchRuleReasons)[number];

/** One answer of `readBranchRules`: `unknown` when the host can't say, and `reasons` says why. */
export type BranchRules = {
  readonly protected: boolean | "unknown";
  readonly requiresSignedCommits: boolean | "unknown";
  /** Why, one per check that isn't a plain yes: codes, never a vendor's body. */
  readonly reasons: readonly BranchRuleReason[];
};

/** A PR's state, for the reconcile (F-044). */
export type PullRequestDetails = PullRequest & {
  readonly merged: boolean;
  readonly headSha: string;
  /** In ms since the epoch. */
  readonly updatedAt: number;
  readonly mergedAt: number | null;
  readonly closedAt: number | null;
  /**
   * Milestone 3: the PR's description as it is now, when the host says, so ostra edits its own
   * checks section without overwriting a person's edits (F-054). Untrusted text: never logged.
   */
  readonly body?: string | null;
};

/**
 * A verified webhook, read loosely. Only `pull_request` events are read in milestone 2. A new head
 * on a PR is its `synchronize` action, which milestone 4's review check reads (F-104).
 */
export type CodeHostWebhookEvent =
  | {
      readonly kind: "pull_request";
      /** The host's action: `opened`, `closed`, `reopened`, `synchronize`, `edited`, … */
      readonly action: string;
      readonly installationId: string | null;
      readonly hostRepoId: string;
      readonly repo: RepoFullName;
      readonly number: number;
      readonly state: "open" | "closed" | "merged";
      readonly headBranch: string;
      readonly headSha: string;
      /** When the PR last changed, in ms since the epoch: an older report changes nothing. */
      readonly changedAt: number;
    }
    // ---- milestone 3 (F-053, F-070, ADR 0052): the hints `@ostra` and "behind" read ----
  /** A comment on a PR's conversation (or an issue's: `onPullRequest` says which). */
  | {
      readonly kind: "issue_comment";
      /** `created`, `edited`, `deleted`. */
      readonly action: string;
      readonly installationId: string | null;
      readonly hostRepoId: string;
      readonly repo: RepoFullName;
      /** The PR's (or the issue's) number. */
      readonly number: number;
      readonly onPullRequest: boolean;
      readonly comment: PullRequestComment;
      /** The host account that caused the delivery: for an `edited` comment, its editor, who may not be its author. */
      readonly senderId: string;
    }
  /** A comment on a line of a PR's diff. */
  | {
      readonly kind: "pull_request_review_comment";
      readonly action: string;
      readonly installationId: string | null;
      readonly hostRepoId: string;
      readonly repo: RepoFullName;
      readonly number: number;
      readonly comment: PullRequestComment;
      /** The host account that caused the delivery: for an `edited` comment, its editor, who may not be its author. */
      readonly senderId: string;
      readonly path: string;
      readonly side: "old" | "new";
      /** The line in the side's file, or `null` for a comment on a whole file. */
      readonly line: number | null;
    }
  /** A push to a branch. */
  | {
      readonly kind: "push";
      readonly installationId: string | null;
      readonly hostRepoId: string;
      readonly repo: RepoFullName;
      /** The full ref, `refs/heads/<branch>`. */
      readonly ref: string;
      readonly before: string;
      readonly after: string;
      /** The paths the push's commits touched, when the payload lists them; `null` when it doesn't. */
      readonly changedPaths: readonly string[] | null;
    }
    // ---- milestone 4 (F-104): a review submitted, edited or dismissed ----
  /** A review on a PR. A new head is the `pull_request` event's `synchronize`. */
  | {
      readonly kind: "pull_request_review";
      /** `submitted`, `edited`, `dismissed`. */
      readonly action: string;
      readonly installationId: string | null;
      readonly hostRepoId: string;
      readonly repo: RepoFullName;
      readonly number: number;
      /** The PR's head when the review was sent, so a review of an older head is told apart. */
      readonly headSha: string;
      readonly review: PullRequestReview;
    }
    // ---- milestone 4 (F-136, ADR 0065): installations on the App's own account and on others' ----
  /** The App installed on an account, removed from it, suspended or unsuspended. */
  | {
      readonly kind: "installation";
      /** `created`, `deleted`, `suspend`, `unsuspend`, or another the host adds (`new_permissions_accepted`). */
      readonly action: string;
      readonly installationId: string;
      readonly account: InstallationAccount;
    }
  /** Repos added to an installation, or removed from it. */
  | {
      readonly kind: "installation_repositories";
      /** `added`, `removed`. */
      readonly action: string;
      readonly installationId: string;
      readonly account: InstallationAccount;
      readonly reposAdded: readonly InstallationRepo[];
      readonly reposRemoved: readonly InstallationRepo[];
    }
    // ---- milestone 6 (F-035, F-102): hints core reads the host's state by ----
  /**
   * CI changed on a head: a check run (`check_run`), a check suite (`check_suite`) or a commit
   * status (`status`). A hint: core reads `listCiResults` for the head, never the payload's own verdict.
   */
  | {
      readonly kind: "ci";
      readonly event: "check_run" | "check_suite" | "status";
      /** The host's action (`created`, `completed`, `rerequested`, …); `null` for a status, which has none. */
      readonly action: string | null;
      readonly installationId: string | null;
      readonly hostRepoId: string;
      readonly repo: RepoFullName;
      readonly headSha: string;
      /** The app that made the check run or suite, so core leaves out ostra's own; `null` for a status. */
      readonly appSlug: string | null;
    }
  /** A PR's requested reviewers changed. A hint: core reads `listRequestedReviewers`. */
  | {
      readonly kind: "pull_request_reviewers";
      readonly action: "review_requested" | "review_request_removed";
      readonly installationId: string | null;
      readonly hostRepoId: string;
      readonly repo: RepoFullName;
      readonly number: number;
      readonly headSha: string;
    }
  /** Every other event: recorded and not acted on. */
  | { readonly kind: "other"; readonly event: string };

/** A PR comment as a webhook carries it. Its body is untrusted text: data, never logged. */
export type PullRequestComment = {
  /** The host's ID of the comment, which a reaction names. */
  readonly commentId: string;
  /** The commenter's host account ID, which the verified link matches (F-119). */
  readonly authorId: string;
  readonly authorLogin: string;
  readonly body: string;
  readonly url: string;
};

// ---------- milestone 3 (ADR 0051, ADR 0052) ----------

/** How a file changed between a base and a head, as the host names it. */
export type CompareFileStatus = "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";

/** One file of a compare. */
export type CompareFile = {
  readonly path: string;
  /** The path before a rename or a copy, else `null`. */
  readonly previousPath: string | null;
  readonly status: CompareFileStatus;
  readonly additions: number;
  readonly deletions: number;
  /** The unified diff, or `null` for a binary file or one the host didn't send. Holds the repo's code: never logged. */
  readonly patch: string | null;
  /** The host cut the patch, or left it out for its size: the panel then links to the host. */
  readonly truncated: boolean;
};

/**
 * A compare of a base and a head (F-027, F-070, ADR 0051). The host's own limits are reported,
 * never hidden: `filesTruncated` when it listed fewer files than changed, and each file's
 * `truncated`.
 */
export type CompareResult = {
  /** Commits on the head the base lacks. */
  readonly aheadBy: number;
  /** Commits on the base the head lacks: the branch is "behind" when this is above 0. */
  readonly behindBy: number;
  /** The commit both grew from, or `null` when the host doesn't say. */
  readonly mergeBase: string | null;
  readonly files: readonly CompareFile[];
  /** The host listed fewer files than changed. */
  readonly filesTruncated: boolean;
  /** The host's limits, as it applied them: the most files it lists and the largest patch it sends. */
  readonly limits: { readonly maxFiles: number; readonly maxPatchBytes: number };
};

/** A PR comment a reaction is for: one on the conversation, or one on a line. */
export type CommentRef = { readonly kind: "issue" | "review"; readonly commentId: string };

/** The reactions ostra makes: 👀, "seen" (F-053). */
export type Reaction = "eyes";

/** The App's OAuth client, for the verified link (F-119). Never logged. */
export type CodeHostOAuthClient = { readonly clientId: string; readonly clientSecret: string };

/** A member's account on the host, as the verified link reads it. */
export type LinkedUser = { readonly userId: string; readonly login: string };

/** A ref on the host, full, such as `refs/ostra/wip/<taskId>`. */
export type DeleteRefResult = {
  /** `false` when there was no such ref: deleting it again is not an error. */
  readonly deleted: boolean;
};

// ---------- milestone 4 (F-104, ADR 0040, ADR 0027): reviews, check runs ----------

/** A review's state, as the host reports it: `dismissed` is a review someone dismissed since. */
export const pullRequestReviewStates = ["approved", "changes_requested", "commented", "dismissed", "pending"] as const;
export type PullRequestReviewState = (typeof pullRequestReviewStates)[number];

/**
 * One review on a PR (`listReviews`, the `pull_request_review` webhook). Milestone 6 (F-105): its
 * body and its page, when the host gives them, for a "changes requested" prompt; the body is
 * untrusted text, never logged.
 */
export type PullRequestReview = {
  readonly reviewId: string;
  /** The reviewer's account on the host: what a member's linked account is matched by (F-119). */
  readonly userId: string;
  readonly login: string;
  /** A bot or an App, which never counts as an independent review (F-104). */
  readonly isBot: boolean;
  readonly state: PullRequestReviewState;
  /** The head commit it reviewed; `null` when the host doesn't say. */
  readonly commitId: string | null;
  /** In ms since the epoch; `null` for a pending review, which isn't submitted. */
  readonly submittedAt: number | null;
  /** Milestone 6 (F-105): the review's own words, `null` or missing when it has none. Untrusted: never logged. */
  readonly body?: string | null;
  /** Milestone 6 (F-105): the review's page on the host, when the host says. */
  readonly url?: string | null;
};

/**
 * A check run's state: in progress with no conclusion, or completed with one. ostra writes only
 * `success` and `action_required` (ADR 0040): a check that waits for a review is never a failure.
 */
export type CheckRunState =
  | { readonly status: "in_progress"; readonly conclusion: null }
  | { readonly status: "completed"; readonly conclusion: "success" | "action_required" };

/** What `publishCheckRun` and `updateCheckRun` write. The title and summary are ostra's words, sent as data. */
export type CheckRunInput = CheckRunState & {
  /** The check's name, as branch protection requires it. With `headSha`, its identity. */
  readonly name: string;
  readonly headSha: string;
  readonly title: string;
  readonly summary: string;
  /** ostra's own ID for it, such as the review check's row. */
  readonly externalId: string;
};

export type PublishedCheckRun = { readonly checkRunId: string };

// ---------- milestone 6 (spec section 5.2, ADR 0058): CI, comment-type reviews, reviewers ----------

/** A check run's status, as GitHub names them. */
export type CiCheckRunStatus = "queued" | "in_progress" | "completed" | "waiting" | "requested" | "pending";

/** A completed check run's conclusion, as GitHub names them. */
export type CiConclusion = "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | "stale" | "startup_failure";

/** A check run on a head, any app's: ostra's own are told apart by `appSlug`. */
export type CiCheckRun = {
  readonly id: string;
  readonly name: string;
  /** The app that made it (`github-actions`, ostra's own App's slug); `null` when the host doesn't say. */
  readonly appSlug: string | null;
  readonly status: CiCheckRunStatus;
  readonly conclusion: CiConclusion | null;
  readonly detailsUrl: string | null;
  /** In ms since the epoch. */
  readonly startedAt: number | null;
  readonly completedAt: number | null;
};

export type CiStatusState = "error" | "failure" | "pending" | "success";

/** A commit status (the older CI API), by its context. */
export type CiStatus = {
  readonly context: string;
  readonly state: CiStatusState;
  readonly targetUrl: string | null;
  /** The status's words. Untrusted text. */
  readonly description: string | null;
};

/** What `listCiResults` reads for a head. */
export type CiResults = { readonly checkRuns: readonly CiCheckRun[]; readonly statuses: readonly CiStatus[] };

/** Which log `getCiLog` reads: a check run's, or a status's words. */
export type CiLogRef = { readonly kind: "check-run"; readonly checkRunId: string } | { readonly kind: "status"; readonly headSha: string; readonly context: string };

/**
 * A log's tail: at most the caller's byte cap, from the end, cut on a character, with its size
 * before the cut. Its text is untrusted, never logged, and never in an error. Or no log, with why:
 * the host expired it, or the check has none.
 */
export type CiLog =
  | { readonly found: true; readonly text: string; readonly truncated: boolean; readonly totalBytes: number }
  | { readonly found: false; readonly reason: "expired" | "no-log" };

/** A side of a diff: the head's (`new`) or the base's (`old`). */
export type DiffSide = "new" | "old";

/** A line comment in a comment-type review. Its body is ostra's words around a finding: never logged. */
export type ReviewLineComment = {
  readonly path: string;
  readonly line: number;
  readonly side: DiffSide;
  readonly body: string;
};

/**
 * A comment-type review (ADR 0028, F-100). The event is `"COMMENT"` by its type: no caller can
 * approve or request changes through this interface, and an adapter refuses any other event.
 */
export type CommentReviewInput = {
  /** The head the review is of. */
  readonly commitId: string;
  readonly body: string;
  readonly event: "COMMENT";
  readonly comments: readonly ReviewLineComment[];
};

export type CreatedReview = { readonly reviewId: string; readonly url: string };

/**
 * Why `createReview` failed: the shared errors, or a line comment the host refused because its
 * line isn't in the diff (GitHub's 422), naming the comment, so core moves it into the body and
 * tries once more. Nothing was posted.
 */
export type CreateReviewError = AdapterError | { readonly code: "line-outside-diff"; readonly message: string; readonly commentIndex: number };

/** Lines from `start` to `end`, both included. */
export type LineRange = { readonly start: number; readonly end: number };

/** The lines a line comment may sit on in one file of a PR's diff, per side. */
export type DiffFileLines = { readonly path: string; readonly new: readonly LineRange[]; readonly old: readonly LineRange[] };

export type RequestedReviewers = {
  readonly users: readonly { readonly userId: string; readonly login: string }[];
  readonly teams: readonly { readonly slug: string }[];
};

/** A review's line comment, as `listReviewComments` reads it. Its body is untrusted, never logged. */
export type ReviewComment = {
  readonly id: string;
  readonly path: string;
  /** `null` for a comment on a whole file. */
  readonly line: number | null;
  readonly side: DiffSide;
  readonly body: string;
  readonly userId: string;
};

// ---------- milestone 8 (F-145, ADR 0069, ADR 0025 amended): a repo's files at a commit ----------

/**
 * An installation's access to the repos it covers (ADR 0040, ADR 0065). In its place, `null` reads
 * a public repo anonymously, under the host's anonymous rate limit. A `RepoAccess` is one too.
 */
export type InstallationAccess = { readonly app: CodeHostAppCredentials; readonly installationId: string };

/** A ref (a branch, a tag or a commit) as the commit it names now. */
export type ResolvedRef = { readonly commit: GitSha };

/**
 * The caps `readTree` applies while it reads: at most `maxFiles` files, and at most `maxBytes`
 * bytes of them in all. The library asks for a little over ostra's limits, so the domain's
 * `checkSkill` can name what passes them.
 */
export type TreeLimits = { readonly maxFiles: number; readonly maxBytes: number };

/** A file's mode as git keeps it: a regular file, or one with its executable bit. */
export type TreeFileMode = "regular" | "executable";

/** One file of a tree, its path repo-relative. Its bytes are the repo's content: never logged. */
export type TreeFile = {
  readonly path: string;
  readonly size: number;
  readonly mode: TreeFileMode;
  readonly bytes: Uint8Array;
};

/**
 * Why an entry under the folder isn't among the files:
 * - `symlink-outside`: a symlink whose target, or a hop to it, leaves the folder (or the repo), or
 *   loops back to a folder holding it: never followed;
 * - `symlink-dangling`: a symlink whose target isn't in the tree;
 * - `over-max-bytes`: a file bigger than the bytes the cap had left;
 * - `over-max-files`: the first file past `maxFiles`, after which reading stopped.
 */
export type TreeNoteReason = "symlink-outside" | "symlink-dangling" | "over-max-bytes" | "over-max-files";

export type TreeNote = { readonly path: string; readonly reason: TreeNoteReason };

/**
 * The files under a folder at a commit, in path order. `truncated` when a cap left a file out;
 * `notes` say what was left out and why, at most `TREE_NOTES_MAX` of them.
 */
export type RepoTree = {
  readonly files: readonly TreeFile[];
  readonly truncated: boolean;
  readonly notes: readonly TreeNote[];
};

/** Whether a line is inside one of the ranges. */
export const lineInRanges = (ranges: readonly LineRange[], line: number): boolean => ranges.some((range) => line >= range.start && line <= range.end);

/**
 * A log's tail of at most `maxBytes` UTF-8 bytes, from the end, cut forward to a whole character,
 * with the size before the cut. Shared, so every adapter cuts the same way.
 */
export const logTail = (text: string, maxBytes: number): { readonly text: string; readonly truncated: boolean; readonly totalBytes: number } => {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) {
    return { text, truncated: false, totalBytes: bytes.length };
  }
  let start = bytes.length - Math.max(0, maxBytes);
  // A UTF-8 continuation byte is 10xxxxxx: step past them to the next character's first byte.
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) {
    start += 1;
  }
  return { text: new TextDecoder().decode(bytes.subarray(start)), truncated: true, totalBytes: bytes.length };
};

export abstract class CodeHostAdapter {
  readonly kind = "code-host" as const;
  abstract readonly name: string;
  abstract readonly capabilities: CodeHostCapabilities;

  readonly #context: AdapterContext;
  #plumbing: Plumbing | undefined;

  constructor(context: AdapterContext = defaultAdapterContext) {
    this.#context = context;
  }

  /** Retries, rate budgets, idempotency and the logger, shared by every adapter (ADR 0025). */
  protected get plumbing(): Plumbing {
    this.#plumbing ??= createPlumbing(this.#context, { kind: this.kind, name: this.name });
    return this.#plumbing;
  }

  /** Whether the host answers. */
  abstract health(): Promise<HealthReport>;

  /** The manifest that creates the organization's App in one flow (F-006). */
  abstract appManifest(input: AppManifestInput): AppManifest;

  /** Trades the manifest flow's code for the new App's credentials. */
  abstract convertManifestCode(code: string): Promise<AdapterResult<CreatedApp>>;

  /** Reads an App, to check its credentials and show its permissions. */
  abstract readApp(app: CodeHostAppCredentials): Promise<AdapterResult<AppInfo>>;

  abstract listInstallations(app: CodeHostAppCredentials): Promise<AdapterResult<readonly Installation[]>>;

  abstract listRepos(app: CodeHostAppCredentials, installationId: string): Promise<AdapterResult<readonly HostRepo[]>>;

  /** A token for this one repo with these permissions only (ADR 0030). */
  abstract mintRepoToken(
    access: RepoAccess,
    permissions: Readonly<Partial<Record<RepoPermission, PermissionLevel>>>,
  ): Promise<AdapterResult<RepoToken>>;

  /** Reads files at a ref, for environment detection (F-112). Missing paths are listed, not errors. */
  abstract readFiles(access: RepoAccess, ref: string, paths: readonly string[]): Promise<AdapterResult<ReadFilesResult>>;

  /**
   * Every file path in the repo at a ref, for environment detection (F-112, ticket 32). Additive
   * to the first contract: a host that can't list answers `unsupported`, and detection then reads
   * only the well-known paths.
   */
  listTree(access: RepoAccess, ref: string): Promise<AdapterResult<readonly string[]>> {
    this.plumbing.logger.debug('listTree is not supported', { repo: access.repo, ref });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't list a repo's files`));
  }

  abstract getDefaultBranch(access: RepoAccess): Promise<AdapterResult<string>>;

  /** The repo's PR template, or `null` when it has none (F-078). */
  abstract getPullRequestTemplate(access: RepoAccess, ref: string): Promise<AdapterResult<string | null>>;

  /** The App's bot identity, which authors every commit (F-078, ADR 0040). */
  abstract getBotIdentity(app: CodeHostAppCredentials): Promise<AdapterResult<GitPerson>>;

  /** The PR whose head is `head`, or `null`: opening a PR is checked against this first. */
  abstract findPullRequest(access: RepoAccess, head: string): Promise<AdapterResult<PullRequest | null>>;

  /** Opens a PR as the App. Opening one that exists answers `conflict`. */
  abstract openPullRequest(input: OpenPullRequestInput): Promise<AdapterResult<PullRequest>>;

  /**
   * Replaces a PR's body, as the App: a task's first PRs link the ones opened after them (F-030).
   * Additive to the first contract: a host that can't answers `unsupported`, and a PR then links
   * only the task's PRs opened before it.
   */
  updatePullRequestBody(input: UpdatePullRequestBodyInput): Promise<AdapterResult<PullRequest>> {
    this.plumbing.logger.debug("updatePullRequestBody is not supported", { repo: input.access.repo, prNumber: input.number });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't change a PR's body`));
  }

  /** Checks a webhook's signature. */
  abstract verifyWebhook(input: WebhookInput): boolean;

  // ---------- milestone 2: additive, so each answers `unsupported` until an adapter has it ----------

  /**
   * A branch's protection and its signed-commit rule (F-055, F-060), from classic protection and
   * rulesets both. A private repo on a free plan, which the host won't answer for, reads as `unknown`
   * with the reason. Needs the capability `branchRules`.
   */
  readBranchRules(access: RepoAccess, branch: string): Promise<AdapterResult<BranchRules>> {
    this.plumbing.logger.debug("readBranchRules is not supported", { repo: access.repo, branch });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't read branch rules`));
  }

  /** One PR by number, with its merge state and head (the reconcile, F-044). */
  getPullRequest(access: RepoAccess, number: number): Promise<AdapterResult<PullRequestDetails>> {
    this.plumbing.logger.debug("getPullRequest is not supported", { repo: access.repo, number });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't read a PR by number`));
  }

  /**
   * Reads a webhook `verifyWebhook` accepted into an event. The event's name is the host's header
   * (GitHub's `X-GitHub-Event`); a body that doesn't read is `invalid-response`.
   */
  parseWebhook(input: WebhookInput): AdapterResult<CodeHostWebhookEvent> {
    this.plumbing.logger.debug("parseWebhook is not supported", { bytes: input.body.length });
    return adapterError("unsupported", `${this.name} can't read webhooks yet`);
  }

  /** Deletes a ref, such as a task's hidden ref after its last PR closed (F-079). */
  deleteRef(access: RepoAccess, ref: string): Promise<AdapterResult<DeleteRefResult>> {
    this.plumbing.logger.debug("deleteRef is not supported", { repo: access.repo, refLength: ref.length });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't delete refs`));
  }

  // ---------- milestone 3: additive, so each answers `unsupported` until an adapter has it ----------

  /**
   * The files and counts between `base` and `head` (F-027, F-070, ADR 0051), with the host's limits
   * reported (`CompareResult`). Needs the capability `compare`.
   */
  compare(access: RepoAccess, base: string, head: string): Promise<AdapterResult<CompareResult>> {
    this.plumbing.logger.debug("compare is not supported", { repo: access.repo, baseLength: base.length, headLength: head.length });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't compare branches`));
  }

  /** Makes a PR a draft, or ready for review (F-054, ADR 0052). Needs `draftPullRequests`. */
  setPullRequestDraft(access: RepoAccess, number: number, draft: boolean): Promise<AdapterResult<PullRequest>> {
    this.plumbing.logger.debug("setPullRequestDraft is not supported", { repo: access.repo, number, draft });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't make a PR a draft`));
  }

  /**
   * Reacts to a PR comment, as the App (F-053): idempotent by the comment, so reacting again makes
   * no second reaction (`created: false`). Needs `prComments`.
   */
  addReaction(access: RepoAccess, comment: CommentRef, reaction: Reaction): Promise<AdapterResult<{ readonly created: boolean }>> {
    this.plumbing.logger.debug("addReaction is not supported", { repo: access.repo, kind: comment.kind, reaction });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't react to a comment`));
  }

  /** Where a member signs in to the host to link their account (F-119). Needs `userLink`. */
  userAuthorizeUrl(client: CodeHostOAuthClient, state: string, redirectUri: string): AdapterResult<string> {
    this.plumbing.logger.debug("userAuthorizeUrl is not supported", { stateLength: state.length, redirectLength: redirectUri.length, clientLength: client.clientId.length });
    return adapterError("unsupported", `${this.name} can't link a member's account`);
  }

  /**
   * Trades the sign-in's code for the member's account, and revokes the token it got before it
   * returns: ostra keeps the verified ID and login, never a token (F-119, ADR 0052). A revocation
   * that fails is an error, never a silent success. Needs `userLink`.
   */
  exchangeUserCode(client: CodeHostOAuthClient, code: string, redirectUri: string): Promise<AdapterResult<LinkedUser>> {
    this.plumbing.logger.debug("exchangeUserCode is not supported", { codeLength: code.length, redirectLength: redirectUri.length, clientLength: client.clientId.length });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't link a member's account`));
  }

  // ---------- milestone 4: additive, so each answers `unsupported` until an adapter has it ----------

  /**
   * A PR's reviews, oldest first, dismissed ones included (F-104, ADR 0040). Needs the capability
   * `reviews`.
   */
  listReviews(access: RepoAccess, number: number): Promise<AdapterResult<readonly PullRequestReview[]>> {
    this.plumbing.logger.debug("listReviews is not supported", { repo: access.repo, number });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't list a PR's reviews`));
  }

  /**
   * Publishes a check run on a head, as the App, idempotent by `(headSha, name)`: a second publish
   * for the same head and name answers the run that exists, and makes no second one (ADR 0040).
   * Needs the capability `checkRuns`.
   */
  publishCheckRun(access: RepoAccess, input: CheckRunInput): Promise<AdapterResult<PublishedCheckRun>> {
    this.plumbing.logger.debug("publishCheckRun is not supported", { repo: access.repo, nameLength: input.name.length });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't publish a check run`));
  }

  /** Changes a published check run's status, conclusion and words. Needs the capability `checkRuns`. */
  updateCheckRun(access: RepoAccess, checkRunId: string, input: CheckRunInput): Promise<AdapterResult<void>> {
    this.plumbing.logger.debug("updateCheckRun is not supported", { repo: access.repo, idLength: checkRunId.length, status: input.status });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't update a check run`));
  }

  /**
   * Uninstalls the App from an installation's account, as the App (F-136, ADR 0065). An unknown
   * installation is `not-found`. Needs the capability `installableByOtherAccounts`.
   */
  removeInstallation(app: CodeHostAppCredentials, installationId: string): Promise<AdapterResult<void>> {
    this.plumbing.logger.debug("removeInstallation is not supported", { appId: app.appId, installationId });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't remove an installation`));
  }

  // ---------- milestone 6: additive, so each answers `unsupported` until an adapter has it ----------

  /** A head's check runs, every app's, and its commit statuses (F-035). Needs `ciResults`. */
  listCiResults(access: RepoAccess, headSha: string): Promise<AdapterResult<CiResults>> {
    this.plumbing.logger.debug("listCiResults is not supported", { repo: access.repo, headSha });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't read CI results`));
  }

  /**
   * The tail of a check run's log (an Actions job's log; another app's summary and text) or a
   * status's words, at most `maxBytes` (F-035). Needs `ciLogs`.
   */
  getCiLog(access: RepoAccess, ref: CiLogRef, maxBytes: number): Promise<AdapterResult<CiLog>> {
    this.plumbing.logger.debug("getCiLog is not supported", { repo: access.repo, kind: ref.kind, maxBytes });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't read a CI log`));
  }

  /** Posts a comment-type review with line comments (F-100, ADR 0028). Needs `reviewComments`. */
  createReview(access: RepoAccess, number: number, review: CommentReviewInput): Promise<Result<CreatedReview, CreateReviewError>> {
    this.plumbing.logger.debug("createReview is not supported", { repo: access.repo, number, comments: review.comments.length });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't post a review`));
  }

  /** The lines of a PR's diff a line comment may sit on, per file and side. Needs `reviewComments`. */
  diffLines(access: RepoAccess, number: number): Promise<AdapterResult<readonly DiffFileLines[]>> {
    this.plumbing.logger.debug("diffLines is not supported", { repo: access.repo, number });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't read a diff's lines`));
  }

  /** A review's line comments (F-105). Needs `reviewComments`. */
  listReviewComments(access: RepoAccess, number: number, reviewId: string): Promise<AdapterResult<readonly ReviewComment[]>> {
    this.plumbing.logger.debug("listReviewComments is not supported", { repo: access.repo, number, reviewId });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't read a review's comments`));
  }

  /** A PR's requested reviewers, people and teams (F-102). Needs `requestedReviewers`. */
  listRequestedReviewers(access: RepoAccess, number: number): Promise<AdapterResult<RequestedReviewers>> {
    this.plumbing.logger.debug("listRequestedReviewers is not supported", { repo: access.repo, number });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't read requested reviewers`));
  }

  /** The repo's `CODEOWNERS` text at a ref, from where the host looks first, or `null` (F-102). Needs `codeOwners`. */
  readCodeOwners(access: RepoAccess, ref: string): Promise<AdapterResult<string | null>> {
    this.plumbing.logger.debug("readCodeOwners is not supported", { repo: access.repo, refLength: ref.length });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't read CODEOWNERS`));
  }

  // ---------- milestone 8: additive, so each answers `unsupported` until an adapter has it ----------

  /**
   * The commit a branch, a tag or a commit names now, or `null` when the repo has no such ref
   * (F-145, ADR 0069). `access` is an installation's, for a repo it covers, or `null` to read a
   * public repo anonymously; a repo that isn't public, read anonymously, is `not-found`, as a repo
   * that doesn't exist is. Needs the capability `readTree`.
   */
  resolveRef(access: InstallationAccess | null, repo: RepoFullName, ref: string): Promise<AdapterResult<ResolvedRef | null>> {
    this.plumbing.logger.debug("resolveRef is not supported", { repo, anonymous: access === null, refLength: ref.length });
    return Promise.resolve(adapterError("unsupported", readTreeRefusalOf(this.name)));
  }

  /**
   * The files under `path` (repo-relative; `""` for the whole repo) at a commit, a full SHA and
   * never a branch, so what's read is what was pinned (F-145, ADR 0069). Paths are repo-relative
   * and inside `path`. A symlink is followed only when its target stays inside `path`, else it's
   * left out with a note. The caps are applied while reading (`createTreeCollector`, shared by
   * every adapter). Needs the capability `readTree`.
   */
  readTree(access: InstallationAccess | null, repo: RepoFullName, commit: GitSha, path: string, limits: TreeLimits): Promise<AdapterResult<RepoTree>> {
    this.plumbing.logger.debug("readTree is not supported", { repo, anonymous: access === null, commitLength: commit.length, pathLength: path.length, maxFiles: limits.maxFiles });
    return Promise.resolve(adapterError("unsupported", readTreeRefusalOf(this.name)));
  }
}

const readTreeRefusalOf = (name: string): string => `${name} can't read a repo's files at a commit, so ostra can't install a skill from it`;

/**
 * The capability check before a library install reads a repo through a host (F-145, ADR 0069):
 * the words the install's refusal shows when the host lacks `readTree`, or `null` when it has it.
 */
export const readTreeRefusal = (host: Pick<CodeHostAdapter, "name" | "capabilities">): string | null =>
  host.capabilities.readTree ? null : readTreeRefusalOf(host.name);
