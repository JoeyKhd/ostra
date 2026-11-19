import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { mapModel } from "@ostra/db";
import {
  appendServerEvent,
  effectiveReasoning,
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  saveAgentProfile,
  setModelReasoning,
  setModelReasoningInTx,
  setTaskEffort,
  setTaskEffortInTx,
  syncProviderModels,
  systemClock,
} from "@ostra/domain";
import type { EffortDeps, M3Deps, MemberScope, SaveAgentProfileInput } from "@ostra/domain";
import { agentProfileIdSchema, effortChangeIdSchema, memberIdSchema, modelIdSchema, organizationIdSchema, sessionIdSchema } from "@ostra/protocol";
import type { EffortLevel, ModelId, ReasoningControls, TaskId } from "@ostra/protocol";
import { reasoningControlsFixtures } from "@ostra/protocol/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { agentEffortLevels } from "../agents/effort-levels.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { seedLeasedTask, seedRunner } from "../testing/seed.ts";
import type { LeasedTask } from "../testing/seed.ts";
import { PROVIDER_TOKEN, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";

// Reasoning effort's use cases (F-137, ADR 0066, milestone 4's ticket 56): a model's controls set
// by an admin, and a task's level set by its driver, each one transaction with its audit entry,
// against a real database.

let test: TestDatabase;
let fixture: IsolationFixture;
let world: World;
let deps: EffortDeps;
let driver: MemberScope;
let watcher: MemberScope;
let admin: MemberScope;
let outsider: MemberScope;
let sessionProfileId: string;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const modelProvider = new FakeModelProvider();

const scopeOf = (organizationId: string, memberId: string, role: "admin" | "member" = "member"): MemberScope => ({
  organizationId: organizationIdSchema.parse(organizationId),
  memberId: memberIdSchema.parse(memberId),
  role,
  projectRoles: new Map(),
});

let changes = 0;
const changeId = () => {
  changes += 1;
  return effortChangeIdSchema.parse(`effort-change-${String(changes)}`);
};

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  deps = { db: test.db, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, effortLevels: agentEffortLevels };
  // The tasks' sessions run on a model with every level on the scale (ticket 59 refuses a level the model lacks).
  const model = await test.db.model.create({
    data: {
      organizationId: world.organizationId,
      providerId: world.providerId,
      endpointModelId: "every-level",
      catalogReasoning: { supported: true, effort: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] },
    },
  });
  sessionProfileId = (await test.db.agentProfile.create({ data: { organizationId: world.organizationId, name: "Every level", adapter: "opencode", modelId: model.id } })).id;
  driver = scopeOf(fixture.a.organization.id, fixture.a.member.id);
  watcher = scopeOf(fixture.a.organization.id, fixture.a.insider.id);
  admin = scopeOf(fixture.a.organization.id, fixture.a.admin.id, "admin");
  outsider = scopeOf(fixture.b.organization.id, fixture.b.admin.id, "admin");
});

afterAll(async () => {
  await test.dispose();
});

/** A task leased to a runner of the driver's, its session going, driven by the driver. */
const leasedTask = async (minor: number | null = null): Promise<LeasedTask> => {
  const runner = await seedRunner(test.db, world.organizationId, fixture.a.member.id);
  if (minor !== null) {
    await test.db.runnerPresence.create({
      data: { runnerId: runner.runnerId, organizationId: world.organizationId, replicaId: "test", connectionEpoch: 1, carrier: "websocket", minor },
    });
  }
  const task = await seedLeasedTask(test.db, runner, world.projectId, { state: "running", creatorMemberId: fixture.a.member.id });
  await test.db.session.update({ where: { id: task.sessionId }, data: { agentProfileId: sessionProfileId } });
  return task;
};

/** What a change of the task's level left behind. */
const traces = async (taskId: TaskId) => ({
  effort: (await test.db.task.findUniqueOrThrow({ where: { id: taskId }, select: { effort: true } })).effort,
  events: await test.db.event.findMany({ where: { taskId, kind: "effort.changed" }, orderBy: { seq: "asc" }, select: { seq: true, payload: true } }),
  audits: await test.db.auditEntry.findMany({ where: { entityId: taskId, action: "task.effort-changed" }, select: { actorId: true, data: true } }),
  commands: await test.db.command.findMany({ where: { taskId, kind: "set_effort" }, select: { body: true } }),
});

/** A take-over as the task page's: under the task's lock, the driver and `driver.changed` together. */
const takeOver = (scope: MemberScope, task: LeasedTask) =>
  test.db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "task" WHERE "id" = ${task.taskId} FOR UPDATE`;
    await tx.task.update({ where: { id: task.taskId }, data: { driverMemberId: scope.memberId } });
    return appendServerEvent(tx, {
      organizationId: task.organizationId,
      projectId: task.projectId,
      taskId: task.taskId,
      sessionId: sessionIdSchema.parse(task.sessionId),
      at: Date.now(),
      event: { kind: "driver.changed", memberId: scope.memberId, byMemberId: scope.memberId },
    });
  });

describe("setTaskEffort", () => {
  it("F-137: setTaskEffort is refused for a member who isn't the driver, and writes nothing", async () => {
    const task = await leasedTask();
    for (const scope of [watcher, admin]) {
      expect(await setTaskEffort(deps, scope, { taskId: task.taskId, level: "high", changeId: changeId() })).toMatchObject({
        ok: false,
        error: "take-over-to-change",
      });
    }
    expect(await setTaskEffort(deps, outsider, { taskId: task.taskId, level: "high", changeId: changeId() })).toMatchObject({ ok: false, error: "not-found" });
    expect(await traces(task.taskId)).toEqual({ effort: "default", events: [], audits: [], commands: [] });
  });

  it("F-137: the driver's change writes the level, effort.changed, the audit entry and a set-effort, in one transaction", async () => {
    const task = await leasedTask();
    const id = changeId();
    expect(await setTaskEffort(deps, driver, { taskId: task.taskId, level: "high", changeId: id })).toEqual({
      ok: true,
      from: "default",
      to: "high",
      changed: true,
      sentToRunner: true,
    });
    const after = await traces(task.taskId);
    expect(after.effort).toBe("high");
    expect(after.events.map((event) => event.payload)).toEqual([{ kind: "effort.changed", from: "default", to: "high", memberId: driver.memberId }]);
    expect(after.audits).toEqual([{ actorId: driver.memberId, data: { from: "default", to: "high" } }]);
    expect(after.commands.map((command) => command.body)).toEqual([{ sessionId: task.sessionId, level: "high", changeId: id }]);
    // The same level again changes nothing.
    expect(await setTaskEffort(deps, driver, { taskId: task.taskId, level: "high", changeId: changeId() })).toMatchObject({ ok: true, changed: false });
    expect((await traces(task.taskId)).audits).toHaveLength(1);
  });

  it("F-137: a minor-2 runner is never sent set-effort; the next session starts at the level", async () => {
    const task = await leasedTask(2);
    expect(await setTaskEffort(deps, driver, { taskId: task.taskId, level: "low", changeId: changeId() })).toMatchObject({ ok: true, sentToRunner: false });
    const after = await traces(task.taskId);
    expect(after.effort).toBe("low");
    expect(after.commands).toEqual([]);
    expect(after.events).toHaveLength(1);
  });

  it("F-137: a take-over racing the driver's change, 50 times: each change committed before the take-over, or was refused", async () => {
    const levels: readonly EffortLevel[] = ["low", "high", "max", "medium", "none"];
    for (let round = 0; round < 50; round += 1) {
      const task = await leasedTask();
      const level = levels[round % levels.length] ?? "high";
      const [changed, taken] = await Promise.allSettled([
        setTaskEffort(deps, driver, { taskId: task.taskId, level, changeId: changeId() }),
        takeOver(watcher, task),
      ]);
      if (changed.status !== "fulfilled" || taken.status !== "fulfilled") {
        throw new Error(`round ${String(round)}: a transaction failed`);
      }
      const after = await traces(task.taskId);
      if (changed.value.ok) {
        // It landed before the take-over: its event comes first in the thread.
        expect(after.events).toHaveLength(1);
        expect(after.events[0]?.seq ?? Number.POSITIVE_INFINITY).toBeLessThan(taken.value);
        expect(after.effort).toBe(level);
      } else {
        expect(changed.value.error).toBe("take-over-to-change");
        expect(after).toEqual({ effort: "default", events: [], audits: [], commands: [] });
      }
    }
  });
});

describe("a model's reasoning controls", () => {
  const modelOf = async (): Promise<ModelId> => {
    const row = await test.db.model.findFirstOrThrow({ where: { providerId: world.providerId, endpointModelId: "dev-model-1" } });
    return modelIdSchema.parse(row.id);
  };
  const reasoningOf = async (modelId: ModelId) => mapModel(await test.db.model.findUniqueOrThrow({ where: { id: modelId } }));

  it("F-137: only an organization admin sets a model's controls; null goes back to the catalog's", async () => {
    const modelId = await modelOf();
    const controls: ReasoningControls = reasoningControlsFixtures.effortNoLow;
    expect(await setModelReasoning(deps, driver, { modelId, controls })).toMatchObject({ ok: false, error: "forbidden" });
    expect(await setModelReasoning(deps, outsider, { modelId, controls })).toMatchObject({ ok: false, error: "not-found" });
    expect((await reasoningOf(modelId)).adminReasoning).toBeNull();

    expect(await setModelReasoning(deps, admin, { modelId, controls })).toEqual({ ok: true, changed: true });
    expect((await reasoningOf(modelId)).adminReasoning).toEqual(controls);
    const audits = await test.db.auditEntry.findMany({ where: { entityId: modelId, action: "model.reasoning-changed" }, select: { actorId: true, data: true } });
    expect(audits).toEqual([{ actorId: admin.memberId, data: { from: "catalog", to: "effort:medium/high/xhigh" } }]);

    expect(await setModelReasoning(deps, admin, { modelId, controls: null })).toEqual({ ok: true, changed: true });
    expect((await reasoningOf(modelId)).adminReasoning).toBeNull();
  });

  it("F-137: a catalog refresh's value never replaces an admin's", async () => {
    const modelId = await modelOf();
    const controls: ReasoningControls = reasoningControlsFixtures.toggle;
    expect(await setModelReasoning(deps, admin, { modelId, controls })).toMatchObject({ ok: true });
    // The catalog's value arrives beside it, as the sync writes it.
    await test.db.model.update({ where: { id: modelId }, data: { catalogReasoning: reasoningControlsFixtures.effort } });
    // And a refresh of the provider's models runs through the real sync.
    modelProvider.endpoints.set("https://models.example/v1", {
      token: PROVIDER_TOKEN,
      models: [{ endpointModelId: "dev-model-1", displayName: "Dev model", contextWindow: 200_000 }],
    });
    const synced = await syncProviderModels(
      { db: test.db, notices: postgresChangeNotices, clock: systemClock, adapters: { codeHost, secretStore, modelProvider }, catalog: () => Promise.resolve([]) },
      { organizationId: world.organizationId, providerId: world.providerId },
    );
    expect(synced).toMatchObject({ ok: true });
    const model = await reasoningOf(modelId);
    expect(model.adminReasoning).toEqual(controls);
    expect(effectiveReasoning(model)).toEqual(controls);
  });
});

describe("the profile's level", () => {
  const profileDeps = (notices: M3Deps["notices"] = postgresChangeNotices): M3Deps => ({
    ...deps,
    notices,
    jobs: { enqueueInTx: () => Promise.resolve() },
    adapters: { codeHost, secretStore, modelProvider },
  });
  const input = async (name: string): Promise<SaveAgentProfileInput> => ({
    profileId: null,
    name,
    adapter: "opencode",
    modelId: (await test.db.model.findFirstOrThrow({ where: { providerId: world.providerId, endpointModelId: "dev-model-1" } })).id,
    instructions: null,
    approvalRules: [],
    planFirst: false,
    access: { kind: "everyone" },
    mcpServers: [],
    skills: [],
  });
  const auditsOf = (profileId: string) =>
    test.db.auditEntry.findMany({ where: { entityId: profileId, action: { startsWith: "agent-profile." } }, orderBy: { createdAt: "asc" }, select: { action: true, data: true } });

  it("F-137: a profile's save stores its level, its audit entry carries it, and a rollback leaves neither", async () => {
    const created = await saveAgentProfile(profileDeps(), admin, { ...(await input("Thinks hard")), effort: "high" });
    if (!created.ok) {
      throw new Error(created.message);
    }
    const profileId = agentProfileIdSchema.parse(created.profileId);
    const effortOf = async () => (await test.db.agentProfile.findUniqueOrThrow({ where: { id: profileId }, select: { effort: true } })).effort;
    expect(await effortOf()).toBe("high");
    // A save that leaves the level out keeps it.
    expect(await saveAgentProfile(profileDeps(), admin, { ...(await input("Thinks hard")), profileId, planFirst: true })).toMatchObject({ ok: true });
    expect(await effortOf()).toBe("high");
    expect(await saveAgentProfile(profileDeps(), admin, { ...(await input("Thinks hard")), profileId, planFirst: true, effort: "low" })).toMatchObject({ ok: true });
    expect(await effortOf()).toBe("low");
    const audits = await auditsOf(profileId);
    expect(audits.map((entry) => entry.action)).toEqual(["agent-profile.created", "agent-profile.updated", "agent-profile.updated"]);
    expect(audits.map((entry) => (entry.data !== null && typeof entry.data === "object" && !Array.isArray(entry.data) ? entry.data["effort"] : null))).toEqual(["high", "high", "low"]);
    expect(audits[2]?.data).toMatchObject({ changed: "effort" });

    // A failure later in the same transaction rolls the level and the entry back together.
    const failing: M3Deps["notices"] = { emitInTx: () => Promise.reject(new Error("rolled back")) };
    await expect(saveAgentProfile(profileDeps(failing), admin, { ...(await input("Thinks hard")), profileId, planFirst: true, effort: "max" })).rejects.toThrow("rolled back");
    expect(await effortOf()).toBe("low");
    expect(await auditsOf(profileId)).toHaveLength(3);
  });
});

describe("the audit entries", () => {
  it("F-137: every use case writes its audit entry in its transaction, and a rollback leaves none", async () => {
    const task = await leasedTask();
    const modelId = modelIdSchema.parse((await test.db.model.findFirstOrThrow({ where: { providerId: world.providerId, endpointModelId: "dev-model-1" } })).id);
    const before = await test.db.model.findUniqueOrThrow({ where: { id: modelId }, select: { adminReasoning: true } });
    const audits = { action: { in: ["task.effort-changed", "model.reasoning-changed"] }, entityId: { in: [task.taskId, modelId] } };
    const auditsBefore = await test.db.auditEntry.count({ where: audits });
    const rollback = new Error("rolled back");
    await expect(
      test.db.$transaction(async (tx) => {
        expect(await setTaskEffortInTx(deps, tx, driver, { taskId: task.taskId, level: "max", changeId: changeId() })).toMatchObject({ ok: true });
        expect(await setModelReasoningInTx(deps, tx, admin, { modelId, controls: reasoningControlsFixtures.budget })).toMatchObject({ ok: true });
        expect(await tx.auditEntry.count({ where: audits })).toBe(auditsBefore + 2);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await traces(task.taskId)).toEqual({ effort: "default", events: [], audits: [], commands: [] });
    expect(await test.db.model.findUniqueOrThrow({ where: { id: modelId }, select: { adminReasoning: true } })).toEqual(before);
    expect(await test.db.auditEntry.count({ where: audits })).toBe(auditsBefore);
  });
});
