import { spawn } from "node:child_process";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { repoFullNameSchema, segmentIdSchema } from "@ostra/protocol";
import { z } from "zod";
import type { BoxState, GitPerson, OrganizationId, RepoFullName, StopReason, TaskEvent } from "@ostra/protocol";

import { AgentAdapter } from "../agent/base.ts";
import type {
  AcpUpdate,
  AgentLaunch,
  DriverConnection,
  DriverHandlers,
  DriverPort,
  MapContext,
  MappedUpdate,
  PrepareLaunchInput,
} from "../agent/base.ts";
import type { AgentCapabilities } from "../agent/capabilities.ts";
import { BlobStoreAdapter } from "../blob-store/base.ts";
import type { StoredBlob, UploadSession } from "../blob-store/base.ts";
import { CodeHostAdapter } from "../code-host/base.ts";
import type {
  AppInfo,
  AppManifest,
  AppManifestInput,
  BranchRules,
  CodeHostAppCredentials,
  CodeHostOAuthClient,
  CheckRunInput,
  CodeHostWebhookEvent,
  CommentRef,
  CompareFile,
  CompareResult,
  CreatedApp,
  DeleteRefResult,
  LinkedUser,
  PublishedCheckRun,
  PullRequestComment,
  PullRequestReview,
  Reaction,
  HostRepo,
  Installation,
  InstallationAccount,
  InstallationRepo,
  OpenPullRequestInput,
  PullRequest,
  PullRequestDetails,
  ReadFilesResult,
  RepoAccess,
  RepoToken,
  UpdatePullRequestBodyInput,
  WebhookInput,
} from "../code-host/base.ts";
import { pullRequestReviewStates } from "../code-host/base.ts";
import { FakeReviewsAndChecks } from "../testing/fake-reviews-and-checks.ts";
import type { FakeMergeOutcome } from "../testing/fake-reviews-and-checks.ts";
import type { CodeHostCapabilities } from "../code-host/capabilities.ts";
import { adapterError, ok } from "../common/result.ts";
import type { AdapterResult, HealthReport } from "../common/result.ts";
import type { AdapterContext } from "../common/context.ts";
import { ExecutorAdapter } from "../executor/base.ts";
import type {
  AgentProcess,
  BoxRef,
  BoxSize,
  CreateBoxInput,
  CreatedBox,
  ExecutorCapacity,
  PrepareInput,
  PrepareResult,
  RepoPushResult,
  StopInput,
} from "../executor/base.ts";
import type { ExecutorCapabilities } from "../executor/capabilities.ts";
import { writeTaskTokenFile } from "../executor/task-token.ts";
import { runChecksWith } from "../executor/checks.ts";
import type { CheckRunResult, RunChecksInput } from "../executor/checks.ts";
import { ModelProviderAdapter } from "../model-provider/base.ts";
import type { CatalogEntry, CatalogMatch, ConnectionTest, EndpointModel, ModelEndpoint } from "../model-provider/base.ts";
import type { ModelProviderCapabilities } from "../model-provider/capabilities.ts";
import { emailRecipients, NotificationAdapter, refuseAccountMail } from "../notification/base.ts";
import type { Notification, SendResult } from "../notification/base.ts";
import type { SecretRowStore } from "../plumbing/stores.ts";
import { SecretStoreAdapter, secretRefSchema } from "../secret-store/base.ts";
import type { SecretRef, SecretScope } from "../secret-store/base.ts";
import type { StubEndpoint } from "../testing/model-provider-suite.ts";
import { TrackerAdapter } from "../tracker/base.ts";
import type {
  BoardRef,
  CodeHostIntegration,
  DownloadedFile,
  MoveResult,
  Ticket,
  TicketContext,
  TicketPage,
  TrackerBoard,
  TrackerStatus,
  TrackerUser,
  TrackerWebhookHint,
  WebhookVerification,
} from "../tracker/base.ts";

// Tiny adapters of every kind, for this package's own tests: each runs its kind's contract suite,
// so the suites are known to pass against a correct adapter. None of these is shipped.

const unsupported = (what: string) => Promise.resolve(adapterError("unsupported", `${what}: not in this test adapter`));

// ---------- tracker, notification, blob store: the first cases only ----------

// The tracker's full suite runs against the Jira fake (`testing/jira-fake.ts`), a full in-memory
// tracker; this one answers `unsupported` and runs the first cases.
export class TinyTracker extends TrackerAdapter {
  readonly name: string = "tiny-tracker";
  readonly capabilities = {
    agentSessions: false,
    subIssues: true,
    statusGraph: true,
    webhooks: false,
    commentEdit: false,
    attachments: false,
    transitions: false,
    mentions: true,
  };
  /** Milestone 3: the board's users, by email, for `findUsersByEmail`. */
  readonly users: { readonly email: string; readonly userId: string }[] = [];

  override findUsersByEmail(_board: BoardRef, emails: readonly string[]): Promise<AdapterResult<readonly TrackerUser[]>> {
    const wanted = new Set(emails.map((email) => email.toLowerCase()));
    return Promise.resolve(
      ok(this.users.filter((user) => wanted.has(user.email.toLowerCase())).map((user) => ({ ...user, mention: `@${user.userId}` }))),
    );
  }
  health(): Promise<HealthReport> {
    return Promise.resolve({ status: "ok" });
  }
  getTicket(): Promise<AdapterResult<Ticket>> {
    return unsupported("getTicket");
  }
  listTickets(): Promise<AdapterResult<TicketPage>> {
    return unsupported("listTickets");
  }
  updateStatus(): Promise<AdapterResult<void>> {
    return unsupported("updateStatus");
  }
  comment(): Promise<AdapterResult<{ readonly commentId: string }>> {
    return unsupported("comment");
  }
  linkPullRequest(): Promise<AdapterResult<void>> {
    return unsupported("linkPullRequest");
  }
  listBoards(): Promise<AdapterResult<readonly TrackerBoard[]>> {
    return unsupported("listBoards");
  }
  listStatuses(): Promise<AdapterResult<readonly TrackerStatus[]>> {
    return unsupported("listStatuses");
  }
  getTicketContext(): Promise<AdapterResult<TicketContext>> {
    return unsupported("getTicketContext");
  }
  moveTicket(): Promise<AdapterResult<MoveResult>> {
    return unsupported("moveTicket");
  }
  updateComment(): Promise<AdapterResult<void>> {
    return unsupported("updateComment");
  }
  linkTask(): Promise<AdapterResult<{ readonly attachmentId: string }>> {
    return unsupported("linkTask");
  }
  createTicket(): Promise<AdapterResult<Ticket>> {
    return unsupported("createTicket");
  }
  detectCodeHostIntegration(): Promise<AdapterResult<CodeHostIntegration>> {
    return unsupported("detectCodeHostIntegration");
  }
  downloadFile(): Promise<AdapterResult<DownloadedFile>> {
    return unsupported("downloadFile");
  }
  verifyWebhook(): WebhookVerification {
    return { ok: false, reason: "bad-signature" };
  }
  parseWebhook(): AdapterResult<TrackerWebhookHint> {
    return adapterError("unsupported", "parseWebhook: not in this test adapter");
  }
}

/** What the tiny notifier delivered, by its provider ID: what a channel's own inbox would hold. */
export type TinyDelivery = {
  readonly providerMessageId: string;
  readonly to: readonly string[];
  readonly subject: string;
  html: string | null;
  text: string;
  edits: number;
};

/**
 * A notifier with no provider (milestone 3, ticket 04), for the notification suite: `panel` keeps a
 * row per recipient and edits it in place; `email` needs the rendered parts and an address, and
 * can't edit. Each sends once per idempotency key, refuses a recipient it can't reach without
 * failing the others, and can be made to answer a rate limit.
 */
export class TinyNotifier extends NotificationAdapter {
  readonly name: string;
  readonly capabilities: { readonly channels: readonly string[]; readonly edits: boolean };
  readonly sent: Notification[] = [];
  readonly delivered: TinyDelivery[] = [];
  readonly #byKey = new Map<string, SendResult>();
  readonly #channel: "panel" | "email";
  #rateLimitMs: number | null = null;

  constructor(channel: "panel" | "email" = "panel", context?: AdapterContext) {
    super(context);
    this.#channel = channel;
    this.name = `tiny-notifier-${channel}`;
    this.capabilities = { channels: [channel], edits: channel === "panel" };
  }

  /** The next send answers a rate limit, with this long to wait. */
  rateLimitNext(retryAfterMs: number): void {
    this.#rateLimitMs = retryAfterMs;
  }

  health(): Promise<HealthReport> {
    return Promise.resolve({ status: "ok" });
  }

  send(notification: Notification): Promise<AdapterResult<SendResult>> {
    const known = this.#byKey.get(notification.idempotencyKey);
    if (known !== undefined) {
      return Promise.resolve(ok(known));
    }
    if (this.#rateLimitMs !== null) {
      const retryAfterMs = this.#rateLimitMs;
      this.#rateLimitMs = null;
      return Promise.resolve(adapterError("rate-limited", "the channel's rate limit", retryAfterMs));
    }
    if (this.#channel === "email" && notification.rendered === null) {
      return Promise.resolve(adapterError("invalid-input", "an email needs its rendered parts"));
    }
    if (this.#channel === "panel" && notification.category === "account") {
      return Promise.resolve(refuseAccountMail("panel"));
    }
    const recipients = emailRecipients(notification);
    // Milestone 4: an address without an @ is refused, as a real provider refuses it.
    const reachable = recipients.filter((recipient) => this.#channel === "panel" || (recipient.email?.includes("@") ?? false));
    const refused = recipients
      .filter((recipient) => !reachable.includes(recipient))
      .map((recipient) => ({ memberId: recipient.memberId, reason: "the member has no email address" }));
    this.sent.push(notification);
    this.plumbing.logger.info("tiny_notifier.sent", { kind: notification.kind, recipients: reachable.length, refused: refused.length });
    const providerMessageId = reachable.length === 0 ? null : `tiny-${randomUUID()}`;
    if (providerMessageId !== null) {
      this.delivered.push({
        providerMessageId,
        to: reachable.map((recipient) => (this.#channel === "panel" ? String(recipient.memberId) : (recipient.email ?? ""))),
        subject: notification.rendered?.subject ?? notification.title,
        html: notification.rendered?.html ?? null,
        text: notification.rendered?.text ?? notification.body,
        edits: 0,
      });
    }
    const result: SendResult = { providerMessageId, refused };
    this.#byKey.set(notification.idempotencyKey, result);
    return Promise.resolve(ok(result));
  }

  override update(notification: Notification, providerMessageId: string): Promise<AdapterResult<void>> {
    if (!this.capabilities.edits) {
      return super.update(notification, providerMessageId);
    }
    const delivery = this.delivered.find((candidate) => candidate.providerMessageId === providerMessageId);
    if (delivery === undefined) {
      return Promise.resolve(adapterError("not-found", "no such notification"));
    }
    delivery.text = notification.body;
    delivery.edits += 1;
    return Promise.resolve(ok(undefined));
  }
}

export class TinyBlobStore extends BlobStoreAdapter {
  readonly name = "tiny-blob-store";
  readonly capabilities = { resumableUpload: false };
  health(): Promise<HealthReport> {
    return Promise.resolve({ status: "ok" });
  }
  put(): Promise<AdapterResult<StoredBlob>> {
    return unsupported("put");
  }
  get(): Promise<AdapterResult<Uint8Array>> {
    return unsupported("get");
  }
  delete(): Promise<AdapterResult<void>> {
    return unsupported("delete");
  }
  startUpload(): Promise<AdapterResult<UploadSession>> {
    return unsupported("startUpload");
  }
  appendUpload(): Promise<AdapterResult<UploadSession>> {
    return unsupported("appendUpload");
  }
  finishUpload(): Promise<AdapterResult<StoredBlob>> {
    return unsupported("finishUpload");
  }
}

// ---------- code host: an in-memory host ----------

export type MemoryRepo = {
  readonly hostRepoId: string;
  readonly fullName: RepoFullName;
  readonly defaultBranch: string;
  readonly files: Readonly<Record<string, string>>;
  readonly branches: readonly string[];
  /** Milestone 2: each branch's rules; a branch not listed is unprotected and unsigned. */
  readonly rules?: Readonly<Record<string, BranchRules>>;
  /** Milestone 2: refs outside the branches, such as hidden refs, which `deleteRef` removes. */
  readonly refs?: readonly string[];
  /**
   * Milestone 3: what `compare` answers, by `"<base>...<head>"`, before the host's limits are
   * applied. A pair not listed is `not-found`.
   */
  readonly compares?: Readonly<Record<string, MemoryCompare>>;
};

/** A compare as the memory host keeps it: every file, whole. */
export type MemoryCompare = {
  readonly aheadBy: number;
  readonly behindBy: number;
  readonly mergeBase: string | null;
  readonly files: readonly Omit<CompareFile, "truncated">[];
};

export type MemoryHostWorld = {
  readonly app: CodeHostAppCredentials & { readonly slug: string; readonly name: string };
  readonly installationId: string;
  readonly repos: readonly MemoryRepo[];
  /** Milestone 3: the host's limits on a compare (GitHub's: 300 files, about 1 MiB a patch). */
  readonly compareLimits?: { readonly maxFiles: number; readonly maxPatchBytes: number };
  /** Milestone 3: the App's OAuth client, and the accounts a sign-in's code stands for (F-119). */
  readonly oauth?: {
    readonly client: CodeHostOAuthClient;
    readonly users: readonly { readonly code: string; readonly user: LinkedUser }[];
  };
  /** Milestone 4 (F-136): installations on other accounts than the owner's, such as a stranger's. */
  readonly otherInstallations?: readonly Installation[];
};

/** The tiny host's own installation's account: the App's owner (F-136). */
const TINY_OWNER = { login: "test-org", accountId: "5001" } as const;

/** The memory host's limits when the world names none: GitHub's. */
const DEFAULT_COMPARE_LIMITS = { maxFiles: 300, maxPatchBytes: 1024 * 1024 } as const;

const TEMPLATE_PATHS = [".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md", "pull_request_template.md"];

/** A PR the tiny host keeps. */
type TinyPullRequest = PullRequest & {
  readonly repo: RepoFullName;
  updatedAt: number;
  mergedAt: number | null;
  closedAt: number | null;
  draft: boolean;
  /** Milestone 4: its head and its description. */
  headSha: string;
  body: string;
};

export class TinyCodeHost extends CodeHostAdapter {
  readonly name = "tiny-code-host";
  readonly capabilities: CodeHostCapabilities = {
    checkRuns: true,
    prTemplates: true,
    lfsActionHosts: [],
    branchRules: true,
    compare: true,
    draftPullRequests: true,
    prComments: true,
    userLink: true,
    reviews: true,
    installableByOtherAccounts: true,
  };
  /** Milestone 4, for tests: the PRs' reviews, the check runs and branch protection. */
  readonly reviewsAndChecks = new FakeReviewsAndChecks();
  readonly #world: MemoryHostWorld;
  readonly #prs: TinyPullRequest[] = [];
  readonly #refs = new Map<string, Set<string>>();
  readonly #reactions = new Set<string>();
  /** Milestone 4 (F-136): installations the App was removed from. */
  readonly #removedInstallations = new Set<string>();
  /** Milestone 4, for tests: how many times `removeInstallation` reached the host. */
  installationRemovals = 0;
  /** Milestone 3, for tests: the user tokens a sign-in got, and how many were revoked (F-119). */
  readonly userTokens = { issued: 0, revoked: 0 };
  /** Milestone 3, for tests: the next revocation fails, as a host that's down would. */
  failNextRevocation = false;

  /** How many reactions the App made, on any comment: for tests. */
  get reactionCount(): number {
    return this.#reactions.size;
  }

  constructor(world: MemoryHostWorld) {
    super();
    this.#world = world;
    for (const repo of world.repos) {
      this.#refs.set(repo.fullName, new Set(repo.refs ?? []));
    }
  }

  /** Merges or closes a PR, as a person does on the host: for tests. */
  finishPullRequest(repo: RepoFullName, number: number, how: "merged" | "closed"): void {
    const pr = this.#prs.find((candidate) => candidate.repo === repo && candidate.number === number);
    if (pr === undefined) throw new Error("no such PR");
    const index = this.#prs.indexOf(pr);
    const now = Date.now();
    this.#prs[index] = { ...pr, state: how, updatedAt: now, mergedAt: how === "merged" ? now : null, closedAt: now };
  }

  #authorized(app: CodeHostAppCredentials): boolean {
    return app.appId === this.#world.app.appId && app.privateKey === this.#world.app.privateKey;
  }

  #repo(access: RepoAccess): AdapterResult<MemoryRepo> {
    if (!this.#authorized(access.app)) {
      return adapterError("unauthorized", "the App's credentials were refused");
    }
    const repo = this.#world.repos.find((candidate) => candidate.fullName === access.repo);
    return repo !== undefined && access.installationId === this.#world.installationId && !this.#removedInstallations.has(access.installationId)
      ? ok(repo)
      : adapterError("not-found", "no such repo in the installation");
  }

  health(): Promise<HealthReport> {
    return Promise.resolve({ status: "ok" });
  }

  appManifest(input: AppManifestInput): AppManifest {
    const isPublic = input.public === true;
    return {
      manifest: {
        name: input.name,
        // A public App's page is the project's, not the install's address (F-136).
        url: isPublic ? "https://code-host.invalid/ostra" : input.homepageUrl,
        public: isPublic,
        hook_attributes: { url: input.webhookUrl },
        redirect_url: input.redirectUrl,
        default_permissions: { contents: "write", pull_requests: "write", checks: "write", actions: "read" },
      },
      createUrl: "https://code-host.invalid/settings/apps/new",
    };
  }

  convertManifestCode(): Promise<AdapterResult<CreatedApp>> {
    return unsupported("convertManifestCode");
  }

  readApp(app: CodeHostAppCredentials): Promise<AdapterResult<AppInfo>> {
    if (!this.#authorized(app)) {
      return Promise.resolve(adapterError("unauthorized", "the App's credentials were refused"));
    }
    return Promise.resolve(
      ok({
        appId: this.#world.app.appId,
        slug: this.#world.app.slug,
        name: this.#world.app.name,
        permissions: { contents: "write", pull_requests: "write", checks: "write", actions: "read" },
        events: ["pull_request"],
        owner: { ...TINY_OWNER },
      }),
    );
  }

  listInstallations(app: CodeHostAppCredentials): Promise<AdapterResult<readonly Installation[]>> {
    if (!this.#authorized(app)) {
      return Promise.resolve(adapterError("unauthorized", "the App's credentials were refused"));
    }
    const all: Installation[] = [
      {
        installationId: this.#world.installationId,
        accountLogin: TINY_OWNER.login,
        accountId: TINY_OWNER.accountId,
        accountKind: "organization",
        repositorySelection: "selected",
      },
      ...(this.#world.otherInstallations ?? []),
    ];
    return Promise.resolve(ok(all.filter((installation) => !this.#removedInstallations.has(installation.installationId))));
  }

  override removeInstallation(app: CodeHostAppCredentials, installationId: string): Promise<AdapterResult<void>> {
    if (!this.#authorized(app)) {
      return Promise.resolve(adapterError("unauthorized", "the App's credentials were refused"));
    }
    this.installationRemovals += 1;
    const known = installationId === this.#world.installationId || (this.#world.otherInstallations ?? []).some((item) => item.installationId === installationId);
    if (!known || this.#removedInstallations.has(installationId)) {
      return Promise.resolve(adapterError("not-found", "no such installation"));
    }
    this.#removedInstallations.add(installationId);
    return Promise.resolve(ok(undefined));
  }

  listRepos(app: CodeHostAppCredentials, installationId: string): Promise<AdapterResult<readonly HostRepo[]>> {
    if (!this.#authorized(app) || installationId !== this.#world.installationId || this.#removedInstallations.has(installationId)) {
      return Promise.resolve(adapterError("unauthorized", "the App's credentials were refused"));
    }
    return Promise.resolve(
      ok(
        this.#world.repos.map((repo) => ({
          hostRepoId: repo.hostRepoId,
          fullName: repo.fullName,
          defaultBranch: repo.defaultBranch,
          private: true,
          cloneUrl: `https://code-host.invalid/${repo.fullName}.git`,
        })),
      ),
    );
  }

  mintRepoToken(access: RepoAccess): Promise<AdapterResult<RepoToken>> {
    const repo = this.#repo(access);
    return Promise.resolve(
      repo.ok ? ok({ token: `tiny-token-${randomUUID()}`, expiresAt: Date.now() + 3_600_000 }) : repo,
    );
  }

  readFiles(access: RepoAccess, _ref: string, paths: readonly string[]): Promise<AdapterResult<ReadFilesResult>> {
    const repo = this.#repo(access);
    if (!repo.ok) {
      return Promise.resolve(repo);
    }
    const files = paths.flatMap((file) => {
      const content = repo.value.files[file];
      return content === undefined ? [] : [{ path: file, content }];
    });
    const missing = paths.filter((file) => repo.value.files[file] === undefined);
    return Promise.resolve(ok({ files, missing }));
  }

  getDefaultBranch(access: RepoAccess): Promise<AdapterResult<string>> {
    const repo = this.#repo(access);
    return Promise.resolve(repo.ok ? ok(repo.value.defaultBranch) : repo);
  }

  getPullRequestTemplate(access: RepoAccess): Promise<AdapterResult<string | null>> {
    const repo = this.#repo(access);
    if (!repo.ok) {
      return Promise.resolve(repo);
    }
    const found = TEMPLATE_PATHS.map((file) => repo.value.files[file]).find((content) => content !== undefined);
    return Promise.resolve(ok(found ?? null));
  }

  getBotIdentity(app: CodeHostAppCredentials): Promise<AdapterResult<GitPerson>> {
    if (!this.#authorized(app)) {
      return Promise.resolve(adapterError("unauthorized", "the App's credentials were refused"));
    }
    const name = `${this.#world.app.slug}[bot]`;
    return Promise.resolve(ok({ name, email: `${this.#world.app.appId}+${name}@users.noreply.code-host.invalid` }));
  }

  findPullRequest(access: RepoAccess, head: string): Promise<AdapterResult<PullRequest | null>> {
    const repo = this.#repo(access);
    if (!repo.ok) {
      return Promise.resolve(repo);
    }
    const found = this.#prs.find((pr) => pr.repo === access.repo && pr.headBranch === head);
    return Promise.resolve(ok(found === undefined ? null : withoutRepo(found)));
  }

  openPullRequest(input: OpenPullRequestInput): Promise<AdapterResult<PullRequest>> {
    const repo = this.#repo(input.access);
    if (!repo.ok) {
      return Promise.resolve(repo);
    }
    if (!repo.value.branches.includes(input.head)) {
      return Promise.resolve(adapterError("invalid-input", "the head branch does not exist"));
    }
    if (this.#prs.some((pr) => pr.repo === input.access.repo && pr.headBranch === input.head && pr.state === "open")) {
      return Promise.resolve(adapterError("conflict", "a PR from this branch is open"));
    }
    const number = this.#prs.length + 1;
    const pr: TinyPullRequest = {
      repo: input.access.repo,
      number,
      url: `https://code-host.invalid/${input.access.repo}/pull/${String(number)}`,
      state: "open" as const,
      headBranch: input.head,
      baseBranch: input.base,
      title: input.title,
      updatedAt: Date.now(),
      mergedAt: null,
      closedAt: null,
      draft: input.draft,
      headSha: "0".repeat(40),
      body: input.body,
    };
    this.#prs.push(pr);
    return Promise.resolve(ok(withoutRepo(pr)));
  }

  verifyWebhook(input: WebhookInput): boolean {
    const header = input.headers["x-hub-signature-256"];
    if (header === undefined) {
      return false;
    }
    const expected = Buffer.from(`sha256=${createHmac("sha256", input.secret).update(input.body).digest("hex")}`);
    const given = Buffer.from(header);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  override readBranchRules(access: RepoAccess, branch: string): Promise<AdapterResult<BranchRules>> {
    const repo = this.#repo(access);
    if (!repo.ok) {
      return Promise.resolve(repo);
    }
    return Promise.resolve(ok(repo.value.rules?.[branch] ?? { protected: false, requiresSignedCommits: false, reasons: [] }));
  }

  override getPullRequest(access: RepoAccess, number: number): Promise<AdapterResult<PullRequestDetails>> {
    const repo = this.#repo(access);
    if (!repo.ok) {
      return Promise.resolve(repo);
    }
    const pr = this.#prs.find((candidate) => candidate.repo === access.repo && candidate.number === number);
    if (pr === undefined) {
      return Promise.resolve(adapterError("not-found", "no such PR"));
    }
    return Promise.resolve(
      ok({ ...withoutRepo(pr), merged: pr.state === "merged", headSha: pr.headSha, updatedAt: pr.updatedAt, mergedAt: pr.mergedAt, closedAt: pr.closedAt, body: pr.body }),
    );
  }

  override parseWebhook(input: WebhookInput): AdapterResult<CodeHostWebhookEvent> {
    const event = input.headers["x-github-event"] ?? "unknown";
    if (
      event !== "pull_request" &&
      event !== "issue_comment" &&
      event !== "pull_request_review_comment" &&
      event !== "push" &&
      event !== "pull_request_review" &&
      event !== "installation" &&
      event !== "installation_repositories"
    ) {
      return ok({ kind: "other", event });
    }
    let body: unknown;
    try {
      body = JSON.parse(input.body);
    } catch {
      return adapterError("invalid-response", "the webhook's body isn't JSON");
    }
    if (event === "pull_request_review") {
      return parseReview(body);
    }
    if (event === "installation" || event === "installation_repositories") {
      return parseInstallationEvent(event, body);
    }
    if (event !== "pull_request") {
      return parseCommentOrPush(event, body);
    }
    const parsed = tinyPullRequestEventSchema.safeParse(body);
    if (!parsed.success) {
      return adapterError("invalid-response", "the pull_request event couldn't be read");
    }
    const { action, pull_request: pr, repository, installation } = parsed.data;
    const fullName = repoFullNameSchema.safeParse(repository.full_name);
    if (!fullName.success) {
      return adapterError("invalid-response", "the repo's name couldn't be read");
    }
    return ok({
      kind: "pull_request",
      action,
      installationId: installation === undefined ? null : String(installation.id),
      hostRepoId: String(repository.id),
      repo: fullName.data,
      number: pr.number,
      state: pr.merged ? "merged" : pr.state,
      headBranch: pr.head.ref,
      headSha: pr.head.sha,
      changedAt: Date.parse(pr.updated_at),
    });
  }

  override deleteRef(access: RepoAccess, ref: string): Promise<AdapterResult<DeleteRefResult>> {
    const repo = this.#repo(access);
    if (!repo.ok) {
      return Promise.resolve(repo);
    }
    const refs = this.#refs.get(access.repo);
    return Promise.resolve(ok({ deleted: refs?.delete(ref) === true }));
  }

  // ---------- milestone 3 ----------

  override compare(access: RepoAccess, base: string, head: string): Promise<AdapterResult<CompareResult>> {
    const repo = this.#repo(access);
    if (!repo.ok) {
      return Promise.resolve(repo);
    }
    const kept = repo.value.compares?.[`${base}...${head}`];
    if (kept === undefined) {
      return Promise.resolve(adapterError("not-found", "no such base and head"));
    }
    const limits = this.#world.compareLimits ?? DEFAULT_COMPARE_LIMITS;
    const files = kept.files.slice(0, limits.maxFiles).map((file): CompareFile => {
      const tooLarge = file.patch !== null && Buffer.byteLength(file.patch, "utf8") > limits.maxPatchBytes;
      return { ...file, patch: tooLarge ? null : file.patch, truncated: tooLarge };
    });
    return Promise.resolve(
      ok({
        aheadBy: kept.aheadBy,
        behindBy: kept.behindBy,
        mergeBase: kept.mergeBase,
        files,
        filesTruncated: kept.files.length > limits.maxFiles,
        limits: { maxFiles: limits.maxFiles, maxPatchBytes: limits.maxPatchBytes },
      }),
    );
  }

  override setPullRequestDraft(access: RepoAccess, number: number, draft: boolean): Promise<AdapterResult<PullRequest>> {
    const repo = this.#repo(access);
    if (!repo.ok) {
      return Promise.resolve(repo);
    }
    const index = this.#prs.findIndex((candidate) => candidate.repo === access.repo && candidate.number === number);
    const pr = this.#prs[index];
    if (pr === undefined) {
      return Promise.resolve(adapterError("not-found", "no such PR"));
    }
    if (pr.state !== "open") {
      return Promise.resolve(adapterError("conflict", "only an open PR can change between draft and ready"));
    }
    const changed = { ...pr, draft, updatedAt: Date.now() };
    this.#prs[index] = changed;
    return Promise.resolve(ok(withoutRepo(changed)));
  }

  override addReaction(access: RepoAccess, comment: CommentRef, reaction: Reaction): Promise<AdapterResult<{ readonly created: boolean }>> {
    const repo = this.#repo(access);
    if (!repo.ok) {
      return Promise.resolve(repo);
    }
    const key = `${access.repo}:${comment.kind}:${comment.commentId}:${reaction}`;
    const created = !this.#reactions.has(key);
    this.#reactions.add(key);
    return Promise.resolve(ok({ created }));
  }

  override userAuthorizeUrl(client: CodeHostOAuthClient, state: string, redirectUri: string): AdapterResult<string> {
    const url = new URL("https://code-host.invalid/login/oauth/authorize");
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", redirectUri);
    return ok(url.toString());
  }

  override exchangeUserCode(client: CodeHostOAuthClient, code: string, redirectUri: string): Promise<AdapterResult<LinkedUser>> {
    const oauth = this.#world.oauth;
    if (client.clientId !== oauth?.client.clientId || client.clientSecret !== oauth.client.clientSecret) {
      return Promise.resolve(adapterError("unauthorized", "the App's OAuth client was refused"));
    }
    if (redirectUri.length === 0) {
      return Promise.resolve(adapterError("invalid-input", "a sign-in needs its redirect address"));
    }
    const found = oauth.users.find((candidate) => candidate.code === code);
    if (found === undefined) {
      return Promise.resolve(adapterError("unauthorized", "the sign-in's code was refused"));
    }
    // A token was issued for the code; it's revoked before the account is handed back.
    this.userTokens.issued += 1;
    if (this.failNextRevocation) {
      this.failNextRevocation = false;
      return Promise.resolve(adapterError("unavailable", "the host didn't revoke the sign-in's token"));
    }
    this.userTokens.revoked += 1;
    return Promise.resolve(ok(found.user));
  }
  // ---------- milestone 4 (ticket 03, F-104): reviews, check runs, a PR's body and its head ----------

  /** Moves a PR's head, as a push to its branch does: for tests. */
  pushHead(repo: RepoFullName, number: number, headSha: string): void {
    this.#pr(repo, number).headSha = headSha;
  }

  /**
   * Merges a PR as a person does on the host, if its base's protection lets it (the two modes of
   * `FakeReviewsAndChecks`): for tests.
   */
  mergePullRequest(repo: RepoFullName, number: number): FakeMergeOutcome {
    const pr = this.#pr(repo, number);
    const outcome = this.reviewsAndChecks.merge(repo, pr.baseBranch, pr.headSha);
    if (outcome.merged) {
      this.finishPullRequest(repo, number, "merged");
    }
    return outcome;
  }

  #pr(repo: RepoFullName, number: number): TinyPullRequest {
    const pr = this.#prs.find((candidate) => candidate.repo === repo && candidate.number === number);
    if (pr === undefined) throw new Error("no such PR");
    return pr;
  }

  override updatePullRequestBody(input: UpdatePullRequestBodyInput): Promise<AdapterResult<PullRequest>> {
    const repo = this.#repo(input.access);
    if (!repo.ok) {
      return Promise.resolve(repo);
    }
    const pr = this.#prs.find((candidate) => candidate.repo === input.access.repo && candidate.number === input.number);
    if (pr === undefined) {
      return Promise.resolve(adapterError("not-found", "no such PR"));
    }
    pr.body = input.body;
    pr.updatedAt = Date.now();
    return Promise.resolve(ok(withoutRepo(pr)));
  }

  override listReviews(access: RepoAccess, number: number): Promise<AdapterResult<readonly PullRequestReview[]>> {
    const repo = this.#repo(access);
    if (!repo.ok) {
      return Promise.resolve(repo);
    }
    if (!this.#prs.some((candidate) => candidate.repo === access.repo && candidate.number === number)) {
      return Promise.resolve(adapterError("not-found", "no such PR"));
    }
    return Promise.resolve(ok(this.reviewsAndChecks.reviews(access.repo, number)));
  }

  override publishCheckRun(access: RepoAccess, input: CheckRunInput): Promise<AdapterResult<PublishedCheckRun>> {
    const repo = this.#repo(access);
    return Promise.resolve(repo.ok ? ok(this.reviewsAndChecks.publish(access.repo, input)) : repo);
  }

  override updateCheckRun(access: RepoAccess, checkRunId: string, input: CheckRunInput): Promise<AdapterResult<void>> {
    const repo = this.#repo(access);
    if (!repo.ok) {
      return Promise.resolve(repo);
    }
    return Promise.resolve(
      this.reviewsAndChecks.update(access.repo, checkRunId, input) ? ok(undefined) : adapterError("not-found", "no such check run"),
    );
  }
}

// ---------- milestone 3: the comment and push webhooks, in GitHub's shape, read loosely ----------

const webhookRepoSchema = z.looseObject({ id: z.number(), full_name: z.string() });
const webhookInstallationSchema = z.looseObject({ id: z.number() }).optional();
const webhookCommentSchema = z.looseObject({
  id: z.number(),
  body: z.string(),
  html_url: z.string(),
  user: z.looseObject({ id: z.number(), login: z.string() }),
});

const issueCommentEventSchema = z.looseObject({
  action: z.string(),
  installation: webhookInstallationSchema,
  repository: webhookRepoSchema,
  issue: z.looseObject({ number: z.number().int().positive(), pull_request: z.looseObject({}).optional() }),
  comment: webhookCommentSchema,
  sender: z.looseObject({ id: z.number() }),
});

const reviewCommentEventSchema = z.looseObject({
  action: z.string(),
  installation: webhookInstallationSchema,
  repository: webhookRepoSchema,
  pull_request: z.looseObject({ number: z.number().int().positive() }),
  sender: z.looseObject({ id: z.number() }),
  comment: webhookCommentSchema.extend({
    path: z.string(),
    side: z.enum(["LEFT", "RIGHT"]).nullish(),
    line: z.number().int().positive().nullish(),
  }),
});

const pushEventSchema = z.looseObject({
  ref: z.string(),
  before: z.string(),
  after: z.string(),
  installation: webhookInstallationSchema,
  repository: webhookRepoSchema,
  commits: z
    .array(
      z.looseObject({
        added: z.array(z.string()).optional(),
        removed: z.array(z.string()).optional(),
        modified: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});

const commentOf = (comment: z.infer<typeof webhookCommentSchema>): PullRequestComment => ({
  commentId: String(comment.id),
  authorId: String(comment.user.id),
  authorLogin: comment.user.login,
  body: comment.body,
  url: comment.html_url,
});

const parseCommentOrPush = (
  event: "issue_comment" | "pull_request_review_comment" | "push",
  body: unknown,
): AdapterResult<CodeHostWebhookEvent> => {
  const repoOf = (repository: z.infer<typeof webhookRepoSchema>) => repoFullNameSchema.safeParse(repository.full_name);
  switch (event) {
    case "issue_comment": {
      const parsed = issueCommentEventSchema.safeParse(body);
      const repo = parsed.success ? repoOf(parsed.data.repository) : undefined;
      if (!parsed.success || repo?.success !== true) {
        return adapterError("invalid-response", "the issue_comment event couldn't be read");
      }
      return ok({
        kind: "issue_comment",
        action: parsed.data.action,
        installationId: parsed.data.installation === undefined ? null : String(parsed.data.installation.id),
        hostRepoId: String(parsed.data.repository.id),
        repo: repo.data,
        number: parsed.data.issue.number,
        onPullRequest: parsed.data.issue.pull_request !== undefined,
        comment: commentOf(parsed.data.comment),
        senderId: String(parsed.data.sender.id),
      });
    }
    case "pull_request_review_comment": {
      const parsed = reviewCommentEventSchema.safeParse(body);
      const repo = parsed.success ? repoOf(parsed.data.repository) : undefined;
      if (!parsed.success || repo?.success !== true) {
        return adapterError("invalid-response", "the pull_request_review_comment event couldn't be read");
      }
      return ok({
        kind: "pull_request_review_comment",
        action: parsed.data.action,
        installationId: parsed.data.installation === undefined ? null : String(parsed.data.installation.id),
        hostRepoId: String(parsed.data.repository.id),
        repo: repo.data,
        number: parsed.data.pull_request.number,
        comment: commentOf(parsed.data.comment),
        senderId: String(parsed.data.sender.id),
        path: parsed.data.comment.path,
        side: parsed.data.comment.side === "LEFT" ? "old" : "new",
        line: parsed.data.comment.line ?? null,
      });
    }
    case "push": {
      const parsed = pushEventSchema.safeParse(body);
      const repo = parsed.success ? repoOf(parsed.data.repository) : undefined;
      if (!parsed.success || repo?.success !== true) {
        return adapterError("invalid-response", "the push event couldn't be read");
      }
      const commits = parsed.data.commits;
      const changedPaths =
        commits === undefined
          ? null
          : [...new Set(commits.flatMap((commit) => [...(commit.added ?? []), ...(commit.removed ?? []), ...(commit.modified ?? [])]))];
      return ok({
        kind: "push",
        installationId: parsed.data.installation === undefined ? null : String(parsed.data.installation.id),
        hostRepoId: String(parsed.data.repository.id),
        repo: repo.data,
        ref: parsed.data.ref,
        before: parsed.data.before,
        after: parsed.data.after,
        changedPaths,
      });
    }
    default:
      return event satisfies never;
  }
};

const tinyPullRequestEventSchema = z.looseObject({
  action: z.string(),
  installation: z.looseObject({ id: z.number() }).optional(),
  repository: z.looseObject({ id: z.number(), full_name: z.string() }),
  pull_request: z.looseObject({
    number: z.number().int().positive(),
    state: z.enum(["open", "closed"]),
    merged: z.boolean(),
    updated_at: z.string(),
    head: z.looseObject({ ref: z.string(), sha: z.string() }),
  }),
});

// ---------- milestone 4: the pull_request_review webhook, in GitHub's shape, read loosely ----------

const reviewEventSchema = z.looseObject({
  action: z.string(),
  installation: webhookInstallationSchema,
  repository: webhookRepoSchema,
  pull_request: z.looseObject({ number: z.number().int().positive(), head: z.looseObject({ sha: z.string() }) }),
  review: z.looseObject({
    id: z.number(),
    user: z.looseObject({ id: z.number(), login: z.string(), type: z.string().optional() }),
    state: z.string(),
    commit_id: z.string().nullish(),
    submitted_at: z.string().nullish(),
  }),
});

const reviewStateOf = (state: string): PullRequestReview["state"] | undefined =>
  pullRequestReviewStates.find((known) => known === state.toLowerCase());

const parseReview = (body: unknown): AdapterResult<CodeHostWebhookEvent> => {
  const parsed = reviewEventSchema.safeParse(body);
  const repo = parsed.success ? repoFullNameSchema.safeParse(parsed.data.repository.full_name) : undefined;
  const state = parsed.success ? reviewStateOf(parsed.data.review.state) : undefined;
  if (!parsed.success || repo?.success !== true || state === undefined) {
    return adapterError("invalid-response", "the pull_request_review event couldn't be read");
  }
  const { review } = parsed.data;
  return ok({
    kind: "pull_request_review",
    action: parsed.data.action,
    installationId: parsed.data.installation === undefined ? null : String(parsed.data.installation.id),
    hostRepoId: String(parsed.data.repository.id),
    repo: repo.data,
    number: parsed.data.pull_request.number,
    headSha: parsed.data.pull_request.head.sha,
    review: {
      reviewId: String(review.id),
      userId: String(review.user.id),
      login: review.user.login,
      isBot: review.user.type === "Bot",
      state,
      commitId: review.commit_id ?? null,
      submittedAt: review.submitted_at === undefined || review.submitted_at === null ? null : Date.parse(review.submitted_at),
    },
  });
};

const withoutRepo = (pr: PullRequest & { readonly repo: RepoFullName; readonly draft: boolean }): PullRequest => ({
  number: pr.number,
  url: pr.url,
  state: pr.state,
  headBranch: pr.headBranch,
  baseBranch: pr.baseBranch,
  title: pr.title,
  draft: pr.draft,
});

export const signWebhook = (secret: string, body: string): string =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

// ---------- agent: a scripted driver, no process ----------

/**
 * A driver that plays a script instead of speaking ACP: `simple` answers with one message and
 * ends the turn; `long` sends one update and runs until it's cancelled.
 */
export const scriptedDriver = (): DriverPort => ({
  connect: (_io, handlers: DriverHandlers) => {
    const cancels = new Map<string, () => void>();
    let sessions = 0;
    const connection: DriverConnection = {
      agentName: "scripted",
      agentVersion: "0.0.0",
      steeringAdvertised: false,
      newSession: () => {
        sessions += 1;
        return Promise.resolve(ok({ agentSessionId: `scripted-${String(sessions)}` }));
      },
      loadSession: () => Promise.resolve(ok(undefined)),
      prompt: (agentSessionId, text) => {
        handlers.onUpdate(agentSessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `Working on: ${text}` },
        });
        if (text !== "long") {
          return Promise.resolve(ok({ stopReason: "end_turn" satisfies StopReason }));
        }
        return new Promise((resolve) => {
          cancels.set(agentSessionId, () => {
            resolve(ok({ stopReason: "cancelled" }));
          });
        });
      },
      cancel: (agentSessionId) => {
        cancels.get(agentSessionId)?.();
        cancels.delete(agentSessionId);
        return Promise.resolve();
      },
      steer: () => Promise.resolve(adapterError("unsupported", "the scripted agent can't steer")),
      close: () => Promise.resolve(),
    };
    return Promise.resolve(ok(connection));
  },
  mapUpdate: (update: AcpUpdate, context: MapContext): readonly TaskEvent[] => {
    const content: unknown = update["content"];
    const text: unknown = Reflect.get(Object(content), "text");
    return update.sessionUpdate === "agent_message_chunk" && typeof text === "string"
      ? [{ kind: "agent.message", turnId: context.turnId, segmentId: segmentIdSchema.parse(`${context.turnId}-1`), text }]
      : [];
  },
});

export class TinyAgent extends AgentAdapter {
  readonly name = "tiny-agent";
  readonly capabilities: AgentCapabilities = {
    steerMidTurn: false,
    sessionLoad: false,
    nativePlan: false,
    rejectAndContinue: true,
    elicitationForm: true,
    modelBaseUrlAndPlaceholderKey: true,
    sessionArchive: false,
    // Milestone 3: the tiny agent asks for nothing itself and has no plan mode.
    permissionRules: "runner-only",
    planMode: "none",
    skills: false,
    mcp: { http: false, stdio: false },
    projectConfigOverride: false,
    // Milestone 4: no MCP, so the memory block alone.
    memory: "index-only",
  };
  health(): Promise<HealthReport> {
    return Promise.resolve({ status: "ok" });
  }
  prepareLaunch(input: PrepareLaunchInput): Promise<AdapterResult<AgentLaunch>> {
    return Promise.resolve(
      ok({
        command: process.execPath,
        args: ["--version"],
        cwd: input.workspaceDir,
        env: {
          TINY_AGENT_BASE_URL: input.model.baseUrl,
          TINY_AGENT_API_KEY: input.model.placeholderKey,
          TINY_AGENT_MODEL: input.model.endpointModelId,
          ...input.extraEnv,
        },
        files: [{ path: path.join(input.agentDir, "config.json"), content: JSON.stringify({ mcp: input.mcp.url }) }],
      }),
    );
  }
  protected mapUpdate(): MappedUpdate {
    return { handled: false };
  }
}

// ---------- executor: a folder and child processes ----------
// Its setup script is JavaScript run by Node, so the case runs the same on every platform. The
// real executors run the environment's script with bash (spec section 11, item 9).

type TinyBox = {
  state: BoxState;
  readonly root: string;
  readonly created: CreatedBox;
  child: ReturnType<typeof spawn> | undefined;
  /** Milestone 5: what the fleet variant was asked for, which `inspect` reads back. */
  readonly record: TinyBoxRecord;
  /** Resolves once the box is scheduled: at once, or after a held node wait. */
  readonly scheduled: Promise<void>;
};

/** Milestone 5 (ticket 02): what the tiny executor's fleet variant knows of a box, as an engine's inspection would say it. */
export type TinyBoxRecord = {
  /** The box's own folder: its workspace, its agent's folder and its sidecar's folder. */
  readonly root: string;
  readonly limits: BoxSize | null;
  /** The image the box started from, by digest. */
  readonly image: { readonly ref: string; readonly digest: string } | null;
  /** The sidecar's token folder, when the box was given a task token. */
  readonly sidecarDir: string | null;
  /** Every agent launch's command, arguments and environment: the box's process list. */
  readonly launches: AgentLaunch[];
};

/** A pull the fleet variant made: by digest, with the credential's user (never its token). */
export type TinyPull = { readonly ref: string; readonly digest: string; readonly username: string | null };

export type TinyExecutorOptions = {
  /**
   * Milestone 5 (ticket 02): a test double of a pool executor for the suite's fleet cases. It takes
   * box sizes and records them as its limits, "pulls" a registry image by digest, writes the task
   * token to a sidecar folder of the box's own, and can hold a box waiting for a node. It isolates
   * nothing and enforces no limit: it only says what it was asked, as an engine's inspection would.
   */
  readonly fleet?: boolean;
};

export const killTree = (pid: number): Promise<void> =>
  new Promise((resolve) => {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.on("error", () => {
        resolve();
      });
      killer.on("close", () => {
        resolve();
      });
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    resolve();
  });

export class TinyExecutor extends ExecutorAdapter {
  readonly name: string;
  readonly capabilities: ExecutorCapabilities;
  readonly #boxes = new Map<string, TinyBox>();
  readonly #fleet: boolean;
  readonly #pulls: TinyPull[] = [];
  #holdNextMs = 0;

  constructor(options: TinyExecutorOptions = {}) {
    super();
    this.#fleet = options.fleet ?? false;
    this.name = this.#fleet ? "tiny-fleet-executor" : "tiny-executor";
    this.capabilities = this.#fleet
      ? {
          isolation: "container",
          services: false,
          boxSizes: true,
          snapshots: "none",
          processContainment: "process-tree",
          registry: "optional",
          nodeWait: true,
        }
      : { isolation: "none", services: false, boxSizes: false, snapshots: "none", processContainment: "process-tree", registry: "none", nodeWait: false };
  }

  /** Milestone 5: the fleet variant offers two slots, 4 CPUs and 8 GiB; the plain one counts slots only. */
  override capacity(): ExecutorCapacity | null {
    return this.#fleet ? { slots: 2, cpuMillis: 4000, memoryMiB: 8192 } : null;
  }

  /** The fleet variant's next box waits this long for a node before it's scheduled. */
  holdNextBox(ms: number): void {
    this.#holdNextMs = ms;
  }

  /** What the executor knows of a box, as an engine's inspection would say it. */
  inspect(ref: BoxRef): TinyBoxRecord | undefined {
    return this.#boxes.get(String(ref.boxId))?.record;
  }

  /** Every pull so far. */
  pulls(): readonly TinyPull[] {
    return [...this.#pulls];
  }

  /**
   * Milestone 3: the turn's checks, each a JavaScript program run by Node, as the tiny setup script
   * is, so the case runs the same on every platform (the real executors run a command line).
   */
  override async runChecks(ref: BoxRef, input: Omit<RunChecksInput, "workspaceDir">): Promise<AdapterResult<readonly CheckRunResult[]>> {
    const box = this.#boxes.get(String(ref.boxId));
    if (box === undefined) {
      return adapterError("not-found", "no such box");
    }
    return ok(
      await runChecksWith({ ...input, workspaceDir: box.created.workspaceDir }, ({ command, cwd, env, timeoutMs, onOutput }) =>
        new Promise((resolve) => {
          let timedOut = false;
          const child = spawn(process.execPath, ["-e", command], { cwd, env: { ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
          const timer = setTimeout(() => {
            timedOut = true;
            if (child.pid !== undefined) {
              void killTree(child.pid);
            }
          }, timeoutMs);
          child.stdout.on("data", (chunk: Buffer) => {
            onOutput(chunk.toString("utf8"));
          });
          child.stderr.on("data", (chunk: Buffer) => {
            onOutput(chunk.toString("utf8"));
          });
          child.on("error", (error) => {
            clearTimeout(timer);
            resolve({ exitCode: null, timedOut: false, error: error.name });
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ exitCode: code, timedOut, error: null });
          });
        }),
      ),
    );
  }

  health(): Promise<HealthReport> {
    return Promise.resolve({ status: "ok" });
  }

  async create(input: CreateBoxInput): Promise<AdapterResult<CreatedBox>> {
    const unfit = this.refuseUnfitBox(input);
    if (unfit !== null) {
      return unfit;
    }
    const root = await mkdtemp(path.join(tmpdir(), "ostra-tiny-box-"));
    const created = { workspaceDir: path.join(root, "workspace"), agentDir: path.join(root, "agent"), gitConfig: path.join(root, "git", "config") };
    await mkdir(created.workspaceDir, { recursive: true });
    await mkdir(created.agentDir, { recursive: true });
    const image = input.image ?? null;
    if (image !== null) {
      // By digest, with the credential handed to the pull only: nothing in the box holds it.
      this.#pulls.push({ ref: `${image.ref}@${image.digest}`, digest: image.digest, username: image.pull?.username ?? null });
    }
    let sidecarDir: string | null = null;
    const token = input.taskToken ?? null;
    if (token !== null) {
      sidecarDir = path.join(root, "sidecar");
      const written = await writeTaskTokenFile(sidecarDir, { kind: "group", gid: process.getgid?.() ?? 0 }, token);
      if (!written.ok) {
        await rm(root, { recursive: true, force: true });
        return written;
      }
    }
    const holdMs = this.#holdNextMs;
    this.#holdNextMs = 0;
    let scheduled = Promise.resolve();
    if (holdMs > 0) {
      const since = new Date();
      input.onWaiting?.({ kind: "waiting", reason: "node", since });
      scheduled = new Promise((resolve) => {
        setTimeout(() => {
          input.onWaiting?.({ kind: "scheduled", afterMs: Date.now() - since.getTime() });
          resolve();
        }, holdMs);
      });
    }
    const record: TinyBoxRecord = {
      root,
      limits: input.size === undefined || input.size === null ? null : { cpuMillis: input.size.cpuMillis, memoryMiB: input.size.memoryMiB },
      image: image === null ? null : { ref: image.ref, digest: image.digest },
      sidecarDir,
      launches: [],
    };
    this.#boxes.set(String(input.boxId), { state: "creating", root, created, child: undefined, record, scheduled });
    return ok(created);
  }

  async prepare(input: PrepareInput): Promise<AdapterResult<PrepareResult>> {
    const box = this.#boxes.get(String(input.box.boxId));
    if (box === undefined) {
      return adapterError("not-found", "no such box");
    }
    // A box waiting for a node prepares once it's scheduled.
    await box.scheduled;
    box.state = "preparing";
    const script = input.spec.environment.setupScript;
    if (script === null) {
      box.state = "ready";
      return ok({ setup: null });
    }
    const started = Date.now();
    const exitCode = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, ["-e", script], { cwd: box.created.workspaceDir, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (chunk: Buffer) => {
        input.onSetupOutput("stdout", chunk.toString("utf8"));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        input.onSetupOutput("stderr", chunk.toString("utf8"));
      });
      child.on("error", () => {
        resolve(null);
      });
      child.on("close", (code) => {
        resolve(code);
      });
    });
    box.state = "ready";
    return ok({ setup: { exitCode, durationMs: Date.now() - started } });
  }

  startAgent(ref: BoxRef, launch: AgentLaunch): Promise<AdapterResult<AgentProcess>> {
    const box = this.#boxes.get(String(ref.boxId));
    if (box?.state !== "ready") {
      return Promise.resolve(adapterError("conflict", "the box is not ready"));
    }
    const child = spawn(launch.command, [...launch.args], {
      cwd: launch.cwd,
      env: { ...launch.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    box.child = child;
    box.record.launches.push(launch);
    const exited = new Promise<{ readonly code: number | null; readonly signal: string | null }>((resolve) => {
      child.on("exit", (code, signal) => {
        resolve({ code, signal });
      });
    });
    return Promise.resolve(
      ok({ stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, pid: child.pid ?? null, exited }),
    );
  }

  commitAndPush(): Promise<AdapterResult<readonly RepoPushResult[]>> {
    return unsupported("commitAndPush");
  }

  async stop(input: StopInput): Promise<AdapterResult<void>> {
    const box = this.#boxes.get(String(input.box.boxId));
    if (box === undefined) {
      return adapterError("not-found", "no such box");
    }
    const pid = box.child?.pid;
    if (pid !== undefined && box.child?.exitCode === null) {
      await killTree(pid);
    }
    box.state = "stopped";
    return ok(undefined);
  }

  async release(ref: BoxRef): Promise<AdapterResult<void>> {
    const box = this.#boxes.get(String(ref.boxId));
    if (box === undefined) {
      return adapterError("not-found", "no such box");
    }
    const pid = box.child?.pid;
    if (pid !== undefined && box.child?.exitCode === null) {
      await killTree(pid);
    }
    await rm(box.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    box.state = "released";
    return ok(undefined);
  }

  state(ref: BoxRef): Promise<AdapterResult<BoxState>> {
    const box = this.#boxes.get(String(ref.boxId));
    return Promise.resolve(box === undefined ? adapterError("not-found", "no such box") : ok(box.state));
  }

  async listWorkspaceRoot(ref: BoxRef): Promise<AdapterResult<readonly string[]>> {
    const box = this.#boxes.get(String(ref.boxId));
    if (box === undefined || box.state === "released") {
      return adapterError("not-found", "no such box");
    }
    return ok(await readdir(box.created.workspaceDir));
  }
}

// ---------- model provider: endpoints in memory ----------

export class TinyModelProvider extends ModelProviderAdapter {
  readonly name = "tiny-model-provider";
  readonly capabilities: ModelProviderCapabilities = {
    apiFormats: ["openai-compatible", "anthropic-messages"],
    modelList: true,
    usageInStream: true,
  };
  readonly #endpoints: readonly StubEndpoint[];

  constructor(endpoints: readonly StubEndpoint[]) {
    super();
    this.#endpoints = endpoints;
  }

  health(): Promise<HealthReport> {
    return Promise.resolve({ status: "ok" });
  }

  #find(endpoint: ModelEndpoint): AdapterResult<StubEndpoint> {
    const found = this.#endpoints.find((candidate) => candidate.baseUrl === endpoint.baseUrl);
    if (found === undefined) {
      return adapterError("unavailable", "nothing answers at that address");
    }
    return found.token === endpoint.token ? ok(found) : adapterError("unauthorized", "the token was refused");
  }

  testConnection(endpoint: ModelEndpoint): Promise<AdapterResult<ConnectionTest>> {
    const found = this.#find(endpoint);
    if (!found.ok) {
      return Promise.resolve(found);
    }
    return Promise.resolve(
      ok({
        apiFormat: found.value.apiFormat,
        authScheme: found.value.authScheme,
        models: found.value.models.map((id) => ({ endpointModelId: id, displayName: null, contextWindow: null })),
      }),
    );
  }

  listModels(endpoint: ModelEndpoint): Promise<AdapterResult<readonly EndpointModel[]>> {
    const found = this.#find(endpoint);
    return Promise.resolve(
      found.ok ? ok(found.value.models.map((id) => ({ endpointModelId: id, displayName: null, contextWindow: null }))) : found,
    );
  }

  matchCatalog(models: readonly EndpointModel[], catalog: readonly CatalogEntry[]): readonly CatalogMatch[] {
    return models.map((model) => {
      const entry = catalog.find(
        (candidate) => candidate.catalogId === model.endpointModelId || candidate.aliases.includes(model.endpointModelId),
      );
      return { endpointModelId: model.endpointModelId, match: entry === undefined ? { kind: "custom" } : { kind: "catalog", entry } };
    });
  }
}

// ---------- secret store: rows in memory ----------

export class TinySecretStore extends SecretStoreAdapter {
  readonly name = "tiny-secret-store";
  readonly capabilities = { rotation: false };
  readonly #rows: SecretRowStore;

  constructor(rows: SecretRowStore) {
    super();
    this.#rows = rows;
  }

  health(): Promise<HealthReport> {
    return Promise.resolve({ status: "ok" });
  }

  async put(scope: SecretScope, value: string): Promise<AdapterResult<SecretRef>> {
    const id = randomUUID();
    // A test store: the bytes are reversed, not encrypted. The built-in store (ticket 14) encrypts.
    await this.#rows.insert({
      id,
      organizationId: scope.organizationId,
      purpose: scope.purpose,
      ciphertext: Buffer.from(value, "utf8").reverse(),
      nonce: new Uint8Array(12),
      keyVersion: 1,
    });
    return ok(secretRefSchema.parse(`tiny:${id}`));
  }

  async get(organizationId: OrganizationId, ref: SecretRef): Promise<AdapterResult<string>> {
    const row = await this.#rows.get(ref.slice("tiny:".length));
    if (row?.organizationId !== organizationId) {
      return adapterError("not-found", "no such secret");
    }
    return ok(Buffer.from(row.ciphertext).reverse().toString("utf8"));
  }

  async delete(organizationId: OrganizationId, ref: SecretRef): Promise<AdapterResult<void>> {
    const id = ref.slice("tiny:".length);
    const row = await this.#rows.get(id);
    if (row?.organizationId !== organizationId) {
      return adapterError("not-found", "no such secret");
    }
    await this.#rows.delete(id);
    return ok(undefined);
  }
}

// ---------- milestone 4 (F-136): the installation webhooks, in GitHub's shape, read loosely ----------

const installationAccountSchema = z.looseObject({ id: z.number(), login: z.string(), type: z.string().optional() });
const installationRepoSchema = z.looseObject({ id: z.number(), full_name: z.string() });
const installationEventSchema = z.looseObject({
  action: z.string(),
  installation: z.looseObject({ id: z.number(), account: installationAccountSchema }),
  repositories_added: z.array(installationRepoSchema).optional(),
  repositories_removed: z.array(installationRepoSchema).optional(),
});

const installationReposOf = (list: readonly z.infer<typeof installationRepoSchema>[] | undefined): InstallationRepo[] | null => {
  const read: InstallationRepo[] = [];
  for (const item of list ?? []) {
    const fullName = repoFullNameSchema.safeParse(item.full_name);
    if (!fullName.success) {
      return null;
    }
    read.push({ hostRepoId: String(item.id), fullName: fullName.data });
  }
  return read;
};

const parseInstallationEvent = (event: "installation" | "installation_repositories", body: unknown): AdapterResult<CodeHostWebhookEvent> => {
  const parsed = installationEventSchema.safeParse(body);
  if (!parsed.success) {
    return adapterError("invalid-response", `the ${event} event couldn't be read`);
  }
  const { action, installation } = parsed.data;
  const account: InstallationAccount = {
    accountId: String(installation.account.id),
    login: installation.account.login,
    kind: installation.account.type === "Organization" ? "organization" : "user",
  };
  if (event === "installation") {
    return ok({ kind: "installation", action, installationId: String(installation.id), account });
  }
  const added = installationReposOf(parsed.data.repositories_added);
  const removed = installationReposOf(parsed.data.repositories_removed);
  if (added === null || removed === null) {
    return adapterError("invalid-response", "the installation_repositories event names a repo that couldn't be read");
  }
  return ok({ kind: "installation_repositories", action, installationId: String(installation.id), account, reposAdded: added, reposRemoved: removed });
};
