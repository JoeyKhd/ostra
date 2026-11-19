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
  CodeHostWebhookEvent,
  CreatedApp,
  DeleteRefResult,
  HostRepo,
  Installation,
  OpenPullRequestInput,
  PullRequest,
  PullRequestDetails,
  ReadFilesResult,
  RepoAccess,
  RepoToken,
  WebhookInput,
} from "../code-host/base.ts";
import type { CodeHostCapabilities } from "../code-host/capabilities.ts";
import { adapterError, ok } from "../common/result.ts";
import type { AdapterResult, HealthReport } from "../common/result.ts";
import { ExecutorAdapter } from "../executor/base.ts";
import type {
  AgentProcess,
  BoxRef,
  CreateBoxInput,
  CreatedBox,
  PrepareInput,
  PrepareResult,
  RepoPushResult,
  StopInput,
} from "../executor/base.ts";
import type { ExecutorCapabilities } from "../executor/capabilities.ts";
import { ModelProviderAdapter } from "../model-provider/base.ts";
import type { CatalogEntry, CatalogMatch, ConnectionTest, EndpointModel, ModelEndpoint } from "../model-provider/base.ts";
import type { ModelProviderCapabilities } from "../model-provider/capabilities.ts";
import { NotificationAdapter } from "../notification/base.ts";
import type { Notification } from "../notification/base.ts";
import type { SecretRowStore } from "../plumbing/stores.ts";
import { SecretStoreAdapter, secretRefSchema } from "../secret-store/base.ts";
import type { SecretRef, SecretScope } from "../secret-store/base.ts";
import type { StubEndpoint } from "../testing/model-provider-suite.ts";
import { TrackerAdapter } from "../tracker/base.ts";
import type {
  CodeHostIntegration,
  DownloadedFile,
  MoveResult,
  Ticket,
  TicketContext,
  TicketPage,
  TrackerBoard,
  TrackerStatus,
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
  };
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

export class TinyNotifier extends NotificationAdapter {
  readonly name = "tiny-notifier";
  readonly capabilities = { channels: ["panel"] };
  readonly sent: Notification[] = [];
  health(): Promise<HealthReport> {
    return Promise.resolve({ status: "ok" });
  }
  send(notification: Notification): Promise<AdapterResult<void>> {
    this.sent.push(notification);
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
};

export type MemoryHostWorld = {
  readonly app: CodeHostAppCredentials & { readonly slug: string; readonly name: string };
  readonly installationId: string;
  readonly repos: readonly MemoryRepo[];
};

const TEMPLATE_PATHS = [".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md", "pull_request_template.md"];

export class TinyCodeHost extends CodeHostAdapter {
  readonly name = "tiny-code-host";
  readonly capabilities: CodeHostCapabilities = { checkRuns: false, prTemplates: true, lfsActionHosts: [], branchRules: true };
  readonly #world: MemoryHostWorld;
  readonly #prs: (PullRequest & { readonly repo: RepoFullName; updatedAt: number; mergedAt: number | null; closedAt: number | null })[] = [];
  readonly #refs = new Map<string, Set<string>>();

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
    return repo !== undefined && access.installationId === this.#world.installationId
      ? ok(repo)
      : adapterError("not-found", "no such repo in the installation");
  }

  health(): Promise<HealthReport> {
    return Promise.resolve({ status: "ok" });
  }

  appManifest(input: AppManifestInput): AppManifest {
    return {
      manifest: {
        name: input.name,
        url: input.homepageUrl,
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
      }),
    );
  }

  listInstallations(app: CodeHostAppCredentials): Promise<AdapterResult<readonly Installation[]>> {
    if (!this.#authorized(app)) {
      return Promise.resolve(adapterError("unauthorized", "the App's credentials were refused"));
    }
    return Promise.resolve(
      ok([
        {
          installationId: this.#world.installationId,
          accountLogin: "test-org",
          accountKind: "organization",
          repositorySelection: "selected",
        },
      ]),
    );
  }

  listRepos(app: CodeHostAppCredentials, installationId: string): Promise<AdapterResult<readonly HostRepo[]>> {
    if (!this.#authorized(app) || installationId !== this.#world.installationId) {
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
    const pr = {
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
      ok({ ...withoutRepo(pr), merged: pr.state === "merged", headSha: "0".repeat(40), updatedAt: pr.updatedAt, mergedAt: pr.mergedAt, closedAt: pr.closedAt }),
    );
  }

  override parseWebhook(input: WebhookInput): AdapterResult<CodeHostWebhookEvent> {
    const event = input.headers["x-github-event"] ?? "unknown";
    if (event !== "pull_request") {
      return ok({ kind: "other", event });
    }
    let body: unknown;
    try {
      body = JSON.parse(input.body);
    } catch {
      return adapterError("invalid-response", "the webhook's body isn't JSON");
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
}

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

const withoutRepo = (pr: PullRequest & { readonly repo: RepoFullName }): PullRequest => ({
  number: pr.number,
  url: pr.url,
  state: pr.state,
  headBranch: pr.headBranch,
  baseBranch: pr.baseBranch,
  title: pr.title,
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
  readonly name = "tiny-executor";
  readonly capabilities: ExecutorCapabilities = {
    isolation: "none",
    services: false,
    boxSizes: false,
    snapshots: false,
    processContainment: "process-tree",
  };
  readonly #boxes = new Map<string, TinyBox>();

  health(): Promise<HealthReport> {
    return Promise.resolve({ status: "ok" });
  }

  async create(input: CreateBoxInput): Promise<AdapterResult<CreatedBox>> {
    const root = await mkdtemp(path.join(tmpdir(), "ostra-tiny-box-"));
    const created = { workspaceDir: path.join(root, "workspace"), agentDir: path.join(root, "agent"), gitConfig: path.join(root, "git", "config") };
    await mkdir(created.workspaceDir, { recursive: true });
    await mkdir(created.agentDir, { recursive: true });
    this.#boxes.set(String(input.boxId), { state: "creating", root, created, child: undefined });
    return ok(created);
  }

  async prepare(input: PrepareInput): Promise<AdapterResult<PrepareResult>> {
    const box = this.#boxes.get(String(input.box.boxId));
    if (box === undefined) {
      return adapterError("not-found", "no such box");
    }
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
