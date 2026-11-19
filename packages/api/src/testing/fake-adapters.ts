import { randomUUID } from "node:crypto";

import { CodeHostAdapter, ModelProviderAdapter, SecretStoreAdapter, adapterError, ok, secretRefSchema } from "@ostra/adapter-sdk";
import type {
  AdapterResult,
  BranchRules,
  AppInfo,
  AppManifest,
  AppManifestInput,
  CatalogEntry,
  CatalogMatch,
  CodeHostAppCredentials,
  CodeHostCapabilities,
  ConnectionTest,
  CreatedApp,
  EndpointModel,
  HealthReport,
  HostRepo,
  Installation,
  ModelEndpoint,
  PullRequest,
  ReadFilesResult,
  RepoAccess,
  RepoToken,
  SecretRef,
  SecretScope,
} from "@ostra/adapter-sdk";
import type { ApiFormat, AuthScheme, GitPerson, OrganizationId } from "@ostra/protocol";

// Fake adapters for the API's tests (spec section 8): small, in memory, and honest about what they
// refuse. Each is a real subclass of its kind's base class (ADR 0025), so a router that works with
// these works through the shared interface. They are never shipped.

const healthy: Promise<HealthReport> = Promise.resolve({ status: "ok" });

// ---------- the secret store ----------

type StoredSecret = { readonly organizationId: OrganizationId; readonly purpose: string; readonly value: string };

/** A secret store that keeps values in memory, scoped by organization like the real one. */
export class FakeSecretStore extends SecretStoreAdapter {
  readonly name = "fake-secret-store";
  readonly capabilities = { rotation: false };
  readonly entries = new Map<string, StoredSecret>();

  health(): Promise<HealthReport> {
    return healthy;
  }

  put(scope: SecretScope, value: string): Promise<AdapterResult<SecretRef>> {
    const ref = secretRefSchema.parse(`fake:${randomUUID()}`);
    this.entries.set(ref, { organizationId: scope.organizationId, purpose: scope.purpose, value });
    return Promise.resolve(ok(ref));
  }

  get(organizationId: OrganizationId, ref: SecretRef): Promise<AdapterResult<string>> {
    const found = this.entries.get(ref);
    if (found?.organizationId !== organizationId) {
      return Promise.resolve(adapterError("not-found", "no such secret"));
    }
    return Promise.resolve(ok(found.value));
  }

  delete(organizationId: OrganizationId, ref: SecretRef): Promise<AdapterResult<void>> {
    const found = this.entries.get(ref);
    if (found?.organizationId !== organizationId) {
      return Promise.resolve(adapterError("not-found", "no such secret"));
    }
    this.entries.delete(ref);
    return Promise.resolve(ok(undefined));
  }

  /** Every value held, for a test that searches an output for them. */
  values(): readonly string[] {
    return [...this.entries.values()].map((entry) => entry.value);
  }
}

// ---------- the model provider ----------

export type FakeEndpoint = {
  readonly token: string;
  readonly apiFormat: ApiFormat;
  readonly authScheme: AuthScheme;
  readonly models: readonly EndpointModel[];
};

/** A model provider adapter over a table of endpoints: the right token lists the models. */
export class FakeModelProvider extends ModelProviderAdapter {
  readonly name = "fake-model-provider";
  readonly capabilities = { apiFormats: ["openai-compatible", "anthropic-messages"] as const, modelList: true, usageInStream: true };
  /** By base URL. */
  readonly endpoints = new Map<string, FakeEndpoint>();
  /** The tokens `testConnection` was called with, so a test can check what reached the adapter. */
  readonly testedTokens: string[] = [];

  health(): Promise<HealthReport> {
    return healthy;
  }

  testConnection(endpoint: ModelEndpoint): Promise<AdapterResult<ConnectionTest>> {
    this.testedTokens.push(endpoint.token);
    const found = this.endpoints.get(endpoint.baseUrl);
    if (found === undefined) {
      return Promise.resolve(adapterError("unavailable", "the endpoint didn't answer"));
    }
    if (found.token !== endpoint.token) {
      return Promise.resolve(adapterError("unauthorized", "the endpoint refused the token"));
    }
    return Promise.resolve(ok({ apiFormat: found.apiFormat, authScheme: found.authScheme, models: found.models }));
  }

  listModels(endpoint: ModelEndpoint & { readonly apiFormat: ApiFormat }): Promise<AdapterResult<readonly EndpointModel[]>> {
    const found = this.endpoints.get(endpoint.baseUrl);
    if (found === undefined) {
      return Promise.resolve(adapterError("unavailable", "the endpoint didn't answer"));
    }
    if (found.token !== endpoint.token) {
      return Promise.resolve(adapterError("unauthorized", "the endpoint refused the token"));
    }
    return Promise.resolve(ok(found.models));
  }

  matchCatalog(models: readonly EndpointModel[], catalog: readonly CatalogEntry[]): readonly CatalogMatch[] {
    return models.map((model) => {
      const entry = catalog.find((candidate) => candidate.aliases.includes(model.endpointModelId));
      return {
        endpointModelId: model.endpointModelId,
        match: entry === undefined ? { kind: "custom" } : { kind: "catalog", entry },
      };
    });
  }
}

// ---------- the code host ----------

export type FakeApp = {
  readonly privateKey: string;
  readonly info: AppInfo;
  readonly bot: GitPerson;
  readonly installations: readonly Installation[];
  /** Repos by installation ID. */
  readonly repos: ReadonlyMap<string, readonly HostRepo[]>;
};

/** A code host with a few Apps, their installations, repos and files. */
export class FakeCodeHost extends CodeHostAdapter {
  readonly name = "fake-code-host";
  readonly capabilities: CodeHostCapabilities = { checkRuns: true, prTemplates: true, lfsActionHosts: [], branchRules: true };
  /** By App ID. */
  readonly apps = new Map<string, FakeApp>();
  /** File contents by `owner/name`, then path. */
  readonly files = new Map<string, ReadonlyMap<string, string>>();
  /** When true, `listTree` lists a repo's files; otherwise it answers `unsupported` like a host that can't. */
  treeEnabled = false;
  /** What `convertManifestCode` returns for a code. */
  readonly manifestCodes = new Map<string, CreatedApp>();
  /** The manifests `appManifest` produced. */
  readonly manifests: AppManifestInput[] = [];
  /** What `readBranchRules` answers for a repo (`owner/name`); a repo not listed is unprotected and unsigned. */
  readonly branchRules = new Map<string, BranchRules>();
  /** How `readBranchRules` fails for every repo: `unsupported` like a host without the capability, or `down`. */
  branchRulesFailure: "unsupported" | "down" | null = null;
  /** How many times `readBranchRules` was called. */
  branchRulesReads = 0;

  health(): Promise<HealthReport> {
    return healthy;
  }

  private app(credentials: CodeHostAppCredentials): FakeApp | undefined {
    const found = this.apps.get(credentials.appId);
    return found?.privateKey === credentials.privateKey ? found : undefined;
  }

  appManifest(input: AppManifestInput): AppManifest {
    this.manifests.push(input);
    // Like the real host, a private address gets a manifest without a webhook (GitHub refuses one).
    const privateAddress = /localhost|127\.0\.0\.1|\.local\b/.test(input.webhookUrl);
    return {
      manifest: {
        name: input.name,
        url: input.homepageUrl,
        redirect_url: input.redirectUrl,
        ...(privateAddress ? {} : { hook_attributes: { url: input.webhookUrl, active: true } }),
      },
      createUrl: 'https://github.example/settings/apps/new',
    };
  }

  convertManifestCode(code: string): Promise<AdapterResult<CreatedApp>> {
    const created = this.manifestCodes.get(code);
    return Promise.resolve(created === undefined ? adapterError("not-found", "no such manifest code") : ok(created));
  }

  readApp(credentials: CodeHostAppCredentials): Promise<AdapterResult<AppInfo>> {
    const found = this.app(credentials);
    return Promise.resolve(found === undefined ? adapterError("unauthorized", "the App's credentials were refused") : ok(found.info));
  }

  listInstallations(credentials: CodeHostAppCredentials): Promise<AdapterResult<readonly Installation[]>> {
    const found = this.app(credentials);
    return Promise.resolve(found === undefined ? adapterError("unauthorized", "the App's credentials were refused") : ok(found.installations));
  }

  listRepos(credentials: CodeHostAppCredentials, installationId: string): Promise<AdapterResult<readonly HostRepo[]>> {
    const found = this.app(credentials);
    if (found === undefined) {
      return Promise.resolve(adapterError("unauthorized", "the App's credentials were refused"));
    }
    const repos = found.repos.get(installationId);
    return Promise.resolve(repos === undefined ? adapterError("not-found", "no such installation") : ok(repos));
  }

  mintRepoToken(): Promise<AdapterResult<RepoToken>> {
    return Promise.resolve(ok({ token: `fake-repo-token-${randomUUID()}`, expiresAt: Date.now() + 3_600_000 }));
  }

  readFiles(access: RepoAccess, _ref: string, paths: readonly string[]): Promise<AdapterResult<ReadFilesResult>> {
    const repoFiles = this.files.get(access.repo);
    if (repoFiles === undefined) {
      return Promise.resolve(adapterError("not-found", "no such repo"));
    }
    const files: { path: string; content: string }[] = [];
    const missing: string[] = [];
    for (const path of paths) {
      const content = repoFiles.get(path);
      if (content === undefined) {
        missing.push(path);
      } else {
        files.push({ path, content });
      }
    }
    return Promise.resolve(ok({ files, missing }));
  }

  override listTree(access: RepoAccess, ref: string): Promise<AdapterResult<readonly string[]>> {
    const repoFiles = this.files.get(access.repo);
    if (!this.treeEnabled || repoFiles === undefined) {
      return super.listTree(access, ref);
    }
    return Promise.resolve(ok([...repoFiles.keys()]));
  }

  getDefaultBranch(access: RepoAccess): Promise<AdapterResult<string>> {
    for (const app of this.apps.values()) {
      for (const repos of app.repos.values()) {
        const repo = repos.find((candidate) => candidate.fullName === access.repo);
        if (repo !== undefined) {
          return Promise.resolve(ok(repo.defaultBranch));
        }
      }
    }
    return Promise.resolve(adapterError("not-found", "no such repo"));
  }

  getPullRequestTemplate(): Promise<AdapterResult<string | null>> {
    return Promise.resolve(ok(null));
  }

  getBotIdentity(credentials: CodeHostAppCredentials): Promise<AdapterResult<GitPerson>> {
    const found = this.app(credentials);
    return Promise.resolve(found === undefined ? adapterError("unauthorized", "the App's credentials were refused") : ok(found.bot));
  }

  findPullRequest(): Promise<AdapterResult<PullRequest | null>> {
    return Promise.resolve(ok(null));
  }

  openPullRequest(): Promise<AdapterResult<PullRequest>> {
    return Promise.resolve(adapterError("unsupported", "the fake code host opens no PRs"));
  }

  verifyWebhook(): boolean {
    return false;
  }

  override readBranchRules(access: RepoAccess): Promise<AdapterResult<BranchRules>> {
    this.branchRulesReads += 1;
    if (this.branchRulesFailure === "unsupported") {
      return Promise.resolve(adapterError("unsupported", "the fake code host can't read branch rules"));
    }
    if (this.branchRulesFailure === "down") {
      return Promise.resolve(adapterError("unavailable", "the fake code host did not answer"));
    }
    return Promise.resolve(ok(this.branchRules.get(access.repo) ?? { protected: false, requiresSignedCommits: false, reasons: [] }));
  }
}
