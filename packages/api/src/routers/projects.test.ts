import { projectIdSchema, repoIdSchema } from "@ostra/protocol";
import type { EnvironmentConfig } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// Ticket 32: projects, environments and detection, against the fake code host. An admin creates a
// project on `ostra-test/test1`, a member can't save its environment, another organization can't
// see it, and no router returns a secret's value.

const APP_ID = "5821041";
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nPROJECT-KEY-BODY-0123456789\n-----END RSA PRIVATE KEY-----";
const SECRET_VALUE = "stripe-secret-value-0123456789";

const repoFiles = new Map([
  ["package.json", '{"name":"test1","packageManager":"pnpm@10.4.1"}'],
  ["pnpm-lock.yaml", "lockfileVersion: 9"],
  [".nvmrc", "22\n"],
  [".env.example", "DATABASE_URL=\nSTRIPE_SECRET_KEY=\nPORT=3000\n"],
  ["docker-compose.yml", "services:\n  db:\n    image: postgres:16\n    ports:\n      - 5432:5432\n"],
  ["src/index.ts", "export {};"],
]);

let harness: ApiHarness;
let connectionId: string;
const installationId = "9001";

beforeAll(async () => {
  harness = await createApiHarness();
  harness.fakes.codeHost.apps.set(APP_ID, {
    privateKey: PEM,
    info: { appId: APP_ID, slug: "ostra-test-app", name: "ostra test app", permissions: { checks: "write", actions: "read" }, events: [] },
    bot: { name: "ostra-test-app[bot]", email: "1+ostra-test-app[bot]@users.noreply.github.com" },
    installations: [{ installationId, accountLogin: "ostra-test", accountKind: "organization", repositorySelection: "all" }],
    repos: new Map([
      [
        installationId,
        [
          { hostRepoId: "1", fullName: "ostra-test/test1", defaultBranch: "main", private: true, cloneUrl: "https://github.example/ostra-test/test1.git" },
          { hostRepoId: "2", fullName: "ostra-test/test2", defaultBranch: "main", private: true, cloneUrl: "https://github.example/ostra-test/test2.git" },
        ],
      ],
    ]),
  });
  harness.fakes.codeHost.files.set("ostra-test/test1", repoFiles);
  harness.fakes.codeHost.files.set("ostra-test/test2", new Map());
  const connected = await (await harness.as(harness.fixture.a.admin)).github.connectExisting({ appId: APP_ID, privateKey: PEM, webhookSecret: "whsec-0123456789" });
  connectionId = connected.connectionId;
});

afterAll(async () => {
  await harness.dispose();
});

const form = (over: Record<string, unknown> = {}) => ({
  name: "Test One",
  slug: "test-one",
  access: "open" as const,
  repo: { connectionId, installationId, fullName: "ostra-test/test1" },
  ...over,
});

describe("projects.create", () => {
  it("is for admins: a member is FORBIDDEN and nothing is created", async () => {
    await expect((await harness.as(harness.fixture.a.member)).projects.create(form())).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await harness.test.db.project.count({ where: { slug: "test-one" } })).toBe(0);
  });

  it("creates the project, links the repo, the default pool and profile, and drafts the environment from the repo", async () => {
    const { a } = harness.fixture;
    const created = await (await harness.as(a.admin)).projects.create(form());

    const project = await harness.test.db.project.findUniqueOrThrow({ where: { id: created.projectId }, include: { repos: true, pools: { include: { pool: true } }, environment: true } });
    expect(project).toMatchObject({ organizationId: a.organization.id, slug: "test-one", access: "open" });
    expect(project.repos).toHaveLength(1);
    expect(project.repos[0]).toMatchObject({ fullName: "ostra-test/test1", defaultBranch: "main", checkoutDir: "test1", envFile: ".env", hostRepoId: "1", installationId });
    // Linked to the organization's default pool, and its profiles are the built-in OpenCode profile.
    expect(project.pools.map((link) => [link.pool.isDefault, link.pool.organizationId])).toEqual([[true, a.organization.id]]);
    const profile = await harness.test.db.agentProfile.findFirstOrThrow({ where: { organizationId: a.organization.id, builtIn: true } });
    expect([project.defaultRefineProfileId, project.defaultCodeProfileId, project.defaultReviewProfileId]).toEqual([profile.id, profile.id, profile.id]);
    // The environment is a draft with the detected setup script.
    expect(project.environment).toMatchObject({ status: "draft", setupScript: "set -euo pipefail\ncorepack enable\npnpm install --frozen-lockfile\n" });
    expect(created.environmentId).toBe(project.environment?.id);

    // The detection's reasons name the files it read, and services are marked as not run on host.
    expect(created.detection.reasons.map((reason) => reason.file)).toEqual(
      expect.arrayContaining(["package.json", "pnpm-lock.yaml", ".nvmrc", ".env.example", "docker-compose.yml"]),
    );
    expect(created.detection.variables.map((variable) => [variable.name, variable.secret])).toEqual([
      ["DATABASE_URL", false],
      ["STRIPE_SECRET_KEY", true],
      ["PORT", false],
    ]);
    expect(created.detection.services).toMatchObject([{ name: "db", runsOnHost: false }]);

    expect(await harness.test.db.auditEntry.count({ where: { organizationId: a.organization.id, projectId: created.projectId, action: "project.created" } })).toBe(1);
    expect(await harness.test.db.changeNotice.count({ where: { organizationId: a.organization.id, projectId: created.projectId, entity: "project" } })).toBe(1);
  });

  it("drafts the same from a host that lists a repo's files, reading only what it needs", async () => {
    harness.fakes.codeHost.treeEnabled = true;
    try {
      const created = await (await harness.as(harness.fixture.a.admin)).projects.create(form({ name: "Test One Again", slug: "test-one-again" }));
      expect(created.detection.setupLines).toEqual(["corepack enable", "pnpm install --frozen-lockfile"]);
      expect(created.detection.reasons.map((reason) => reason.file)).toContain("pnpm-lock.yaml");
    } finally {
      harness.fakes.codeHost.treeEnabled = false;
    }
  });

  it("refuses a slug that exists, a repo the installation doesn't include, and another organization's connection", async () => {
    const { a, b } = harness.fixture;
    const admin = await harness.as(a.admin);
    await expect(admin.projects.create(form())).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(admin.projects.create(form({ slug: "elsewhere", repo: { connectionId, installationId, fullName: "ostra-test/not-installed" } }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(admin.projects.create(form({ slug: "wrong-installation", repo: { connectionId, installationId: "424242", fullName: "ostra-test/test1" } }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // B's admin presenting A's connection ID gets nothing of A's.
    await expect((await harness.as(b.admin)).projects.create(form({ slug: "stolen" }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await harness.test.db.project.count({ where: { slug: { in: ["elsewhere", "wrong-installation", "stolen"] } } })).toBe(0);
  });

  it("validates its input: a slug is lowercase letters, digits and inner hyphens", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    await expect(admin.projects.create(form({ slug: "Not A Slug" }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(admin.projects.create(form({ name: "   " }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("projects.list and projects.get", () => {
  it("lists the open projects to members, and leaves out a restricted one they aren't on and other organizations'", async () => {
    const { a, b } = harness.fixture;
    const forMember = (await (await harness.as(a.member)).projects.list()).map((project) => project.slug);
    expect(forMember).toContain("test-one");
    expect(forMember).not.toContain(harness.fixture.a.restrictedProject.slug);
    const forInsider = (await (await harness.as(a.insider)).projects.list()).map((project) => project.slug);
    expect(forInsider).toContain(harness.fixture.a.restrictedProject.slug);
    const forAdmin = (await (await harness.as(a.admin)).projects.list()).map((project) => project.slug);
    expect(forAdmin).toContain(harness.fixture.a.restrictedProject.slug);
    // Organization B sees only its own.
    expect((await (await harness.as(b.admin)).projects.list()).map((project) => project.slug)).toEqual([b.project.slug]);
  });

  it("gets a project for a member of its organization, with their role, and says NOT_FOUND to everyone else", async () => {
    const { a, b } = harness.fixture;
    const project = await harness.test.db.project.findFirstOrThrow({ where: { slug: "test-one" } });
    const asMember = await (await harness.as(a.member)).projects.get({ projectId: projectIdSchema.parse(project.id) });
    expect(asMember).toMatchObject({ slug: "test-one", role: "member", environmentStatus: "draft", repos: [{ fullName: "ostra-test/test1" }] });
    expect(asMember.pools).toHaveLength(1);
    expect(asMember.defaultCodeProfile).toMatchObject({ name: "OpenCode" });
    await expect((await harness.as(b.admin)).projects.get({ projectId: projectIdSchema.parse(project.id) })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect((await harness.as(a.member)).projects.get({ projectId: a.restrictedProject.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("counts the tasks waiting on a person, for the sidebar", async () => {
    const { a } = harness.fixture;
    const project = await harness.test.db.project.findFirstOrThrow({ where: { slug: "test-one" } });
    await harness.test.db.task.create({
      data: {
        organizationId: a.organization.id,
        projectId: project.id,
        kind: "code",
        source: "prompt",
        title: "waiting",
        prompt: "a prompt",
        branchName: "ostra/aaaaaaaa-waiting",
        state: "needs_you",
        needsYouReason: "question",
      },
    });
    const summary = (await (await harness.as(a.member)).projects.list()).find((candidate) => candidate.slug === "test-one");
    expect(summary).toMatchObject({ needsYouCount: 1, runningCount: 0 });
  });
});

describe("environments", () => {
  const projectId = async () => projectIdSchema.parse((await harness.test.db.project.findFirstOrThrow({ where: { slug: "test-one" } })).id);
  const repoIdOf = async () => repoIdSchema.parse((await harness.test.db.repo.findFirstOrThrow({ where: { fullName: "ostra-test/test1", projectId: await projectId() } })).id);

  const config = async (over: Partial<EnvironmentConfig> = {}): Promise<EnvironmentConfig> => ({
    baseImage: null,
    setupScript: "npm ci\n",
    envFiles: [{ repoId: await repoIdOf(), path: ".env.local" }],
    entries: [
      { kind: "variable", repoId: await repoIdOf(), name: "PORT", value: "3000", availableDuringSetup: false },
      { kind: "secret", repoId: await repoIdOf(), name: "STRIPE_SECRET_KEY", value: SECRET_VALUE, availableDuringSetup: false },
      { kind: "file", repoId: await repoIdOf(), path: "config/dev.json", content: '{"a":1}', availableDuringSetup: true },
    ],
    ...over,
  });

  it("is saved by an admin only: a member of the project is FORBIDDEN, another organization sees nothing", async () => {
    const { a, b } = harness.fixture;
    const id = await projectId();
    const body = { projectId: id, environment: await config() };
    await expect((await harness.as(a.member)).environments.save(body)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect((await harness.as(b.admin)).environments.save(body)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect((await harness.as(b.admin)).environments.get({ projectId: id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect((await harness.as(a.member)).environments.detect({ projectId: id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await harness.test.db.environmentEntry.count()).toBe(0);
  });

  it("is saved with its secret in the secret store, and shown with the secret masked", async () => {
    const { a } = harness.fixture;
    const id = await projectId();
    const admin = await harness.as(a.admin);
    const saved = await admin.environments.save({ projectId: id, environment: await config() });
    expect(saved.warnings).toEqual([]);

    const row = await harness.test.db.environmentEntry.findFirstOrThrow({ where: { kind: "secret" } });
    expect(row.value).toBeNull();
    expect(harness.fakes.secretStore.entries.get(row.secretRef ?? "")).toMatchObject({ organizationId: a.organization.id, value: SECRET_VALUE });

    const shown = await (await harness.as(a.member)).environments.get({ projectId: id });
    expect(shown).toMatchObject({ status: "saved", setupScript: "npm ci\n" });
    expect(shown.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "variable", name: "PORT", value: "3000" }),
        expect.objectContaining({ kind: "secret", name: "STRIPE_SECRET_KEY", hasValue: true }),
        expect.objectContaining({ kind: "file", path: "config/dev.json", content: '{"a":1}' }),
      ]),
    );
    expect(JSON.stringify(shown)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(shown)).not.toContain(row.secretRef ?? "never");
    // The repo's env file is where the admin said; the audit entry holds counts, no value.
    expect((await harness.test.db.repo.findUniqueOrThrow({ where: { id: await repoIdOf() } })).envFile).toBe(".env.local");
    const audit = JSON.stringify(await harness.test.db.auditEntry.findMany({ where: { action: "environment.saved" } }));
    expect(audit).not.toContain(SECRET_VALUE);
    expect(audit).toContain('"secrets":1');
  });

  it("keeps a secret saved without a value, replaces one saved with a value, and deletes one dropped", async () => {
    const { a } = harness.fixture;
    const id = await projectId();
    const repoId = await repoIdOf();
    const admin = await harness.as(a.admin);
    const before = await harness.test.db.environmentEntry.findFirstOrThrow({ where: { kind: "secret" } });

    // Saved again without a value: the same reference stays.
    await admin.environments.save({
      projectId: id,
      environment: await config({ entries: [{ kind: "secret", repoId, name: "STRIPE_SECRET_KEY", availableDuringSetup: false }] }),
    });
    expect((await harness.test.db.environmentEntry.findFirstOrThrow({ where: { kind: "secret" } })).secretRef).toBe(before.secretRef);

    // With a new value: a new reference, and the old value is gone from the store.
    await admin.environments.save({
      projectId: id,
      environment: await config({ entries: [{ kind: "secret", repoId, name: "STRIPE_SECRET_KEY", value: "replacement-value-99", availableDuringSetup: false }] }),
    });
    const replaced = await harness.test.db.environmentEntry.findFirstOrThrow({ where: { kind: "secret" } });
    expect(replaced.secretRef).not.toBe(before.secretRef);
    expect(harness.fakes.secretStore.values()).not.toContain(SECRET_VALUE);
    expect(harness.fakes.secretStore.values()).toContain("replacement-value-99");

    // Dropped: no row, and no value left in the store.
    await admin.environments.save({ projectId: id, environment: await config({ entries: [] }) });
    expect(await harness.test.db.environmentEntry.count({ where: { kind: "secret" } })).toBe(0);
    expect(harness.fakes.secretStore.values()).not.toContain("replacement-value-99");
  });

  it("refuses a new secret with no value, an unknown repo and a duplicate, and stores nothing for them", async () => {
    const { a } = harness.fixture;
    const id = await projectId();
    const repoId = await repoIdOf();
    const admin = await harness.as(a.admin);
    const storedBefore = harness.fakes.secretStore.entries.size;
    await expect(
      admin.environments.save({ projectId: id, environment: await config({ entries: [{ kind: "secret", repoId, name: "NEW_SECRET", availableDuringSetup: false }] }) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      admin.environments.save({
        projectId: id,
        environment: await config({ entries: [{ kind: "variable", repoId: repoIdSchema.parse("not-a-repo-of-this-project"), name: "A", value: "1", availableDuringSetup: false }] }),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      admin.environments.save({
        projectId: id,
        environment: await config({
          entries: [
            { kind: "variable", repoId, name: "A", value: "1", availableDuringSetup: false },
            { kind: "secret", repoId, name: "A", value: "dup-secret-value", availableDuringSetup: false },
          ],
        }),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(harness.fakes.secretStore.entries.size).toBe(storedBefore);
  });

  it("warns that a base image applies on docker only when none of the project's runners uses docker", async () => {
    const { a } = harness.fixture;
    const id = await projectId();
    const admin = await harness.as(a.admin);
    const without = await admin.environments.save({ projectId: id, environment: await config({ baseImage: "node:22", entries: [] }) });
    expect(without.warnings).toHaveLength(1);
    expect(without.warnings[0]).toContain("docker");
    const pool = await harness.test.db.runnerPool.findFirstOrThrow({ where: { organizationId: a.organization.id, isDefault: true } });
    await harness.test.db.runner.create({
      data: { organizationId: a.organization.id, kind: "pool", poolId: pool.id, name: "box", publicKey: "d".repeat(43), executor: "docker", capacity: 2, version: "0.0.0", state: "online" },
    });
    const withDocker = await admin.environments.save({ projectId: id, environment: await config({ baseImage: "node:22", entries: [] }) });
    expect(withDocker.warnings).toEqual([]);
  });

  it("drafts again from the repo on request, with the reasons", async () => {
    const { a } = harness.fixture;
    const detected = await (await harness.as(a.admin)).environments.detect({ projectId: await projectId() });
    expect(detected).toHaveLength(1);
    expect(detected[0]).toMatchObject({ fullName: "ostra-test/test1" });
    expect(detected[0]?.detection.reasons.map((reason) => reason.file)).toContain(".env.example");
  });

  it("leaves no router output holding a stored secret", async () => {
    const { a } = harness.fixture;
    const id = await projectId();
    const admin = await harness.as(a.admin);
    await admin.environments.save({ projectId: id, environment: await config() });
    const outputs = JSON.stringify([
      await admin.environments.get({ projectId: id }),
      await admin.environments.detect({ projectId: id }),
      await admin.projects.list(),
      await admin.projects.get({ projectId: id }),
      await admin.github.connection(),
    ]);
    for (const value of [...harness.fakes.secretStore.values(), ...harness.fakes.secretStore.entries.keys()]) {
      expect(outputs).not.toContain(value);
    }
    expect(JSON.stringify(harness.logs)).not.toContain(SECRET_VALUE);
  });
});
