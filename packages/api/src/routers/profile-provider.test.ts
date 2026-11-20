import { dispatchTask, dispatchWaitFromDb, modelNameSchema, releaseProviderBoxes } from "@ostra/domain";
import { agentProfileIdSchema, leaseEpochSchema, organizationIdSchema, providerIdSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import type { AgentProfileId, ProjectId, ProviderId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedConnectionAndModel, seedProject } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// The profile's provider through the panel's API (F-135, F-021; ADR 0065 amended 2026-11-20, the
// maintainer: "you should first select the provider and then you get to see which models are
// available under that provider"). Saving stores the provider; New task and a project's defaults
// offer only profiles whose provider the project allows; a start on one it doesn't is refused in
// words, and the organization's admins see why in needs-you.

const WORLD_MODEL = modelNameSchema.parse({ kind: "custom", endpointModelId: "world-model" });

let harness: ApiHarness;
let world: Awaited<ReturnType<typeof seedConnectionAndModel>>;
let providerB: ProviderId;

beforeAll(async () => {
  harness = await createApiHarness();
  world = await seedConnectionAndModel(harness);
  // A second key of the organization that lists the same model by name, as a client's own would.
  const organizationId = harness.fixture.a.organization.id;
  const b = await harness.test.db.modelProvider.create({
    data: { organizationId, name: "Client B", baseUrl: "https://client-b.example/v1", apiFormat: "anthropic_messages", authScheme: "x_api_key", tokenSecretRef: "builtin:unused" },
  });
  providerB = providerIdSchema.parse(b.id);
  await harness.test.db.model.create({ data: { organizationId, providerId: b.id, endpointModelId: "world-model", displayName: "World model" } });
  await harness.test.db.model.create({ data: { organizationId, providerId: b.id, endpointModelId: "b-only-model", displayName: "B only" } });
});

afterAll(async () => {
  await harness.dispose();
});

const profileInput = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  adapter: "opencode",
  modelId: null,
  modelName: WORLD_MODEL,
  instructions: null,
  approvalRules: [],
  planFirst: false,
  access: { kind: "everyone" as const },
  mcpServers: [],
  skills: [],
  ...over,
});

/** Gives a project its own list with these providers (an organization admin's save, written directly). */
const setOwnList = async (projectId: ProjectId, providerIds: readonly string[]): Promise<void> => {
  const organizationId = harness.fixture.a.organization.id;
  await harness.test.db.providerListEntry.deleteMany({ where: { organizationId, projectId } });
  await harness.test.db.project.update({ where: { id: projectId }, data: { ownProviders: true } });
  for (const providerId of providerIds) {
    await harness.test.db.providerListEntry.create({ data: { organizationId, projectId, providerId } });
  }
};

const saveOnB = async (name: string): Promise<AgentProfileId> => {
  const admin = await harness.as(harness.fixture.a.admin);
  return agentProfileIdSchema.parse((await admin.agentProfiles.save(profileInput(name, { providerId: providerB }))).profileId);
};

describe("the profile's provider through the API", () => {
  it("F-135/c3,c19, F-021/c1: saving stores the provider, only one that lists the model, and the views name it", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    const profileId = await saveOnB("On client B");
    const row = await harness.test.db.agentProfile.findUniqueOrThrow({ where: { id: profileId } });
    expect(row).toMatchObject({ providerId: providerB, modelCustomName: "world-model" });
    // `modelId` is still written, as the profile's own provider's row, so a rollback reads the same.
    expect(await harness.test.db.model.findUniqueOrThrow({ where: { id: row.modelId ?? "" } })).toMatchObject({ providerId: providerB });
    expect(await admin.agentProfiles.get({ profileId })).toMatchObject({ provider: { providerId: providerB, name: "Client B" }, modelName: WORLD_MODEL });
    expect((await admin.agentProfiles.list()).find((profile) => profile.id === profileId)?.provider).toEqual({ providerId: providerB, name: "Client B" });
    // A save that leaves the provider out keeps it.
    await admin.agentProfiles.save({ ...profileInput("On client B", { instructions: "Keep it short" }), profileId });
    expect((await harness.test.db.agentProfile.findUniqueOrThrow({ where: { id: profileId } })).providerId).toBe(providerB);
    // A model the provider doesn't list is refused, naming both; so is another organization's provider.
    const only = modelNameSchema.parse({ kind: "custom", endpointModelId: "b-only-model" });
    await expect(admin.agentProfiles.save({ ...profileInput("On client B", { modelName: only, providerId: world.providerId }), profileId })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "World models doesn't list b-only-model",
    });
    const outsider = await harness.test.db.modelProvider.create({
      data: { organizationId: harness.fixture.b.organization.id, name: "B's key", baseUrl: "https://b.example/v1", apiFormat: "anthropic_messages", authScheme: "x_api_key", tokenSecretRef: "builtin:unused" },
    });
    await expect(admin.agentProfiles.save({ ...profileInput("On client B", { providerId: outsider.id }), profileId })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "No such provider" });
    expect((await harness.test.db.agentProfile.findUniqueOrThrow({ where: { id: profileId } })).providerId).toBe(providerB);
    // The change is an audit entry that names the field, never a value.
    await admin.agentProfiles.save({ ...profileInput("On client B", { providerId: world.providerId }), profileId });
    const entry = await harness.test.db.auditEntry.findFirstOrThrow({ where: { entity: "agent-profile", entityId: profileId, action: "agent-profile.updated" }, orderBy: { createdAt: "desc" } });
    expect(JSON.stringify(entry.data)).toContain("providerId");
    // The editor's provider options: every key by name, with each project's allowance.
    const options = await admin.agentProfiles.providerOptions();
    expect(options.map((option) => option.name)).toEqual(["Client B", "World models"]);
    await expect((await harness.as(harness.fixture.a.member)).agentProfiles.providerOptions()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("F-135/c4, F-021: New task and a project's defaults offer only profiles whose provider the project allows", async () => {
    const { projectId } = await seedProject(harness, world, "pinned-offers");
    const profileId = await saveOnB("Offered on B");
    const member = await harness.as(harness.fixture.a.member);
    const admin = await harness.as(harness.fixture.a.admin);
    await setOwnList(projectId, [world.providerId]);
    expect((await member.agentProfiles.forStart({ projectId, kind: "code" })).map((profile) => profile.profileId)).not.toContain(profileId);
    expect((await admin.agentProfiles.providerOptions()).find((option) => option.providerId === providerB)?.projects.find((project) => project.projectId === projectId)).toMatchObject({ allowed: false });
    const refusedDefault = admin.projects.setDefaultProfile({ projectId, kind: "code", profileId });
    await expect(refusedDefault).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(refusedDefault).rejects.toThrow(/Client B, which this project's list doesn't allow/);
    await setOwnList(projectId, [world.providerId, providerB]);
    expect((await member.agentProfiles.forStart({ projectId, kind: "code" })).map((profile) => profile.profileId)).toContain(profileId);
    await admin.projects.setDefaultProfile({ projectId, kind: "code", profileId });
    expect((await harness.test.db.project.findUniqueOrThrow({ where: { id: projectId } })).defaultCodeProfileId).toBe(profileId);
  });

  it("F-135/c4, F-021: a start on a profile whose provider the project doesn't allow is refused in words, and its organization admins see why", async () => {
    const { projectId } = await seedProject(harness, world, "pinned-refused");
    const profileId = await saveOnB("Refused on B");
    const member = await harness.as(harness.fixture.a.member);
    const admin = await harness.as(harness.fixture.a.admin);
    await setOwnList(projectId, [world.providerId]);
    // World models lists the same model and is allowed here: the profile on Client B never runs on it.
    expect(await member.tasks.startCheck({ projectId, profileId })).toMatchObject({ kind: "wait", reason: "no-provider", modelName: "world-model", provider: { name: "Client B", reason: "not-allowed" } });
    const refused = member.tasks.create({ projectId, prompt: "Add a CONTRIBUTING.md", agentProfileId: profileId });
    await expect(refused).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(refused).rejects.toThrow(/The profile runs on Client B, which this project's list doesn't allow/);
    expect(await harness.test.db.task.count({ where: { projectId } })).toBe(0);

    // Allowed, it starts on Client B; the list drops it before the dispatch, and the task waits.
    await setOwnList(projectId, [world.providerId, providerB]);
    const created = await member.tasks.create({ projectId, prompt: "Add a CONTRIBUTING.md", agentProfileId: profileId });
    expect(await harness.test.db.session.findUniqueOrThrow({ where: { id: created.sessionId } })).toMatchObject({ providerId: providerB });
    await setOwnList(projectId, [world.providerId]);
    const organizationId = organizationIdSchema.parse(harness.fixture.a.organization.id);
    const { ports } = harness.deps;
    await releaseProviderBoxes({ db: harness.test.db, ...ports }, { organizationId, projectId });
    const lease = (await harness.test.db.task.findUniqueOrThrow({ where: { id: created.taskId } })).leaseEpoch + 1;
    const result = await harness.test.db.$transaction((tx) =>
      dispatchTask({ tx, ...ports }, { organizationId, taskId: taskIdSchema.parse(created.taskId), sessionId: sessionIdSchema.parse(created.sessionId), leaseEpoch: leaseEpochSchema.parse(lease) }),
    );
    expect(result).toMatchObject({ ok: false, message: "no-provider-for-model" });
    const task = await harness.test.db.task.findUniqueOrThrow({ where: { id: created.taskId } });
    expect(dispatchWaitFromDb(task.dispatchWait)).toEqual({ code: "no-provider-for-model", modelName: "world-model", provider: { name: "Client B", reason: "not-allowed" } });
    const adminRow = (await admin.home.needsYou({})).rows.find((row) => row.taskId === created.taskId);
    expect(adminRow?.detail).toEqual({ reason: "no_provider_for_model", modelName: "world-model", provider: { name: "Client B", reason: "not-allowed" } });
    expect((await member.home.needsYou({})).rows.map((row) => row.taskId)).not.toContain(created.taskId);
  });
});
