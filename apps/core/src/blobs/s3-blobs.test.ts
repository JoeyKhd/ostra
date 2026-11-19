import { createHash, randomUUID } from "node:crypto";

import { S3BlobStore } from "@ostra/adapter-blob-s3";
import { createFakeS3 } from "@ostra/adapter-blob-s3/testing";
import type { FakeS3 } from "@ostra/adapter-blob-s3/testing";
import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { manualClock } from "@ostra/adapter-sdk/testing";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { systemClock } from "@ostra/domain";
import { blobRefSchema, blobUploadStartResponseSchema, projectIdSchema, runnerHttpErrorSchema, runnerPaths } from "@ostra/protocol";
import type { BlobRef, OrganizationId, TaskId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RunnerRef } from "../gateway/context.ts";
import { accessToken, registerPersonal, startGateway } from "../testing/harness.ts";
import type { GatewayHarness } from "../testing/harness.ts";
import { seedLeasedTask } from "../testing/seed.ts";
import type { LeasedTask } from "../testing/seed.ts";
import { createBlobService } from "./blob-service.ts";
import type { BlobService } from "./blob-service.ts";
import { handleBlobEndpoint } from "./endpoints.ts";
import { collectStaleUploads, STALE_UPLOAD_MS } from "./gc.ts";

// Ticket 11's cases in core: the blob service on the S3-compatible store (a fake S3 server), the bulk
// path over core's HTTP server with a real runner's access token, the switch from the built-in
// store to S3 with the old blobs still read, and `blob.gc` dropping the bucket's unfinished uploads.

let test: TestDatabase;
let fixture: IsolationFixture;
let harness: GatewayHarness;
let fake: FakeS3;
let store: S3BlobStore;
let blobs: BlobService;
let postgresBlobs: BlobService;
let token: string;
let runner: RunnerRef;
let task: LeasedTask;
let otherTask: LeasedTask;
const records: LogRecord[] = [];
const logger = createLogger((record) => {
  records.push(record);
});

const MAX_BYTES = 64 * 1024;
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const randomBytes = (size: number, seed: string): Uint8Array => {
  const out = new Uint8Array(size);
  let block = createHash("sha256").update(seed).digest();
  for (let at = 0; at < size; at += block.length) {
    out.set(block.subarray(0, Math.min(block.length, size - at)), at);
    block = createHash("sha256").update(block).digest();
  }
  return out;
};

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  fake = await createFakeS3();
  store = new S3BlobStore({
    endpoint: fake.endpoint,
    bucket: fake.bucket,
    region: fake.region,
    accessKeyId: fake.accessKeyId,
    secretAccessKey: fake.secretAccessKey,
    maxBytes: MAX_BYTES,
  });
  // The install ran on the built-in store first, then switched to S3: both services share the database.
  postgresBlobs = createBlobService({ db: test.db, settings: { kind: "postgres", maxBytes: MAX_BYTES }, context: { logger, clock: systemClock } });
  blobs = createBlobService({
    db: test.db,
    settings: {
      kind: "s3",
      maxBytes: MAX_BYTES,
      endpoint: fake.endpoint,
      bucket: fake.bucket,
      region: fake.region,
      accessKeyId: fake.accessKeyId,
      secretAccessKey: fake.secretAccessKey,
    },
    context: { logger, clock: systemClock },
    s3: store,
  });
  harness = await startGateway(test.db, test.url, {}, (gateway) => [
    handleBlobEndpoint({ db: test.db, tokens: gateway.context.tokens, taskTokens: gateway.context.taskTokens, blobs, clock: systemClock, logger }),
  ]);
  const registered = await registerPersonal(harness, test.db, fixture.a.admin);
  runner = { runnerId: registered.runnerId, organizationId: fixture.a.organization.id };
  token = (await accessToken(harness, registered)).accessToken;
  task = await seedLeasedTask(test.db, runner, fixture.a.openProject.id, { state: "running" });
  otherTask = await seedLeasedTask(test.db, runner, fixture.a.openProject.id, { state: "running" });
});

afterAll(async () => {
  await harness.stop();
  store.close();
  await fake.close();
  await test.dispose();
});

const url = (path: string): string => `${harness.url}${path}`;
const auth = (): Record<string, string> => ({ authorization: `Bearer ${token}` });

const start = async (forTask: LeasedTask, bytes: Uint8Array, size = bytes.length) => {
  const response = await fetch(url(runnerPaths.taskBlobs(forTask.taskId)), {
    method: "POST",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ purpose: "session-archive", sha256: sha(bytes), size, contentType: "application/gzip", leaseEpoch: 1 }),
  });
  const body: unknown = await response.json();
  return { status: response.status, body };
};

const put = async (forTask: LeasedTask, uploadId: string, offset: number, chunk: Uint8Array) => {
  const response = await fetch(`${url(runnerPaths.taskBlobs(forTask.taskId))}/${uploadId}?offset=${String(offset)}&leaseEpoch=1`, {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/octet-stream" },
    body: chunk,
  });
  const body: unknown = await response.json();
  return { status: response.status, body };
};

const finish = async (forTask: LeasedTask, uploadId: string) => {
  const response = await fetch(`${url(runnerPaths.taskBlobs(forTask.taskId))}/${uploadId}/finish`, {
    method: "POST",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ leaseEpoch: 1 }),
  });
  const body: unknown = await response.json();
  return { status: response.status, body };
};

const download = async (forTask: { readonly taskId: TaskId }, blobId: string) => {
  const response = await fetch(`${url(runnerPaths.taskBlobs(forTask.taskId))}/${blobId}?leaseEpoch=1`, { headers: auth() });
  return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()), type: response.headers.get("content-type") };
};

const uploadWhole = async (forTask: LeasedTask, bytes: Uint8Array, chunk = 20_000): Promise<BlobRef> => {
  const started = blobUploadStartResponseSchema.parse((await start(forTask, bytes)).body);
  for (let offset = started.receivedBytes; offset < bytes.length; offset += chunk) {
    expect((await put(forTask, started.uploadId, offset, bytes.subarray(offset, offset + chunk))).status).toBe(200);
  }
  const done = await finish(forTask, started.uploadId);
  expect(done.status).toBe(200);
  return blobRefSchema.parse(done.body);
};

const errorCode = (body: unknown): string => runnerHttpErrorSchema.parse(body).error.code;

describe("the bulk path on the S3-compatible store", () => {
  it("uploads in chunks into the bucket, records the blob as the task's, and downloads it for that task only", async () => {
    const bytes = randomBytes(50_000, "s3-archive-1");
    const ref = await uploadWhole(task, bytes);
    expect(ref).toMatchObject({ size: bytes.length, sha256: sha(bytes) });
    const row = await test.db.blob.findUniqueOrThrow({ where: { id: ref.blobId } });
    expect(row).toMatchObject({
      organizationId: task.organizationId,
      projectId: task.projectId,
      taskId: task.taskId,
      store: "s3",
      purpose: "session-archive",
      contentType: "application/gzip",
    });
    // The bytes are in the bucket, not in the database.
    expect(Buffer.from(fake.objects.get(row.key)?.body ?? new Uint8Array()).equals(Buffer.from(bytes))).toBe(true);
    expect(await test.db.blobChunk.count({ where: { blobId: ref.blobId } })).toBe(0);
    const got = await download(task, ref.blobId);
    expect(got.status).toBe(200);
    expect(got.type).toBe("application/gzip");
    expect(Buffer.from(got.bytes).equals(Buffer.from(bytes))).toBe(true);
    // Another task of the same project can't download it.
    expect((await download(otherTask, ref.blobId)).status).toBe(404);
  });

  it("resumes an upload: the start says where it stopped, a chunk sent again is stored once, and finishing twice answers the same", async () => {
    const bytes = randomBytes(30_000, "s3-resume");
    const started = blobUploadStartResponseSchema.parse((await start(task, bytes)).body);
    expect(started.receivedBytes).toBe(0);
    expect((await put(task, started.uploadId, 0, bytes.subarray(0, 12_000))).status).toBe(200);
    const resumed = blobUploadStartResponseSchema.parse((await start(task, bytes)).body);
    expect(resumed).toEqual({ uploadId: started.uploadId, receivedBytes: 12_000 });
    expect((await put(task, resumed.uploadId, 0, bytes.subarray(0, 12_000))).body).toEqual({ receivedBytes: 12_000 });
    expect((await put(task, resumed.uploadId, 12_000, bytes.subarray(12_000))).body).toEqual({ receivedBytes: 30_000 });
    const ref = blobRefSchema.parse((await finish(task, resumed.uploadId)).body);
    expect(ref.sha256).toBe(sha(bytes));
    expect((await finish(task, resumed.uploadId)).body).toEqual(ref);
    expect(Buffer.from((await download(task, ref.blobId)).bytes).equals(Buffer.from(bytes))).toBe(true);
    expect(await test.db.blobUpload.findUniqueOrThrow({ where: { id: started.uploadId } })).toMatchObject({ store: "s3", blobId: ref.blobId, receivedBytes: 30_000 });
  });

  it("keeps two tasks' uploads of the same bytes apart", async () => {
    const bytes = randomBytes(3_000, "s3-same-bytes");
    const first = blobUploadStartResponseSchema.parse((await start(task, bytes)).body);
    const second = blobUploadStartResponseSchema.parse((await start(otherTask, bytes)).body);
    expect(second.uploadId).not.toBe(first.uploadId);
    // The other task can't append to, or finish, the first task's upload.
    expect((await put(otherTask, first.uploadId, 0, bytes)).status).toBe(404);
    expect((await finish(otherTask, first.uploadId)).status).toBe(404);
  });

  it("refuses a gap with offset-mismatch, a chunk past the size, and a blob over the cap", async () => {
    const bytes = randomBytes(4_000, "s3-gap");
    const started = blobUploadStartResponseSchema.parse((await start(task, bytes)).body);
    const gap = await put(task, started.uploadId, 100, bytes.subarray(100, 200));
    expect(gap.status).toBe(409);
    expect(errorCode(gap.body)).toBe("offset-mismatch");
    expect((await put(task, started.uploadId, 0, new Uint8Array(4_001))).status).toBe(413);
    expect((await start(task, bytes, MAX_BYTES + 1)).status).toBe(413);
  });

  it("refuses bytes that don't match the digest, drops the upload from the bucket, and a retry starts from zero", async () => {
    const bytes = randomBytes(3_000, "s3-mismatch");
    const started = blobUploadStartResponseSchema.parse((await start(task, bytes)).body);
    await put(task, started.uploadId, 0, randomBytes(3_000, "other bytes"));
    const done = await finish(task, started.uploadId);
    expect(done.status).toBe(409);
    expect(errorCode(done.body)).toBe("digest-mismatch");
    expect(await test.db.blobUpload.count({ where: { id: started.uploadId } })).toBe(0);
    expect([...fake.objects.keys()].filter((key) => key.startsWith(`uploads/${started.uploadId}/`))).toEqual([]);
    expect(blobUploadStartResponseSchema.parse((await start(task, bytes)).body).receivedBytes).toBe(0);
  });

  it("logs IDs, sizes and digests, never the bytes", async () => {
    const marker = `archive-content-${randomUUID()}`;
    await uploadWhole(task, new TextEncoder().encode(marker.repeat(20)));
    const logged = JSON.stringify(records);
    expect(logged).toContain("blob.uploaded");
    expect(logged).not.toContain(marker);
    expect(logged).not.toContain(fake.secretAccessKey);
  });
});

describe("switching from the built-in store to S3", () => {
  const owner = () => ({ organizationId: task.organizationId, task: { projectId: projectIdSchema.parse(task.projectId), taskId: task.taskId } });

  it("reads, from Postgres, a blob written before the switch, and writes the next one to S3", async () => {
    const before = randomBytes(2_000, "written before the switch");
    const stored = await postgresBlobs.put(owner(), { purpose: "ticket-file", contentType: "image/png", bytes: before });
    if (!stored.ok) throw new Error(stored.message);
    expect(await test.db.blob.findUniqueOrThrow({ where: { id: stored.value.blobId }, select: { store: true } })).toEqual({ store: "postgres" });

    // The service now defaults to S3, and still reads the old blob where it is.
    const old = await blobs.read(task.organizationId, stored.value.blobId, task.taskId);
    if (!old.ok) throw new Error(old.message);
    expect(Buffer.from(old.value.bytes).equals(Buffer.from(before))).toBe(true);

    const after = randomBytes(2_500, "written after the switch");
    const next = await blobs.put(owner(), { purpose: "ticket-file", contentType: "image/png", bytes: after });
    if (!next.ok) throw new Error(next.message);
    const row = await test.db.blob.findUniqueOrThrow({ where: { id: next.value.blobId }, select: { store: true, key: true } });
    expect(row.store).toBe("s3");
    expect(row.key.startsWith(`blobs/${task.organizationId}/`)).toBe(true);
    const back = await blobs.read(task.organizationId, next.value.blobId, task.taskId);
    expect(back.ok && Buffer.from(back.value.bytes).equals(Buffer.from(after))).toBe(true);

    // Each is deleted from the store that holds it.
    expect(await blobs.delete(task.organizationId, stored.value.blobId)).toEqual({ ok: true, value: undefined });
    expect(await test.db.blobChunk.count({ where: { blobId: stored.value.blobId } })).toBe(0);
    expect(await blobs.delete(task.organizationId, next.value.blobId)).toEqual({ ok: true, value: undefined });
    expect(fake.objects.has(row.key)).toBe(false);
    expect(await test.db.blob.count({ where: { id: { in: [stored.value.blobId, next.value.blobId] } } })).toBe(0);
  });

  it("reads another organization's blob as missing", async () => {
    const stored = await blobs.put(owner(), { purpose: "ticket-file", contentType: "text/plain", bytes: randomBytes(100, "mine") });
    if (!stored.ok) throw new Error(stored.message);
    const theirs: OrganizationId = fixture.b.organization.id;
    expect(await blobs.read(theirs, stored.value.blobId)).toMatchObject({ ok: false, error: "not-found" });
    expect(await blobs.delete(theirs, stored.value.blobId)).toMatchObject({ ok: false, error: "not-found" });
  });

  it("says the store is not set up when an S3 blob is read on an install without S3 settings", async () => {
    const stored = await blobs.put(owner(), { purpose: "ticket-file", contentType: "text/plain", bytes: randomBytes(100, "kept in s3") });
    if (!stored.ok) throw new Error(stored.message);
    const result = await postgresBlobs.read(task.organizationId, stored.value.blobId);
    expect(result).toMatchObject({ ok: false, error: "unavailable" });
    expect(!result.ok && result.message).toContain("s3");
  });
});

describe("blob.gc with an S3-compatible store", () => {
  const ageUpload = async (uploadId: string, ms: number): Promise<void> => {
    await test.db.$executeRaw`UPDATE "blob_upload" SET "updatedAt" = ${new Date(Date.now() - ms)} WHERE "id" = ${uploadId}`;
  };

  it("drops a stale upload's chunks from the bucket with its record, and leaves a fresh one and every blob", async () => {
    const staleBytes = randomBytes(1_000, "s3-stale");
    const stale = blobUploadStartResponseSchema.parse((await start(task, staleBytes)).body);
    await put(task, stale.uploadId, 0, staleBytes.subarray(0, 500));
    const freshBytes = randomBytes(1_000, "s3-fresh");
    const fresh = blobUploadStartResponseSchema.parse((await start(task, freshBytes)).body);
    await put(task, fresh.uploadId, 0, freshBytes.subarray(0, 500));
    const kept = await uploadWhole(task, randomBytes(900, "s3-kept"));
    await ageUpload(stale.uploadId, STALE_UPLOAD_MS + 60_000);
    await ageUpload(fresh.uploadId, STALE_UPLOAD_MS - 60_000);

    const deleted = await collectStaleUploads({ db: test.db, clock: manualClock(Date.now()), logger, s3: store });
    expect(deleted.unfinished).toBeGreaterThanOrEqual(1);
    expect(await test.db.blobUpload.count({ where: { id: stale.uploadId } })).toBe(0);
    expect([...fake.objects.keys()].filter((key) => key.startsWith(`uploads/${stale.uploadId}/`))).toEqual([]);
    expect(await test.db.blobUpload.count({ where: { id: fresh.uploadId } })).toBe(1);
    expect([...fake.objects.keys()].some((key) => key.startsWith(`uploads/${fresh.uploadId}/`))).toBe(true);
    expect((await download(task, kept.blobId)).status).toBe(200);
    // The stale upload's bytes started again are a new upload, from zero.
    expect(blobUploadStartResponseSchema.parse((await start(task, staleBytes)).body).receivedBytes).toBe(0);
  });

  it("keeps a record whose bytes the bucket could not drop, for the next pass", async () => {
    const bytes = randomBytes(1_000, "s3-stuck");
    const stuck = blobUploadStartResponseSchema.parse((await start(task, bytes)).body);
    await put(task, stuck.uploadId, 0, bytes.subarray(0, 400));
    await ageUpload(stuck.uploadId, STALE_UPLOAD_MS + 60_000);
    fake.faults.push({ match: (request) => request.method === "DELETE", action: { kind: "status", status: 500, code: "InternalError" }, times: 100 });
    const failed = await collectStaleUploads({ db: test.db, clock: manualClock(Date.now()), logger, s3: store });
    fake.faults.length = 0;
    expect(failed.unfinished).toBe(0);
    expect(await test.db.blobUpload.count({ where: { id: stuck.uploadId } })).toBe(1);
    const next = await collectStaleUploads({ db: test.db, clock: manualClock(Date.now()), logger, s3: store });
    expect(next.unfinished).toBe(1);
    expect([...fake.objects.keys()].filter((key) => key.startsWith(`uploads/${stuck.uploadId}/`))).toEqual([]);
  }, 60_000);
});
