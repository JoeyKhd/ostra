import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFakeS3 } from "@ostra/adapter-blob-s3/testing";
import type { FakeS3 } from "@ostra/adapter-blob-s3/testing";
import { LinearAdapter } from "@ostra/adapter-linear";
import { silentLogger } from "@ostra/adapter-sdk";
import type { TrackerAdapter } from "@ostra/adapter-sdk";
import { createFakeLinear } from "@ostra/adapter-sdk/testing";
import type { FakeLinear } from "@ostra/adapter-sdk/testing";
import { coreBlobReader, corePanelUploader } from "@ostra/api";
import type { Context } from "@ostra/api";
import { createApiHarness, seedBoard } from "@ostra/api/testing";
import type { ApiHarness } from "@ostra/api/testing";
import { jobPayloadSchemas, parseServerSettings, postgresChangeNotices, saveDraft, systemClock, taskPageUrl } from "@ostra/domain";
import type { ServerSettings } from "@ostra/domain";
import {
  APP_SCREENSHOT_CONTENT_TYPE,
  blobIdSchema,
  boxIdSchema,
  connectionIdSchema,
  externalTicketIdSchema,
  parseRunnerConfig,
  projectIdSchema,
  runnerConfigKeys,
  runnerEnvNames,
  sha256HexSchema,
  taskIdSchema,
} from "@ostra/protocol";
import type { BlobRef, BlobUploadPurpose, BoardId, ConnectionId, ExternalTicketId, RefineDraft, TaskId } from "@ostra/protocol";
import { runnerServerLink } from "@ostra/runner";
import type { ServerLink } from "@ostra/runner";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startCore } from "../core.ts";
import type { RunningCore } from "../core.ts";
import type { RunnerRef } from "../gateway/context.ts";
import { draftApplyHandler } from "../refine/apply.ts";
import { loadSecretsKey } from "../secrets.ts";
import { FakeCodeHost, FakeModelProvider } from "../testing/fake-adapters.ts";
import { seedLeasedTask, seedRunner } from "../testing/seed.ts";
import type { LeasedTask } from "../testing/seed.ts";
import { jobContext } from "../testing/turns.ts";
import { createConnectionTrackers } from "../tracker/connections.ts";
import { BLOB_CHUNK_BYTES } from "./postgres-blob-rows.ts";

// F-114 (ADR 0043): blob storage as an install runs it. Core is the whole of `startCore`, on
// settings parsed from the environment an admin writes: a fresh install's, with no blob setting,
// and the same install switched to an S3-compatible store (a fake S3 server) by its address and
// keys. Both run on one database, as two replicas of a rolling restart do. The runner's side is
// `apps/runner`'s own link to core (`runnerServerLink`), built from core's address alone; the
// panel's is `@ostra/api`'s uploader to core, wired as `apps/web` wires it. A draft's image goes to
// the fake Linear through core's own `draft.apply` worker, which reads it from the blob store.

const MiB = 1024 * 1024;

let harness: ApiHarness;
let fake: FakeS3;
let linear: FakeLinear;
let linearToken: string;
let connectionId: ConnectionId;
let boardId: BoardId;
let dataDir: string;
let freshEnv: Readonly<Record<string, string>>;
let s3Env: Readonly<Record<string, string>>;
let freshSettings: ServerSettings;
let secretsKey: string;
const running = new Set<RunningCore>();
let fresh: RunningCore;
let s3: RunningCore;
let runner: RunnerRef;

const settingsOf = (env: Readonly<Record<string, string>>): ServerSettings => {
  const parsed = parseServerSettings(env);
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("\n"));
  }
  return parsed.settings;
};

const boot = async (settings: ServerSettings): Promise<RunningCore> => {
  const core = await startCore({ ...settings, corePort: 0 }, silentLogger, {
    host: "127.0.0.1",
    adapters: { codeHost: new FakeCodeHost(), secretStore: harness.fakes.secretStore, modelProvider: new FakeModelProvider() },
    linearApiUrl: linear.apiUrl,
    jobIntervals: { pollingIntervalSeconds: 0.5, superviseIntervalSeconds: 1 },
  });
  running.add(core);
  return core;
};

beforeAll(async () => {
  harness = await createApiHarness();
  fake = await createFakeS3();
  linear = await createFakeLinear();
  linear.createApp({ name: "ostra", redirectUris: ["http://localhost:3000/api/linear/callback"], webhookUrl: null });
  linearToken = linear.mintToken("app").accessToken;
  const organizationId = harness.fixture.a.organization.id;
  // The organization's Linear connection, its token one the fake Linear takes, in the secret store core reads.
  const secret = await harness.fakes.secretStore.put({ organizationId, purpose: "linear-access-token" }, linearToken);
  if (!secret.ok) throw new Error("the secret store refused the token");
  const connection = await harness.test.db.connection.create({
    data: {
      organizationId,
      accessTokenSecretRef: secret.value,
      kind: "linear",
      appId: "linear-client-id",
      state: "active",
      credentialKind: "app_oauth",
      externalWorkspaceId: "workspace-1",
      externalWorkspaceKey: "ostra-test",
      externalWorkspaceName: "ostra-test",
      appUserId: "app-user-1",
      appUserName: "ostra",
      activatedAt: new Date(),
    },
    select: { id: true },
  });
  connectionId = connectionIdSchema.parse(connection.id);
  boardId = await seedBoard(harness, { projectId: harness.fixture.a.openProject.id, connectionId, externalId: linear.team.id });

  dataDir = await mkdtemp(path.join(tmpdir(), "ostra-blob-storage-"));
  // A fresh install: the database and a folder for core's keys, and the catalog fetch off so the
  // test reaches no network. No blob setting at all.
  freshEnv = { DATABASE_URL: harness.test.url, OSTRA_DATA_DIR: dataDir, OSTRA_CATALOG_FETCH: "false" };
  // The admin's switch: the store's address and keys, nothing else.
  s3Env = {
    ...freshEnv,
    OSTRA_BLOB_STORE: "s3",
    OSTRA_S3_ENDPOINT: fake.endpoint,
    OSTRA_S3_BUCKET: fake.bucket,
    OSTRA_S3_REGION: fake.region,
    OSTRA_S3_ACCESS_KEY_ID: fake.accessKeyId,
    OSTRA_S3_SECRET_ACCESS_KEY: fake.secretAccessKey,
  };
  freshSettings = settingsOf(freshEnv);
  fresh = await boot(freshSettings);
  s3 = await boot(settingsOf(s3Env));
  // The panel holds the secrets key from the install's folder, as a one-machine install's does.
  secretsKey = await loadSecretsKey(freshSettings);
  runner = await seedRunner(harness.test.db, organizationId, harness.fixture.a.member.id);
}, 180_000);

afterAll(async () => {
  for (const core of running) {
    await core.stop();
  }
  await linear.close();
  await fake.close();
  await harness.dispose();
  await rm(dataDir, { recursive: true, force: true });
}, 60_000);

const waitFor = async <T,>(what: string, read: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const urlOf = (core: RunningCore): string => `http://127.0.0.1:${String(core.port)}`;
const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));

/** A running task of the member's personal runner, leased at epoch 1. */
const leasedTask = (): Promise<LeasedTask> => seedLeasedTask(harness.test.db, runner, projectIdSchema.parse(harness.fixture.a.openProject.id), { state: "running" });

/** The runner's own access token, as either replica issues it: they share the install's key. */
const runnerToken = (): string => fresh.gateway.context.tokens.issue(runner.runnerId, runner.organizationId, Date.now()).accessToken;

/**
 * `apps/runner`'s link to core, as a runner (its access token) or a box's sidecar (its task token)
 * builds it: core's address and a token, nothing else. No session is opened here.
 */
const linkTo = (serverUrl: string, token: () => string): ServerLink =>
  runnerServerLink({
    serverUrl,
    tokens: { get: () => Promise.resolve({ ok: true as const, token: token(), expiresAt: Date.now() + 600_000 }), invalidate: () => undefined },
    connection: { openSession: () => Promise.reject(new Error("no session in this test")), statusChanged: () => undefined },
  });

const upload = async (link: ServerLink, task: LeasedTask, purpose: BlobUploadPurpose, contentType: string, bytes: Uint8Array): Promise<BlobRef> => {
  const sent = await link.uploadBlob({ taskId: task.taskId, leaseEpoch: task.leaseEpoch, purpose, contentType, bytes });
  if (!sent.ok) throw new Error(`the upload failed: ${sent.failure.kind}, ${sent.failure.message}`);
  return sent.value;
};

/** A member's request as the web app builds it, its blob store reaching `core` as `apps/web` wires it. */
const panelAs = async (core: RunningCore): Promise<ReturnType<ApiHarness["callerFor"]>> => {
  const context: Context = await harness.contextOf(harness.fixture.a.member);
  const coreUrl = urlOf(core);
  return harness.callerFor({
    ...context,
    deps: {
      ...context.deps,
      blobStore: {
        ...context.deps.blobStore,
        name: core.blobs.kind,
        read: coreBlobReader({ db: harness.test.db, coreUrl, secret: secretsKey, logger: silentLogger }),
        upload: corePanelUploader({ coreUrl, secret: secretsKey, logger: silentLogger }),
      },
    },
  });
};

const draft = (): RefineDraft => ({
  description: "Make the footer fast.",
  acceptanceCriteria: ["The footer renders in under 1 s"],
  edgeCases: [],
  openQuestions: [],
  subTickets: [],
});

/** A refine task with its first draft, on a ticket of the fake Linear when `ticket` is given. */
const refineTask = async (ticket: { readonly externalId: ExternalTicketId; readonly key: string } | null): Promise<TaskId> => {
  const { a } = harness.fixture;
  const ticketRow =
    ticket === null
      ? null
      : await harness.test.db.ticket.create({
          data: {
            organizationId: a.organization.id,
            projectId: a.openProject.id,
            boardId,
            connectionId,
            externalId: ticket.externalId,
            key: ticket.key,
            title: "Speed up the footer",
            description: "It's slow.",
            statusId: "st",
            statusName: "Todo",
            statusCategory: "open",
            open: true,
            labels: [],
            url: `https://linear.example/${ticket.key}`,
            trackerUpdatedAt: new Date(),
          },
          select: { id: true },
        });
  const task = await harness.test.db.task.create({
    data: {
      organizationId: a.organization.id,
      projectId: a.openProject.id,
      kind: "refine",
      source: ticketRow === null ? "prompt" : "ticket",
      title: "Refine the footer",
      prompt: "Refine the footer ticket",
      branchName: `ostra/${randomBytes(4).toString("hex")}-refine`,
      state: "needs_you",
      needsYouReason: "draft_ready",
      ...(ticketRow === null || ticket === null ? {} : { ticketId: ticketRow.id, ticketKey: ticket.key, boardId }),
    },
    select: { id: true },
  });
  const taskId = taskIdSchema.parse(task.id);
  const saved = await harness.test.db.$transaction((tx) => saveDraft({ tx, ...harness.deps.ports }, { organizationId: a.organization.id, taskId, draft: draft() }));
  expect(saved).toMatchObject({ ok: true });
  return taskId;
};

/** "Add image" on the draft in the panel: the panel hands the bytes to `core`'s blob service. */
const addDraftImage = async (core: RunningCore, taskId: TaskId, bytes: Uint8Array): Promise<{ readonly blobId: string; readonly version: number }> => {
  const member = await panelAs(core);
  const added = await member.drafts.addImage({ taskId, name: "footer.png", contentType: "image/png", data: Buffer.from(bytes).toString("base64") });
  const image = await harness.test.db.refineDraftImage.findUniqueOrThrow({ where: { id: added.imageId }, select: { blobId: true } });
  return { blobId: image.blobId, version: added.version };
};

/** Where a blob's bytes are: its row names the store, and that store holds them, whole. */
const expectKeptIn = async (store: "postgres" | "s3", blobId: string, bytes: Uint8Array): Promise<void> => {
  const row = await harness.test.db.blob.findUniqueOrThrow({ where: { id: blobId }, select: { store: true, key: true, size: true, sha256: true } });
  expect(row).toMatchObject({ store, size: bytes.length, sha256: sha256Of(bytes) });
  const chunks = await harness.test.db.blobChunk.findMany({ where: { blobId }, orderBy: { ordinal: "asc" }, select: { bytes: true } });
  if (store === "postgres") {
    expect(chunks.length).toBeGreaterThan(0);
    expect(same(Buffer.concat(chunks.map((chunk) => chunk.bytes)), bytes)).toBe(true);
    expect(fake.objects.has(row.key)).toBe(false);
  } else {
    expect(chunks).toEqual([]);
    expect(same(fake.objects.get(row.key)?.body ?? new Uint8Array(), bytes)).toBe(true);
  }
};

describe("blob storage as an install runs it (F-114)", () => {
  it("F-114/c2: a fresh install with no blob setting keeps blobs in Postgres, in chunks of at most 1 MiB, and refuses one over 64 MiB", async () => {
    // Not one blob or S3 setting in the environment: the defaults are the built-in store and 64 MiB.
    expect(Object.keys(freshEnv).filter((name) => /BLOB|S3/.test(name))).toEqual([]);
    expect(freshSettings.blobStore).toEqual({ kind: "postgres", maxBytes: 64 * MiB });
    expect(fresh.blobs).toMatchObject({ kind: "postgres", maxBytes: 64 * MiB });

    // A session archive of a little over 2 MiB, from the runner over the bulk path.
    const task = await leasedTask();
    const archive = randomBytes(2 * MiB + 123);
    const ref = await upload(linkTo(urlOf(fresh), runnerToken), task, "session-archive", "application/gzip", archive);
    await expectKeptIn("postgres", ref.blobId, archive);
    const chunks = await harness.test.db.blobChunk.findMany({ where: { blobId: ref.blobId }, orderBy: { ordinal: "asc" }, select: { bytes: true } });
    expect(chunks.map((chunk) => chunk.bytes.length)).toEqual([BLOB_CHUNK_BYTES, BLOB_CHUNK_BYTES, 123]);

    // A blob core stores whole (a ticket's image) is cut into the same chunks by the store itself.
    const owner = { organizationId: task.organizationId, task: { projectId: task.projectId, taskId: task.taskId } };
    const image = randomBytes(BLOB_CHUNK_BYTES + 1);
    const whole = await fresh.blobs.put(owner, { purpose: "ticket-file", contentType: "image/png", bytes: image });
    if (!whole.ok) throw new Error(whole.message);
    await expectKeptIn("postgres", whole.value.blobId, image);
    expect((await harness.test.db.blobChunk.findMany({ where: { blobId: whole.value.blobId }, select: { bytes: true } })).map((chunk) => chunk.bytes.length).sort((x, y) => y - x)).toEqual([BLOB_CHUNK_BYTES, 1]);

    // The cap: an archive of exactly 64 MiB may start; one byte more is refused, in the setting's words.
    const digest = sha256HexSchema.parse(sha256Of(new Uint8Array(1)));
    const atCap = await fresh.blobs.startUpload(owner, { purpose: "session-archive", sha256: digest, size: 64 * MiB, contentType: "application/gzip" });
    expect(atCap.ok).toBe(true);
    const over = await fresh.blobs.startUpload(owner, { purpose: "session-archive", sha256: digest, size: 64 * MiB + 1, contentType: "application/gzip" });
    expect(over).toMatchObject({ ok: false, error: "too-large" });
    expect(!over.ok && over.message).toContain("over the cap of 64 MiB (OSTRA_BLOB_MAX_MIB)");
    // And over the bulk path the task's lease goes on: the next upload works as before.
    const next = randomBytes(500);
    await expectKeptIn("postgres", (await upload(linkTo(urlOf(fresh), runnerToken), task, "session-archive", "application/gzip", next)).blobId, next);
  }, 120_000);

  for (const store of ["postgres", "s3"] as const) {
    it(`F-114/c1: a session archive and a screenshot from the runner, and an image on a refine draft from the panel, all go through the ${store === "postgres" ? "built-in" : "S3-compatible"} blob store adapter`, async () => {
      const core = store === "postgres" ? fresh : s3;
      const task = await leasedTask();
      const link = linkTo(urlOf(core), runnerToken);
      const archive = randomBytes(300_000);
      const screenshot = randomBytes(40_000);
      const image = randomBytes(30_000);
      const archiveRef = await upload(link, task, "session-archive", "application/gzip", archive);
      const screenshotRef = await upload(link, task, "app-screenshot", APP_SCREENSHOT_CONTENT_TYPE, screenshot);
      const drafted = await addDraftImage(core, await refineTask(null), image);

      const files: readonly (readonly [string, Uint8Array, string])[] = [
        [archiveRef.blobId, archive, "session-archive"],
        [screenshotRef.blobId, screenshot, "app-screenshot"],
        [drafted.blobId, image, "draft-image"],
      ];
      for (const [blobId, bytes, purpose] of files) {
        expect((await harness.test.db.blob.findUniqueOrThrow({ where: { id: blobId }, select: { purpose: true } })).purpose).toBe(purpose);
        await expectKeptIn(store, blobId, bytes);
        // And each reads back through core's blob service, from the store its row names.
        const read = await core.blobs.read(harness.fixture.a.organization.id, blobIdSchema.parse(blobId));
        expect(read.ok && same(read.value.bytes, bytes)).toBe(true);
      }
    }, 60_000);
  }

  it("F-114/c3: an admin switches to an S3-compatible store with its address and keys alone: the next blob goes to the bucket, one from before is still read from Postgres, and each setting is in the configuration reference", async () => {
    // The switch is the store's address and keys. Without the keys, the settings say which are missing, naming no value.
    const switched = settingsOf(s3Env);
    expect(switched.blobStore).toEqual({
      kind: "s3",
      maxBytes: 64 * MiB,
      endpoint: fake.endpoint,
      bucket: fake.bucket,
      region: fake.region,
      accessKeyId: fake.accessKeyId,
      secretAccessKey: fake.secretAccessKey,
    });
    const halfway = parseServerSettings({ ...freshEnv, OSTRA_BLOB_STORE: "s3", OSTRA_S3_ENDPOINT: fake.endpoint });
    expect(halfway).toEqual({
      ok: false,
      errors: [
        "OSTRA_S3_BUCKET is required with OSTRA_BLOB_STORE=s3",
        "OSTRA_S3_ACCESS_KEY_ID is required with OSTRA_BLOB_STORE=s3",
        "OSTRA_S3_SECRET_ACCESS_KEY is required with OSTRA_BLOB_STORE=s3",
      ],
    });

    // Before the switch: the fresh install keeps a task's archive in Postgres.
    const task = await leasedTask();
    const before = randomBytes(120_000);
    const old = await upload(linkTo(urlOf(fresh), runnerToken), task, "session-archive", "application/gzip", before);
    await expectKeptIn("postgres", old.blobId, before);

    // After it: the next archive goes to the bucket, and the runner still downloads the old one,
    // read from Postgres where it was written.
    const link = linkTo(urlOf(s3), runnerToken);
    const after = randomBytes(150_000);
    const next = await upload(link, task, "session-archive", "application/gzip", after);
    await expectKeptIn("s3", next.blobId, after);
    for (const [ref, bytes] of [
      [old, before],
      [next, after],
    ] as const) {
      const got = await link.downloadBlob({ taskId: task.taskId, leaseEpoch: task.leaseEpoch, blobId: ref.blobId, maxBytes: 64 * MiB });
      expect(got.ok && same(got.value.bytes, bytes) && got.value.sha256 === ref.sha256).toBe(true);
    }

    // The configuration reference lists each setting the switch uses, with its default.
    const reference = await readFile(path.resolve(import.meta.dirname, "../../../../docs/configuration.md"), "utf8");
    const rows = new Map(
      reference
        .split("\n")
        .flatMap((line) => {
          const match = /^\| `(OSTRA_(?:BLOB|S3)_[A-Z_]+)` \| ([^|]+) \|/.exec(line);
          return match?.[1] === undefined || match[2] === undefined ? [] : [[match[1], match[2].trim()] as const];
        }),
    );
    expect(Object.fromEntries(rows)).toEqual({
      OSTRA_BLOB_STORE: "`postgres`",
      OSTRA_BLOB_MAX_MIB: "`64`",
      OSTRA_S3_ENDPOINT: "unset: AWS S3",
      OSTRA_S3_BUCKET: "unset; required with `OSTRA_BLOB_STORE=s3`",
      OSTRA_S3_REGION: "unset: us-east-1",
      OSTRA_S3_ACCESS_KEY_ID: "unset; required with `OSTRA_BLOB_STORE=s3`",
      OSTRA_S3_SECRET_ACCESS_KEY: "unset; required with `OSTRA_BLOB_STORE=s3`",
    });
    expect(reference).toContain("Only core needs them");
  }, 60_000);

  it("F-114/c4: a runner and a box's sidecar upload through core with its address alone, and the S3-compatible store's address and keys stay core's", async () => {
    // The runner knows no store: nothing of its configuration names one, and its server's address is all it needs.
    expect(runnerConfigKeys.filter((key) => /blob|s3|bucket|storage/i.test(key))).toEqual([]);
    expect(runnerEnvNames.filter((name) => /BLOB|S3|BUCKET|STORAGE/.test(name))).toEqual([]);
    expect(parseRunnerConfig({ flags: { server: urlOf(s3) }, env: {} })).toMatchObject({ ok: true, config: { serverUrl: urlOf(s3) } });

    const requestsBefore = fake.requests.length;
    // A personal runner on `host`, with its access token.
    const onHost = await leasedTask();
    const archive = randomBytes(200_000);
    const fromRunner = await upload(linkTo(urlOf(s3), runnerToken), onHost, "session-archive", "application/gzip", archive);
    await expectKeptIn("s3", fromRunner.blobId, archive);

    // A box's sidecar on `docker`, with its task's token: the same link, the same one address.
    const inBox = await leasedTask();
    await harness.test.db.box.update({ where: { id: inBox.boxId }, data: { executor: "docker" } });
    const taskToken = s3.gateway.context.taskTokens.issue({
      organizationId: inBox.organizationId,
      taskId: inBox.taskId,
      leaseEpoch: inBox.leaseEpoch,
      boxId: boxIdSchema.parse(inBox.boxId),
      runnerId: runner.runnerId,
    });
    const sidecar = linkTo(urlOf(s3), () => taskToken);
    const screenshot = randomBytes(60_000);
    const fromSidecar = await upload(sidecar, inBox, "app-screenshot", APP_SCREENSHOT_CONTENT_TYPE, screenshot);
    await expectKeptIn("s3", fromSidecar.blobId, screenshot);
    const back = await sidecar.downloadBlob({ taskId: inBox.taskId, leaseEpoch: inBox.leaseEpoch, blobId: fromSidecar.blobId, maxBytes: 8 * MiB });
    expect(back.ok && same(back.value.bytes, screenshot)).toBe(true);
    // The bucket took both, from core: the one process whose settings hold its address and keys.
    expect(fake.requests.length).toBeGreaterThan(requestsBefore);
  }, 60_000);

  it("F-114/c5: a draft's image goes to Linear as an attachment, read from the blob store by core's own worker; a tracker whose adapter can't take one gets a link to it in ostra instead", async () => {
    const reader = new LinearAdapter({ apiUrl: linear.apiUrl, auth: { kind: "oauth", token: linearToken } });
    // Linear's adapter declares attachments: the image goes as a copy.
    expect(reader.capabilities.attachments).toBe(true);
    const issue = await linear.createIssue({ title: "Speed up the footer", description: "It's slow." });
    const externalId = externalTicketIdSchema.parse(issue.id);
    const taskId = await refineTask({ externalId, key: issue.identifier });
    const image = randomBytes(20_000);
    const drafted = await addDraftImage(fresh, taskId, image);
    await expectKeptIn("postgres", drafted.blobId, image);

    // "Update ticket": the panel enqueues `draft.apply`, and core's own worker runs it.
    const member = await panelAs(fresh);
    harness.fakes.jobs.clear();
    await member.drafts.updateTicket({ taskId, version: drafted.version });
    const sent = harness.fakes.jobs.jobs.find((job) => job.job === "draft.apply");
    const payload = jobPayloadSchemas["draft.apply"].parse(sent?.payload);
    await harness.test.db.$transaction((tx) => fresh.jobs.enqueueInTx(tx, "draft.apply", payload));
    const attachment = await waitFor("the image on the Linear issue", () => Promise.resolve(linear.issueView(externalId).attachments[0]));
    // The copy on the ticket is the blob's bytes.
    const copy = await fetch(attachment.url, { headers: { authorization: `Bearer ${linearToken}` } });
    expect(copy.status).toBe(200);
    expect(same(new Uint8Array(await copy.arrayBuffer()), image)).toBe(true);
    expect(linear.issueView(externalId).attachments).toHaveLength(1);
    const attached = await reader.getTicketContext({ externalId: linear.team.id }, { externalId });
    if (!attached.ok) throw new Error(attached.error.message);
    expect(attached.value.ticket.description).not.toContain("## Images");

    // A tracker whose adapter declares no attachments: nothing is read from the store or sent, and
    // the ticket names the image with a link to it in ostra.
    const other = await linear.createIssue({ title: "Speed up the header", description: "Also slow." });
    const otherId = externalTicketIdSchema.parse(other.id);
    const otherTask = await refineTask({ externalId: otherId, key: other.identifier });
    const otherImage = await addDraftImage(fresh, otherTask, randomBytes(10_000));
    harness.fakes.jobs.clear();
    await member.drafts.updateTicket({ taskId: otherTask, version: otherImage.version });
    const otherPayload = jobPayloadSchemas["draft.apply"].parse(harness.fakes.jobs.jobs.find((job) => job.job === "draft.apply")?.payload);
    const reads: string[] = [];
    const withoutAttachments = (adapter: TrackerAdapter): TrackerAdapter =>
      new Proxy(adapter, {
        get: (target, property): unknown => {
          if (property === "capabilities") return { ...target.capabilities, attachments: false };
          const value: unknown = Reflect.get(target, property, target);
          // The adapters keep private fields: their methods run on the adapter itself.
          return typeof value === "function" ? (...args: unknown[]): unknown => Reflect.apply(value, target, args) : value;
        },
      });
    await draftApplyHandler({
      db: harness.test.db,
      trackers: createConnectionTrackers({
        db: harness.test.db,
        secretStore: harness.fakes.secretStore,
        clock: systemClock,
        logger: silentLogger,
        build: (input) => withoutAttachments(new LinearAdapter({ apiUrl: linear.apiUrl, auth: { kind: "oauth", token: input.token } }, input.context)),
      }),
      notices: postgresChangeNotices,
      clock: systemClock,
      publicUrl: freshSettings.publicUrl,
      logger: silentLogger,
      readBlob: (_organizationId, blobId) => {
        reads.push(blobId);
        return Promise.resolve(null);
      },
    })(jobContext("draft.apply", otherPayload, silentLogger));
    expect(reads).toEqual([]);
    expect(linear.issueView(otherId).attachments).toEqual([]);
    const linked = await reader.getTicketContext({ externalId: linear.team.id }, { externalId: otherId });
    if (!linked.ok) throw new Error(linked.error.message);
    expect(linked.value.ticket.description).toContain(`## Images\n- footer.png (in ostra: ${taskPageUrl(freshSettings.publicUrl, otherTask)})`);
  }, 90_000);
});
