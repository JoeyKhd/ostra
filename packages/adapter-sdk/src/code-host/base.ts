import type { GitPerson, RepoFullName } from "@ostra/protocol";

import { createPlumbing, defaultAdapterContext } from "../common/context.ts";
import type { AdapterContext, Plumbing } from "../common/context.ts";
import { adapterError } from "../common/result.ts";
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

/** One answer of `readBranchRules`: `unknown` when the host can't say, and `reasons` says why. */
export type BranchRules = {
  readonly protected: boolean | "unknown";
  readonly requiresSignedCommits: boolean | "unknown";
  /** Words for the panel, one per check that isn't a plain yes: never a vendor's body. */
  readonly reasons: readonly string[];
};

/** A PR's state, for the reconcile (F-044). */
export type PullRequestDetails = PullRequest & {
  readonly merged: boolean;
  readonly headSha: string;
  /** In ms since the epoch. */
  readonly updatedAt: number;
  readonly mergedAt: number | null;
  readonly closedAt: number | null;
};

/** A verified webhook, read loosely. Only `pull_request` events are read in milestone 2. */
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
  /** Every other event: recorded and not acted on. */
  | { readonly kind: "other"; readonly event: string };

/** A ref on the host, full, such as `refs/ostra/wip/<taskId>`. */
export type DeleteRefResult = {
  /** `false` when there was no such ref: deleting it again is not an error. */
  readonly deleted: boolean;
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
}
