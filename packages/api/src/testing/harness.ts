import { randomBytes } from "node:crypto";

import { createLogger, silentLogger } from "@ostra/adapter-sdk";
import type { CatalogEntry, LogRecord, ModelProviderAdapter, TrackerAdapter } from "@ostra/adapter-sdk";
import { createJiraSite, JiraFakeAdapter } from "@ostra/adapter-sdk/testing";
import { postgresAuditLog, postgresChangeNotices, systemClock } from "@ostra/domain";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, SeededMember, TestDatabase } from "@ostra/db/testing";
import { hashPassword } from "better-auth/crypto";

import { createAuth } from "../auth/create-auth.ts";
import type { OstraAuth } from "../auth/create-auth.ts";
import { loadMemberContext, loginSessionIdSchema } from "../auth/scope.ts";
import type { SessionUser } from "../auth/scope.ts";
import { createCatalogSource } from "../catalog/catalog-source.ts";
import { appRouter } from "../routers/app-router.ts";
import { createLinearAppKit } from "../services/linear-app.ts";
import type { LinearEndpoints } from "../services/linear-app.ts";
import { createTrackerDirectory } from "../services/trackers.ts";
import { noEmailDirectory } from "../services/email.ts";
import type { EmailDirectory } from "../services/email.ts";
import { postgresBlobReader } from "../services/blob-store-view.ts";
import { createStreamHub } from "../stream/hub.ts";
import type { StreamHub } from "../stream/hub.ts";
import type { ApiDeps, Context } from "../trpc/context.ts";
import { createCallerFactory } from "../trpc/init.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "./fake-adapters.ts";
import { memoryJobQueue, memoryOutbox } from "./memory-ports.ts";
import type { MemoryJobQueue, MemoryOutbox } from "./memory-ports.ts";

// The API's test harness (spec section 8): a migrated test database, the isolation fixture (two
// organizations and a restricted project), fake adapters, in-memory job and outbox ports, and a
// caller for each kind of actor. A router test calls `harness.as(member)` and uses it like the
// panel does, through the same procedures, middleware and access checks.

const callerFactory = createCallerFactory(appRouter);

/** A router caller: what a test calls procedures on. */
export type AppCaller = ReturnType<typeof callerFactory>;

export type BareHarness = {
  readonly test: TestDatabase;
  readonly deps: ApiDeps;
  readonly auth: OstraAuth;
  readonly hub: StreamHub;
  readonly fakes: {
    readonly secretStore: FakeSecretStore;
    readonly modelProvider: FakeModelProvider;
    readonly codeHost: FakeCodeHost;
    readonly jobs: MemoryJobQueue;
    readonly outbox: MemoryOutbox;
    /**
     * The tracker adapter every Linear connection gets (tickets 27 to 29). A test points it at the
     * adapter it wants to run against: the Jira fake, or Linear's adapter on the fake Linear server.
     */
    readonly tracker: { adapter: TrackerAdapter };
    /** The tokens the tracker directory built an adapter with, to search an output for them. */
    readonly trackerTokens: string[];
  };
  /** Every line the API logged, to check that nothing sensitive reached one. */
  readonly logs: readonly LogRecord[];
  /** The models.dev catalog the routers see: a test pushes entries into it. */
  readonly catalogEntries: CatalogEntry[];
  /** A caller for a context a test built (other settings, another session). */
  readonly callerFor: (context: Context) => AppCaller;
  /** A caller with no session. */
  readonly anonymous: (resHeaders?: Headers) => AppCaller;
  /** A caller signed in as this member of an organization. */
  readonly as: (member: SeededMember) => Promise<AppCaller>;
  /** The context a member's request would resolve, for tests that call a helper directly. */
  readonly contextOf: (member: SeededMember, sessionId?: string) => Promise<Context>;
  readonly dispose: () => Promise<void>;
};

/** The harness with the two organizations of `seedIsolationFixture` seeded. */
export type ApiHarness = BareHarness & { readonly fixture: IsolationFixture };

export type BareHarnessOptions = {
  /** `OSTRA_ALLOW_DEFAULT_PASSWORD`: off by default, as on an install. */
  readonly allowDefaultPassword?: boolean;
  /** The model provider adapter the routers use. Default: the fake (`fakes.modelProvider`). */
  readonly modelProvider?: ModelProviderAdapter;
  /** Linear's OAuth and API addresses: a test points them at the fake Linear server. Default: the real ones. */
  readonly linearEndpoints?: LinearEndpoints;
  /** The adapters that send mail (the test mail). Default: none. */
  readonly email?: EmailDirectory;
};

/** A harness on an empty install: no account, no organization (the first-run tests). */
export const createBareHarness = async (options: BareHarnessOptions = {}): Promise<BareHarness> => {
  const test = await createTestDatabase();
  const baseUrl = "http://localhost:3000";
  const allowDefaultPassword = options.allowDefaultPassword ?? false;
  const auth = createAuth({
    db: test.db,
    baseUrl,
    secret: randomBytes(32).toString("hex"),
    settings: { allowDefaultPassword },
    logLevel: "error",
  });

  const logs: LogRecord[] = [];
  const logger = createLogger((record) => {
    logs.push(record);
  });
  const secretStore = new FakeSecretStore();
  const modelProvider = new FakeModelProvider();
  const codeHost = new FakeCodeHost();
  const jobs = memoryJobQueue();
  const outbox = memoryOutbox();
  const tracker: { adapter: TrackerAdapter } = { adapter: new JiraFakeAdapter({ site: createJiraSite() }) };
  const trackerTokens: string[] = [];
  const hub = createStreamHub({ db: test.db, databaseUrl: test.url, logger: silentLogger, pollMs: 50 });
  const catalogEntries: CatalogEntry[] = [];
  const emailDirectory: EmailDirectory = options.email ?? noEmailDirectory;

  const deps: ApiDeps = {
    db: test.db,
    auth,
    settings: {
      mode: "test",
      publicUrl: baseUrl,
      corePublicUrl: "http://localhost:8787",
      catalogFetch: false,
      allowDefaultPassword,
      retentionDays: null,
      blobStore: { kind: "postgres", maxBytes: 64 * 1024 * 1024 },
      trackerPollSeconds: 60,
      reconcileMinutes: 5,
      boxIdleMinutes: 15,
      taskSpendCapMicroUsd: 25_000_000,
      taskTokenCap: 10_000_000,
      email: { source: "panel", fromName: "ostra" },
      emailDelaySeconds: 120,
      cliSessionDays: 30,
    },
    blobStore: { name: "postgres", health: () => Promise.resolve({ status: "ok" }), read: postgresBlobReader(test.db) },
    linear: createLinearAppKit(options.linearEndpoints === undefined ? {} : { endpoints: options.linearEndpoints }),
    trackers: createTrackerDirectory({
      db: test.db,
      secretStore,
      makeLinear: (auth) => {
        trackerTokens.push(auth.token);
        return tracker.adapter;
      },
    }),
    ports: {
      jobs,
      outbox,
      notices: postgresChangeNotices,
      audit: postgresAuditLog,
      clock: systemClock,
      adapters: { codeHost, modelProvider: options.modelProvider ?? modelProvider, secretStore },
    },
    logger,
    hashPassword,
    catalog: createCatalogSource({
      fetchEnabled: false,
      loadBundled: () => Promise.resolve(catalogEntries),
      fetchLatest: () => Promise.resolve([]),
      clock: systemClock,
      logger: silentLogger,
    }),
    email: emailDirectory,
    stream: hub,
  };

  const contextOf = async (member: SeededMember, sessionId = `session-of-${member.id}`): Promise<Context> => {
    const account = await test.db.user.findUniqueOrThrow({ where: { id: member.userId } });
    const user: SessionUser = {
      sessionId: loginSessionIdSchema.parse(sessionId),
      userId: member.userId,
      name: account.name,
      username: account.username,
      email: account.email,
      instanceAdmin: account.role === "admin",
      sessionOrganizationId: member.organizationId,
      mustChangePassword: account.mustChangePassword,
    };
    // A revoked membership shows here as it does in production: the member row is read again.
    return {
      deps,
      headers: new Headers(),
      resHeaders: new Headers(),
      user,
      member: await loadMemberContext(test.db, user),
      revalidate: () => loadMemberContext(test.db, user),
    };
  };

  return {
    test,
    deps,
    auth,
    hub,
    fakes: { secretStore, modelProvider, codeHost, jobs, outbox, tracker, trackerTokens },
    logs,
    catalogEntries,
    callerFor: (context) => callerFactory(context),
    anonymous: (resHeaders = new Headers()) => callerFactory({ deps, headers: new Headers(), resHeaders, user: null, member: null, revalidate: () => Promise.resolve(null) }),
    as: async (member) => callerFactory(await contextOf(member)),
    contextOf,
    dispose: async () => {
      await hub.stop();
      await test.dispose();
    },
  };
};

export const createApiHarness = async (options: BareHarnessOptions = {}): Promise<ApiHarness> => {
  const bare = await createBareHarness(options);
  return { ...bare, fixture: await seedIsolationFixture(bare.test.db) };
};
