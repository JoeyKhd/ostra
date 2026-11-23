import { createHash, randomBytes } from "node:crypto";

import { createLogger, silentLogger } from "@ostra/adapter-sdk";
import type { CatalogEntry, LogRecord, ModelProviderAdapter, TrackerAdapter } from "@ostra/adapter-sdk";
import { createJiraSite, JiraFakeAdapter } from "@ostra/adapter-sdk/testing";
import {
  createPanelPreviewTokens,
  DRAFT_IMAGE_MAX_BYTES,
  parseServerSettings,
  postgresAuditLog,
  postgresChangeNotices,
  previewCheckMark,
  profileLimits,
  startAppForMember,
  systemClock,
} from "@ostra/domain";
import type { FileSettings } from "@ostra/domain";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, SeededMember, TestDatabase } from "@ostra/db/testing";
import { hashPassword } from "better-auth/crypto";

import { createAuth } from "../auth/create-auth.ts";
import type { OstraAuth } from "../auth/create-auth.ts";
import { loadMemberContext, loginSessionIdSchema } from "../auth/scope.ts";
import type { SessionUser } from "../auth/scope.ts";
import { createCatalogSource } from "../catalog/catalog-source.ts";
import { shippedAgentEffort } from "../services/agent-effort.ts";
import type { AgentEffort } from "../services/agent-effort.ts";
import { panelMessageFilesDeps } from "../services/agent-images.ts";
import { appRouter } from "../routers/app-router.ts";
import { createJiraConnectKit } from "../services/jira-connect.ts";
import { createLinearAppKit } from "../services/linear-app.ts";
import type { LinearEndpoints } from "../services/linear-app.ts";
import { createTrackerDirectory } from "../services/trackers.ts";
import { noEmailDirectory } from "../services/email.ts";
import type { EmailDirectory } from "../services/email.ts";
import type { BlobStoreView } from "../services/blob-store-view.ts";
import { createStreamHub } from "../stream/hub.ts";
import type { StreamHub } from "../stream/hub.ts";
import type { ApiDeps, Context } from "../trpc/context.ts";
import { createCallerFactory } from "../trpc/init.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "./fake-adapters.ts";
import { fakeCoreUploads } from "./files.ts";
import type { FakeCoreUploads } from "./files.ts";
import { createFakeLibrary } from "./library-fakes.ts";
import type { FakeLibrary } from "./library-fakes.ts";
import { memoryJobQueue, memoryOutbox } from "./memory-ports.ts";
import type { MemoryJobQueue, MemoryOutbox } from "./memory-ports.ts";

// The API's test harness (spec section 8): a migrated test database, the isolation fixture (two
// organizations and a restricted project), fake adapters, in-memory job and outbox ports, and a
// caller for each kind of actor. A router test calls `harness.as(member)` and uses it like the
// panel does, through the same procedures, middleware and access checks.

const callerFactory = createCallerFactory(appRouter);

/** The secrets key's text the harness's panel signs a view's token under: a relay test's fake core verifies with it. */
export const PREVIEW_SECRET = randomBytes(32).toString("hex");


/**
 * What core's blob service answers the panel's read with, in this process: the built-in store's
 * chunks for a blob of that owner, and `unavailable` for a blob in another store, as a core that
 * can't reach it answers. A test of the read itself points `coreBlobReader` at a real core.
 */
const builtInRowsReader =
  (db: TestDatabase["db"]): BlobStoreView["read"] =>
  async (organizationId, taskId, blobId) => {
    const blob = await db.blob.findFirst({ where: { id: blobId, organizationId, taskId }, select: { id: true, store: true } });
    if (blob === null) {
      return { kind: "not-found" };
    }
    if (blob.store !== "postgres") {
      return { kind: "unavailable" };
    }
    const chunks = await db.blobChunk.findMany({ where: { blobId: blob.id, organizationId }, orderBy: { ordinal: "asc" }, select: { bytes: true } });
    const size = chunks.reduce((total, chunk) => total + chunk.bytes.length, 0);
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (const chunk of chunks) {
          controller.enqueue(new Uint8Array(chunk.bytes));
        }
        controller.close();
      },
    });
    return { kind: "found", blob: { size, stream } };
  };

/** A router caller: what a test calls procedures on. */
export type AppCaller = ReturnType<typeof callerFactory>;

export type UploadedBlob = { readonly organizationId: string; readonly purpose: string; readonly blobId: string; readonly size: number };

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
    readonly tracker: {
      adapter: TrackerAdapter;
      /**
       * Milestone 11: an adapter of its own for one connection, by its Linear token or its Jira
       * site's host, so a test holds several connections apart; the others get `adapter`.
       */
      readonly byConnection: Map<string, TrackerAdapter>;
    };
    /** The tokens the tracker directory built an adapter with, to search an output for them. */
    readonly trackerTokens: string[];
    /** Milestone 11: the sites and service accounts the tracker directory built a Jira adapter for (never the token). */
    readonly jiraTrackers: { readonly host: string; readonly cloudId: string; readonly email: string }[];
    /** Milestone 8 (ticket 30): the library's sources, which the library's calls out reach and nothing else. */
    readonly library: FakeLibrary;
    /** Milestone 9 (ticket 14): core's side of a member's upload (`deps.fileUploader`), and every upload it was asked for. */
    readonly core: FakeCoreUploads;
  };
  /** Whether the install's email counts as set up (F-002): off by default, as on a fresh install. A test flips it. */
  readonly emailSwitch: { on: boolean };
  /** Every line the API logged, to check that nothing sensitive reached one. */
  readonly logs: readonly LogRecord[];
  /** The files the panel handed to the blob store, in order. */
  readonly uploads: readonly UploadedBlob[];
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
  /** Milestone 11: `OSTRA_JIRA_API_URL`, the fake Jira's gateway the connect steps call. Default: Jira's own. */
  readonly jiraApiUrl?: string;
  /** The adapters that send mail (the test mail). Default: none. */
  readonly email?: EmailDirectory;
  /** F-137: each agent's reasoning levels. Default: the one the runtime uses. */
  readonly agentEffort?: AgentEffort;
  /** `OSTRA_INVITATION_DAYS` and `OSTRA_RESET_LINK_HOURS`. Default 7 and 24. */
  readonly invitationDays?: number;
  readonly resetLinkHours?: number;
  /** `OSTRA_DEV_HOST_POOL_SAME_USER`. Default off, as on an install. */
  readonly devHostPoolSameUser?: boolean;
  /** `OSTRA_SCHEDULE_MIN_INTERVAL_MINUTES`. Default 60, as on an install. */
  readonly scheduleMinIntervalMinutes?: number;
  /** Milestone 9 (ticket 14): the file limits (`OSTRA_MESSAGE_FILES_*`, `OSTRA_TICKET_FILES_*`). Default: a fresh install's. */
  readonly files?: Partial<FileSettings>;
};

/** A harness on an empty install: no account, no organization (the first-run tests). */
export const createBareHarness = async (options: BareHarnessOptions = {}): Promise<BareHarness> => {
  const test = await createTestDatabase();
  const baseUrl = "http://localhost:3000";
  const allowDefaultPassword = options.allowDefaultPassword ?? false;
  const invitationDays = options.invitationDays ?? 7;
  const resetLinkHours = options.resetLinkHours ?? 24;
  const emailSwitch = { on: false };
  const emailOn = (): Promise<boolean> => Promise.resolve(emailSwitch.on);
  const jobs = memoryJobQueue();
  const auth = createAuth({
    db: test.db,
    baseUrl,
    secret: randomBytes(32).toString("hex"),
    settings: { allowDefaultPassword, invitationDays, resetLinkHours },
    logLevel: "error",
    accounts: { emailOn, jobs, audit: postgresAuditLog, notices: postgresChangeNotices, clock: systemClock },
  });

  const logs: LogRecord[] = [];
  const logger = createLogger((record) => {
    logs.push(record);
  });
  const secretStore = new FakeSecretStore();
  const modelProvider = new FakeModelProvider();
  const codeHost = new FakeCodeHost();
  const outbox = memoryOutbox();
  const tracker: BareHarness["fakes"]["tracker"] = { adapter: new JiraFakeAdapter({ site: createJiraSite() }), byConnection: new Map() };
  const trackerTokens: string[] = [];
  const jiraTrackers: { readonly host: string; readonly cloudId: string; readonly email: string }[] = [];
  const hub = createStreamHub({ db: test.db, databaseUrl: test.url, logger: silentLogger, pollMs: 50 });
  const catalogEntries: CatalogEntry[] = [];
  const uploads: UploadedBlob[] = [];
  const library = createFakeLibrary();
  const emailDirectory: EmailDirectory = options.email ?? noEmailDirectory;

  const parsedDefaults = parseServerSettings({});
  if (!parsedDefaults.ok) {
    throw new Error("the install's default settings don't parse");
  }
  const installDefaults = parsedDefaults.settings;
  // Milestone 9 (ticket 14): the file limits, as a fresh install has them unless the test says.
  const files: FileSettings = { ...installDefaults.files, ...options.files };
  const core = fakeCoreUploads(test.db, { maxFiles: files.messageFilesMax });
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
      budgetWarnPercent: 80,
      projectMaxRepos: 10,
      insightsIntervalMinutes: 5,
      invitationDays,
      resetLinkHours,
      joinTokenDays: 30,
      devHostPoolSameUser: options.devHostPoolSameUser ?? false,
      docsUrl: "https://docs.example.com/ostra/",
      // Milestone 6's working values, as a fresh install has them.
      team: { ...installDefaults.team, ...(options.scheduleMinIntervalMinutes === undefined ? {} : { scheduleMinIntervalMinutes: options.scheduleMinIntervalMinutes }) },
      // Milestone 8's previews and a personal runner's slots, as a fresh install has them, but with
      // no preview domain, as a fresh install on public hosts (or `OSTRA_PREVIEW_DOMAIN=off`) has
      // it: on this machine's loopback the default would be `preview.localhost` (F-144/c10), and a
      // test that wants a domain names it (`previews-native.test.ts`'s `withDomain`).
      previews: { ...installDefaults.previews, domain: null, localDefault: false },
      personalRunnerCapacity: installDefaults.personalRunnerCapacity,
      // Milestone 8's library, as a fresh install has it: search may be turned on, at skills.sh's address.
      library: installDefaults.library,
      memoryProposalsPerTask: installDefaults.memoryProposalsPerTask,
      files,
    },
    // Milestone 9 (ticket 14): every send binds its files as the runtime's does; core's upload, faked at its port.
    messageFiles: panelMessageFilesDeps(files),
    fileUploader: core.uploader,
    blobStore: {
      name: "postgres",
      health: () => Promise.resolve({ status: "ok" }),
      read: builtInRowsReader(test.db),
      // Core's blob service stands behind this in a real install: here it is a row, as core writes one.
      upload: async ({ organizationId, purpose, bytes }) => {
        if (bytes.length > (purpose === "draft-image" ? DRAFT_IMAGE_MAX_BYTES : profileLimits.skillFileMaxBytes)) {
          return { kind: "too-large" };
        }
        const row = await test.db.blob.create({
          data: {
            organizationId,
            store: "postgres",
            key: `panel-${crypto.randomUUID()}`,
            purpose,
            contentType: "application/octet-stream",
            size: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
          select: { id: true },
        });
        // Its bytes as one chunk of the built-in store, so the panel's own reader reads them back.
        await test.db.blobChunk.create({ data: { organizationId, blobId: row.id, ordinal: 0, offset: 0, bytes: Uint8Array.from(bytes) } });
        uploads.push({ organizationId, purpose, blobId: row.id, size: bytes.length });
        return { kind: "stored", blobId: row.id, size: bytes.length };
      },
    },
    linear: createLinearAppKit(options.linearEndpoints === undefined ? {} : { endpoints: options.linearEndpoints }),
    jira: createJiraConnectKit({ apiUrl: options.jiraApiUrl ?? null, timeoutMs: 5000 }),
    trackers: createTrackerDirectory({
      db: test.db,
      secretStore,
      makeLinear: (auth) => {
        trackerTokens.push(auth.token);
        return tracker.byConnection.get(auth.token) ?? tracker.adapter;
      },
      makeJira: (auth) => {
        trackerTokens.push(auth.token);
        jiraTrackers.push({ host: auth.host, cloudId: auth.cloudId, email: auth.email });
        return tracker.byConnection.get(auth.host) ?? tracker.adapter;
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
    agentEffort: options.agentEffort ?? shippedAgentEffort,
    emailOn,
    stream: hub,
    // Core stands behind this in a real install; a relay test points `coreUrl` at its fake core.
    previews: { coreUrl: "http://127.0.0.1:9", panelTokens: createPanelPreviewTokens(PREVIEW_SECRET), checkMark: (host) => previewCheckMark(PREVIEW_SECRET, host) },
    // Core runs "Start the app" in a real install (`coreAppStarter`): here its body runs in this
    // process, on the harness's ports. A test of the request itself points a starter at its fake core.
    appStart: (request) =>
      startAppForMember(
        {
          db: test.db,
          jobs,
          outbox,
          notices: postgresChangeNotices,
          audit: postgresAuditLog,
          clock: systemClock,
          logger,
          dispatch: { personalSlots: installDefaults.personalRunnerCapacity },
        },
        request,
      ),
    library: { fetch: library.fetch, serverVersion: "9.9.9-test" },
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
      theme: account.theme,
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
    fakes: { secretStore, modelProvider, codeHost, jobs, outbox, tracker, trackerTokens, jiraTrackers, library, core },
    emailSwitch,
    logs,
    uploads,
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
