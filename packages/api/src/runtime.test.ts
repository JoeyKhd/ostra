import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createLogger } from "@ostra/adapter-sdk";
import { createJiraSite, JiraFakeAdapter } from "@ostra/adapter-sdk/testing";
import type { LogRecord } from "@ostra/adapter-sdk";
import { createTestDatabase } from "@ostra/db/testing";
import type { TestDatabase } from "@ostra/db/testing";
import { parseServerSettings, seedMember } from "@ostra/domain";
import { isAPIError } from "better-auth/api";
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

describe("an install upgraded with the retired OSTRA_OPEN_SIGNUP_* settings still set", () => {
  // Both settings were removed on 2026-11-19 (docs/configuration.md, "Removed settings"): an old env
  // file that turns them on must neither stop the server nor open anything.
  const retired = { OSTRA_OPEN_SIGNUP_ACCOUNTS: "true", OSTRA_OPEN_SIGNUP_ORGANIZATIONS: "true" } as const;
  const admin = { OSTRA_ADMIN_EMAIL: "ada@example.com", OSTRA_ADMIN_USERNAME: "ada", OSTRA_ADMIN_PASSWORD: TEST_PASSWORD, OSTRA_ORGANIZATION_NAME: "Calculator Co" };
  let install: { readonly test: TestDatabase; readonly dataDir: string };
  let started: Awaited<ReturnType<typeof start>>;

  const refusedWith = async (call: () => Promise<unknown>): Promise<{ readonly code: string | undefined; readonly status: number }> => {
    try {
      await call();
    } catch (error) {
      if (isAPIError(error)) {
        const code: unknown = Reflect.get(error.body ?? {}, "code");
        return { code: typeof code === "string" ? code : undefined, status: error.statusCode };
      }
      throw error;
    }
    throw new Error("expected the call to be refused");
  };

  const signIn = async (username: string): Promise<Headers> => {
    const { headers } = await started.runtime.auth.api.signInUsername({ body: { username, password: TEST_PASSWORD }, returnHeaders: true });
    return cookieHeaderFrom(headers);
  };

  beforeAll(async () => {
    install = await freshInstall();
    started = await start(install, { ...retired, ...admin });
  });

  it("F-002: starts with them set, warns once for each that it ignores it, and still refuses sign-up to anyone", async () => {
    const { runtime, logs } = started;
    expect(logs.filter((record) => record.message === "settings.retired_ignored").map((record) => [record.level, record.fields["setting"]])).toEqual([
      ["warn", "OSTRA_OPEN_SIGNUP_ACCOUNTS"],
      ["warn", "OSTRA_OPEN_SIGNUP_ORGANIZATIONS"],
    ]);
    // The install works: the first admin is seeded and signs in.
    expect(await install.test.db.user.count()).toBe(1);
    await signIn("ada");

    // A stranger's sign-up is refused, through better-auth's API and over HTTP as a browser sends it.
    const stranger = { name: "mallory", email: "mallory@example.com", password: TEST_PASSWORD, username: "mallory" };
    expect(await refusedWith(() => runtime.auth.api.signUpEmail({ body: stranger }))).toEqual({ code: "SIGN_UP_CLOSED", status: 403 });
    const overHttp = await runtime.auth.handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify(stranger),
      }),
    );
    expect(overHttp.status).toBe(403);
    expect(await install.test.db.user.count()).toBe(1);
  });

  it("only the instance admin creates an organization; an organization's admin and a member are refused", async () => {
    const { runtime } = started;
    for (const [username, role] of [
      ["grace", "admin"],
      ["linus", "member"],
    ] as const) {
      const seeded = await seedMember(
        { db: install.test.db, hashPassword: runtime.deps.hashPassword, env: { NODE_ENV: "test" } },
        { username, email: `${username}@example.com`, password: TEST_PASSWORD, role },
      );
      expect(seeded.ok, username).toBe(true);
      const headers = await signIn(username);
      expect(await refusedWith(() => runtime.auth.api.createOrganization({ body: { name: `${username}'s org`, slug: username }, headers }))).toEqual({
        code: "YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_ORGANIZATION",
        status: 403,
      });
    }
    expect(await install.test.db.organization.count()).toBe(1);

    const created = await runtime.auth.api.createOrganization({ body: { name: "Second Org", slug: "second-org" }, headers: await signIn("ada") });
    expect(created.name).toBe("Second Org");
    expect(await install.test.db.organization.count()).toBe(2);
  });
});
