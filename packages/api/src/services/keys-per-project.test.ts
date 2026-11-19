import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDb } from "@ostra/db";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import {
  chooseModelProvider,
  confirmUpgradeChoice,
  modelNameSchema,
  postgresAuditLog,
  previewProviderChange,
  providerAuditActions,
  resolveSessionModel,
  setDefaultProviders,
  setProjectProviders,
} from "@ostra/domain";
import type { AuditLog, JobQueue, MemberScope, ProviderDeps } from "@ostra/domain";
import { modelIdSchema, organizationIdSchema, projectIdSchema, providerIdSchema } from "@ostra/protocol";
import type { ProviderId } from "@ostra/protocol";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { memoryJobQueue } from "../testing/memory-ports.ts";

// Keys per project's use cases (milestone 4's ticket 45, ADR 0065), against Postgres: each
// organization admin's save writes its audit entry in its own transaction, and a rollback leaves
// neither the change nor the entry; and an upgraded database keeps every task on its provider.

let test: TestDatabase;
let fixture: IsolationFixture;

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
});

afterAll(async () => {
  await test.dispose();
});

const scopeOf = (member: IsolationFixture["a"]["admin"], role: "admin" | "member"): MemberScope => ({
  organizationId: member.organizationId,
  memberId: member.id,
  role,
  projectRoles: new Map(),
});

const sonnet = modelNameSchema.parse({ kind: "catalog", catalogId: "anthropic/claude-sonnet" });

const seedProviders = async (organizationId: string) => {
  const make = async (label: string, endpointModelId: string, catalogId: string | null) => {
    const provider = await test.db.modelProvider.create({
      data: { organizationId, name: `${label}-${randomUUID().slice(0, 6)}`, baseUrl: "https://models.example.com", apiFormat: "anthropic_messages", authScheme: "x_api_key", tokenSecretRef: "ref" },
    });
    const model = await test.db.model.create({ data: { organizationId, providerId: provider.id, endpointModelId, catalogId } });
    return { providerId: providerIdSchema.parse(provider.id), modelId: modelIdSchema.parse(model.id) };
  };
  return { one: await make("client-one", "claude-sonnet", "anthropic/claude-sonnet"), two: await make("client-two", "sonnet-latest", "anthropic/claude-sonnet") };
};

const auditCount = (action: string): Promise<number> => test.db.auditEntry.count({ where: { organizationId: fixture.a.organization.id, action } });

/** An audit log that writes its entry, then fails: the transaction it's in must roll both back. */
const failingAfterAudit: AuditLog = {
  recordInTx: async (tx, entry) => {
    await postgresAuditLog.recordInTx(tx, entry);
    throw new Error("a later write in the same transaction failed");
  },
};

describe("keys per project's use cases", () => {
  let providers: Awaited<ReturnType<typeof seedProviders>>;
  const jobs = memoryJobQueue();
  const deps = (audit: AuditLog = postgresAuditLog, queue: JobQueue = jobs): ProviderDeps => ({ db: test.db, audit, jobs: queue, clock: { now: () => 1_700_000_000_000 } });
  const admin = (): MemberScope => scopeOf(fixture.a.admin, "admin");

  beforeAll(async () => {
    providers = await seedProviders(fixture.a.organization.id);
    await test.db.providerListEntry.create({ data: { organizationId: fixture.a.organization.id, projectId: null, providerId: providers.one.providerId } });
  });

  it("F-135: every use case writes its audit entry, and a rollback leaves none", async () => {
    const organizationId = fixture.a.organization.id;
    const project = projectIdSchema.parse(fixture.a.openProject.id);
    const choiceOf = (projectId: string | null) => test.db.modelChoice.findFirst({ where: { organizationId, projectId, modelKey: "catalog:anthropic/claude-sonnet" } });

    // The default list gains a second provider: the keep rule keeps the first serving the model.
    const before = await auditCount(providerAuditActions.defaultChanged);
    await expect(setDefaultProviders(deps(failingAfterAudit), admin(), { providerIds: [providers.one.providerId, providers.two.providerId] })).rejects.toThrow();
    expect(await auditCount(providerAuditActions.defaultChanged)).toBe(before);
    expect(await test.db.providerListEntry.count({ where: { organizationId, projectId: null } })).toBe(1);
    expect(await choiceOf(null)).toBeNull();
    const saved = await setDefaultProviders(deps(), admin(), { providerIds: [providers.one.providerId, providers.two.providerId] });
    expect(saved.ok).toBe(true);
    expect(await auditCount(providerAuditActions.defaultChanged)).toBe(before + 1);
    expect(await choiceOf(null)).toMatchObject({ modelId: providers.one.modelId, reason: "kept", needsConfirm: false });
    expect((await resolveSessionModel(test.db, { organizationId, projectId: project, modelName: sonnet }))).toEqual({ ok: true, providerId: providers.one.providerId, modelId: providers.one.modelId });

    // An admin moves the model to the second key on the default list.
    const choices = await auditCount(providerAuditActions.choiceChanged);
    await expect(chooseModelProvider(deps(failingAfterAudit), admin(), { projectId: null, modelId: providers.two.modelId })).rejects.toThrow();
    expect(await auditCount(providerAuditActions.choiceChanged)).toBe(choices);
    expect(await choiceOf(null)).toMatchObject({ modelId: providers.one.modelId });
    expect(await chooseModelProvider(deps(), admin(), { projectId: null, modelId: providers.two.modelId })).toEqual({ ok: true, modelKey: "catalog:anthropic/claude-sonnet" });
    expect(await auditCount(providerAuditActions.choiceChanged)).toBe(choices + 1);
    expect(await choiceOf(null)).toMatchObject({ modelId: providers.two.modelId, reason: "admin", chosenByMemberId: fixture.a.admin.id });

    // The project gets its own list with the first key alone: the model moves there, the release
    // of idle boxes is sent with the change, and a rollback leaves the project following the default.
    const projects = await auditCount(providerAuditActions.projectChanged);
    await expect(setProjectProviders(deps(failingAfterAudit), admin(), { projectId: project, mode: { kind: "own", providerIds: [providers.one.providerId] } })).rejects.toThrow();
    expect(await auditCount(providerAuditActions.projectChanged)).toBe(projects);
    expect((await test.db.project.findUniqueOrThrow({ where: { id: project } })).ownProviders).toBe(false);
    expect(await test.db.providerListEntry.count({ where: { organizationId, projectId: project } })).toBe(0);
    const own = await setProjectProviders(deps(), admin(), { projectId: project, mode: { kind: "own", providerIds: [providers.one.providerId] } });
    expect(own.ok && own.plan.lines.map((line) => line.change)).toEqual(["moves"]);
    expect(await auditCount(providerAuditActions.projectChanged)).toBe(projects + 1);
    expect(jobs.jobs.map((job) => job.key)).toContain(`project:${project}:release-boxes:1700000000000`);
    expect(await resolveSessionModel(test.db, { organizationId, projectId: project, modelName: sonnet })).toEqual({ ok: true, providerId: providers.one.providerId, modelId: providers.one.modelId });
    // Another project still follows the default and its choice.
    const restricted = projectIdSchema.parse(fixture.a.restrictedProject.id);
    expect(await resolveSessionModel(test.db, { organizationId, projectId: restricted, modelName: sonnet })).toMatchObject({ ok: true, providerId: providers.two.providerId });

    // The upgrade's mark, confirmed by an admin.
    await test.db.modelChoice.updateMany({ where: { organizationId, projectId: null }, data: { needsConfirm: true, reason: "upgrade" } });
    const confirms = await auditCount(providerAuditActions.choiceChanged);
    await expect(confirmUpgradeChoice(deps(failingAfterAudit), admin(), { projectId: null, modelName: sonnet })).rejects.toThrow();
    expect(await choiceOf(null)).toMatchObject({ needsConfirm: true });
    expect(await auditCount(providerAuditActions.choiceChanged)).toBe(confirms);
    expect(await confirmUpgradeChoice(deps(), admin(), { projectId: null, modelName: sonnet })).toEqual({ ok: true, confirmed: true });
    expect(await choiceOf(null)).toMatchObject({ needsConfirm: false });
    expect(await auditCount(providerAuditActions.choiceChanged)).toBe(confirms + 1);

    // A preview writes nothing.
    const total = await test.db.auditEntry.count({ where: { organizationId } });
    const preview = await previewProviderChange(test.db, admin(), { projectId: null, providerIds: [providers.one.providerId] });
    expect(preview.ok && preview.plan.lines.map((line) => line.change)).toEqual(["moves"]);
    expect(await test.db.auditEntry.count({ where: { organizationId } })).toBe(total);
  });

  it("F-135: refuses a member, and a list naming another organization's provider", async () => {
    const theirs = await seedProviders(fixture.b.organization.id);
    expect(await setDefaultProviders(deps(), scopeOf(fixture.a.member, "member"), { providerIds: [providers.one.providerId] })).toMatchObject({ ok: false, error: "forbidden" });
    expect(await setDefaultProviders(deps(), admin(), { providerIds: [theirs.one.providerId] })).toMatchObject({ ok: false, error: "not-found" });
    expect(
      await setProjectProviders(deps(), admin(), { projectId: projectIdSchema.parse(fixture.a.restrictedProject.id), mode: { kind: "own", providerIds: [theirs.two.providerId] } }),
    ).toMatchObject({ ok: false, error: "not-found" });
    expect(await chooseModelProvider(deps(), admin(), { projectId: null, modelId: theirs.one.modelId })).toMatchObject({ ok: false, error: "not-found" });
    // B's project isn't A's to change.
    expect(await setProjectProviders(deps(), admin(), { projectId: projectIdSchema.parse(fixture.b.project.id), mode: { kind: "default" } })).toMatchObject({ ok: false, error: "not-found" });
  });
});

// ---------- an upgraded database keeps every task on its provider ----------

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.resolve("@ostra/db"))), "..", "prisma", "migrations");
const keysMigration = "20261121010000_keys_per_project";

const withClient = async <T,>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
};

describe("the upgrade", () => {
  const serverUrl = inject("ostraDbServerUrl");
  const name = `ostra_keys_resolve_${randomUUID().slice(0, 8)}`;
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const upgradeUrl = url.toString();

  afterAll(async () => {
    await withClient(serverUrl, (client) => client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`));
  });

  it("F-135: after it, every existing task resolves the provider it used before, over two organizations", async () => {
    await withClient(serverUrl, (client) => client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`));
    const all = (await readdir(migrationsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const sqlOf = (migration: string): Promise<string> => readFile(path.join(migrationsDir, migration, "migration.sql"), "utf8");
    await withClient(upgradeUrl, async (client) => {
      for (const migration of all.filter((entry) => entry < keysMigration)) {
        await client.query(await sqlOf(migration));
      }
      // Organization A: two clients' keys, each serving a model only it has, and a model both
      // serve, which two profiles name on different keys. Organization B: one key.
      await client.query(`
        INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ('org-a', 'A', 'a', now()), ('org-b', 'B', 'b', now());
        INSERT INTO "model_provider" (id, "organizationId", name, "baseUrl", "apiFormat", "authScheme", "tokenSecretRef", "updatedAt")
          VALUES ('prov-a1', 'org-a', 'Client one', 'https://one.example.com', 'anthropic_messages', 'x_api_key', 'ref', now()),
                 ('prov-a2', 'org-a', 'Client two', 'https://two.example.com', 'anthropic_messages', 'x_api_key', 'ref', now()),
                 ('prov-b1', 'org-b', 'B key', 'https://b.example.com', 'openai_compatible', 'bearer', 'ref', now());
        INSERT INTO "model" (id, "organizationId", "providerId", "endpointModelId", "catalogId", "updatedAt")
          VALUES ('m-a1-sonnet', 'org-a', 'prov-a1', 'claude-sonnet', 'anthropic/claude-sonnet', now()),
                 ('m-a1-haiku', 'org-a', 'prov-a1', 'claude-haiku', 'anthropic/claude-haiku', now()),
                 ('m-a2-sonnet', 'org-a', 'prov-a2', 'sonnet-latest', 'anthropic/claude-sonnet', now()),
                 ('m-a2-custom', 'org-a', 'prov-a2', 'in-house-7b', NULL, now()),
                 ('m-b1-gpt', 'org-b', 'prov-b1', 'gpt-x', 'openai/gpt-x', now());
        INSERT INTO "agent_profile" (id, "organizationId", name, adapter, "modelId", "createdAt", "updatedAt")
          VALUES ('prof-a-sonnet-old', 'org-a', 'Sonnet one', 'opencode', 'm-a1-sonnet', now() - interval '2 days', now()),
                 ('prof-a-sonnet-new', 'org-a', 'Sonnet two', 'opencode', 'm-a2-sonnet', now() - interval '1 day', now()),
                 ('prof-a-haiku', 'org-a', 'Haiku', 'opencode', 'm-a1-haiku', now(), now()),
                 ('prof-a-custom', 'org-a', 'Custom', 'opencode', 'm-a2-custom', now(), now()),
                 ('prof-b', 'org-b', 'B', 'opencode', 'm-b1-gpt', now(), now());
        INSERT INTO "project" (id, "organizationId", name, slug, "updatedAt") VALUES ('proj-a', 'org-a', 'A', 'a', now()), ('proj-b', 'org-b', 'B', 'b', now());
        INSERT INTO "task" (id, "organizationId", "projectId", kind, source, title, prompt, "branchName", "agentProfileId", "updatedAt")
          VALUES ('task-sonnet-old', 'org-a', 'proj-a', 'code', 'prompt', 'x', 'x', 'ostra/1', 'prof-a-sonnet-old', now()),
                 ('task-sonnet-new', 'org-a', 'proj-a', 'code', 'prompt', 'x', 'x', 'ostra/2', 'prof-a-sonnet-new', now()),
                 ('task-haiku', 'org-a', 'proj-a', 'code', 'prompt', 'x', 'x', 'ostra/3', 'prof-a-haiku', now()),
                 ('task-custom', 'org-a', 'proj-a', 'code', 'prompt', 'x', 'x', 'ostra/4', 'prof-a-custom', now()),
                 ('task-b', 'org-b', 'proj-b', 'code', 'prompt', 'x', 'x', 'ostra/5', 'prof-b', now());
      `);
      for (const migration of all.filter((entry) => entry >= keysMigration)) {
        await client.query(await sqlOf(migration));
      }
    });

    const db = createDb(upgradeUrl);
    try {
      const tasks = await db.task.findMany({
        select: { id: true, organizationId: true, projectId: true, agentProfile: { select: { modelCatalogId: true, modelCustomName: true, model: { select: { id: true, providerId: true } } } } },
        orderBy: { id: "asc" },
      });
      const marked = new Set((await db.modelChoice.findMany({ where: { needsConfirm: true }, select: { modelKey: true } })).map((choice) => choice.modelKey));
      expect([...marked]).toEqual(["catalog:anthropic/claude-sonnet"]);
      const outcomes: Record<string, { readonly before: ProviderId; readonly after: ProviderId | null; readonly marked: boolean }> = {};
      for (const task of tasks) {
        const profile = task.agentProfile;
        if (profile?.model === null || profile?.model === undefined) {
          throw new Error("every fixture task has a model");
        }
        const modelName = modelNameSchema.parse(profile.modelCatalogId === null ? { kind: "custom", endpointModelId: profile.modelCustomName } : { kind: "catalog", catalogId: profile.modelCatalogId });
        const resolved = await resolveSessionModel(db, { organizationId: organizationIdSchema.parse(task.organizationId), projectId: projectIdSchema.parse(task.projectId), modelName });
        const key = profile.modelCatalogId === null ? `custom:${String(profile.modelCustomName)}` : `catalog:${profile.modelCatalogId}`;
        outcomes[task.id] = { before: providerIdSchema.parse(profile.model.providerId), after: resolved.ok ? resolved.providerId : null, marked: marked.has(key) };
      }
      // Every task resolves the provider it used, except the one whose model another profile named
      // on another key first: that one's model is marked for an admin to confirm.
      expect(outcomes).toEqual({
        "task-b": { before: "prov-b1", after: "prov-b1", marked: false },
        "task-custom": { before: "prov-a2", after: "prov-a2", marked: false },
        "task-haiku": { before: "prov-a1", after: "prov-a1", marked: false },
        "task-sonnet-new": { before: "prov-a2", after: "prov-a1", marked: true },
        "task-sonnet-old": { before: "prov-a1", after: "prov-a1", marked: true },
      });
    } finally {
      await db.$disconnect();
    }
  });
});
