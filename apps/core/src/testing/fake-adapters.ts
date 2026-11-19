import { randomUUID } from "node:crypto";

import { adapterError, CodeHostAdapter, ModelProviderAdapter, ok, secretRefSchema, SecretStoreAdapter } from "@ostra/adapter-sdk";
import type {
  AdapterResult,
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
  PermissionLevel,
  PullRequest,
  ReadFilesResult,
  RepoAccess,
  RepoPermission,
  RepoToken,
  SecretRef,
  SecretScope,
} from "@ostra/adapter-sdk";
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
    return Promise.resolve(ok(pull));
  }

  verifyWebhook(): boolean {
    return false;
  }
}

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
