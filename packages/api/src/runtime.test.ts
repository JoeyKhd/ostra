import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { silentLogger } from "@ostra/adapter-sdk";
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
// with no setting still works (the self-hosting rule): the secrets are generated and kept, the log
// says how to create the first admin, and a request's cookie resolves to the member it is.

let test: TestDatabase;
let dataDir: string;
const runtimes: ApiRuntime[] = [];
const callerFactory = createCallerFactory(appRouter);

beforeAll(async () => {
  test = await createTestDatabase();
  dataDir = await mkdtemp(path.join(tmpdir(), "ostra-runtime-"));
});

afterAll(async () => {
  await Promise.all(runtimes.map((runtime) => runtime.close()));
  await test.dispose();
  await rm(dataDir, { recursive: true, force: true });
});

const start = async () => {
  const parsed = parseServerSettings({ NODE_ENV: "test", DATABASE_URL: test.url, OSTRA_DATA_DIR: dataDir });
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("; "));
  }
  const announced: string[] = [];
  const runtime = await createApiRuntime({
    settings: parsed.settings,
    db: test.db,
    adapters: { codeHost: new FakeCodeHost(), modelProvider: new FakeModelProvider(), secretStore: new FakeSecretStore() },
    jobs: memoryJobQueue(),
    outbox: memoryOutbox(),
    catalog: createCatalogSource({
      fetchEnabled: false,
      loadBundled: () => Promise.resolve([]),
      fetchLatest: () => Promise.resolve([]),
      clock: { now: () => Date.now() },
      logger: silentLogger,
    }),
    logger: silentLogger,
    announce: (text) => announced.push(text),
  });
  runtimes.push(runtime);
  return { runtime, announced };
};

describe("a fresh install with no setting", () => {
  it("generates its secrets, keeps them in the data folder, and says how to create the first admin", async () => {
    const first = await start();
    expect(first.announced).toHaveLength(1);
    const line = first.announced.join("");
    const token = (await readFile(path.join(dataDir, "setup-token"), "utf8")).trim();
    expect(line).toContain(token);
    expect(line).toContain("http://localhost:3000");
    expect((await readFile(path.join(dataDir, "better-auth-secret"), "utf8")).trim().length).toBeGreaterThanOrEqual(32);

    // A second process on the same folder agrees on the token (several web processes, one install).
    const second = await start();
    expect(second.announced.join("")).toContain(token);
    expect(second.runtime.deps.setupToken).toBe(first.runtime.deps.setupToken);
  });

  it("creates the first admin through the routers, and the cookie it sets resolves to that admin", async () => {
    const { runtime } = await start();
    const resHeaders = new Headers();
    const caller = callerFactory(await runtime.createContext({ headers: new Headers(), resHeaders }));
    expect(await caller.setup.state()).toEqual({ needsFirstAdmin: true, openSignup: false });
    await caller.setup.createFirstAdmin({
      setupToken: runtime.deps.setupToken,
      username: "ada",
      email: "ada@example.com",
      password: TEST_PASSWORD,
      organizationName: "Calculator Co",
    });

    // The next request carries the cookie: the same session, member and organization, from the database.
    const next = await runtime.createContext({ headers: cookieHeaderFrom(resHeaders), resHeaders: new Headers() });
    expect(next.user).toMatchObject({ username: "ada", instanceAdmin: true });
    expect(next.member?.scope).toMatchObject({ role: "admin" });
    const organization = await callerFactory(next).organization.get();
    expect(organization).toMatchObject({ name: "Calculator Co", role: "admin" });
    expect(await callerFactory(next).setup.status()).toMatchObject({ next: "model-provider" });

    // And a request without it is nobody.
    const anonymous = await runtime.createContext({ headers: new Headers(), resHeaders: new Headers() });
    expect(anonymous.user).toBeNull();
    expect(await anonymous.revalidate()).toBeNull();
    // Revalidating a cookie that still stands finds the member again.
    expect((await next.revalidate())?.scope.organizationId).toBe(next.member?.scope.organizationId);
  });

  it("stops announcing the setup token once the first account exists", async () => {
    const { announced } = await start();
    expect(announced).toEqual([]);
  });
});
