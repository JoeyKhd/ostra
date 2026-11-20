import { randomBytes, randomUUID } from "node:crypto";

import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, SeededMember, TestDatabase } from "@ostra/db/testing";
import { createPromptTask, dispatchTask, dispatchWaitFromDb, postgresAuditLog, postgresChangeNotices, postgresCommandOutbox, systemClock } from "@ostra/domain";
import type { MemberScope } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { agentProfileIdSchema, modelIdSchema, projectIdSchema, providerIdSchema, runnerPaths, taskCredentialsSchema, taskSpecSchema } from "@ostra/protocol";
import type { ModelId, ProjectId, ProviderId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { accessToken, postJson, registerPersonal, startGateway } from "../testing/harness.ts";
import type { GatewayHarness, RegisteredRunner } from "../testing/harness.ts";
import { dispatchPayload, INSTALLATION_ID, PROVIDER_TOKEN, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { QueuedTask, World } from "../testing/world.ts";
import { handleTaskEndpoint } from "./endpoints.ts";

// The profile's provider (F-135, F-021; ADR 0065 amended 2026-11-20, the maintainer: "you should
// first select the provider and then you get to see which models are available under that
// provider"). A profile names the provider whose key and base URL its tasks use, and no other: the
// project's list decides whether the profile runs there at all. Two providers list one model by
// name (the same models.dev catalog ID); the project's own choice for the name is the first.

const CATALOG_ID = "anthropic/claude-sonnet-4-5";
const TOKEN_B = `sk-client-b-${randomBytes(12).toString("hex")}`;
const BASE_URL_B = "https://client-b.example/v1";

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let harness: GatewayHarness;
let runner: RegisteredRunner;
let modelA: ModelId;
let providerB: ProviderId;
let modelB: ModelId;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const records: LogRecord[] = [];
const logger = createLogger((record) => records.push(record));

const domainDeps = () => ({ jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, logger });
const dispatch = (task: QueuedTask, epoch = 1) => test.db.$transaction((tx) => dispatchTask({ tx, ...domainDeps() }, dispatchPayload(task, epoch)));
const scopeOf = (member: SeededMember): MemberScope => ({ organizationId: member.organizationId, memberId: member.id, role: member.role === "admin" ? "admin" : "member", projectRoles: new Map() });

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  const organizationId = world.organizationId;
  const profile = await test.db.agentProfile.findUniqueOrThrow({ where: { id: world.profileId } });
  modelA = modelIdSchema.parse(profile.modelId);
  await test.db.model.update({ where: { id: modelA }, data: { catalogId: CATALOG_ID } });
  const tokenRef = await secretStore.put({ organizationId, purpose: "model-provider.token" }, TOKEN_B);
  if (!tokenRef.ok) {
    throw new Error("the fake secret store refused");
  }
  const b = await test.db.modelProvider.create({
    data: { organizationId, name: "Client B endpoint", baseUrl: BASE_URL_B, apiFormat: "openai_compatible", authScheme: "bearer", tokenSecretRef: tokenRef.value, allowOnPersonalRunners: true },
  });
  providerB = providerIdSchema.parse(b.id);
  modelB = modelIdSchema.parse((await test.db.model.create({ data: { organizationId, providerId: b.id, endpointModelId: "claude-sonnet-4-5-b", catalogId: CATALOG_ID } })).id);
  harness = await startGateway(test.db, test.url, {}, (gateway) => [
    handleTaskEndpoint({
      db: test.db,
      tokens: gateway.context.tokens,
      taskTokens: gateway.context.taskTokens,
      adapters: { codeHost, secretStore, modelProvider: new FakeModelProvider() },
      audit: postgresAuditLog,
      clock: systemClock,
      signingKey: randomBytes(32),
      logger,
    }),
  ]);
  runner = await registerPersonal(harness, test.db, fixture.a.member);
  await test.db.runner.update({ where: { id: runner.runnerId }, data: { state: "online", capacity: 50 } });
  await test.db.runnerPresence.create({ data: { runnerId: runner.runnerId, organizationId, replicaId: "test", connectionEpoch: 1, carrier: "websocket", minor: 2 } });
});

afterAll(async () => {
  await harness.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

let projectCount = 0;

/** A project of organization A with its own provider list and one repo of its own. */
const projectWith = async (providerIds: readonly ProviderId[]): Promise<World> => {
  projectCount += 1;
  const organizationId = world.organizationId;
  const project = await test.db.project.create({
    data: { organizationId, name: `pinned ${String(projectCount)}`, slug: `pinned-${String(projectCount)}-${randomUUID().slice(0, 6)}`, access: "open", ownProviders: true },
  });
  for (const providerId of providerIds) {
    await test.db.providerListEntry.create({ data: { organizationId, projectId: project.id, providerId } });
  }
  const connection = await test.db.connection.findFirstOrThrow({ where: { organizationId, kind: "github" } });
  const fullName = `ostra-test/pinned-${String(projectCount)}`;
  codeHost.repos.set(INSTALLATION_ID, [
    ...(codeHost.repos.get(INSTALLATION_ID) ?? []),
    { hostRepoId: `host-${fullName}`, fullName, defaultBranch: "main", private: true, cloneUrl: `https://github.example/${fullName}.git` },
  ]);
  const repo = await test.db.repo.create({
    data: { organizationId, projectId: project.id, connectionId: connection.id, installationId: INSTALLATION_ID, hostRepoId: `host-${fullName}`, fullName, defaultBranch: "main", checkoutDir: `pinned-${String(projectCount)}` },
  });
  return { ...world, projectId: projectIdSchema.parse(project.id), repoId: repo.id };
};

/** A profile that names the model by its catalog ID, on `providerId` (or by name alone, `null`). */
const profileOn = async (providerId: ProviderId | null): Promise<string> =>
  (
    await test.db.agentProfile.create({
      data: { organizationId: world.organizationId, name: `on ${providerId ?? "name"} ${randomUUID().slice(0, 6)}`, adapter: "opencode", modelCatalogId: CATALOG_ID, providerId, modelId: providerId === providerB ? modelB : modelA },
      select: { id: true },
    })
  ).id;

const sessionRow = (sessionId: string) => test.db.session.findUniqueOrThrow({ where: { id: sessionId } });

const runnerCalls = async () => {
  const token = (await accessToken(harness, runner)).accessToken;
  return {
    spec: async (task: QueuedTask) => fetch(`${harness.url}${runnerPaths.taskSpec(task.taskId)}?leaseEpoch=1`, { headers: { authorization: `Bearer ${token}` } }),
    credentials: (task: QueuedTask) => postJson(`${harness.url}${runnerPaths.taskCredentials(task.taskId)}`, { taskId: task.taskId, leaseEpoch: 1 }, token),
  };
};

/** The project's own choice for the model name: provider A's row. */
const chooseA = (projectId: ProjectId) =>
  test.db.modelChoice.create({
    data: { organizationId: world.organizationId, projectId, modelKey: `catalog:${CATALOG_ID}`, modelCatalogId: CATALOG_ID, modelId: modelA, reason: "admin" },
  });

describe("the profile's provider at the dispatch and the credentials", () => {
  it("F-135/c4, F-021: a task runs on its profile's provider, its key and base URL, never another provider's that serves the same model name", async () => {
    // Both providers are on the project's list and list the model; the project's choice is A.
    const project = await projectWith([world.providerId, providerB]);
    await chooseA(project.projectId);
    const onB = await seedQueuedTask(test.db, { ...project, profileId: await profileOn(providerB) }, fixture.a.member, runner.runnerId);
    const byName = await seedQueuedTask(test.db, { ...project, profileId: await profileOn(null) }, fixture.a.member, runner.runnerId);
    expect(await dispatch(onB)).toMatchObject({ ok: true });
    expect(await dispatch(byName)).toMatchObject({ ok: true });
    // The profile on B records B; a profile by name takes the project's choice, A.
    expect(await sessionRow(onB.sessionId)).toMatchObject({ providerId: providerB, modelId: modelB });
    expect(await sessionRow(byName.sessionId)).toMatchObject({ providerId: world.providerId, modelId: modelA });

    const { spec, credentials } = await runnerCalls();
    expect(taskSpecSchema.parse(await (await spec(onB)).json()).agent).toMatchObject({ providerId: providerB, modelId: modelB, endpointModelId: "claude-sonnet-4-5-b", apiFormat: "openai-compatible" });
    const issued = await credentials(onB);
    expect(issued.status).toBe(200);
    const model = taskCredentialsSchema.parse(issued.body).model;
    expect(model).toMatchObject({ token: TOKEN_B, baseUrl: BASE_URL_B });
    // Searched by value: A's key never reaches the task on B, nor B's the task on A.
    expect(JSON.stringify(issued.body).includes(PROVIDER_TOKEN)).toBe(false);
    const issuedByName = await credentials(byName);
    expect(taskCredentialsSchema.parse(issuedByName.body).model.token).toBe(PROVIDER_TOKEN);
    expect(JSON.stringify(issuedByName.body).includes(TOKEN_B)).toBe(false);
  });

  it("F-135/c4, F-021/c1: a project whose list doesn't allow the profile's provider can't start it, and its organization admins hear why", async () => {
    // Only A is allowed here, and A lists the same model by name: the profile on B still never runs on A.
    const project = await projectWith([world.providerId]);
    const profileId = await profileOn(providerB);
    const refused = await test.db.$transaction((tx) =>
      createPromptTask({ tx, scope: scopeOf(fixture.a.member), ...domainDeps() }, { projectId: project.projectId, prompt: "Add a CONTRIBUTING.md", agentProfileId: agentProfileIdSchema.parse(profileId) }),
    );
    expect(refused).toMatchObject({ ok: false, error: "no-provider-for-model" });
    expect(refused.ok ? "" : refused.message).toContain("Client B endpoint, which this project's list doesn't allow");
    expect(await test.db.task.count({ where: { projectId: project.projectId } })).toBe(0);

    // A task already queued on it (from a ticket, an automation or a reopen) waits with the reason.
    const queued = await seedQueuedTask(test.db, { ...project, profileId }, fixture.a.member, runner.runnerId);
    expect(await dispatch(queued)).toMatchObject({ ok: false, error: "no-runner", message: "no-provider-for-model" });
    const task = await test.db.task.findUniqueOrThrow({ where: { id: queued.taskId } });
    expect(task.state).toBe("queued");
    expect(dispatchWaitFromDb(task.dispatchWait)).toEqual({ code: "no-provider-for-model", modelName: CATALOG_ID, provider: { name: "Client B endpoint", reason: "not-allowed" } });
    expect(await sessionRow(queued.sessionId)).toMatchObject({ providerId: null, modelId: null });
    expect(await test.db.lease.count({ where: { taskId: queued.taskId } })).toBe(0);
    expect(await test.db.needsYouItem.findFirst({ where: { taskId: queued.taskId, state: "open" } })).toMatchObject({ reason: "no_provider_for_model", audience: "organization_admins" });

    // Allowed, it runs on B; the item is closed.
    await test.db.providerListEntry.create({ data: { organizationId: world.organizationId, projectId: project.projectId, providerId: providerB } });
    expect(await dispatch(queued)).toMatchObject({ ok: true });
    expect(await sessionRow(queued.sessionId)).toMatchObject({ providerId: providerB, modelId: modelB });
    expect(await test.db.needsYouItem.count({ where: { taskId: queued.taskId, state: "open" } })).toBe(0);

    // The list drops B again: the key proxy's credentials are refused with an audit entry, and the
    // next dispatch of a session that recorded B takes the same worded path, never A.
    await test.db.providerListEntry.deleteMany({ where: { projectId: project.projectId, providerId: providerB } });
    const { credentials } = await runnerCalls();
    const denied = await credentials(queued);
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body).includes(TOKEN_B)).toBe(false);
    expect(JSON.stringify(denied.body).includes(PROVIDER_TOKEN)).toBe(false);
    expect(await test.db.auditEntry.findFirst({ where: { action: "task.credentials-refused", entityId: queued.taskId } })).toMatchObject({ projectId: project.projectId });
    const again = await seedQueuedTask(test.db, { ...project, profileId }, fixture.a.member, runner.runnerId);
    await test.db.session.update({ where: { id: again.sessionId }, data: { providerId: providerB, modelId: modelB } });
    expect(await dispatch(again)).toMatchObject({ ok: false, message: "no-provider-for-model" });
    expect(dispatchWaitFromDb((await test.db.task.findUniqueOrThrow({ where: { id: again.taskId } })).dispatchWait)).toMatchObject({ provider: { name: "Client B endpoint", reason: "not-allowed" } });
    expect(await test.db.needsYouItem.findFirst({ where: { taskId: again.taskId, state: "open" } })).toMatchObject({ audience: "organization_admins" });
  });
});
