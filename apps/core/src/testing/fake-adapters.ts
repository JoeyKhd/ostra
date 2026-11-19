import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { adapterError, CodeHostAdapter, ModelProviderAdapter, ok, secretRefSchema, SecretStoreAdapter } from "@ostra/adapter-sdk";
import { FakeReviewsAndChecks } from "@ostra/adapter-sdk/testing";
import type {
  AdapterResult,
  CheckRunInput,
  PublishedCheckRun,
  PullRequestReview,
  CodeHostWebhookEvent,
  CommentRef,
  CompareResult,
  Reaction,
  DeleteRefResult,
  PullRequestDetails,
  WebhookInput,
  CatalogEntry,
  CatalogMatch,
  ConnectionTest,
  EndpointModel,
  ModelEndpoint,
  AppInfo,
  AppManifest,
  CodeHostAppCredentials,
  CodeHostCapabilities,
  CreatedApp,
  HealthReport,
  HostRepo,
  Installation,
  OpenPullRequestInput,
  UpdatePullRequestBodyInput,
  PermissionLevel,
  PullRequest,
  ReadFilesResult,
  RepoAccess,
  RepoPermission,
  RepoToken,
  SecretRef,
  SecretScope,
} from "@ostra/adapter-sdk";
import { parseJson, repoFullNameSchema } from "@ostra/protocol";
import type { ApiFormat, GitPerson, OrganizationId } from "@ostra/protocol";

// Fake adapters for core's tests (spec section 8): in memory, each a subclass of its kind's base
// class (ADR 0025), so core's code that works with them works through the shared interface. The code
// host records every token it mints and every PR it opens, so a test can check both. Never shipped.

const healthy: Promise<HealthReport> = Promise.resolve({ status: "ok" });

type StoredSecret = { readonly organizationId: OrganizationId; readonly value: string };

export class FakeSecretStore extends SecretStoreAdapter {
  readonly name = "fake-secret-store";
  readonly capabilities = { rotation: false };
  readonly entries = new Map<string, StoredSecret>();

  health(): Promise<HealthReport> {
    return healthy;
  }

  put(scope: SecretScope, value: string): Promise<AdapterResult<SecretRef>> {
    const ref = secretRefSchema.parse(`fake:${randomUUID()}`);
    this.entries.set(ref, { organizationId: scope.organizationId, value });
    return Promise.resolve(ok(ref));
  }

  get(organizationId: OrganizationId, ref: SecretRef): Promise<AdapterResult<string>> {
    const found = this.entries.get(ref);
    return Promise.resolve(found?.organizationId === organizationId ? ok(found.value) : adapterError("not-found", "no such secret"));
  }

  delete(organizationId: OrganizationId, ref: SecretRef): Promise<AdapterResult<void>> {
    const found = this.entries.get(ref);
    if (found?.organizationId !== organizationId) {
      return Promise.resolve(adapterError("not-found", "no such secret"));
    }
    this.entries.delete(ref);
    return Promise.resolve(ok(undefined));
  }
}

export type MintedToken = {
  readonly repo: string;
  readonly installationId: string;
  readonly permissions: Readonly<Partial<Record<RepoPermission, PermissionLevel>>>;
  readonly token: string;
};

export type OpenedPull = PullRequest & { readonly repo: string; readonly body: string };

export class FakeCodeHost extends CodeHostAdapter {
  readonly name = "fake-code-host";
  readonly capabilities: CodeHostCapabilities = { checkRuns: true, prTemplates: true, lfsActionHosts: ["lfs.example.test"], branchRules: false, compare: true, draftPullRequests: true, prComments: true, userLink: false, reviews: true, installableByOtherAccounts: false };
  /** Milestone 4 (F-104, ticket 18): the PRs' reviews and the check runs, in memory. */
  readonly reviewsAndChecks = new FakeReviewsAndChecks();
  /** Fail the next `listReviews` this many times, as a flaky host would. */
  failReviewLists = 0;
  /** App ID to its private key and bot. */
  readonly apps = new Map<string, { readonly privateKey: string; readonly bot: GitPerson }>();
  /** Installation ID to the repos it lists. */
  readonly repos = new Map<string, readonly HostRepo[]>();
  /** `owner/name` to its PR template. */
  readonly templates = new Map<string, string>();
  readonly minted: MintedToken[] = [];
  readonly pulls: OpenedPull[] = [];
  /** Fail the next `openPullRequest` this many times, as a flaky host would. */
  failOpens = 0;
  /** Open the PR, then lose the answer, this many times: a timeout after the host made it. */
  loseOpenAnswers = 0;

  health(): Promise<HealthReport> {
    return healthy;
  }

  private known(app: CodeHostAppCredentials): boolean {
    return this.apps.get(app.appId)?.privateKey === app.privateKey;
  }

  appManifest(): AppManifest {
    return { manifest: {}, createUrl: "https://github.example/settings/apps/new" };
  }

  convertManifestCode(): Promise<AdapterResult<CreatedApp>> {
    return Promise.resolve(adapterError("unsupported", "the fake has no manifest flow"));
  }

  /** Milestone 4 (F-136): the account that owns every App here, when set; `readApp` names it. */
  owner: { readonly login: string; readonly accountId: string } | undefined;
  /** Milestone 4 (F-136): what `listInstallations` lists. */
  readonly installations: Installation[] = [];

  readApp(app: CodeHostAppCredentials): Promise<AdapterResult<AppInfo>> {
    return Promise.resolve(
      this.known(app)
        ? ok({ appId: app.appId, slug: "ostra-test", name: "ostra-test", permissions: {}, events: [], ...(this.owner === undefined ? {} : { owner: this.owner }) })
        : adapterError("unauthorized", "refused"),
    );
  }

  listInstallations(app: CodeHostAppCredentials): Promise<AdapterResult<readonly Installation[]>> {
    return Promise.resolve(this.known(app) ? ok([...this.installations]) : adapterError("unauthorized", "refused"));
  }

  listRepos(app: CodeHostAppCredentials, installationId: string): Promise<AdapterResult<readonly HostRepo[]>> {
    if (!this.known(app)) {
      return Promise.resolve(adapterError("unauthorized", "refused"));
    }
    return Promise.resolve(ok(this.repos.get(installationId) ?? []));
  }

  mintRepoToken(access: RepoAccess, permissions: Readonly<Partial<Record<RepoPermission, PermissionLevel>>>): Promise<AdapterResult<RepoToken>> {
    if (!this.known(access.app)) {
      return Promise.resolve(adapterError("unauthorized", "the App's credentials were refused"));
    }
    const token = `ghs_fake${randomUUID().replaceAll("-", "")}`;
    this.minted.push({ repo: access.repo, installationId: access.installationId, permissions, token });
    return Promise.resolve(ok({ token, expiresAt: Date.now() + 3_600_000 }));
  }

  readFiles(): Promise<AdapterResult<ReadFilesResult>> {
    return Promise.resolve(ok({ files: [], missing: [] }));
  }

  getDefaultBranch(): Promise<AdapterResult<string>> {
    return Promise.resolve(ok("main"));
  }

  getPullRequestTemplate(access: RepoAccess): Promise<AdapterResult<string | null>> {
    return Promise.resolve(this.known(access.app) ? ok(this.templates.get(access.repo) ?? null) : adapterError("unauthorized", "refused"));
  }

  getBotIdentity(app: CodeHostAppCredentials): Promise<AdapterResult<GitPerson>> {
    const found = this.apps.get(app.appId);
    return Promise.resolve(found?.privateKey === app.privateKey ? ok(found.bot) : adapterError("unauthorized", "refused"));
  }

  findPullRequest(access: RepoAccess, head: string): Promise<AdapterResult<PullRequest | null>> {
    const found = this.pulls.find((pull) => pull.repo === access.repo && pull.headBranch === head);
    return Promise.resolve(ok(found ?? null));
  }

  openPullRequest(input: OpenPullRequestInput): Promise<AdapterResult<PullRequest>> {
    if (!this.known(input.access.app)) {
      return Promise.resolve(adapterError("unauthorized", "refused"));
    }
    if (this.failOpens > 0) {
      this.failOpens -= 1;
      return Promise.resolve(adapterError("unavailable", "the host is down"));
    }
    const number = this.pulls.length + 1;
    const pull: OpenedPull = {
      number,
      url: `https://github.example/${input.access.repo}/pull/${String(number)}`,
      state: "open",
      headBranch: input.head,
      baseBranch: input.base,
      title: input.title,
      repo: input.access.repo,
      body: input.body,
      draft: input.draft,
    };
    this.pulls.push(pull);
    if (this.loseOpenAnswers > 0) {
      this.loseOpenAnswers -= 1;
      return Promise.resolve(adapterError("unavailable", "the host timed out after opening the PR"));
    }
    return Promise.resolve(ok(pull));
  }

  override updatePullRequestBody(input: UpdatePullRequestBodyInput): Promise<AdapterResult<PullRequest>> {
    if (!this.known(input.access.app)) {
      return Promise.resolve(adapterError("unauthorized", "refused"));
    }
    const index = this.pulls.findIndex((pull) => pull.repo === input.access.repo && pull.number === input.number);
    const found = this.pulls[index];
    if (found === undefined) {
      return Promise.resolve(adapterError("not-found", "no such PR"));
    }
    const updated: OpenedPull = { ...found, body: input.body };
    this.pulls[index] = updated;
    return Promise.resolve(ok(updated));
  }

  // ---------- milestone 2: webhooks, PR states, refs (spec section 8) ----------

  /** The App's webhook secret: deliveries are signed with it. */
  webhookSecret = `whsec-${randomUUID()}`;
  /** Each PR's merge state, by `repo#number`. */
  readonly states = new Map<string, FakePullState>();
  /** `getPullRequest` calls: the reconcile's reads. */
  readonly prReads: { readonly repo: string; readonly number: number }[] = [];
  readonly deletedRefs: { readonly repo: string; readonly ref: string }[] = [];
  /** Fail the next `getPullRequest` this many times. */
  failReads = 0;
  /** The time PR changes are stamped with. */
  now: () => number = () => Date.now();

  #stateOf(repo: string, number: number): FakePullState {
    const key = `${repo}#${String(number)}`;
    let state = this.states.get(key);
    if (state === undefined) {
      state = { state: "open", headSha: "a".repeat(40), updatedAt: this.now(), mergedAt: null, closedAt: null };
      this.states.set(key, state);
    }
    return state;
  }

  /** A person merges, closes or reopens a PR on the host. */
  changePull(repo: string, number: number, change: "merge" | "close" | "reopen"): void {
    const state = this.#stateOf(repo, number);
    const now = Math.max(this.now(), state.updatedAt + 1);
    state.updatedAt = now;
    switch (change) {
      case "merge":
        state.state = "merged";
        state.mergedAt = now;
        state.closedAt = now;
        break;
      case "close":
        state.state = "closed";
        state.closedAt = now;
        break;
      case "reopen":
        state.state = "open";
        state.closedAt = null;
        break;
      default:
        change satisfies never;
    }
    const index = this.pulls.findIndex((pull) => pull.repo === repo && pull.number === number);
    const found = this.pulls[index];
    if (found !== undefined) {
      this.pulls[index] = { ...found, state: state.state };
    }
  }

  /** Someone pushes to a PR's branch: its head moves (a `synchronize`, F-104). */
  pushHead(repo: string, number: number, headSha: string): void {
    const state = this.#stateOf(repo, number);
    state.headSha = headSha;
    state.updatedAt = Math.max(this.now(), state.updatedAt + 1);
  }

  hostRepoIdOf(repo: string): string {
    for (const repos of this.repos.values()) {
      const found = repos.find((candidate) => candidate.fullName === repo);
      if (found !== undefined) return found.hostRepoId;
    }
    return `host-${repo}`;
  }

  /** A `pull_request` delivery as GitHub sends it, signed with `webhookSecret`. */
  pullRequestDelivery(
    repo: string,
    number: number,
    action: string,
    options: { readonly deliveryId?: string; readonly installationId?: string; readonly hostRepoId?: string } = {},
  ): { readonly body: string; readonly headers: Readonly<Record<string, string>> } {
    const state = this.#stateOf(repo, number);
    const pull = this.pulls.find((candidate) => candidate.repo === repo && candidate.number === number);
    const body = JSON.stringify({
      action,
      number,
      installation: { id: Number(options.installationId ?? "777") },
      repository: { id: options.hostRepoId ?? this.hostRepoIdOf(repo), full_name: repo },
      pull_request: {
        number,
        state: state.state === "open" ? "open" : "closed",
        merged: state.state === "merged",
        head: { ref: pull?.headBranch ?? "ostra/branch", sha: state.headSha },
        updated_at: new Date(state.updatedAt).toISOString(),
      },
    });
    return { body, headers: this.sign(body, "pull_request", options.deliveryId) };
  }

  /** GitHub's headers for a body: the event, the delivery ID and the HMAC. */
  sign(body: string, event: string, deliveryId: string = randomUUID()): Readonly<Record<string, string>> {
    return {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": `sha256=${createHmac("sha256", this.webhookSecret).update(body).digest("hex")}`,
    };
  }

  // ---------- milestone 3: compares, drafts, reactions (tickets 22 to 25) ----------

  /** Compares by `repo:base...head`, or `repo:*...head` for any base. */
  readonly compares = new Map<string, CompareResult>();
  /** Every `compare` call, so a test can count them. */
  readonly compareCalls: { readonly repo: string; readonly base: string; readonly head: string }[] = [];
  /** Every `setPullRequestDraft` call. */
  readonly draftCalls: { readonly repo: string; readonly number: number; readonly draft: boolean }[] = [];
  /** Every `addReaction` call, and the reactions made (one per comment and reaction). */
  readonly reactionCalls: { readonly repo: string; readonly comment: CommentRef; readonly reaction: Reaction }[] = [];
  readonly reactions = new Set<string>();

  /** The compare `compare` answers for a head, on any base or on `base`. */
  setCompare(repo: string, head: string, result: CompareResult, base = "*"): void {
    this.compares.set(`${repo}:${base}...${head}`, result);
  }

  override compare(access: RepoAccess, base: string, head: string): Promise<AdapterResult<CompareResult>> {
    if (!this.known(access.app)) {
      return Promise.resolve(adapterError("unauthorized", "refused"));
    }
    this.compareCalls.push({ repo: access.repo, base, head });
    const found = this.compares.get(`${access.repo}:${base}...${head}`) ?? this.compares.get(`${access.repo}:*...${head}`);
    return Promise.resolve(found === undefined ? adapterError("not-found", "no such commits") : ok(found));
  }

  override setPullRequestDraft(access: RepoAccess, number: number, draft: boolean): Promise<AdapterResult<PullRequest>> {
    if (!this.known(access.app)) {
      return Promise.resolve(adapterError("unauthorized", "refused"));
    }
    const index = this.pulls.findIndex((pull) => pull.repo === access.repo && pull.number === number);
    const found = this.pulls[index];
    if (found === undefined) {
      return Promise.resolve(adapterError("not-found", "no such PR"));
    }
    this.draftCalls.push({ repo: access.repo, number, draft });
    const updated: OpenedPull = { ...found, draft };
    this.pulls[index] = updated;
    return Promise.resolve(ok(updated));
  }

  /** A person makes a PR a draft, or ready, on the host. */
  setDraftByPerson(repo: string, number: number, draft: boolean): void {
    const index = this.pulls.findIndex((pull) => pull.repo === repo && pull.number === number);
    const found = this.pulls[index];
    if (found !== undefined) {
      this.pulls[index] = { ...found, draft };
    }
  }

  override addReaction(access: RepoAccess, comment: CommentRef, reaction: Reaction): Promise<AdapterResult<{ readonly created: boolean }>> {
    if (!this.known(access.app)) {
      return Promise.resolve(adapterError("unauthorized", "refused"));
    }
    this.reactionCalls.push({ repo: access.repo, comment, reaction });
    const key = `${access.repo}:${comment.kind}:${comment.commentId}:${reaction}`;
    const created = !this.reactions.has(key);
    this.reactions.add(key);
    return Promise.resolve(ok({ created }));
  }

  /** An `issue_comment` or `pull_request_review_comment` delivery as GitHub sends it, signed. */
  commentDelivery(
    repo: string,
    input: {
      readonly number: number;
      readonly commentId: number;
      readonly body: string;
      readonly authorId: number;
      readonly authorLogin: string;
      /** Who caused the delivery, when it isn't the author: an `edited` comment's editor. */
      readonly senderId?: number;
      readonly action?: string;
      readonly line?: { readonly path: string; readonly line: number; readonly side?: "LEFT" | "RIGHT" };
      readonly onPullRequest?: boolean;
      readonly deliveryId?: string;
    },
  ): { readonly body: string; readonly headers: Readonly<Record<string, string>>; readonly event: string } {
    const anchor = input.line === undefined ? "issuecomment-" : "discussion_r";
    const comment = {
      id: input.commentId,
      body: input.body,
      html_url: `https://github.example/${repo}/pull/${String(input.number)}#${anchor}${String(input.commentId)}`,
      user: { id: input.authorId, login: input.authorLogin, type: input.authorLogin.endsWith("[bot]") ? "Bot" : "User" },
      ...(input.line === undefined ? {} : { path: input.line.path, line: input.line.line, side: input.line.side ?? "RIGHT" }),
    };
    const event = input.line === undefined ? "issue_comment" : "pull_request_review_comment";
    const where =
      input.line === undefined
        ? { issue: { number: input.number, ...(input.onPullRequest === false ? {} : { pull_request: { url: `https://api.github.example/repos/${repo}/pulls/${String(input.number)}` } }) } }
        : { pull_request: { number: input.number } };
    const body = JSON.stringify({
      action: input.action ?? "created",
      installation: { id: 777 },
      repository: { id: this.hostRepoIdOf(repo), full_name: repo },
      comment,
      sender: { id: input.senderId ?? input.authorId },
      ...where,
    });
    return { body, headers: this.sign(body, event, input.deliveryId), event };
  }

  /** A `push` delivery as GitHub sends it, signed. */
  pushDelivery(
    repo: string,
    input: { readonly branch: string; readonly before: string; readonly after: string; readonly paths?: readonly string[]; readonly deliveryId?: string },
  ): { readonly body: string; readonly headers: Readonly<Record<string, string>> } {
    const body = JSON.stringify({
      ref: `refs/heads/${input.branch}`,
      before: input.before,
      after: input.after,
      installation: { id: 777 },
      repository: { id: this.hostRepoIdOf(repo), full_name: repo },
      commits: [{ added: [], removed: [], modified: [...(input.paths ?? [])] }],
    });
    return { body, headers: this.sign(body, "push", input.deliveryId) };
  }

  verifyWebhook(input: WebhookInput): boolean {
    const header = input.headers["x-hub-signature-256"];
    if (header === undefined) {
      return false;
    }
    const expected = Buffer.from(`sha256=${createHmac("sha256", input.secret).update(input.body).digest("hex")}`);
    const given = Buffer.from(header);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  override parseWebhook(input: WebhookInput): AdapterResult<CodeHostWebhookEvent> {
    const event = input.headers["x-github-event"] ?? "unknown";
    const json = parseJson(input.body);
    if (!json.ok) {
      return adapterError("invalid-response", "not JSON");
    }
    const read = (...path: readonly string[]): unknown =>
      path.reduce<unknown>((at, key) => (typeof at === "object" && at !== null ? Reflect.get(at, key) : undefined), json.value);
    if (event === "issue_comment" || event === "pull_request_review_comment" || event === "push") {
      return this.#parseM3(event, read);
    }
    if (event === "installation") {
      // Milestone 4 (F-136): GitHub's shape, read as the GitHub adapter reads it.
      const action = read("action");
      const id = read("installation", "id");
      const accountId = read("installation", "account", "id");
      const login = read("installation", "account", "login");
      const type = read("installation", "account", "type");
      if (typeof action !== "string" || typeof id !== "number" || typeof accountId !== "number" || typeof login !== "string") {
        return adapterError("invalid-response", "not an installation event");
      }
      return ok({ kind: "installation", action, installationId: String(id), account: { accountId: String(accountId), login, kind: type === "User" ? "user" : "organization" } });
    }
    if (event === "pull_request_review") {
      return this.#parseReview(read);
    }
    if (event !== "pull_request") {
      return ok({ kind: "other", event });
    }
    const number = read("number");
    const repoId = read("repository", "id");
    const repo = repoFullNameSchema.safeParse(read("repository", "full_name"));
    const action = read("action");
    const headSha = read("pull_request", "head", "sha");
    const headBranch = read("pull_request", "head", "ref");
    const updatedAt = read("pull_request", "updated_at");
    const installation = read("installation", "id");
    if (
      typeof number !== "number" ||
      (typeof repoId !== "string" && typeof repoId !== "number") ||
      !repo.success ||
      typeof action !== "string" ||
      typeof headSha !== "string" ||
      typeof headBranch !== "string" ||
      typeof updatedAt !== "string"
    ) {
      return adapterError("invalid-response", "not a pull_request event");
    }
    return ok({
      kind: "pull_request",
      action,
      installationId: typeof installation === "number" ? String(installation) : null,
      hostRepoId: String(repoId),
      repo: repo.data,
      number,
      state: read("pull_request", "merged") === true ? "merged" : read("pull_request", "state") === "open" ? "open" : "closed",
      headBranch,
      headSha,
      changedAt: Date.parse(updatedAt),
    });
  }

  // Milestone 4 (F-104): a review, read as GitHub's adapter reads one. Its body is never read.
  #parseReview(read: (...path: readonly string[]) => unknown): AdapterResult<CodeHostWebhookEvent> {
    const number = read("pull_request", "number");
    const repoId = read("repository", "id");
    const repo = repoFullNameSchema.safeParse(read("repository", "full_name"));
    const action = read("action");
    const headSha = read("pull_request", "head", "sha");
    const reviewId = read("review", "id");
    const userId = read("review", "user", "id");
    const login = read("review", "user", "login");
    const state = read("review", "state");
    const installation = read("installation", "id");
    if (
      typeof number !== "number" ||
      (typeof repoId !== "string" && typeof repoId !== "number") ||
      !repo.success ||
      typeof action !== "string" ||
      typeof headSha !== "string" ||
      typeof reviewId !== "number" ||
      typeof userId !== "number" ||
      typeof login !== "string" ||
      typeof state !== "string"
    ) {
      return adapterError("invalid-response", "not a pull_request_review event");
    }
    const lower = state.toLowerCase();
    const submittedAt = read("review", "submitted_at");
    const commitId = read("review", "commit_id");
    return ok({
      kind: "pull_request_review",
      action,
      installationId: typeof installation === "number" ? String(installation) : null,
      hostRepoId: String(repoId),
      repo: repo.data,
      number,
      headSha,
      review: {
        reviewId: String(reviewId),
        userId: String(userId),
        login,
        isBot: read("review", "user", "type") === "Bot",
        state: lower === "approved" || lower === "changes_requested" || lower === "commented" || lower === "dismissed" ? lower : "pending",
        commitId: typeof commitId === "string" ? commitId : null,
        submittedAt: typeof submittedAt === "string" ? Date.parse(submittedAt) : null,
      },
    });
  }

  override listReviews(access: RepoAccess, number: number): Promise<AdapterResult<readonly PullRequestReview[]>> {
    if (!this.known(access.app)) {
      return Promise.resolve(adapterError("unauthorized", "refused"));
    }
    if (this.failReviewLists > 0) {
      this.failReviewLists -= 1;
      return Promise.resolve(adapterError("unavailable", "the fake host is down"));
    }
    return Promise.resolve(ok(this.reviewsAndChecks.reviews(access.repo, number)));
  }

  override publishCheckRun(access: RepoAccess, input: CheckRunInput): Promise<AdapterResult<PublishedCheckRun>> {
    return Promise.resolve(this.known(access.app) ? ok(this.reviewsAndChecks.publish(access.repo, input)) : adapterError("unauthorized", "refused"));
  }

  override updateCheckRun(access: RepoAccess, checkRunId: string, input: CheckRunInput): Promise<AdapterResult<void>> {
    if (!this.known(access.app)) {
      return Promise.resolve(adapterError("unauthorized", "refused"));
    }
    return Promise.resolve(this.reviewsAndChecks.update(access.repo, checkRunId, input) ? ok(undefined) : adapterError("not-found", "no such check run"));
  }

  #parseM3(event: "issue_comment" | "pull_request_review_comment" | "push", read: (...path: readonly string[]) => unknown): AdapterResult<CodeHostWebhookEvent> {
    const repoId = read("repository", "id");
    const repo = repoFullNameSchema.safeParse(read("repository", "full_name"));
    const installation = read("installation", "id");
    if ((typeof repoId !== "string" && typeof repoId !== "number") || !repo.success) {
      return adapterError("invalid-response", `not a ${event} event`);
    }
    const common = { installationId: typeof installation === "number" ? String(installation) : null, hostRepoId: String(repoId), repo: repo.data };
    if (event === "push") {
      const ref = read("ref");
      const before = read("before");
      const after = read("after");
      const commits = read("commits");
      if (typeof ref !== "string" || typeof before !== "string" || typeof after !== "string") {
        return adapterError("invalid-response", "not a push event");
      }
      const changedPaths = Array.isArray(commits)
        ? commits.flatMap((commit: unknown) =>
            ["added", "removed", "modified"].flatMap((key) => {
              const paths: unknown = typeof commit === "object" && commit !== null ? Reflect.get(commit, key) : undefined;
              return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string") : [];
            }),
          )
        : null;
      return ok({ kind: "push", ...common, ref, before, after, changedPaths });
    }
    const commentId = read("comment", "id");
    const authorId = read("comment", "user", "id");
    const authorLogin = read("comment", "user", "login");
    const body = read("comment", "body");
    const url = read("comment", "html_url");
    const action = read("action");
    const sender = read("sender", "id");
    if (
      typeof sender !== "number" ||
      typeof commentId !== "number" ||
      typeof authorId !== "number" ||
      typeof authorLogin !== "string" ||
      typeof body !== "string" ||
      typeof url !== "string" ||
      typeof action !== "string"
    ) {
      return adapterError("invalid-response", `not a ${event} event`);
    }
    const comment = { commentId: String(commentId), authorId: String(authorId), authorLogin, body, url };
    if (event === "issue_comment") {
      const number = read("issue", "number");
      if (typeof number !== "number") {
        return adapterError("invalid-response", "not an issue_comment event");
      }
      return ok({ kind: "issue_comment", action, ...common, number, onPullRequest: read("issue", "pull_request") !== undefined, comment, senderId: String(sender) });
    }
    const number = read("pull_request", "number");
    const path = read("comment", "path");
    const line = read("comment", "line");
    if (typeof number !== "number" || typeof path !== "string") {
      return adapterError("invalid-response", "not a pull_request_review_comment event");
    }
    return ok({
      kind: "pull_request_review_comment",
      action,
      ...common,
      number,
      comment,
      senderId: String(sender),
      path,
      side: read("comment", "side") === "LEFT" ? "old" : "new",
      line: typeof line === "number" ? line : null,
    });
  }

  override getPullRequest(access: RepoAccess, number: number): Promise<AdapterResult<PullRequestDetails>> {
    if (!this.known(access.app)) {
      return Promise.resolve(adapterError("unauthorized", "refused"));
    }
    this.prReads.push({ repo: access.repo, number });
    if (this.failReads > 0) {
      this.failReads -= 1;
      return Promise.resolve(adapterError("unavailable", "the host is down"));
    }
    const pull = this.pulls.find((candidate) => candidate.repo === access.repo && candidate.number === number);
    if (pull === undefined) {
      return Promise.resolve(adapterError("not-found", "no such PR"));
    }
    const state = this.#stateOf(access.repo, number);
    return Promise.resolve(
      ok({
        ...pull,
        state: state.state,
        merged: state.state === "merged",
        headSha: state.headSha,
        updatedAt: state.updatedAt,
        mergedAt: state.mergedAt,
        closedAt: state.closedAt,
      }),
    );
  }

  override deleteRef(access: RepoAccess, ref: string): Promise<AdapterResult<DeleteRefResult>> {
    if (!this.known(access.app)) {
      return Promise.resolve(adapterError("unauthorized", "refused"));
    }
    const deleted = !this.deletedRefs.some((done) => done.repo === access.repo && done.ref === ref);
    this.deletedRefs.push({ repo: access.repo, ref });
    return Promise.resolve(ok({ deleted }));
  }
}

/** A fake PR's merge state on the host. */
export type FakePullState = {
  state: "open" | "closed" | "merged";
  headSha: string;
  updatedAt: number;
  mergedAt: number | null;
  closedAt: number | null;
};

/** A model provider whose endpoints list a fixed set of models, by base URL. */
export class FakeModelProvider extends ModelProviderAdapter {
  readonly name = "fake-model-provider";
  readonly capabilities = { apiFormats: ["openai-compatible", "anthropic-messages"] as const, modelList: true, usageInStream: true };
  /** Base URL to the models its endpoint lists, and the token it takes. */
  readonly endpoints = new Map<string, { readonly token: string; readonly models: readonly EndpointModel[] }>();

  health(): Promise<HealthReport> {
    return healthy;
  }

  testConnection(endpoint: ModelEndpoint): Promise<AdapterResult<ConnectionTest>> {
    const found = this.endpoints.get(endpoint.baseUrl);
    return Promise.resolve(
      found?.token === endpoint.token ? ok({ apiFormat: "openai-compatible", authScheme: "bearer", models: found.models }) : adapterError("unauthorized", "refused"),
    );
  }

  listModels(endpoint: ModelEndpoint & { readonly apiFormat: ApiFormat }): Promise<AdapterResult<readonly EndpointModel[]>> {
    const found = this.endpoints.get(endpoint.baseUrl);
    if (found === undefined) {
      return Promise.resolve(adapterError("unavailable", "the endpoint didn't answer"));
    }
    return Promise.resolve(found.token === endpoint.token ? ok(found.models) : adapterError("unauthorized", "refused"));
  }

  matchCatalog(models: readonly EndpointModel[], catalog: readonly CatalogEntry[]): readonly CatalogMatch[] {
    return models.map((model) => {
      const entry = catalog.find((candidate) => candidate.catalogId === model.endpointModelId || candidate.aliases.includes(model.endpointModelId));
      return { endpointModelId: model.endpointModelId, match: entry === undefined ? { kind: "custom" } : { kind: "catalog", entry } };
    });
  }
}
