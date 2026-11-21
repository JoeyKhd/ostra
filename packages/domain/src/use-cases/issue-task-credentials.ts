import { secretRefSchema } from "@ostra/adapter-sdk";
import { apiFormatFromDb, authSchemeFromDb } from "@ostra/db";
import type { Tx } from "@ostra/db";
import { agentProfileIdSchema, HTTP_HEADER_VALUE, organizationIdSchema, projectIdSchema, repoFullNameSchema, repoIdSchema, runnerIdSchema, taskCredentialsRequestSchema, taskCredentialsSchema } from "@ostra/protocol";
import type { LeaseEpoch, OrganizationId, RepoSecret, ServiceSecrets, TaskCredentials, TaskId } from "@ostra/protocol";
import type { z } from "zod";

import { serviceVariablesFromDb } from "../environment/services.ts";
import type { Ports } from "../ports.ts";
import { providerAuditActions } from "../providers/provider-lists.ts";
import { sessionRowAllowedInTx } from "../providers/session-model.ts";
import { profileLibraryOf } from "../library/profile-library.ts";
import { serverRequestOf } from "../library/server-request.ts";
import { storedMcpServersSchema } from "./task-profile.ts";
import { INSTALLATION_NOT_LINKED, installationStateSelect, installationUsable } from "../code-host/installations.ts";

// ADR 0030, ADR 0034: `POST /runner/v1/tasks/:taskId/credentials`. Only for the runner that holds the
// task's active lease, at its current epoch, before the grace ends: then the model endpoint and its
// token from the secret store, a one-repo git token per repo from the code host, the environment's
// secrets per repo, and the task's MCP token. Each issue is an audit entry. Never logged. Written by
// ticket 26. Milestone 3 (ticket 16): each HTTP MCP server of the session's profile, its URL and its
// headers read from the secret store, for the sidecar's MCP proxy only (ADR 0030, ADR 0049): the
// spec names a proxy path, and the agent never holds a header.

export const issueTaskCredentialsInputSchema = taskCredentialsRequestSchema.extend({ runnerId: runnerIdSchema });
export type IssueTaskCredentialsInput = z.infer<typeof issueTaskCredentialsInputSchema>;

/** Not a `UseCaseResult`: the stale-lease failure carries the task's current epoch. */
export type IssueTaskCredentialsResult =
  | { readonly ok: true; readonly credentials: TaskCredentials }
  | { readonly ok: false; readonly error: "not-found"; readonly message: string }
  | { readonly ok: false; readonly error: "stale-lease"; readonly message: string; readonly currentEpoch: LeaseEpoch }
  | { readonly ok: false; readonly error: "provider-not-allowed-on-personal-runners" | "token-mint-failed"; readonly message: string }
  /** Milestone 4 (F-135): the session's provider is no longer on its project's list; an audit entry records the refusal. */
  | { readonly ok: false; readonly error: "provider-not-allowed"; readonly message: string }
  /** Milestone 4 (F-136): a repo's GitHub installation was unlinked or removed; nothing was minted. */
  | { readonly ok: false; readonly error: "installation-not-linked"; readonly message: string };

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
/**
 * A refine or review task only fetches (ADR 0031, F-099, F-100): its token can't write either, so
 * a push fails at the code host too, not only at the git proxy, and on `host`, where the agent runs
 * as the runner's account, it holds nothing that writes.
 */
const READ_ONLY_GIT_PERMISSIONS = { contents: "read", metadata: "read" } as const;

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
      : await tx.agentProfile.findFirst({ where: { id: session.agentProfileId, organizationId } });
  // Milestone 4 (F-135, ADR 0065): the provider is the session's recorded row, never the profile's,
  // and it must be on the project's list now, checked before the token is read.
  const sessionProviderId = session?.providerId ?? null;
  const sessionModelId = session?.modelId ?? null;
  if (session === null || sessionProviderId === null || sessionModelId === null) {
    return failed("the session has no model provider");
  }
  const projectId = projectIdSchema.parse(task.projectId);
  if (!(await sessionRowAllowedInTx(tx, { organizationId, projectId, providerId: sessionProviderId, modelId: sessionModelId }))) {
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId,
      actor: { kind: "runner", id: input.runnerId },
      action: providerAuditActions.credentialsRefused,
      entity: "task",
      entityId: input.taskId,
      data: { leaseEpoch: input.leaseEpoch, sessionId: session.id, providerId: sessionProviderId, reason: "provider-not-allowed" },
    });
    return { ok: false, error: "provider-not-allowed", message: "the session's model provider isn't on its project's list" };
  }
  const provider = await tx.modelProvider.findFirst({ where: { id: sessionProviderId, organizationId } });
  if (provider === null) {
    return failed("the session has no model provider");
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

  const taskRepos = await tx.taskRepo.findMany({
    where: { taskId: task.id },
    include: { repo: { include: { connection: true, ...installationStateSelect } } },
    orderBy: { createdAt: "asc" },
  });
  // Milestone 4 (F-136, ADR 0065): no token through an installation that isn't linked, for any repo.
  if (taskRepos.some(({ repo }) => !installationUsable(repo.installation))) {
    return { ok: false, error: "installation-not-linked", message: INSTALLATION_NOT_LINKED };
  }
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
      task.kind === "code" ? GIT_PERMISSIONS : READ_ONLY_GIT_PERMISSIONS,
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

  // The profile's HTTP MCP servers, for the sidecar alone. A column that doesn't parse gives none:
  // the spec's builder refuses such a profile, so the agent never sees a server without its headers.
  const stored = storedMcpServersSchema.safeParse(profile?.mcpServers ?? []);
  const mcpServers: { name: string; url: string; headers: Record<string, string> }[] = [];
  for (const server of stored.success ? stored.data : []) {
    if (server.transport !== "http") {
      continue;
    }
    const headers: Record<string, string> = {};
    for (const [header, ref] of Object.entries(server.headerSecretRefs)) {
      const secretRef = secretRefSchema.safeParse(ref);
      const value = secretRef.success ? await secretStore.get(organizationId, secretRef.data) : null;
      if (value?.ok !== true) {
        return failed("an MCP server's header couldn't be read from the secret store");
      }
      // A value saved before the editor refused control characters may end in a newline: trimmed here,
      // and one that still can't be sent fails the credentials, not the runner.
      const trimmed = value.value.trim();
      if (!HTTP_HEADER_VALUE.test(trimmed)) {
        return failed("an MCP server's header holds a character a header can't");
      }
      headers[header] = trimmed;
    }
    mcpServers.push({ name: server.name, url: server.url, headers });
  }
  // Milestone 8 (F-145, ADR 0069, ticket 28): the profile's library servers, attached or on every
  // profile, at their current versions: the address with its variables put in and the headers,
  // the secret ones read from the secret store, for the sidecar alone, as the spec names them.
  if (profile !== null) {
    const library = await profileLibraryOf(tx, { organizationId, profileId: agentProfileIdSchema.parse(profile.id) });
    for (const server of library.servers) {
      const request = await serverRequestOf(secretStore, organizationId, server.entry, server.inputs);
      if (!request.ok) {
        return failed(request.error === "secret-unreadable" ? "a library MCP server's input couldn't be read from the secret store" : "a library MCP server's address or header can't be sent");
      }
      mcpServers.push({ name: server.name, url: request.url, headers: { ...request.headers } });
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
    ...(mcpServers.length === 0 ? {} : { mcpServers }),
  });
  await deps.audit.recordInTx(tx, {
    organizationId,
    projectId,
    actor: { kind: "runner", id: input.runnerId },
    action: "task.credentials-issued",
    entity: "task",
    entityId: input.taskId,
    data: {
      leaseEpoch: input.leaseEpoch,
      repos: repos.length,
      secrets: entries.length,
      serviceSecrets: services.reduce((sum, service) => sum + service.variables.length, 0),
      mcpServers: mcpServers.length,
    },
  });
  return { ok: true, credentials };
};
