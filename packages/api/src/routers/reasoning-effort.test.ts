import { randomUUID } from "node:crypto";

import type { CatalogEntry } from "@ostra/adapter-sdk";
import { mapMember } from "@ostra/db";
import type { SeededMember } from "@ostra/db/testing";
import { modelIdSchema, providerIdSchema } from "@ostra/protocol";
import type { EffortLevel, ModelId, ProviderId, ReasoningControls } from "@ostra/protocol";
import { isTrackedEnvelope } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openStream } from "../stream/subscribe.ts";
import { createApiHarness, seedConnectionAndModel, seedLease, seedPersonalRunner, seedProject, seedTask } from "../testing/index.ts";
import type { ApiHarness, SeededTask } from "../testing/index.ts";

// Ticket 61 (F-137, ADR 0066): reasoning effort through the API. A profile's level from its
// model's levels, a model's controls set by an organization admin (or the catalog's again with
// `null`), and a task's level changed by its driver alone, with each turn's level and reasoning
// tokens on the task page and `effort.changed` on the live stream.

const CATALOG_URL = "https://catalog-models.example.com/v1";
const CATALOG_TOKEN = "sk-effort-catalog-token-0123456789abcdef";

/** GPT-5.5 as models.dev lists it: five effort levels (research, section 2.2). */
const gptControls: ReasoningControls = { supported: true, effort: ["none", "low", "medium", "high", "xhigh"] };

const gpt: CatalogEntry = {
  catalogId: "openai/gpt-5.5",
  name: "GPT-5.5",
  aliases: ["gpt-5.5"],
  contextWindow: 400_000,
  maxOutputTokens: 128_000,
  inputPricePerMTok: 1.25,
  outputPricePerMTok: 10,
  cacheReadPricePerMTok: null,
  cacheWritePricePerMTok: null,
  logoPath: "/assets/models/openai.svg",
  reasoning: gptControls,
  reasoningPriceDiffers: false,
};

let harness: ApiHarness;
let world: Awaited<ReturnType<typeof seedConnectionAndModel>>;
let catalogProviderId: ProviderId;
let catalogModelId: ModelId;
/** The built-in profile's model: custom, so it reasons only when an admin says so. */
let customModelId: ModelId;
let builtInProfileId: string;

/** Members of organization A around the restricted project. */
let projectAdmin: SeededMember;
let nonDriver: SeededMember;

const seedMemberOfA = async (label: string): Promise<SeededMember> => {
  const organizationId = harness.fixture.a.organization.id;
  const suffix = randomUUID().slice(0, 8);
  const user = await harness.test.db.user.create({ data: { id: randomUUID(), name: label, email: `${label}-${suffix}@example.com`, username: `${label}-${suffix}` } });
  return mapMember(await harness.test.db.member.create({ data: { id: randomUUID(), organizationId, userId: user.id, role: "member", createdAt: new Date() } }));
};

beforeAll(async () => {
  harness = await createApiHarness();
  world = await seedConnectionAndModel(harness);
  customModelId = world.modelId;
  await seedProject(harness, world, "effort");
  harness.catalogEntries.push(gpt);
  harness.fakes.modelProvider.endpoints.set(CATALOG_URL, {
    token: CATALOG_TOKEN,
    apiFormat: "openai-compatible",
    authScheme: "bearer",
    models: [{ endpointModelId: "gpt-5.5", displayName: null, contextWindow: null }],
  });
  const admin = await harness.as(harness.fixture.a.admin);
  const provider = await admin.providers.create({
    name: "Catalog models",
    baseUrl: CATALOG_URL,
    apiFormat: "openai-compatible",
    authScheme: "bearer",
    sessionsAtOnce: null,
    allowOnPersonalRunners: false,
    token: CATALOG_TOKEN,
  });
  catalogProviderId = providerIdSchema.parse(provider.providerId);
  const [model] = await admin.providers.models({ providerId: catalogProviderId });
  if (model?.catalogId !== "openai/gpt-5.5") {
    throw new Error("the catalog model wasn't matched");
  }
  catalogModelId = modelIdSchema.parse(model.id);
  // The catalog's controls, as the catalog sync writes them (ticket 59).
  await harness.test.db.model.update({ where: { id: catalogModelId }, data: { catalogReasoning: gptControls } });
  builtInProfileId = (await harness.test.db.agentProfile.findFirstOrThrow({ where: { organizationId: harness.fixture.a.organization.id, builtIn: true }, select: { id: true } })).id;

  const restricted = harness.fixture.a.restrictedProject.id;
  projectAdmin = await seedMemberOfA("project-admin");
  nonDriver = await seedMemberOfA("non-driver");
  await harness.test.db.projectMember.createMany({
    data: [
      { organizationId: harness.fixture.a.organization.id, projectId: restricted, memberId: projectAdmin.id, role: "admin" },
      { organizationId: harness.fixture.a.organization.id, projectId: restricted, memberId: nonDriver.id, role: "member" },
    ],
  });
  await harness.hub.start();
});

afterAll(async () => {
  await harness.dispose();
});

const admin = () => harness.as(harness.fixture.a.admin);
const orgA = () => harness.fixture.a.organization.id;
const levelsOf = (views: readonly { readonly level: EffortLevel }[]) => views.map((view) => view.level);

let profileCounter = 0;
const profileInput = (over: Record<string, unknown> = {}) => {
  profileCounter += 1;
  return {
    name: `Careful ${String(profileCounter)}`,
    adapter: "opencode",
    modelId: catalogModelId,
    instructions: null,
    approvalRules: [],
    planFirst: false,
    access: { kind: "everyone" as const },
    mcpServers: [],
    skills: [],
    ...over,
  };
};

/** A running task on the restricted project, its session on `modelId` through the built-in profile, driven by the insider. */
const restrictedTask = async (modelId: ModelId = catalogModelId): Promise<SeededTask> => {
  const restricted = harness.fixture.a.restrictedProject.id;
  const task = await seedTask(harness, { organizationId: orgA(), projectId: restricted, driverMemberId: harness.fixture.a.insider.id });
  await harness.test.db.session.update({ where: { id: task.sessionId }, data: { modelId, agentProfileId: builtInProfileId } });
  return task;
};

describe("the access matrix (F-137)", () => {
  it("F-137: providers.updateModel's reasoning and the model list are an organization admin's alone", async () => {
    const controls: ReasoningControls = { supported: true, effort: ["low", "high"] };
    await expect((await admin()).providers.updateModel({ modelId: customModelId, reasoning: controls })).resolves.toEqual({ id: customModelId });
    for (const who of [projectAdmin, harness.fixture.a.insider, nonDriver, harness.fixture.a.member]) {
      const caller = await harness.as(who);
      await expect(caller.providers.updateModel({ modelId: customModelId, reasoning: null })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller.providers.models({ providerId: world.providerId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect((await harness.as(harness.fixture.b.admin)).providers.updateModel({ modelId: customModelId, reasoning: null })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Nobody but the admin changed it.
    const [row] = (await (await admin()).providers.models({ providerId: world.providerId })).filter((model) => model.id === customModelId);
    expect(row?.reasoning).toMatchObject({ controls, source: "admin" });
    await (await admin()).providers.updateModel({ modelId: customModelId, reasoning: null });
  });

  it("F-137: a profile's levels are any member's to read and an organization admin's to save", async () => {
    const saved = await (await admin()).agentProfiles.save(profileInput({ effort: "high" }));
    for (const who of [harness.fixture.a.admin, projectAdmin, harness.fixture.a.insider, nonDriver, harness.fixture.a.member]) {
      const caller = await harness.as(who);
      expect(levelsOf((await caller.agentProfiles.effortLevels({ adapter: "opencode", modelId: catalogModelId })).levels)).toEqual(["default", "none", "low", "medium", "high", "xhigh"]);
      expect(await caller.agentProfiles.get({ profileId: saved.profileId })).toMatchObject({ effort: "high", effortOptions: { runsAt: "high", adjusted: false } });
    }
    for (const who of [projectAdmin, harness.fixture.a.insider, nonDriver, harness.fixture.a.member]) {
      await expect((await harness.as(who)).agentProfiles.save({ ...profileInput({ effort: "low" }), profileId: saved.profileId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    const outsider = await harness.as(harness.fixture.b.admin);
    await expect(outsider.agentProfiles.effortLevels({ adapter: "opencode", modelId: catalogModelId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(outsider.agentProfiles.get({ profileId: saved.profileId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await (await admin()).agentProfiles.get({ profileId: saved.profileId })).effort).toBe("high");
  });

  it("F-137: tasks.get and tasks.setEffort: the driver changes the level; admins and other members are refused; an outsider sees nothing", async () => {
    const task = await restrictedTask();
    const driver = await harness.as(harness.fixture.a.insider);
    const seen = await driver.tasks.get({ taskId: task.taskId });
    expect(seen.capabilities.setEffort).toBe(true);
    expect(seen.effort.level).toBe("default");
    expect(seen.effort.levels).toContainEqual({ level: "high", labelKey: "effort.levels.high" });
    expect(levelsOf(seen.effort.levels)).toEqual(["default", "none", "low", "medium", "high", "xhigh"]);

    for (const who of [harness.fixture.a.admin, projectAdmin, nonDriver]) {
      const caller = await harness.as(who);
      expect((await caller.tasks.get({ taskId: task.taskId })).capabilities.setEffort).toBe(false);
      await expect(caller.tasks.setEffort({ taskId: task.taskId, level: "high" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    for (const who of [harness.fixture.a.member, harness.fixture.b.admin]) {
      const caller = await harness.as(who);
      await expect(caller.tasks.get({ taskId: task.taskId })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(caller.tasks.setEffort({ taskId: task.taskId, level: "high" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    // Nothing the refused callers did reached the task.
    expect((await harness.test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).effort).toBe("default");
    expect(await harness.test.db.auditEntry.count({ where: { action: "task.effort-changed", entityId: task.taskId } })).toBe(0);

    await expect(driver.tasks.setEffort({ taskId: task.taskId, level: "high" })).resolves.toMatchObject({ from: "default", to: "high", changed: true });
    expect((await driver.tasks.get({ taskId: task.taskId })).effort.level).toBe("high");
    expect(await harness.test.db.auditEntry.count({ where: { action: "task.effort-changed", entityId: task.taskId, actorId: harness.fixture.a.insider.id } })).toBe(1);
  });
});

describe("levels the model doesn't have (F-137)", () => {
  it("F-137: a level outside the model's is refused on a save and on setEffort, naming the levels", async () => {
    const a = await admin();
    // GPT-5.5 has no max.
    await expect(a.agentProfiles.save(profileInput({ effort: "max" }))).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "This model has no max level: it takes default, none, low, medium, high, xhigh",
    });
    // A model that doesn't reason takes Default alone.
    await expect(a.agentProfiles.save(profileInput({ modelId: customModelId, effort: "low" }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const saved = await a.agentProfiles.save(profileInput({ effort: "xhigh" }));
    const entry = await harness.test.db.auditEntry.findFirstOrThrow({ where: { action: "agent-profile.created", entityId: saved.profileId } });
    expect(entry.data).toMatchObject({ effort: "xhigh" });

    const task = await restrictedTask();
    const driver = await harness.as(harness.fixture.a.insider);
    await expect(driver.tasks.setEffort({ taskId: task.taskId, level: "max" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "This model has no max level: it takes default, none, low, medium, high, xhigh",
    });
    await expect(driver.tasks.setEffort({ taskId: task.taskId, level: "on" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await harness.test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).effort).toBe("default");
    expect(await harness.test.db.event.count({ where: { taskId: task.taskId, kind: "effort.changed" } })).toBe(0);
  });

  it("F-137: a stored level the model lost shows the level it runs at", async () => {
    const a = await admin();
    const saved = await a.agentProfiles.save(profileInput({ effort: "xhigh" }));
    // An admin narrows the controls: xhigh is gone, and the clamp moves it to the nearest, high.
    await a.providers.updateModel({ modelId: catalogModelId, reasoning: { supported: true, effort: ["low", "high"] } });
    expect((await a.agentProfiles.get({ profileId: saved.profileId })).effortOptions).toMatchObject({ runsAt: "high", adjusted: true, reasoningSource: "admin" });
    await a.providers.updateModel({ modelId: catalogModelId, reasoning: null });
  });
});

describe("a model's controls (F-137)", () => {
  it("F-137: a custom model that doesn't reason has no levels until an admin says it does", async () => {
    const a = await admin();
    const before = await a.agentProfiles.effortLevels({ adapter: "opencode", modelId: customModelId });
    expect(before).toMatchObject({ reasoningSource: null, customModel: true, agentTakesEffort: true });
    expect(levelsOf(before.levels)).toEqual(["default"]);
    const listed = (await a.providers.models({ providerId: world.providerId })).find((model) => model.id === customModelId);
    expect(listed?.reasoning).toMatchObject({ controls: { supported: false }, source: null, catalog: null });
    expect(levelsOf(listed?.reasoning.levels ?? [])).toEqual(["default"]);

    await a.providers.updateModel({ modelId: customModelId, reasoning: { supported: true, effort: ["high", "low", "medium"] } });
    const after = await a.agentProfiles.effortLevels({ adapter: "opencode", modelId: customModelId });
    expect(after.reasoningSource).toBe("admin");
    expect(levelsOf(after.levels)).toEqual(["default", "low", "medium", "high"]);
    const entry = await harness.test.db.auditEntry.findFirstOrThrow({ where: { action: "model.reasoning-changed", entityId: customModelId }, orderBy: { createdAt: "desc" } });
    expect(entry).toMatchObject({ actorId: harness.fixture.a.admin.id, data: { from: "catalog", to: "effort:high/low/medium" } });

    // Only on or off: a toggle offers Off and On.
    await a.providers.updateModel({ modelId: customModelId, reasoning: { supported: true, toggle: true } });
    expect(levelsOf((await a.agentProfiles.effortLevels({ adapter: "opencode", modelId: customModelId })).levels)).toEqual(["default", "none", "on"]);
    // An agent that takes no level offers Default alone on any model.
    const other = await a.agentProfiles.effortLevels({ adapter: "claude-code", modelId: customModelId });
    expect(other.agentTakesEffort).toBe(false);
    expect(levelsOf(other.levels)).toEqual(["default"]);

    await a.providers.updateModel({ modelId: customModelId, reasoning: null });
    expect(levelsOf((await a.agentProfiles.effortLevels({ adapter: "opencode", modelId: customModelId })).levels)).toEqual(["default"]);
  });

  it("F-137: an admin's override survives a catalog refresh, and null returns to the catalog's", async () => {
    const a = await admin();
    const catalogRow = async () => (await a.providers.models({ providerId: catalogProviderId })).find((model) => model.id === catalogModelId);
    expect((await catalogRow())?.reasoning).toMatchObject({ controls: gptControls, source: "catalog", catalog: gptControls });

    const override: ReasoningControls = { supported: true, effort: ["low", "medium", "high"] };
    // A catalog model takes the catalog's name, limits and prices: its reasoning is the one field an admin overrides.
    await expect(a.providers.updateModel({ modelId: catalogModelId, reasoning: override, displayName: "Mine" })).rejects.toMatchObject({ code: "CONFLICT" });
    await a.providers.updateModel({ modelId: catalogModelId, reasoning: override });
    expect(await a.providers.refresh({ providerId: catalogProviderId })).toMatchObject({ listed: 1, matched: 1 });
    const refreshed = await catalogRow();
    expect(refreshed?.reasoning).toMatchObject({ controls: override, source: "admin", catalog: gptControls });
    expect(levelsOf(refreshed?.reasoning.levels ?? [])).toEqual(["default", "low", "medium", "high"]);

    await a.providers.updateModel({ modelId: catalogModelId, reasoning: null });
    const back = await catalogRow();
    expect(back?.reasoning).toMatchObject({ controls: gptControls, source: "catalog" });
    expect(levelsOf(back?.reasoning.levels ?? [])).toEqual(["default", "none", "low", "medium", "high", "xhigh"]);
    expect(await harness.test.db.auditEntry.count({ where: { action: "model.reasoning-changed", entityId: catalogModelId } })).toBeGreaterThanOrEqual(2);
  });

  it("F-137: the model list marks a catalog model that prices reasoning apart", async () => {
    const a = await admin();
    expect((await a.providers.models({ providerId: catalogProviderId }))[0]?.reasoning.reasoningPriceDiffers).toBe(false);
    // Ticket 58's field on the catalog entry.
    const index = harness.catalogEntries.indexOf(gpt);
    const priced = { ...gpt, reasoningPriceDiffers: true };
    harness.catalogEntries.splice(index, 1, priced);
    try {
      expect((await a.providers.models({ providerId: catalogProviderId }))[0]?.reasoning.reasoningPriceDiffers).toBe(true);
    } finally {
      harness.catalogEntries.splice(index, 1, gpt);
    }
  });
});

describe("the task page (F-137)", () => {
  it("F-137: tasks.get carries each turn's level, adjustedFrom and reasoning tokens", async () => {
    const task = await restrictedTask();
    const restricted = harness.fixture.a.restrictedProject.id;
    await harness.test.db.turn.createMany({
      data: [
        { organizationId: orgA(), projectId: restricted, taskId: task.taskId, sessionId: task.sessionId, ordinal: 1, startSeq: 1, outputTokens: 900, reasoningTokens: 600, effort: "max", endedAt: new Date() },
        { organizationId: orgA(), projectId: restricted, taskId: task.taskId, sessionId: task.sessionId, ordinal: 2, startSeq: 2, outputTokens: 300, reasoningTokens: 120, effort: "xhigh", effortAdjustedFrom: "max" },
      ],
    });
    await harness.test.db.session.update({ where: { id: task.sessionId }, data: { outputTokens: 1200, reasoningTokens: 720 } });
    const seen = await (await harness.as(nonDriver)).tasks.get({ taskId: task.taskId });
    expect(seen.usage?.turns.map((turn) => ({ ordinal: turn.ordinal, effort: turn.effort, adjustedFrom: turn.adjustedFrom, reasoningTokens: turn.reasoningTokens }))).toEqual([
      { ordinal: 1, effort: "max", adjustedFrom: null, reasoningTokens: 600 },
      { ordinal: 2, effort: "xhigh", adjustedFrom: "max", reasoningTokens: 120 },
    ]);
    expect(seen.usage?.totals).toMatchObject({ outputTokens: 1200, reasoningTokens: 720 });
  });

  it("F-137: the driver's change reaches the runner and the live stream carries effort.changed", async () => {
    const task = await restrictedTask();
    const restricted = harness.fixture.a.restrictedProject.id;
    const runnerId = await seedPersonalRunner(harness, harness.fixture.a.insider.id, `effort-runner-${randomUUID().slice(0, 6)}`);
    await seedLease(harness, task, orgA(), restricted, runnerId);

    const context = await harness.contextOf(nonDriver);
    const scope = context.member?.scope;
    if (scope === undefined) {
      throw new Error("the watcher has no scope");
    }
    const controller = new AbortController();
    const kinds: string[] = [];
    const watching = (async () => {
      for await (const value of openStream({ ...context, scope }, { taskId: task.taskId }, controller.signal)) {
        const message = isTrackedEnvelope(value) ? value[1] : value;
        if (message.type === "event") {
          kinds.push(message.event.event.kind);
          if (message.event.event.kind === "effort.changed") {
            expect(message.event.event).toMatchObject({ from: "default", to: "low", memberId: harness.fixture.a.insider.id });
          }
        }
      }
    })();
    const changeId = randomUUID();
    const driver = await harness.as(harness.fixture.a.insider);
    await expect(driver.tasks.setEffort({ taskId: task.taskId, level: "low", changeId })).resolves.toMatchObject({ to: "low", sentToRunner: true });
    const command = harness.fakes.outbox.commands.find((sent) => sent.kind === "set-effort" && sent.runnerId === runnerId);
    expect(command?.body).toEqual({ sessionId: task.sessionId, level: "low", changeId });

    const deadline = Date.now() + 8000;
    while (!kinds.includes("effort.changed")) {
      if (Date.now() > deadline) {
        throw new Error(`timed out; saw ${kinds.join(", ")}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    await watching;
    // The same level again changes nothing.
    await expect(driver.tasks.setEffort({ taskId: task.taskId, level: "low" })).resolves.toMatchObject({ changed: false });
  });
});
