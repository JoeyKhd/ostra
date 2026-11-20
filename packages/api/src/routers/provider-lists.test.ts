import { randomUUID } from "node:crypto";

import { ingestEvents, modelNameSchema, postgresChangeNotices } from "@ostra/domain";
import { mapMember } from "@ostra/db";
import type { SeededMember } from "@ostra/db/testing";
import { leaseEpochSchema, modelIdSchema, providerIdSchema, sessionSeqSchema, taskIdSchema } from "@ostra/protocol";
import type { ModelId, ProjectId, ProviderId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedLease, seedPersonalRunner, seedTask } from "../testing/index.ts";
import type { ApiHarness, AppCaller } from "../testing/index.ts";

// F-135 (ticket 50; ADR 0065): provider lists, model choices and the model by name through the
// panel's API, proved with two stub endpoints (the live two-client run is the maintainer's, ticket
// 55). The access matrix for each procedure; no view holds a token, searched by value; the preview
// and the save, a stale preview refused; spend per provider equal to its sessions' spend through
// the real ingest; and a profile saved by model name, with its options.

const URL_A = "https://client-a-models.example.com/v1";
const URL_B = "https://client-b-models.example.com/v1";
const TOKEN_A = "sk-client-a-token-0123456789abcdefABCDEF";
const TOKEN_B = "sk-client-b-token-0123456789abcdefABCDEF";
const SHARED = modelNameSchema.parse({ kind: "custom", endpointModelId: "shared-model" });

let harness: ApiHarness;
let providerA: ProviderId;
let providerB: ProviderId;
let projectAdmin: SeededMember;
/** Each provider's row for each endpoint model. */
const rows = new Map<string, ModelId>();

const admin = (): Promise<AppCaller> => harness.as(harness.fixture.a.admin);

beforeAll(async () => {
  harness = await createApiHarness();
  const { a } = harness.fixture;
  harness.fakes.modelProvider.endpoints.set(URL_A, {
    token: TOKEN_A,
    apiFormat: "openai-compatible",
    authScheme: "bearer",
    models: [
      { endpointModelId: "shared-model", displayName: "Shared", contextWindow: 100_000 },
      { endpointModelId: "a-only", displayName: "A only", contextWindow: 100_000 },
    ],
  });
  harness.fakes.modelProvider.endpoints.set(URL_B, {
    token: TOKEN_B,
    apiFormat: "openai-compatible",
    authScheme: "bearer",
    models: [
      { endpointModelId: "shared-model", displayName: "Shared", contextWindow: 100_000 },
      { endpointModelId: "b-only", displayName: "B only", contextWindow: 100_000 },
    ],
  });
  const caller = await admin();
  const create = async (name: string, baseUrl: string, token: string) =>
    providerIdSchema.parse((await caller.providers.create({ name, baseUrl, apiFormat: "openai-compatible", authScheme: "bearer", sessionsAtOnce: null, allowOnPersonalRunners: true, token })).providerId);
  // The first provider joins the default list; the second joins none.
  providerA = await create("Client A", URL_A, TOKEN_A);
  providerB = await create("Client B", URL_B, TOKEN_B);
  for (const model of await harness.test.db.model.findMany({ where: { organizationId: a.organization.id }, select: { id: true, providerId: true, endpointModelId: true } })) {
    rows.set(`${model.providerId}:${model.endpointModelId}`, modelIdSchema.parse(model.id));
  }
  // A project admin of the restricted project who is no organization admin.
  const user = await harness.test.db.user.create({ data: { id: randomUUID(), name: "Pat", email: `pat-${randomUUID().slice(0, 8)}@example.com`, username: `pat-${randomUUID().slice(0, 8)}` } });
  projectAdmin = mapMember(await harness.test.db.member.create({ data: { id: randomUUID(), organizationId: a.organization.id, userId: user.id, role: "member", createdAt: new Date() } }));
  await harness.test.db.projectMember.create({ data: { organizationId: a.organization.id, projectId: a.restrictedProject.id, memberId: projectAdmin.id, role: "admin" } });
  // A profile that names the shared model.
  await caller.agentProfiles.save({
    name: "Shared model",
    adapter: "opencode",
    modelId: null,
    modelName: SHARED,
    instructions: null,
    approvalRules: [],
    planFirst: false,
    access: { kind: "everyone" },
    mcpServers: [],
    skills: [],
  });
});

afterAll(async () => {
  await harness.dispose();
});

const row = (providerId: ProviderId, endpointModelId: string): ModelId => {
  const id = rows.get(`${providerId}:${endpointModelId}`);
  if (id === undefined) {
    throw new Error(`no row for ${endpointModelId}`);
  }
  return id;
};

describe("F-135: provider lists in the API", () => {
  it("F-135: a project reads its providers by name and which serves each model; the preview and the save, a stale preview refused", async () => {
    const { a } = harness.fixture;
    const projectId: ProjectId = a.openProject.id;
    const caller = await admin();
    const member = await harness.as(a.member);
    const before = await member.projects.providers({ projectId });
    expect(before.mode).toBe("default");
    expect(before.providers).toEqual([{ providerId: providerA, name: "Client A", host: "client-a-models.example.com", apiFormat: "openai-compatible" }]);
    expect(before.models).toEqual([
      { name: SHARED, text: "shared-model", displayName: "Shared", logoPath: null, served: { providerId: providerA, providerName: "Client A", modelId: row(providerA, "shared-model") }, needsConfirm: false, pinned: null },
    ]);
    // An idle box holding A's key, and an unfinished task on A's own model: what the move would do to them.
    const runnerId = await seedPersonalRunner(harness, a.admin.id, "preview-runner");
    const boxed = await seedTask(harness, { organizationId: a.organization.id, projectId, runnerId, sessionState: "idle" });
    const box = await harness.test.db.box.create({ data: { organizationId: a.organization.id, projectId, taskId: boxed.taskId, runnerId, executor: "host", state: "idle" }, select: { id: true } });
    await harness.test.db.session.update({ where: { id: boxed.sessionId }, data: { boxId: box.id, providerId: providerA, modelId: row(providerA, "a-only") } });

    // The project gets its own list with client B only: the shared model moves to B.
    const preview = await caller.projects.previewProviders({ projectId, mode: { kind: "own", providerIds: [providerB] } });
    expect(preview.whatHappens).toEqual({
      released: { count: 1, providers: [{ providerId: providerA, name: "Client A" }] },
      waiting: { count: 1, models: [{ text: "a-only", displayName: "A only" }] },
    });
    expect(preview.lines.map((line) => line.displayName)).toEqual(["A only", "B only", "Shared"]);
    expect(preview.lines.map((line) => [line.text, line.change, line.before?.providerId ?? null, line.after?.providerId ?? null])).toEqual([
      ["a-only", "loses", providerA, null],
      ["b-only", "gains", null, providerB],
      ["shared-model", "moves", providerA, providerB],
    ]);
    // Someone else changes the list in between: the save with the old preview is refused.
    await caller.projects.setProviders({ projectId, mode: { kind: "own", providerIds: [providerA] }, version: preview.version });
    await expect(caller.projects.setProviders({ projectId, mode: { kind: "own", providerIds: [providerB] }, version: preview.version })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await member.projects.providers({ projectId })).providers.map((line) => line.providerId)).toEqual([providerA]);
    await harness.test.db.task.update({ where: { id: boxed.taskId }, data: { state: "stopped", stoppedReason: "requested" } });
    await harness.test.db.box.update({ where: { id: box.id }, data: { state: "released" } });
    const fresh = await caller.projects.previewProviders({ projectId, mode: { kind: "own", providerIds: [providerB] } });
    await caller.projects.setProviders({ projectId, mode: { kind: "own", providerIds: [providerB] }, version: fresh.version });
    const after = await member.projects.providers({ projectId });
    expect(after.mode).toBe("own");
    expect(after.models[0]?.served).toEqual({ providerId: providerB, providerName: "Client B", modelId: row(providerB, "shared-model") });
    const audit = await harness.test.db.auditEntry.count({ where: { organizationId: a.organization.id, action: "project.providers-changed", entityId: projectId } });
    expect(audit).toBe(2);

    // Both providers on its list: the keep rule keeps B serving it, and an admin may choose A.
    const both = await caller.projects.previewProviders({ projectId, mode: { kind: "own", providerIds: [providerA, providerB] } });
    await caller.projects.setProviders({ projectId, mode: { kind: "own", providerIds: [providerA, providerB] }, version: both.version });
    expect((await member.projects.providers({ projectId })).models[0]?.served?.providerId).toBe(providerB);
    await caller.projects.chooseModelProvider({ projectId, modelId: row(providerA, "shared-model") });
    expect((await member.projects.providers({ projectId })).models[0]?.served?.providerId).toBe(providerA);
    // Back to the default list.
    const back = await caller.projects.previewProviders({ projectId, mode: { kind: "default" } });
    await caller.projects.setProviders({ projectId, mode: { kind: "default" }, version: back.version });
    expect((await member.projects.providers({ projectId })).mode).toBe("default");

    // The default list's own preview and save, stale refused too.
    const defaultPreview = await caller.providers.previewDefaultList({ providerIds: [providerA, providerB] });
    await caller.providers.setDefaultList({ providerIds: [providerA, providerB], version: defaultPreview.version });
    await expect(caller.providers.setDefaultList({ providerIds: [providerA], version: defaultPreview.version })).rejects.toMatchObject({ code: "CONFLICT" });
    const listed = await caller.providers.list();
    const listedB = listed.find((line) => line.id === providerB);
    expect(listedB?.onDefaultList).toBe(true);
    expect(listedB?.host).toBe("client-b-models.example.com");
    expect(listedB?.projects).toContainEqual({ projectId, name: a.openProject.name, via: "default" });
    // The default list may be empty: every project following it then has no key.
    const empty = await caller.providers.previewDefaultList({ providerIds: [] });
    expect(empty.lines.every((line) => line.after === null)).toBe(true);
    await caller.providers.setDefaultList({ providerIds: [], version: empty.version });
    expect((await caller.providers.list()).map((line) => line.onDefaultList)).toEqual([false, false]);
    expect((await member.projects.providers({ projectId })).models[0]?.served).toBeNull();
    const reset = await caller.providers.previewDefaultList({ providerIds: [providerA] });
    await caller.providers.setDefaultList({ providerIds: [providerA], version: reset.version });
  });

  it("F-135: the access matrix: organization admin, project admin, member, and an outsider of a restricted project", async () => {
    const { a } = harness.fixture;
    const restricted = a.restrictedProject.id;
    const outcome = async (call: () => Promise<unknown>): Promise<string> => {
      try {
        await call();
        return "ok";
      } catch (error) {
        return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "threw";
      }
    };
    const roles = { orgAdmin: harness.fixture.a.admin, projectAdmin, member: a.insider, outsider: a.member } as const;
    const table: Record<string, Record<keyof typeof roles, string>> = {};
    for (const [role, member] of Object.entries(roles)) {
      const caller = await harness.as(member);
      const calls: Record<string, () => Promise<unknown>> = {
        "projects.providers": () => caller.projects.providers({ projectId: restricted }),
        "projects.previewProviders": () => caller.projects.previewProviders({ projectId: restricted, mode: { kind: "default" } }),
        "projects.setProviders": () => caller.projects.setProviders({ projectId: restricted, mode: { kind: "default" }, version: "stale" }),
        "projects.chooseModelProvider": () => caller.projects.chooseModelProvider({ projectId: restricted, modelId: row(providerA, "shared-model") }),
        "providers.list": () => caller.providers.list(),
        "providers.previewDefaultList": () => caller.providers.previewDefaultList({ providerIds: [providerA] }),
        "providers.setDefaultList": () => caller.providers.setDefaultList({ providerIds: [providerA], version: "stale" }),
        "providers.confirmChoice": () => caller.providers.confirmChoice({ projectId: null, modelName: modelNameSchema.parse({ kind: "custom", endpointModelId: "never-chosen" }) }),
        "agentProfiles.modelOptions": () => caller.agentProfiles.modelOptions(),
        "providers.choicesToConfirm": () => caller.providers.choicesToConfirm(),
      };
      for (const [path, call] of Object.entries(calls)) {
        table[path] = { ...(table[path] ?? { orgAdmin: "", projectAdmin: "", member: "", outsider: "" }), [role]: await outcome(call) };
      }
    }
    expect(table).toEqual({
      "projects.providers": { orgAdmin: "ok", projectAdmin: "ok", member: "ok", outsider: "NOT_FOUND" },
      "projects.previewProviders": { orgAdmin: "ok", projectAdmin: "FORBIDDEN", member: "FORBIDDEN", outsider: "NOT_FOUND" },
      // The admin's stale version is refused after the access check passed.
      "projects.setProviders": { orgAdmin: "CONFLICT", projectAdmin: "FORBIDDEN", member: "FORBIDDEN", outsider: "NOT_FOUND" },
      // The restricted project follows the default list: an admin chooses there.
      "projects.chooseModelProvider": { orgAdmin: "PRECONDITION_FAILED", projectAdmin: "FORBIDDEN", member: "FORBIDDEN", outsider: "NOT_FOUND" },
      "providers.list": { orgAdmin: "ok", projectAdmin: "FORBIDDEN", member: "FORBIDDEN", outsider: "FORBIDDEN" },
      "providers.previewDefaultList": { orgAdmin: "ok", projectAdmin: "FORBIDDEN", member: "FORBIDDEN", outsider: "FORBIDDEN" },
      "providers.setDefaultList": { orgAdmin: "CONFLICT", projectAdmin: "FORBIDDEN", member: "FORBIDDEN", outsider: "FORBIDDEN" },
      // No choice was ever made for that model: NOT_FOUND for the admin who may confirm one.
      "providers.confirmChoice": { orgAdmin: "NOT_FOUND", projectAdmin: "FORBIDDEN", member: "FORBIDDEN", outsider: "FORBIDDEN" },
      "agentProfiles.modelOptions": { orgAdmin: "ok", projectAdmin: "FORBIDDEN", member: "FORBIDDEN", outsider: "FORBIDDEN" },
      "providers.choicesToConfirm": { orgAdmin: "ok", projectAdmin: "FORBIDDEN", member: "FORBIDDEN", outsider: "FORBIDDEN" },
    });
    // Another organization's admin reaches none of A's.
    const other = await harness.as(harness.fixture.b.admin);
    await expect(other.projects.providers({ projectId: a.openProject.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(JSON.stringify(await other.providers.list())).not.toContain(providerA);
  });

  it("F-135: an upgrade's marked choice is confirmed, or changed to another provider on the list", async () => {
    const { a } = harness.fixture;
    const caller = await admin();
    // The default list holds both; the upgrade left the shared model on B, marked to confirm.
    const both = await caller.providers.previewDefaultList({ providerIds: [providerA, providerB] });
    await caller.providers.setDefaultList({ providerIds: [providerA, providerB], version: both.version });
    await harness.test.db.modelChoice.updateMany({ where: { organizationId: a.organization.id, projectId: null, modelKey: "custom:shared-model" }, data: { modelId: row(providerB, "shared-model"), needsConfirm: true } });
    expect((await (await harness.as(a.member)).projects.providers({ projectId: a.openProject.id })).models[0]).toMatchObject({ needsConfirm: true, served: { providerId: providerB } });
    expect(await caller.providers.choicesToConfirm()).toEqual([
      {
        project: null,
        modelName: SHARED,
        text: "shared-model",
        displayName: "Shared",
        kept: { providerId: providerB, name: "Client B", modelId: row(providerB, "shared-model") },
        alternatives: [{ providerId: providerA, name: "Client A", modelId: row(providerA, "shared-model") }],
      },
    ]);
    await caller.providers.confirmChoice({ projectId: null, modelName: SHARED, modelId: row(providerA, "shared-model") });
    expect((await (await harness.as(a.member)).projects.providers({ projectId: a.openProject.id })).models[0]).toMatchObject({ needsConfirm: false, served: { providerId: providerA } });
    expect(await caller.providers.choicesToConfirm()).toEqual([]);
    const reset = await caller.providers.previewDefaultList({ providerIds: [providerA] });
    await caller.providers.setDefaultList({ providerIds: [providerA], version: reset.version });
  });

  it("F-135: no view holds a token, searched by value", async () => {
    const { a } = harness.fixture;
    const caller = await admin();
    const member = await harness.as(a.member);
    const views: unknown[] = [
      await caller.providers.list(),
      await caller.providers.models({ providerId: providerA }),
      await caller.providers.models({ providerId: providerB }),
      await caller.providers.previewDefaultList({ providerIds: [providerA, providerB] }),
      await caller.projects.previewProviders({ projectId: a.openProject.id, mode: { kind: "own", providerIds: [providerB] } }),
      await member.projects.providers({ projectId: a.openProject.id }),
      await caller.agentProfiles.modelOptions(),
      await member.spend.month({ month: new Date().toISOString().slice(0, 7) }),
    ];
    const text = JSON.stringify(views);
    expect(text).not.toContain(TOKEN_A);
    expect(text).not.toContain(TOKEN_B);
    // Nor any part of a token long enough to mean something.
    expect(text).not.toContain(TOKEN_A.slice(0, 16));
    expect(text).not.toContain(TOKEN_B.slice(-16));
  });

  it("F-135: spend per provider equals the sum of its sessions' spend, through the real ingest", async () => {
    const { a } = harness.fixture;
    const caller = await admin();
    for (const model of [row(providerA, "shared-model"), row(providerB, "shared-model")]) {
      await caller.providers.setModelPrice({ modelId: model, inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: null, cacheWritePerMTok: null });
    }
    const runnerId = await seedPersonalRunner(harness, a.admin.id, "spend-runner");
    const tasksBefore = new Map((await caller.providers.list()).map((line) => [line.id, line.monthTaskCount] as const));
    const organizationId = a.organization.id;
    const projectId = a.openProject.id;
    const run = async (providerId: ProviderId, tokens: { readonly input: number; readonly output: number }) => {
      const task = await seedTask(harness, { organizationId, projectId, runnerId });
      await seedLease(harness, task, organizationId, projectId, runnerId);
      await harness.test.db.session.update({ where: { id: task.sessionId }, data: { providerId, modelId: row(providerId, "shared-model") } });
      const result = await harness.test.db.$transaction((tx) =>
        ingestEvents(
          { tx, jobs: harness.deps.ports.jobs, notices: postgresChangeNotices, clock: harness.deps.ports.clock },
          {
            runnerId,
            events: [
              {
                sessionId: task.sessionId,
                sessionSeq: sessionSeqSchema.parse(1),
                leaseEpoch: leaseEpochSchema.parse(1),
                at: Date.now(),
                event: { kind: "usage.recorded", providerId, modelId: row(providerId, "shared-model"), inputTokens: tokens.input, outputTokens: tokens.output, cacheReadTokens: 0, cacheWriteTokens: 0, estimated: false },
              },
            ],
          },
        ),
      );
      expect(result.outcomes[0]?.kind).toBe("saved");
      return task.sessionId;
    };
    const sessions = [await run(providerA, { input: 100_000, output: 10_000 }), await run(providerB, { input: 200_000, output: 20_000 }), await run(providerA, { input: 50_000, output: 1_000 })];
    // The task's page names the provider its session used.
    const sessionB = sessions[1];
    if (sessionB === undefined) {
      throw new Error("three sessions");
    }
    const sessionTask = await harness.test.db.session.findUniqueOrThrow({ where: { id: sessionB }, select: { taskId: true } });
    expect((await (await harness.as(a.member)).tasks.get({ taskId: taskIdSchema.parse(sessionTask.taskId) })).session?.providerName).toBe("Client B");
    const month = new Date().toISOString().slice(0, 7);
    const view = await caller.spend.month({ month });
    const sessionRows = await harness.test.db.session.findMany({ where: { id: { in: sessions } }, select: { providerId: true, spentMicroUsd: true } });
    for (const providerId of [providerA, providerB]) {
      const fromSessions = sessionRows.filter((session) => session.providerId === providerId).reduce((sum, session) => sum + session.spentMicroUsd, 0);
      expect(fromSessions).toBeGreaterThan(0);
      expect(view.byProvider.find((line) => line.providerId === providerId)?.spentMicroUsd).toBe(fromSessions);
      expect((await caller.providers.list()).find((line) => line.id === providerId)?.monthSpentMicroUsd).toBe(fromSessions);
    }
    expect(view.byProvider.reduce((sum, line) => sum + line.spentMicroUsd, 0)).toBe(view.total.spentMicroUsd);
    // A second session of the first task on A counts the task once.
    const firstTask = await harness.test.db.session.findUniqueOrThrow({ where: { id: sessions[0] ?? "" }, select: { taskId: true } });
    await harness.test.db.session.create({ data: { organizationId, projectId, taskId: firstTask.taskId, origin: "resumed", state: "ended", outcome: "with_changes", endedAt: new Date(), providerId: providerA, modelId: row(providerA, "shared-model") } });
    // This month's tasks per key: two more on A, one more on B.
    const tasksAfter = new Map((await caller.providers.list()).map((line) => [line.id, line.monthTaskCount] as const));
    expect((tasksAfter.get(providerA) ?? 0) - (tasksBefore.get(providerA) ?? 0)).toBe(2);
    expect((tasksAfter.get(providerB) ?? 0) - (tasksBefore.get(providerB) ?? 0)).toBe(1);
  });

  it("F-135: a profile saved by model name, and its options", async () => {
    const { a } = harness.fixture;
    const caller = await admin();
    const options = await caller.agentProfiles.modelOptions();
    const shared = options.find((option) => option.text === "shared-model");
    expect(shared?.providers.map((provider) => provider.providerId).sort()).toEqual([providerA, providerB].sort());
    // B's own model: no project serves it, since no list holds B.
    const bOnly = options.find((option) => option.text === "b-only");
    expect(bOnly?.providers.map((provider) => provider.providerId)).toEqual([providerB]);
    expect(bOnly?.projectsWithout.map((project) => project.projectId).sort()).toEqual([a.openProject.id, a.restrictedProject.id].sort());
    expect(shared?.projectsWithout).toEqual([]);
    // Every project with its key for the model (item 10): A serves the shared model everywhere, B's nowhere.
    expect(shared?.projects.map((project) => [project.projectId, project.providerName]).sort()).toEqual([[a.openProject.id, "Client A"], [a.restrictedProject.id, "Client A"]].sort());
    expect(bOnly?.projects.map((project) => project.providerName)).toEqual([null, null]);

    const saved = await caller.agentProfiles.save({
      name: "B only",
      adapter: "opencode",
      modelId: null,
      modelName: modelNameSchema.parse({ kind: "custom", endpointModelId: "b-only" }),
      instructions: null,
      approvalRules: [],
      planFirst: false,
      access: { kind: "everyone" },
      mcpServers: [],
      skills: [],
    });
    const profile = await harness.test.db.agentProfile.findUniqueOrThrow({ where: { id: saved.profileId } });
    expect(profile).toMatchObject({ modelCustomName: "b-only", modelCatalogId: null });
    // The editor reads the saved name back, by name.
    expect((await caller.agentProfiles.get({ profileId: saved.profileId })).modelName).toEqual({ kind: "custom", endpointModelId: "b-only" });
    expect((await caller.agentProfiles.list()).find((listed) => listed.id === saved.profileId)?.modelName).toEqual({ kind: "custom", endpointModelId: "b-only" });
    // On the open project's list B serves nothing, so the New task check says "no key".
    expect(await (await harness.as(a.member)).tasks.startCheck({ projectId: a.openProject.id, profileId: saved.profileId })).toMatchObject({ kind: "wait", reason: "no-provider", modelName: "b-only" });
  });
});

describe("F-135: a catalog model's logo", () => {
  it("F-135: a catalog model carries its display name and logo in the project's providers and the plan lines", async () => {
    const { a } = harness.fixture;
    const caller = await admin();
    const URL_C = "https://client-c-models.example.com/v1";
    const TOKEN_C = "sk-client-c-token-0123456789abcdefABCDEF";
    harness.catalogEntries.push({
      catalogId: "acme/logo-model",
      name: "Acme Logo 1",
      aliases: ["logo-model"],
      contextWindow: 100_000,
      maxOutputTokens: 8_000,
      inputPricePerMTok: 1,
      outputPricePerMTok: 2,
      cacheReadPricePerMTok: null,
      cacheWritePricePerMTok: null,
      logoPath: "/assets/models/acme.svg",
      reasoning: { supported: false },
      reasoningPriceDiffers: false,
    });
    harness.fakes.modelProvider.endpoints.set(URL_C, { token: TOKEN_C, apiFormat: "openai-compatible", authScheme: "bearer", models: [{ endpointModelId: "logo-model", displayName: null, contextWindow: null }] });
    const providerC = providerIdSchema.parse(
      (await caller.providers.create({ name: "Client C", baseUrl: URL_C, apiFormat: "openai-compatible", authScheme: "bearer", sessionsAtOnce: null, allowOnPersonalRunners: false, token: TOKEN_C })).providerId,
    );
    const logoName = modelNameSchema.parse({ kind: "catalog", catalogId: "acme/logo-model" });
    await caller.agentProfiles.save({ name: "Logo", adapter: "opencode", modelId: null, modelName: logoName, instructions: null, approvalRules: [], planFirst: false, access: { kind: "everyone" }, mcpServers: [], skills: [] });
    const preview = await caller.providers.previewDefaultList({ providerIds: [providerA, providerC] });
    expect(preview.lines.find((line) => line.text === "acme/logo-model")).toMatchObject({ displayName: "Acme Logo 1", logoPath: "/assets/models/acme.svg", change: "gains" });
    await caller.providers.setDefaultList({ providerIds: [providerA, providerC], version: preview.version });
    const view = await (await harness.as(a.member)).projects.providers({ projectId: a.openProject.id });
    expect(view.models.find((model) => model.text === "acme/logo-model")).toMatchObject({ displayName: "Acme Logo 1", logoPath: "/assets/models/acme.svg", served: { providerId: providerC } });
    expect(view.models.find((model) => model.text === "shared-model")?.logoPath).toBeNull();
  });
});
