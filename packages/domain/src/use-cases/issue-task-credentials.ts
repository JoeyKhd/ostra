import { secretRefSchema } from "@ostra/adapter-sdk";
import { apiFormatFromDb, authSchemeFromDb } from "@ostra/db";
import type { Tx } from "@ostra/db";
import { organizationIdSchema, projectIdSchema, repoFullNameSchema, repoIdSchema, runnerIdSchema, taskCredentialsRequestSchema, taskCredentialsSchema } from "@ostra/protocol";
import type { LeaseEpoch, OrganizationId, RepoSecret, ServiceSecrets, TaskCredentials, TaskId } from "@ostra/protocol";
import type { z } from "zod";

import { serviceVariablesFromDb } from "../environment/services.ts";
import type { Ports } from "../ports.ts";

// ADR 0030, ADR 0034: `POST /runner/v1/tasks/:taskId/credentials`. Only for the runner that holds the
// task's active lease, at its current epoch, before the grace ends: then the model endpoint and its
// token from the secret store, a one-repo git token per repo from the code host, the environment's
// secrets per repo, and the task's MCP token. Each issue is an audit entry. Never logged. Written by
// ticket 26.

export const issueTaskCredentialsInputSchema = taskCredentialsRequestSchema.extend({ runnerId: runnerIdSchema });
export type IssueTaskCredentialsInput = z.infer<typeof issueTaskCredentialsInputSchema>;

/** Not a `UseCaseResult`: the stale-lease failure carries the task's current epoch. */
export type IssueTaskCredentialsResult =
  | { readonly ok: true; readonly credentials: TaskCredentials }
  | { readonly ok: false; readonly error: "not-found"; readonly message: string }
  | { readonly ok: false; readonly error: "stale-lease"; readonly message: string; readonly currentEpoch: LeaseEpoch }
  | { readonly ok: false; readonly error: "provider-not-allowed-on-personal-runners" | "token-mint-failed"; readonly message: string };

export type IssueTaskCredentialsDeps = Pick<Ports, "audit" | "clock" | "adapters"> & {
  readonly tx: Tx;
  /** The token the runner sends with this task's MCP calls: core signs it, for this task and epoch. */
  readonly mcpToken: (taskId: TaskId, leaseEpoch: LeaseEpoch) => string;
};

export type IssueTaskCredentials = (
  deps: IssueTaskCredentialsDeps,
  input: IssueTaskCredentialsInput,
) => Promise<IssueTaskCredentialsResult>;

/** The git token's permissions: push the task's branch and its hidden ref, read the repo (ADR 0030). */
const GIT_PERMISSIONS = { contents: "write", metadata: "read" } as const;

export const issueTaskCredentials: IssueTaskCredentials = async (deps, input) => {
  const { tx } = deps;
  const notFound = { ok: false, error: "not-found", message: "no such task for this runner" } as const;
  // Only the runner that held a lease of the task hears anything about it.
  const held = await tx.lease.findFirst({ where: { taskId: input.taskId, runnerId: input.runnerId }, orderBy: { epoch: "desc" } });
  if (held === null) {
    return notFound;
  }
  const task = await tx.task.findFirst({ where: { id: input.taskId, organizationId: held.organizationId } });
  if (task === null) {
    return notFound;
  }
  const lease = await tx.lease.findFirst({
    where: { taskId: task.id, runnerId: input.runnerId, epoch: input.leaseEpoch, state: "active" },
  });
  if (lease === null || task.leaseEpoch !== input.leaseEpoch) {
    return { ok: false, error: "stale-lease", message: "the lease has moved on", currentEpoch: task.leaseEpoch };
  }
  const organizationId: OrganizationId = organizationIdSchema.parse(task.organizationId);
  const { secretStore, codeHost } = deps.adapters;
  const failed = (message: string) => ({ ok: false, error: "token-mint-failed", message }) as const;

  const session = await tx.session.findFirst({ where: { taskId: task.id, boxId: lease.boxId }, orderBy: { startedAt: "desc" } });
  const profile =
    session?.agentProfileId === null || session === null
      ? null
      : await tx.agentProfile.findFirst({ where: { id: session.agentProfileId, organizationId }, include: { model: { include: { provider: true } } } });
  const provider = profile?.model?.provider;
  if (provider === undefined) {
    return failed("the session's profile has no model provider");
  }
  const runner = await tx.runner.findUniqueOrThrow({ where: { id: lease.runnerId }, select: { kind: true } });
  if (runner.kind === "personal" && !provider.allowOnPersonalRunners) {
    return {
      ok: false,
      error: "provider-not-allowed-on-personal-runners",
      message: "this model provider's token never goes to a personal runner unless an admin allows it",
    };
  }
  const token = await secretStore.get(organizationId, secretRefSchema.parse(provider.tokenSecretRef));
  if (!token.ok) {
    return failed("the provider's token couldn't be read from the secret store");
  }

  const taskRepos = await tx.taskRepo.findMany({ where: { taskId: task.id }, include: { repo: { include: { connection: true } } }, orderBy: { createdAt: "asc" } });
  const repos: { repoId: ReturnType<typeof repoIdSchema.parse>; gitToken: string; expiresAt: number }[] = [];
  for (const taskRepo of taskRepos) {
    const { repo } = taskRepo;
    if (repo.connection.privateKeySecretRef === null) {
      return failed("the repo's App has no private key");
    }
    const privateKey = await secretStore.get(organizationId, secretRefSchema.parse(repo.connection.privateKeySecretRef));
    if (!privateKey.ok) {
      return failed("the App's private key couldn't be read from the secret store");
    }
    // Narrowed to this one repo and these permissions: a token can't reach another repo (ADR 0030).
    const minted = await codeHost.mintRepoToken(
      { app: { appId: repo.connection.appId, privateKey: privateKey.value }, installationId: repo.installationId, repo: repoFullNameSchema.parse(repo.fullName) },
      GIT_PERMISSIONS,
    );
    if (!minted.ok) {
      return failed(`the code host refused a token for a repo (${minted.error.code})`);
    }
    repos.push({ repoId: repoIdSchema.parse(repo.id), gitToken: minted.value.token, expiresAt: minted.value.expiresAt });
  }

  const entries = await tx.environmentEntry.findMany({ where: { projectId: task.projectId, kind: "secret", repoId: { in: taskRepos.map((row) => row.repoId) } } });
  const secrets: { repoId: ReturnType<typeof repoIdSchema.parse>; entries: RepoSecret[] }[] = taskRepos.map((row) => ({ repoId: repoIdSchema.parse(row.repoId), entries: [] }));
  for (const entry of entries) {
    if (entry.secretRef === null) {
      continue;
    }
    const value = await secretStore.get(organizationId, secretRefSchema.parse(entry.secretRef));
    if (!value.ok) {
      return failed("an environment secret couldn't be read from the secret store");
    }
    const target = secrets.find((group) => group.repoId === entry.repoId);
    if (entry.path !== null) {
      target?.entries.push({ kind: "file", path: entry.path, content: value.value, availableDuringSetup: entry.availableDuringSetup });
    } else if (entry.name !== null) {
      target?.entries.push({ kind: "variable", name: entry.name, value: value.value, availableDuringSetup: entry.availableDuringSetup });
    }
  }

  // Milestone 3 (F-094, ticket 27): each service's secret variables, for its container only. Only
  // a lease on a runner that can start services ever has any (the dispatch's rule), and the spec
  // never holds them.
  const services: ServiceSecrets[] = [];
  const serviceRows = await tx.service.findMany({ where: { projectId: task.projectId, organizationId }, orderBy: { name: "asc" } });
  for (const service of serviceRows) {
    const variables: { name: string; value: string }[] = [];
    for (const variable of serviceVariablesFromDb(service.variables)) {
      if (variable.kind !== "secret") {
        continue;
      }
      const value = await secretStore.get(organizationId, secretRefSchema.parse(variable.secretRef));
      if (!value.ok) {
        return failed("a service's secret couldn't be read from the secret store");
      }
      variables.push({ name: variable.name, value: value.value });
    }
    if (variables.length > 0) {
      services.push({ name: service.name, variables });
    }
  }

  const credentials = taskCredentialsSchema.parse({
    taskId: input.taskId,
    leaseEpoch: input.leaseEpoch,
    model: {
      baseUrl: provider.baseUrl,
      apiFormat: apiFormatFromDb[provider.apiFormat],
      authScheme: authSchemeFromDb[provider.authScheme],
      token: token.value,
    },
    repos,
    secrets,
    mcpToken: deps.mcpToken(input.taskId, input.leaseEpoch),
    ...(services.length === 0 ? {} : { services }),
  });
  await deps.audit.recordInTx(tx, {
    organizationId,
    projectId: projectIdSchema.parse(task.projectId),
    actor: { kind: "runner", id: input.runnerId },
    action: "task.credentials-issued",
    entity: "task",
    entityId: input.taskId,
    data: { leaseEpoch: input.leaseEpoch, repos: repos.length, secrets: entries.length, serviceSecrets: services.reduce((sum, service) => sum + service.variables.length, 0) },
  });
  return { ok: true, credentials };
};
