import type { GitPerson, RepoFullName } from "@ostra/protocol";

import { createPlumbing, defaultAdapterContext } from "../common/context.ts";
import type { AdapterContext, Plumbing } from "../common/context.ts";
import type { AdapterResult, HealthReport } from "../common/result.ts";
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
};

export type Installation = {
  readonly installationId: string;
  readonly accountLogin: string;
  readonly accountKind: "organization" | "user";
  readonly repositorySelection: "all" | "selected";
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

export type RepoPermission = "contents" | "pull_requests" | "metadata" | "checks" | "actions" | "workflows";
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

export type WebhookInput = {
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** The raw body, exactly as received: the signature is over these bytes. */
  readonly body: string;
  readonly secret: string;
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

  abstract getDefaultBranch(access: RepoAccess): Promise<AdapterResult<string>>;

  /** The repo's PR template, or `null` when it has none (F-078). */
  abstract getPullRequestTemplate(access: RepoAccess, ref: string): Promise<AdapterResult<string | null>>;

  /** The App's bot identity, which authors every commit (F-078, ADR 0040). */
  abstract getBotIdentity(app: CodeHostAppCredentials): Promise<AdapterResult<GitPerson>>;

  /** The PR whose head is `head`, or `null`: opening a PR is checked against this first. */
  abstract findPullRequest(access: RepoAccess, head: string): Promise<AdapterResult<PullRequest | null>>;

  /** Opens a PR as the App. Opening one that exists answers `conflict`. */
  abstract openPullRequest(input: OpenPullRequestInput): Promise<AdapterResult<PullRequest>>;

  /** Checks a webhook's signature. Milestone 2. */
  abstract verifyWebhook(input: WebhookInput): boolean;
}
