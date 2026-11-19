import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { adapterError, CodeHostAdapter, ModelProviderAdapter, ok, secretRefSchema, SecretStoreAdapter } from "@ostra/adapter-sdk";
import type {
  AdapterResult,
  CodeHostWebhookEvent,
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
  readonly capabilities: CodeHostCapabilities = { checkRuns: true, prTemplates: true, lfsActionHosts: ["lfs.example.test"], branchRules: false };
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

  readApp(app: CodeHostAppCredentials): Promise<AdapterResult<AppInfo>> {
    return Promise.resolve(
      this.known(app) ? ok({ appId: app.appId, slug: "ostra-test", name: "ostra-test", permissions: {}, events: [] }) : adapterError("unauthorized", "refused"),
    );
  }

  listInstallations(): Promise<AdapterResult<readonly Installation[]>> {
    return Promise.resolve(ok([]));
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
    if (event !== "pull_request") {
      return ok({ kind: "other", event });
    }
    const read = (...path: readonly string[]): unknown =>
      path.reduce<unknown>((at, key) => (typeof at === "object" && at !== null ? Reflect.get(at, key) : undefined), json.value);
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
