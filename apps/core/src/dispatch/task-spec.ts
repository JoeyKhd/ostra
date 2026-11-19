import { secretRefSchema } from "@ostra/adapter-sdk";
import type { CodeHostAdapter, CodeHostAppCredentials, SecretStoreAdapter } from "@ostra/adapter-sdk";
import { apiFormatFromDb, effortLevelFromDb, mapModel } from "@ostra/db";
import type { Db } from "@ostra/db";
import { buildMemoryBlock, githubNoReplyAddress, modelEffort, modelTokenPrices, sessionRowAllowedInTx, spendCapFor, taskTokensInTx } from "@ostra/domain";
import type { AgentEffortLevels, MemoryLimits, SpendCapSettings } from "@ostra/domain";
import { gitPersonSchema, organizationIdSchema, PROTOCOL_MINOR, projectIdSchema, repoFullNameSchema, taskIdSchema, taskSpecSchema } from "@ostra/protocol";
import type { GitPerson, LeaseEpoch, OrganizationId, RunnerId, TaskId, TaskSpec } from "@ostra/protocol";
import { agentEffortLevels } from "../agents/effort-levels.ts";
import type { BlobService } from "../blobs/blob-service.ts";
import { agentInstructions } from "./agent-instructions.ts";
import { specChecks, specServices, specSnapshot } from "./environment-spec.ts";
import { profileSpecParts } from "./profile-spec.ts";
import { specMilestone2Parts } from "./restore-spec.ts";

// `GET /runner/v1/tasks/:taskId/spec` (ticket 26, ADR 0034): what a dispatch hands the runner once it
// accepted the offer, for the lease holder only. References and the task's text, never a secret:
// those are the credentials, fetched after the lease check. It names the App's bot (who authors
// every commit), the prompting member as co-author (spec section 11, item 4), each repo's PR
// template and the code host's LFS hosts, and the branch the task's rule made (item 10).

/** The longest a turn may run in milestone 1 before the runner cancels it. */
export const TURN_MAX_MINUTES = 120;

export type SpecFailure =
  | { readonly ok: false; readonly error: "not-found"; readonly message: string }
  | { readonly ok: false; readonly error: "stale-lease"; readonly message: string; readonly currentEpoch: number }
  | { readonly ok: false; readonly error: "code-host-failed"; readonly message: string }
  /** Milestone 3: the profile's rules or servers don't parse, or its skills couldn't be copied. */
  | { readonly ok: false; readonly error: "profile-unusable"; readonly message: string }
  /** Milestone 4 (F-135): the session's provider is no longer on its project's list. */
  | { readonly ok: false; readonly error: "provider-not-allowed"; readonly message: string };

export type SpecResult = { readonly ok: true; readonly spec: TaskSpec } | SpecFailure;

/**
 * The settings the spec carries to a minor-1 runner (milestone 2): the idle timer (F-096) and the
 * spend cap (F-068). Without them the spec has milestone 1's limits only.
 */
export type TaskSpecSettings = {
  /** `OSTRA_BOX_IDLE_MINUTES`. */
  readonly idleMinutes: number;
  readonly spendCap: SpendCapSettings;
};

export type SpecDeps = {
  readonly db: Db;
  readonly codeHost: CodeHostAdapter;
  readonly secretStore: SecretStoreAdapter;
  readonly settings?: TaskSpecSettings;
  /** Milestone 3: copies a profile's skills into the blob store, as blobs of the task. Without it a profile with skills is refused. */
  readonly blobs?: Pick<BlobService, "put" | "read">;
  /**
   * Milestone 4 (F-110): how each agent adapter takes memory, by its name. An agent that declares
   * `mcp` gets the memory tools on a minor-3 runner; any other gets the block only.
   */
  readonly agentMemory?: (adapter: string) => "mcp" | "index-only" | undefined;
  /** Milestone 4: the index's limits (`OSTRA_MEMORY_*`); the protocol's working values without it. */
  readonly memoryLimits?: MemoryLimits;
  /** Milestone 4 (F-137): the levels each agent can send for a model. Core's agent registry when unset. */
  readonly effortLevels?: AgentEffortLevels;
};

/**
 * The spec's `limits`: the turn's longest run, and for milestone 2 the idle timer and the spend
 * cap with what the task already spent in every session, so the cap holds across a reopen. The
 * maximum duration and the stall are core's own timers, so the runner isn't told them.
 */
export const specLimits = async (
  deps: Pick<SpecDeps, "db" | "settings">,
  task: { readonly id: string; readonly spentMicroUsd: number },
  model: Parameters<typeof modelTokenPrices>[0],
): Promise<Record<string, unknown>> => {
  if (deps.settings === undefined) {
    return { turnMaxMinutes: TURN_MAX_MINUTES };
  }
  const tokens = await taskTokensInTx(deps.db, taskIdSchema.parse(task.id));
  return {
    turnMaxMinutes: TURN_MAX_MINUTES,
    idleMinutes: deps.settings.idleMinutes,
    spendCap: spendCapFor(deps.settings.spendCap, modelTokenPrices(model), { microUsd: task.spentMicroUsd, tokens }),
  };
};

const appCredentials = async (
  secretStore: SecretStoreAdapter,
  organizationId: OrganizationId,
  connection: { readonly appId: string; readonly privateKeySecretRef: string | null },
): Promise<CodeHostAppCredentials | null> => {
  if (connection.privateKeySecretRef === null) {
    return null;
  }
  const key = await secretStore.get(organizationId, secretRefSchema.parse(connection.privateKeySecretRef));
  return key.ok ? { appId: connection.appId, privateKey: key.value } : null;
};

export const buildTaskSpec = async (
  deps: SpecDeps,
  input: {
    readonly taskId: TaskId;
    readonly runnerId: RunnerId;
    readonly leaseEpoch: LeaseEpoch;
    /** The minor the runner reads the spec at; the current one without it. Below 3, memory is folded into the instructions. */
    readonly minor?: number;
  },
): Promise<SpecResult> => {
  const { db } = deps;
  const held = await db.lease.findFirst({ where: { taskId: input.taskId, runnerId: input.runnerId }, orderBy: { epoch: "desc" } });
  if (held === null) {
    return { ok: false, error: "not-found", message: "no such task for this runner" };
  }
  const task = await db.task.findFirst({ where: { id: input.taskId, organizationId: held.organizationId } });
  if (task === null) {
    return { ok: false, error: "not-found", message: "no such task for this runner" };
  }
  const lease = await db.lease.findFirst({ where: { taskId: task.id, runnerId: input.runnerId, epoch: input.leaseEpoch, state: "active" } });
  if (lease === null || task.leaseEpoch !== input.leaseEpoch) {
    return { ok: false, error: "stale-lease", message: "the lease has moved on", currentEpoch: task.leaseEpoch };
  }
  const organizationId = organizationIdSchema.parse(task.organizationId);
  const session = await db.session.findFirst({ where: { taskId: task.id, boxId: lease.boxId }, orderBy: { startedAt: "desc" } });
  const profileId = session?.agentProfileId ?? null;
  const profile = profileId === null ? null : await db.agentProfile.findFirst({ where: { id: profileId, organizationId } });
  // Milestone 4 (F-135, ADR 0065): the session's own model row, which its start resolved through the
  // project's list; the profile names the model only by name. The spend cap's prices are this row's.
  const model =
    session?.modelId === null || session === null
      ? null
      : await db.model.findFirst({ where: { id: session.modelId, organizationId }, include: { provider: true } });
  if (session === null || profile === null || model === null || session.providerId === null) {
    return { ok: false, error: "not-found", message: "the task's session has no agent profile with a model" };
  }
  if (!(await sessionRowAllowedInTx(db, { organizationId, projectId: projectIdSchema.parse(task.projectId), providerId: session.providerId, modelId: model.id }))) {
    return { ok: false, error: "provider-not-allowed", message: "the session's model provider isn't on its project's list" };
  }

  const taskRepos = await db.taskRepo.findMany({
    where: { taskId: task.id },
    include: { repo: { include: { connection: true } } },
    // F-098: the project's order, then the order the task got them.
    orderBy: [{ repo: { position: "asc" } }, { createdAt: "asc" }],
  });
  const environment = await db.environment.findUnique({ where: { projectId: task.projectId } });
  const entries =
    environment === null
      ? []
      : await db.environmentEntry.findMany({ where: { environmentId: environment.id, kind: { in: ["variable", "file"] } }, orderBy: { createdAt: "asc" } });

  let gitIdentity: GitPerson | null = null;
  // Plain data until `taskSpecSchema` parses the whole spec below, which checks every field.
  const repos: Record<string, unknown>[] = [];
  for (const { repo, branchName: repoBranch } of taskRepos) {
    const app =await appCredentials(deps.secretStore, organizationId, repo.connection);
    if (app === null) {
      return { ok: false, error: "code-host-failed", message: "the repo's App credentials couldn't be read" };
    }
    const access = { app, installationId: repo.installationId, repo: repoFullNameSchema.parse(repo.fullName) };
    // The clone URL is the code host's own, from its listing: core never builds a host's URL.
    const listed = await deps.codeHost.listRepos(app, repo.installationId);
    const hostRepo = listed.ok ? listed.value.find((candidate) => candidate.hostRepoId === repo.hostRepoId) : undefined;
    if (hostRepo === undefined) {
      return { ok: false, error: "code-host-failed", message: "the code host doesn't list the repo for this installation" };
    }
    const template = deps.codeHost.capabilities.prTemplates ? await deps.codeHost.getPullRequestTemplate(access, repo.defaultBranch) : null;
    if (gitIdentity === null) {
      const stored = gitPersonSchema.safeParse({ name: repo.connection.botName, email: repo.connection.botEmail });
      if (stored.success) {
        gitIdentity = stored.data;
      } else {
        const bot = await deps.codeHost.getBotIdentity(app);
        if (!bot.ok) {
          return { ok: false, error: "code-host-failed", message: "the App's bot identity couldn't be read" };
        }
        gitIdentity = bot.value;
      }
    }
    repos.push({
      repoId: repo.id,
      fullName: repo.fullName,
      cloneUrl: hostRepo.cloneUrl,
      defaultBranch: repo.defaultBranch,
      checkoutDir: repo.checkoutDir,
      lfsActionHosts: [...deps.codeHost.capabilities.lfsActionHosts],
      prTemplate: template?.ok === true ? template.value : null,
      // F-066: a repo whose branch isn't the task's (a reopen after a partial merge) carries its own.
      ...(repoBranch === task.branchName ? {} : { branchName: repoBranch }),
    });
  }
  if (gitIdentity === null) {
    return { ok: false, error: "not-found", message: "the task has no repo" };
  }

  // A member with a verified GitHub link (F-119, ADR 0052) is credited by their no-reply address; one
  // without, by the name and email they had when the task started. Read now, so a link made after the
  // task began is used from the next commit on.
  const coAuthorRows = await db.taskCoAuthor.findMany({ where: { taskId: task.id }, orderBy: { createdAt: "asc" } });
  const linked = await db.member.findMany({
    where: { id: { in: coAuthorRows.flatMap((row) => (row.memberId === null ? [] : [row.memberId])) }, organizationId },
    select: { id: true, user: { select: { githubUserId: true, githubLogin: true } } },
  });
  const coAuthors = coAuthorRows
    .map((row) => {
      const user = linked.find((member) => member.id === row.memberId)?.user;
      return user?.githubUserId !== undefined && user.githubUserId !== null && user.githubLogin !== null
        ? { name: row.name, email: githubNoReplyAddress(user.githubUserId, user.githubLogin) }
        : { name: row.name, email: row.email };
    })
    .map((person) => gitPersonSchema.safeParse(person))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []));

  // Milestone 3 (ticket 16): the profile's skills, MCP servers and rules, the task's rules, plan first.
  const profileParts = await profileSpecParts({ db, ...(deps.blobs === undefined ? {} : { blobs: deps.blobs }) }, task, session, profile);
  if (!profileParts.ok) {
    return { ok: false, error: "profile-unusable", message: profileParts.message };
  }
  const parts = profileParts.parts;

  // Milestone 2 (ticket 18): the ticket, its images, and a reopen's restore section and template.
  const extras = await specMilestone2Parts(db, task, session);
  // Milestone 3 (ticket 27): the environment's services, for a runner that can start them.
  const services = await specServices(db, task);
  // Milestone 3 (ticket 23): the environment's checks, run after every turn with changes.
  const checks = await specChecks(db, task, taskRepos.map(({ repo }) => repo.id));
  // Milestone 3 (ticket 26): the snapshot this runner holds, or the host's dependency cache.
  const snapshot = await specSnapshot(db, task, lease);
  // Milestone 4 (ticket 15, F-110): the project's and the organization's approved notes. A minor-3
  // runner gets the section, with the tools for an MCP agent; a minor-2 one gets the block, rendered
  // without the tools, at the end of its instructions.
  const minor = input.minor ?? PROTOCOL_MINOR;
  const tools = minor >= 3 && deps.agentMemory?.(profile.adapter) === "mcp";
  const memory = await buildMemoryBlock(db, { organizationId, projectId: projectIdSchema.parse(task.projectId), tools }, deps.memoryLimits);
  const folded = minor < 3 ? (memory?.block ?? null) : null;
  // Milestone 4 (F-137, ADR 0066): the task's level clamped to the model's levels, with the
  // model's controls and real limits. Every session's spec reads the task's level the same way, so
  // a reopen in a fresh box or on the template starts at it too.
  const apiFormat = apiFormatFromDb[model.provider.apiFormat];
  const effort = modelEffort(deps.effortLevels ?? agentEffortLevels, { adapter: profile.adapter, apiFormat, model: mapModel(model), level: effortLevelFromDb[task.effort] });
  const spec = taskSpecSchema.parse({
    taskId: task.id,
    sessionId: session.id,
    projectId: task.projectId,
    organizationId,
    kind: task.kind,
    title: task.title,
    prompt: extras.prompt ?? task.prompt ?? "",
    ticket: extras.ticket,
    contextFiles: extras.contextFiles,
    ...(extras.restore === undefined ? {} : { restore: extras.restore }),
    branchName: task.branchName,
    leaseEpoch: input.leaseEpoch,
    repos,
    agent: {
      profileId: profile.id,
      adapter: profile.adapter,
      providerId: model.providerId,
      modelId: model.id,
      endpointModelId: model.endpointModelId,
      apiFormat,
      instructions: agentInstructions(
        profile.instructions,
        taskRepos.map(({ repo, branchName: repoBranch }) => ({
          fullName: repoFullNameSchema.parse(repo.fullName),
          checkoutDir: repo.checkoutDir,
          defaultBranch: repo.defaultBranch,
          ...(repoBranch === task.branchName ? {} : { branchName: repoBranch }),
        })),
        task.branchName,
        folded,
      ),
      skills: parts.skills,
      mcpServers: parts.mcpServers,
      approvalRules: parts.approvalRules,
      taskRules: parts.taskRules,
      planFirst: parts.planFirst,
      closingTurn: profile.closingTurn,
      effort: effort.effort.level,
      reasoning: effort.reasoning,
      limits: effort.limits,
    },
    firstTurnMode: parts.firstTurnMode,
    environment: {
      setupScript: environment?.setupScript ?? null,
      baseImage: environment?.baseImage ?? null,
      repos: taskRepos.map(({ repo }) => ({
        repoId: repo.id,
        variables: entries
          .filter((entry) => entry.repoId === repo.id && entry.kind === "variable" && entry.name !== null)
          .map((entry) => ({ name: entry.name, value: entry.value ?? "", availableDuringSetup: entry.availableDuringSetup })),
        files: entries
          .filter((entry) => entry.repoId === repo.id && entry.kind === "file" && entry.path !== null)
          .map((entry) => ({ path: entry.path, content: entry.value ?? "" })),
        envFile: repo.envFile,
      })),
    },
    gitIdentity,
    coAuthors,
    limits: await specLimits(deps, task, model),
    ...(checks.length === 0 ? {} : { checks }),
    ...(services.length === 0 ? {} : { services }),
    ...(snapshot === undefined ? {} : { snapshot }),
    ...(minor >= 3 ? { memory } : {}),
  });
  return { ok: true, spec };
};
