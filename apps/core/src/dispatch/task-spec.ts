import { secretRefSchema } from "@ostra/adapter-sdk";
import type { CodeHostAdapter, CodeHostAppCredentials, SecretStoreAdapter } from "@ostra/adapter-sdk";
import { apiFormatFromDb } from "@ostra/db";
import type { Db } from "@ostra/db";
import { modelTokenPrices, spendCapFor, taskTokensInTx } from "@ostra/domain";
import type { SpendCapSettings } from "@ostra/domain";
import { gitPersonSchema, organizationIdSchema, repoFullNameSchema, taskIdSchema, taskSpecSchema } from "@ostra/protocol";
import type { GitPerson, LeaseEpoch, OrganizationId, RunnerId, TaskId, TaskSpec } from "@ostra/protocol";
import { agentInstructions } from "./agent-instructions.ts";
import { specServices } from "./environment-spec.ts";
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
  | { readonly ok: false; readonly error: "code-host-failed"; readonly message: string };

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
  input: { readonly taskId: TaskId; readonly runnerId: RunnerId; readonly leaseEpoch: LeaseEpoch },
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
  const profile =
    profileId === null
      ? null
      : await db.agentProfile.findFirst({ where: { id: profileId, organizationId }, include: { model: { include: { provider: true } } } });
  const model = profile?.model;
  if (session === null || profile === null || model === undefined || model === null) {
    return { ok: false, error: "not-found", message: "the task's session has no agent profile with a model" };
  }

  const taskRepos = await db.taskRepo.findMany({
    where: { taskId: task.id },
    include: { repo: { include: { connection: true } } },
    orderBy: { createdAt: "asc" },
  });
  const environment = await db.environment.findUnique({ where: { projectId: task.projectId } });
  const entries =
    environment === null
      ? []
      : await db.environmentEntry.findMany({ where: { environmentId: environment.id, kind: { in: ["variable", "file"] } }, orderBy: { createdAt: "asc" } });

  let gitIdentity: GitPerson | null = null;
  // Plain data until `taskSpecSchema` parses the whole spec below, which checks every field.
  const repos: Record<string, unknown>[] = [];
  for (const { repo } of taskRepos) {
    const app = await appCredentials(deps.secretStore, organizationId, repo.connection);
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
    });
  }
  if (gitIdentity === null) {
    return { ok: false, error: "not-found", message: "the task has no repo" };
  }

  const coAuthors = (await db.taskCoAuthor.findMany({ where: { taskId: task.id }, orderBy: { createdAt: "asc" } }))
    .map((row) => gitPersonSchema.safeParse({ name: row.name, email: row.email }))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []));

  // Milestone 2 (ticket 18): the ticket, its images, and a reopen's restore section and template.
  const extras = await specMilestone2Parts(db, task, session);
  // Milestone 3 (ticket 27): the environment's services, for a runner that can start them.
  const services = await specServices(db, task);
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
      apiFormat: apiFormatFromDb[model.provider.apiFormat],
      instructions: agentInstructions(
        profile.instructions,
        taskRepos.map(({ repo }) => ({ fullName: repo.fullName, checkoutDir: repo.checkoutDir })),
      ),
    },
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
    ...(services.length === 0 ? {} : { services }),
  });
  return { ok: true, spec };
};
