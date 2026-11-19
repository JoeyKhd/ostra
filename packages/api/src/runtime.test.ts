import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createLogger } from "@ostra/adapter-sdk";
import { createJiraSite, JiraFakeAdapter } from "@ostra/adapter-sdk/testing";
import type { LogRecord } from "@ostra/adapter-sdk";
import { createTestDatabase } from "@ostra/db/testing";
import type { TestDatabase } from "@ostra/db/testing";
import { parseServerSettings } from "@ostra/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createCatalogSource } from "./catalog/catalog-source.ts";
import { appRouter } from "./routers/app-router.ts";
import { createApiRuntime } from "./runtime.ts";
import type { ApiRuntime } from "./runtime.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore, TEST_PASSWORD, cookieHeaderFrom, memoryJobQueue, memoryOutbox } from "./testing/index.ts";
import { createCallerFactory } from "./trpc/init.ts";

// The composition root (ticket 30): what `apps/web` builds once per server process. A fresh install
// with no setting still works (the self-hosting rule): the secret is generated and kept, the first
// admin is seeded (F-001: demo@demo.com / demo unless OSTRA_ADMIN_* says otherwise), and a
// request's cookie resolves to the member it is.

const runtimes: ApiRuntime[] = [];
const databases: TestDatabase[] = [];
const dataDirs: string[] = [];
const callerFactory = createCallerFactory(appRouter);

afterAll(async () => {
  await Promise.all(runtimes.map((runtime) => runtime.close()));
  await Promise.all(databases.map((database) => database.dispose()));
  await Promise.all(dataDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fresh install: an empty, migrated database and an empty data folder. */
const freshInstall = async (): Promise<{ readonly test: TestDatabase; readonly dataDir: string }> => {
  const test = await createTestDatabase();
  databases.push(test);
  const dataDir = await mkdtemp(path.join(tmpdir(), "ostra-runtime-"));
  dataDirs.push(dataDir);
  return { test, dataDir };
};

const start = async (install: { readonly test: TestDatabase; readonly dataDir: string }, env: Readonly<Record<string, string>> = {}) => {
  const parsed = parseServerSettings({ NODE_ENV: "test", DATABASE_URL: install.test.url, OSTRA_DATA_DIR: install.dataDir, ...env });
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("; "));
  }
  const logs: LogRecord[] = [];
  const runtime = await createApiRuntime({
    settings: parsed.settings,
    db: install.test.db,
    adapters: { codeHost: new FakeCodeHost(), modelProvider: new FakeModelProvider(), secretStore: new FakeSecretStore() },
    jobs: memoryJobQueue(),
    outbox: memoryOutbox(),
    catalog: createCatalogSource({
      fetchEnabled: false,
      loadBundled: () => Promise.resolve([]),
      fetchLatest: () => Promise.resolve([]),
      clock: { now: () => Date.now() },
      logger: createLogger(() => undefined),
    }),
    blobStore: { name: "postgres", health: () => Promise.resolve({ status: "ok" }), read: () => Promise.resolve({ kind: "not-found" }) },
    makeLinearTracker: () => new JiraFakeAdapter({ site: createJiraSite() }),
    logger: createLogger((record) => {
      logs.push(record);
    }),
  });
  runtimes.push(runtime);
  return { runtime, logs };
};

const seededLines = (logs: readonly LogRecord[]): readonly LogRecord[] => logs.filter((record) => record.message === "setup.first_admin_seeded");

describe("a fresh install with no setting", () => {
  let install: { readonly test: TestDatabase; readonly dataDir: string };

  beforeAll(async () => {
    install = await freshInstall();
  });

  it("F-001: a fresh install with no setting seeds demo@demo.com / demo, the instance admin of a first organization named Demo", async () => {
    const { logs } = await start(install);
    const { db } = install.test;
    const user = await db.user.findUniqueOrThrow({ where: { email: "demo@demo.com" } });
    expect(user).toMatchObject({ username: "demo", role: "admin", mustChangePassword: true });
    const organization = await db.organization.findFirstOrThrow();
    expect(organization).toMatchObject({ name: "Demo", slug: "demo" });
    expect(await db.member.findFirst({ where: { userId: user.id } })).toMatchObject({ organizationId: organization.id, role: "admin" });
    expect(await db.runnerPool.count({ where: { organizationId: organization.id, isDefault: true } })).toBe(1);
    expect(await db.agentProfile.count({ where: { organizationId: organization.id, builtIn: true } })).toBe(1);
    expect((await db.instanceSetting.findUniqueOrThrow({ where: { id: "instance" } })).firstAdminCreatedAt).not.toBeNull();
    expect(await db.auditEntry.count({ where: { organizationId: organization.id, action: "instance.first-admin-created" } })).toBe(1);
    expect((await readFile(path.join(install.dataDir, "better-auth-secret"), "utf8")).trim().length).toBeGreaterThanOrEqual(32);

    // The log says so by ID, never with the email, the username or the password.
    const member = await db.member.findFirstOrThrow({ where: { userId: user.id } });
    expect(seededLines(logs).map((record) => record.fields)).toEqual([
      { userId: user.id, memberId: member.id, organizationId: organization.id, defaultPassword: true },
    ]);
    const lines = JSON.stringify(logs);
    expect(lines).not.toContain("demo@demo.com");
    expect(lines).not.toContain('"demo"');
  });

  it("F-001: stores the default password hashed, and signs in with it although it is under the length rule", async () => {
    const account = await install.test.db.account.findFirstOrThrow({ where: { providerId: "credential" } });
    expect(account.password).not.toBeNull();
    expect(account.password).not.toContain("demo");
    const { runtime } = await start(install);
    for (const signIn of [
      () => runtime.auth.api.signInEmail({ body: { email: "demo@demo.com", password: "demo" }, returnHeaders: true }),
      () => runtime.auth.api.signInUsername({ body: { username: "demo", password: "demo" }, returnHeaders: true }),
    ]) {
      const { headers } = await signIn();
      const context = await runtime.createContext({ headers: cookieHeaderFrom(headers), resHeaders: new Headers() });
      expect(context.user).toMatchObject({ username: "demo", instanceAdmin: true, mustChangePassword: true });
      expect(await callerFactory(context).me.get()).toMatchObject({ passwordChange: "required", organization: { name: "Demo" } });
    }
  });

  it("F-001: never seeds again: a restart finds the account and creates nothing", async () => {
    const { logs } = await start(install);
    expect(seededLines(logs)).toEqual([]);
    expect(await install.test.db.user.count()).toBe(1);
    expect(await install.test.db.organization.count()).toBe(1);
  });

  it("keeps the secret it generated for the next process on the same folder", async () => {
    const kept = (await readFile(path.join(install.dataDir, "better-auth-secret"), "utf8")).trim();
    await start(install);
    expect((await readFile(path.join(install.dataDir, "better-auth-secret"), "utf8")).trim()).toBe(kept);
  });
});

describe("two replicas starting at once on a fresh install", () => {
  it("F-001: two replicas starting at once on a fresh install seed exactly one admin, one organization and one member", async () => {
    const install = await freshInstall();
    const started = await Promise.all([start(install), start(install)]);
    expect(started.flatMap(({ logs }) => seededLines(logs))).toHaveLength(1);
    const { db } = install.test;
    expect(await db.user.count()).toBe(1);
    expect(await db.organization.count()).toBe(1);
    expect(await db.member.count()).toBe(1);
    expect(await db.account.count()).toBe(1);
  });
});

describe("a fresh install with OSTRA_ADMIN_* set", () => {
  it("F-001: a fresh install with OSTRA_ADMIN_* set seeds that account and organization, with no forced change, and the routers work at once", async () => {
    const install = await freshInstall();
    const { runtime } = await start(install, {
      OSTRA_ADMIN_EMAIL: "Ada@Example.com",
      OSTRA_ADMIN_USERNAME: "ada",
      OSTRA_ADMIN_PASSWORD: TEST_PASSWORD,
      OSTRA_ORGANIZATION_NAME: "Calculator Co",
    });
    expect(await install.test.db.user.findFirstOrThrow()).toMatchObject({ email: "ada@example.com", username: "ada", mustChangePassword: false });

    // The cookie a sign-in sets resolves, on the next request, to the same session, member and organization.
    const { headers } = await runtime.auth.api.signInUsername({ body: { username: "ada", password: TEST_PASSWORD }, returnHeaders: true });
    const next = await runtime.createContext({ headers: cookieHeaderFrom(headers), resHeaders: new Headers() });
    expect(next.user).toMatchObject({ username: "ada", instanceAdmin: true, mustChangePassword: false });
    expect(next.member?.scope).toMatchObject({ role: "admin" });
    expect(await callerFactory(next).organization.get()).toMatchObject({ name: "Calculator Co", role: "admin" });
    expect(await callerFactory(next).me.get()).toMatchObject({ passwordChange: "none" });
    expect(await callerFactory(next).setup.status()).toMatchObject({ next: "model-provider" });
    await expect(runtime.auth.api.signInEmail({ body: { email: "demo@demo.com", password: "demo" } })).rejects.toThrow();

    // A request without the cookie is nobody.
    const anonymous = await runtime.createContext({ headers: new Headers(), resHeaders: new Headers() });
    expect(anonymous.user).toBeNull();
    expect(await anonymous.revalidate()).toBeNull();
    expect((await next.revalidate())?.scope.organizationId).toBe(next.member?.scope.organizationId);
  });
});
