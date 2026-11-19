import { randomBytes } from "node:crypto";

import type { Db } from "@ostra/db";
import { seedInstallation } from "@ostra/db/testing";
import type { SeededMember } from "@ostra/db/testing";
import { leaseEpochSchema, organizationIdSchema, providerIdSchema, runnerIdSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import type { OrganizationId, ProjectId, ProviderId, RunnerId, SessionId, TaskId } from "@ostra/protocol";

import type { RunnerRef } from "../gateway/context.ts";
import type { FakeCodeHost, FakeSecretStore } from "./fake-adapters.ts";

// One organization's setup, as the first-run checklist leaves it (spec section 3): a model
// provider and its model, the built-in OpenCode profile, the GitHub App, a project with one repo
// and its environment. Values are made up; secrets go through the fake secret store.

export const APP_ID = "5821041";
export const INSTALLATION_ID = "777";
export const PROVIDER_TOKEN = `sk-provider-${randomBytes(12).toString("hex")}`;
export const APP_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----";
export const ENV_SECRET = `env-secret-${randomBytes(8).toString("hex")}`;

export type World = {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly providerId: ProviderId;
  readonly profileId: string;
  readonly repoId: string;
};

export const seedWorld = async (
  db: Db,
  fakes: { readonly codeHost: FakeCodeHost; readonly secretStore: FakeSecretStore },
  organizationId: OrganizationId,
  projectId: ProjectId,
  options: { readonly allowOnPersonalRunners?: boolean; readonly fullName?: string } = {},
): Promise<World> => {
  const fullName = options.fullName ?? "ostra-test/test1";
  const tokenRef = await fakes.secretStore.put({ organizationId, purpose: "model-provider.token" }, PROVIDER_TOKEN);
  const keyRef = await fakes.secretStore.put({ organizationId, purpose: "github-app.private-key" }, APP_PRIVATE_KEY);
  const secretRef = await fakes.secretStore.put({ organizationId, purpose: "environment.secret" }, ENV_SECRET);
  if (!tokenRef.ok || !keyRef.ok || !secretRef.ok) {
    throw new Error("the fake secret store refused");
  }
  fakes.codeHost.apps.set(APP_ID, { privateKey: APP_PRIVATE_KEY, bot: { name: "ostra-test[bot]", email: "1+ostra-test[bot]@users.noreply.github.com" } });
  fakes.codeHost.repos.set(INSTALLATION_ID, [
    ...(fakes.codeHost.repos.get(INSTALLATION_ID) ?? []),
    { hostRepoId: `host-${fullName}`, fullName, defaultBranch: "main", private: true, cloneUrl: `https://github.example/${fullName}.git` },
  ]);
  fakes.codeHost.templates.set(fullName, "## What\n\n## Why\n");
  const provider = await db.modelProvider.create({
    data: {
      organizationId,
      name: "Dev endpoint",
      baseUrl: "https://models.example/v1",
      apiFormat: "anthropic_messages",
      authScheme: "x_api_key",
      tokenSecretRef: tokenRef.value,
      allowOnPersonalRunners: options.allowOnPersonalRunners ?? true,
    },
  });
  // Milestone 4 (F-135): the organization's first provider is on its default list, as `addModelProvider` leaves it.
  if ((await db.providerListEntry.count({ where: { organizationId, projectId: null } })) === 0) {
    await db.providerListEntry.create({ data: { organizationId, projectId: null, providerId: provider.id } });
  }
  const model = await db.model.create({ data: { organizationId, providerId: provider.id, endpointModelId: "dev-model-1" } });
  const profile = await db.agentProfile.create({
    data: { organizationId, name: "OpenCode", adapter: "opencode", modelId: model.id, builtIn: true },
  });
  await db.project.update({ where: { id: projectId }, data: { defaultCodeProfileId: profile.id } });
  const connection = await db.connection.create({
    data: {
      organizationId,
      kind: "github",
      appId: APP_ID,
      slug: "ostra-test",
      botName: "ostra-test[bot]",
      botEmail: "1+ostra-test[bot]@users.noreply.github.com",
      privateKeySecretRef: keyRef.value,
    },
  });
  await seedInstallation(db, { organizationId, connectionId: connection.id, installationId: INSTALLATION_ID });
  const repo = await db.repo.create({
    data: {
      organizationId,
      projectId,
      connectionId: connection.id,
      installationId: INSTALLATION_ID,
      hostRepoId: `host-${fullName}`,
      fullName,
      defaultBranch: "main",
      checkoutDir: fullName.split("/")[1] ?? "repo",
    },
  });
  const environment = await db.environment.create({
    data: { organizationId, projectId, setupScript: "pnpm install", status: "saved" },
  });
  await db.environmentEntry.createMany({
    data: [
      { organizationId, projectId, environmentId: environment.id, repoId: repo.id, kind: "variable", name: "NODE_ENV", value: "test", availableDuringSetup: true },
      { organizationId, projectId, environmentId: environment.id, repoId: repo.id, kind: "file", path: "config/dev.json", value: "{}" },
      { organizationId, projectId, environmentId: environment.id, repoId: repo.id, kind: "secret", name: "API_SECRET", secretRef: secretRef.value },
    ],
  });
  return { organizationId, projectId, providerId: providerIdSchema.parse(provider.id), profileId: profile.id, repoId: repo.id };
};

/** A runner, online and present on a replica now. */
export const seedOnlineRunner = async (
  db: Db,
  organizationId: OrganizationId,
  owner: { readonly kind: "personal"; readonly memberId: string } | { readonly kind: "pool"; readonly poolId: string },
  capacity = 1,
): Promise<RunnerRef> => {
  const runner = await db.runner.create({
    data: {
      organizationId,
      kind: owner.kind,
      ...(owner.kind === "personal" ? { ownerMemberId: owner.memberId } : { poolId: owner.poolId }),
      name: `runner-${randomBytes(3).toString("hex")}`,
      publicKey: randomBytes(32).toString("base64url"),
      executor: owner.kind === "personal" ? "host" : "docker",
      capacity,
      labels: [],
      version: "0.0.0",
      state: "online",
    },
  });
  await db.runnerPresence.create({
    data: { runnerId: runner.id, organizationId, replicaId: "test", connectionEpoch: 1, carrier: "websocket", minor: 0 },
  });
  return { runnerId: runnerIdSchema.parse(runner.id), organizationId };
};

export type QueuedTask = { readonly taskId: TaskId; readonly sessionId: SessionId; readonly organizationId: OrganizationId };

/** A prompt task as `createPromptTask` leaves it: queued, its repo, its co-author, its first session. */
export const seedQueuedTask = async (db: Db, world: World, creator: SeededMember, runnerId: RunnerId | null): Promise<QueuedTask> => {
  const task = await db.task.create({
    data: {
      organizationId: world.organizationId,
      projectId: world.projectId,
      kind: "code",
      source: "prompt",
      title: "Add a short CONTRIBUTING.md",
      prompt: "Add a short CONTRIBUTING.md that explains how to run the tests",
      branchName: `ostra/${randomBytes(4).toString("hex")}-add-a-short-contributing-md`,
      state: "queued",
      creatorMemberId: creator.id,
      driverMemberId: creator.id,
      runnerId,
    },
  });
  await db.taskRepo.create({
    data: { organizationId: world.organizationId, projectId: world.projectId, taskId: task.id, repoId: world.repoId, branchName: task.branchName, baseBranch: "main" },
  });
  await db.taskCoAuthor.create({
    data: { organizationId: world.organizationId, projectId: world.projectId, taskId: task.id, memberId: creator.id, name: "Ada Admin", email: "ada@example.com" },
  });
  const session = await db.session.create({
    data: { organizationId: world.organizationId, projectId: world.projectId, taskId: task.id, agentProfileId: world.profileId, origin: "new", state: "starting" },
  });
  return { taskId: taskIdSchema.parse(task.id), sessionId: sessionIdSchema.parse(session.id), organizationId: organizationIdSchema.parse(world.organizationId) };
};

/**
 * Records the world's provider and model row on a seeded session, as its start does (F-135): for a
 * test that leases a task by hand instead of through the dispatch.
 */
export const recordSessionModel = async (db: Db, world: World, sessionId: string): Promise<void> => {
  const profile = await db.agentProfile.findUniqueOrThrow({ where: { id: world.profileId }, select: { modelId: true } });
  await db.session.update({ where: { id: sessionId }, data: { providerId: world.providerId, modelId: profile.modelId } });
};

export const dispatchPayload = (task: QueuedTask, epoch = 1) => ({
  organizationId: task.organizationId,
  taskId: task.taskId,
  sessionId: task.sessionId,
  leaseEpoch: leaseEpochSchema.parse(epoch),
});
