import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";

import { PostgresBlobStore } from "@ostra/adapter-blob-postgres";
import type { BlobRows } from "@ostra/adapter-blob-postgres";
import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { defineBlobStoreContractSuite, manualClock } from "@ostra/adapter-sdk/testing";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { systemClock } from "@ostra/domain";
import { blobRefSchema, blobUploadStartResponseSchema, projectIdSchema, runnerHttpErrorSchema, runnerPaths, taskIdSchema } from "@ostra/protocol";
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
import { BLOB_CHUNK_BYTES, postgresBlobRows } from "./postgres-blob-rows.ts";

// Ticket 12's cases: the blob contract suite on Postgres, then the bulk path end to end over
// core's HTTP server, with a real runner's access token.

let test: TestDatabase;
let fixture: IsolationFixture;
let harness: GatewayHarness;
let blobs: BlobService;
let token: string;
let runner: RunnerRef;
let task: LeasedTask;
let otherTask: LeasedTask;
const records: LogRecord[] = [];
const logger = createLogger((record) => {
  records.push(record);
});

const MAX_BYTES = 8 * 1024;
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

/** Rows that make the suite's made-up organizations first, as the suite names them freely. */
const rowsMakingOrganizations = (rows: BlobRows): BlobRows => {
  const made = new Set<string>();
  const ensure = async (organizationId: string): Promise<void> => {
    if (made.has(organizationId)) return;
    await test.db.organization.upsert({
      where: { id: organizationId },
      create: { id: organizationId, name: "contract", slug: `contract-${randomUUID().slice(0, 8)}`, createdAt: new Date() },
      update: {},
    });
    made.add(organizationId);
  };
  return {
    ...rows,
    insertBlob: async (row) => {
      await ensure(row.organizationId);
      await rows.insertBlob(row);
    },
    putUpload: async (row) => {
      await ensure(row.organizationId);
      await rows.putUpload(row);
    },
  };
};

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  blobs = createBlobService({ db: test.db, settings: { kind: "postgres", maxBytes: MAX_BYTES }, context: { logger, clock: systemClock } });
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
  await test.dispose();
});

defineBlobStoreContractSuite({
  name: "postgres blob store, on Postgres",
  create: () =>
    Promise.resolve({
      adapter: new PostgresBlobStore({ rows: rowsMakingOrganizations(postgresBlobRows(test.db)), maxBytes: 4096 }),
      fixture: { maxBytes: 4096 },
    }),
});

// ---------- the bulk path over HTTP ----------

const url = (path: string): string => `${harness.url}${path}`;
const auth = (): Record<string, string> => ({ authorization: `Bearer ${token}` });

const start = async (forTask: LeasedTask, bytes: Uint8Array, epoch = 1, size = bytes.length) => {
  const response = await fetch(url(runnerPaths.taskBlobs(forTask.taskId)), {
    method: "POST",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ purpose: "session-archive", sha256: sha(bytes), size, contentType: "application/gzip", leaseEpoch: epoch }),
  });
  const body: unknown = await response.json();
  return { status: response.status, body };
};

const put = async (forTask: LeasedTask, uploadId: string, offset: number, chunk: Uint8Array, epoch = 1) => {
  const response = await fetch(`${url(runnerPaths.taskBlobs(forTask.taskId))}/${uploadId}?offset=${String(offset)}&leaseEpoch=${String(epoch)}`, {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/octet-stream" },
    body: chunk,
  });
  const body: unknown = await response.json();
  return { status: response.status, body };
};

const finish = async (forTask: LeasedTask, uploadId: string, epoch = 1) => {
  const response = await fetch(`${url(runnerPaths.taskBlobs(forTask.taskId))}/${uploadId}/finish`, {
    method: "POST",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ leaseEpoch: epoch }),
  });
  const body: unknown = await response.json();
  return { status: response.status, body };
};

const download = async (forTask: { readonly taskId: TaskId }, blobId: string, epoch = 1) => {
  const response = await fetch(`${url(runnerPaths.taskBlobs(forTask.taskId))}/${blobId}?leaseEpoch=${String(epoch)}`, { headers: auth() });
  return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()), type: response.headers.get("content-type") };
};

const uploadWhole = async (forTask: LeasedTask, bytes: Uint8Array, chunk = 3000): Promise<BlobRef> => {
  const started = blobUploadStartResponseSchema.parse((await start(forTask, bytes)).body);
  for (let offset = started.receivedBytes; offset < bytes.length; offset += chunk) {
    const answer = await put(forTask, started.uploadId, offset, bytes.subarray(offset, offset + chunk));
    expect(answer.status).toBe(200);
  }
  const done = await finish(forTask, started.uploadId);
  expect(done.status).toBe(200);
  return blobRefSchema.parse(done.body);
};

/** Sends a chunk's headers and half its body, then drops the connection. */
const putAndDrop = (forTask: LeasedTask, uploadId: string, offset: number, chunk: Uint8Array): Promise<void> =>
  new Promise((resolve) => {
    const target = new URL(`${url(runnerPaths.taskBlobs(forTask.taskId))}/${uploadId}?offset=${String(offset)}&leaseEpoch=1`);
    const req = httpRequest(
      { method: "PUT", host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, headers: { ...auth(), "content-length": String(chunk.length) } },
      () => undefined,
    );
    req.on("error", () => {
      resolve();
    });
    req.write(chunk.subarray(0, Math.floor(chunk.length / 2)), () => {
      setTimeout(() => {
        req.destroy();
        setTimeout(resolve, 200);
      }, 100);
    });
  });

const errorCode = (body: unknown): string => runnerHttpErrorSchema.parse(body).error.code;

describe("the bulk path", () => {
  it("uploads in chunks, stores the blob as the task's, and downloads it for that task", async () => {
    const bytes = randomBytes(7000, "archive-1");
    const ref = await uploadWhole(task, bytes);
    expect(ref).toMatchObject({ size: bytes.length, sha256: sha(bytes) });
    const row = await test.db.blob.findUniqueOrThrow({ where: { id: ref.blobId } });
    expect(row).toMatchObject({ organizationId: task.organizationId, projectId: task.projectId, taskId: task.taskId, store: "postgres", purpose: "session-archive", contentType: "application/gzip" });
    // The upload's chunks moved to the blob: none were written twice.
    expect(await test.db.blobChunk.count({ where: { blobId: ref.blobId } })).toBeGreaterThan(0);
    expect(await test.db.blobChunk.count({ where: { uploadId: { not: null }, organizationId: task.organizationId } })).toBe(0);
    const got = await download(task, ref.blobId);
    expect(got.status).toBe(200);
    expect(got.type).toBe("application/gzip");
    expect(Buffer.from(got.bytes).equals(Buffer.from(bytes))).toBe(true);
  });

  it("resumes an upload dropped mid-chunk: the start says where it stopped", async () => {
    const bytes = randomBytes(6000, "archive-dropped");
    const started = blobUploadStartResponseSchema.parse((await start(task, bytes)).body);
    expect(started.receivedBytes).toBe(0);
    expect((await put(task, started.uploadId, 0, bytes.subarray(0, 2500))).status).toBe(200);
    // The second chunk's connection dies halfway: nothing of it is kept.
    await putAndDrop(task, started.uploadId, 2500, bytes.subarray(2500, 5000));
    const resumed = blobUploadStartResponseSchema.parse((await start(task, bytes)).body);
    expect(resumed).toEqual({ uploadId: started.uploadId, receivedBytes: 2500 });
    // A chunk sent again is stored once.
    expect((await put(task, resumed.uploadId, 0, bytes.subarray(0, 2500))).body).toEqual({ receivedBytes: 2500 });
    expect((await put(task, resumed.uploadId, 2500, bytes.subarray(2500))).body).toEqual({ receivedBytes: 6000 });
    const ref = blobRefSchema.parse((await finish(task, resumed.uploadId)).body);
    expect(ref.sha256).toBe(sha(bytes));
    // Finishing twice answers the same.
    expect((await finish(task, resumed.uploadId)).body).toEqual(ref);
    const got = await download(task, ref.blobId);
    expect(Buffer.from(got.bytes).equals(Buffer.from(bytes))).toBe(true);
  });

  it("refuses a gap with offset-mismatch, and a chunk past the size", async () => {
    const bytes = randomBytes(4000, "gap");
    const started = blobUploadStartResponseSchema.parse((await start(task, bytes)).body);
    const gap = await put(task, started.uploadId, 100, bytes.subarray(100, 200));
    expect(gap.status).toBe(409);
    expect(errorCode(gap.body)).toBe("offset-mismatch");
    const past = await put(task, started.uploadId, 0, new Uint8Array(4001));
    expect(past.status).toBe(413);
  });

  it("refuses bytes that don't match the digest, and drops the upload", async () => {
    const bytes = randomBytes(3000, "mismatch");
    const started = blobUploadStartResponseSchema.parse((await start(task, bytes)).body);
    await put(task, started.uploadId, 0, randomBytes(3000, "other bytes"));
    const done = await finish(task, started.uploadId);
    expect(done.status).toBe(409);
    expect(errorCode(done.body)).toBe("digest-mismatch");
    expect(await test.db.blobUpload.count({ where: { id: started.uploadId } })).toBe(0);
    // Finishing short is refused too.
    const short = blobUploadStartResponseSchema.parse((await start(task, bytes)).body);
    await put(task, short.uploadId, 0, bytes.subarray(0, 10));
    expect((await finish(task, short.uploadId)).status).toBe(409);
  });

  it("refuses a stale epoch with 409 and the current one, on every endpoint", async () => {
    const bytes = randomBytes(2000, "stale");
    const stale = await start(task, bytes, 2);
    expect(stale.status).toBe(409);
    expect(runnerHttpErrorSchema.parse(stale.body).error).toMatchObject({ code: "stale-lease", currentEpoch: 1 });
    const started = blobUploadStartResponseSchema.parse((await start(task, bytes)).body);
    expect((await put(task, started.uploadId, 0, bytes, 2)).status).toBe(409);
    expect((await put(task, started.uploadId, 0, bytes)).status).toBe(200);
    expect((await finish(task, started.uploadId, 2)).status).toBe(409);
    const ref = blobRefSchema.parse((await finish(task, started.uploadId)).body);
    expect((await download(task, ref.blobId, 2)).status).toBe(409);
    // A lease that ended refuses the same epoch too.
    await test.db.lease.updateMany({ where: { taskId: otherTask.taskId }, data: { state: "ended" } });
    expect((await start(otherTask, bytes)).status).toBe(409);
    await test.db.lease.updateMany({ where: { taskId: otherTask.taskId }, data: { state: "active" } });
  });

  it("never hands a runner another task's blob, or another organization's, or another task's upload", async () => {
    const mine = await uploadWhole(task, randomBytes(1500, "mine"));
    expect((await download(otherTask, mine.blobId)).status).toBe(404);
    // Another organization's blob, stored by the service directly.
    const theirs = await blobs.put(
      { organizationId: fixture.b.organization.id, task: null },
      { purpose: "ticket-file", contentType: "image/png", bytes: randomBytes(100, "theirs") },
    );
    if (!theirs.ok) throw new Error(theirs.message);
    expect((await download(task, theirs.value.blobId)).status).toBe(404);
    expect((await blobs.read(fixture.a.organization.id, theirs.value.blobId)).ok).toBe(false);
    expect((await blobs.read(fixture.b.organization.id, theirs.value.blobId)).ok).toBe(true);
    // Another task's open upload can't be written or finished through this task.
    const bytes = randomBytes(1000, "other's upload");
    const started = blobUploadStartResponseSchema.parse((await start(otherTask, bytes)).body);
    expect((await put(task, started.uploadId, 0, bytes)).status).toBe(404);
    expect((await finish(task, started.uploadId)).status).toBe(404);
    // Another organization's task isn't found at all.
    const foreign = taskIdSchema.parse(randomUUID());
    expect((await download({ taskId: foreign }, mine.blobId)).status).toBe(404);
  });

  it("two tasks uploading the same bytes each get their own upload and blob", async () => {
    const bytes = randomBytes(1200, "same bytes");
    const a = blobUploadStartResponseSchema.parse((await start(task, bytes)).body);
    const b = blobUploadStartResponseSchema.parse((await start(otherTask, bytes)).body);
    expect(a.uploadId).not.toBe(b.uploadId);
  });

  it("refuses a blob over the cap, and the task and its lease go on", async () => {
    const big = await start(task, randomBytes(16, "big"), 1, MAX_BYTES + 1);
    expect(big.status).toBe(413);
    expect(runnerHttpErrorSchema.parse(big.body).error.message).toContain("OSTRA_BLOB_MAX_MIB");
    const after = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    expect(after.state).toBe("running");
    // The next upload works as before.
    const ref = await uploadWhole(task, randomBytes(500, "after the cap"));
    expect(ref.size).toBe(500);
    // The service refuses a whole put over the cap with the same words.
    const put = await blobs.put({ organizationId: task.organizationId, task: { projectId: projectIdSchema.parse(task.projectId), taskId: task.taskId } }, { purpose: "ticket-file", contentType: "image/png", bytes: new Uint8Array(MAX_BYTES + 1) });
    expect(put).toMatchObject({ ok: false, error: "too-large" });
  });

  it("refuses a caller with no token, a bad one, or a revoked runner", async () => {
    const bytes = randomBytes(10, "no token");
    const anonymous = await fetch(url(runnerPaths.taskBlobs(task.taskId)), {
      method: "POST",
      body: JSON.stringify({ purpose: "session-archive", sha256: sha(bytes), size: 10, contentType: "application/gzip", leaseEpoch: 1 }),
    });
    expect(anonymous.status).toBe(401);
    const forged = await fetch(url(runnerPaths.taskBlobs(task.taskId)), { method: "POST", headers: { authorization: "Bearer ostra-runner-x.y" }, body: "{}" });
    expect(forged.status).toBe(401);
  });

  it("logs IDs, sizes and digests, never the bytes", async () => {
    const marker = `archive-content-${randomUUID()}`;
    await uploadWhole(task, new TextEncoder().encode(marker.repeat(20)));
    const logged = JSON.stringify(records);
    expect(logged).toContain("blob.uploaded");
    expect(logged).not.toContain(marker);
  });

  it("splits a big blob into chunks of at most 1 MiB, and reads it back whole", async () => {
    const service = createBlobService({ db: test.db, settings: { kind: "postgres", maxBytes: 4 * BLOB_CHUNK_BYTES }, context: { logger, clock: systemClock } });
    const bytes = randomBytes(BLOB_CHUNK_BYTES * 2 + 123, "big blob");
    const owner = { organizationId: task.organizationId, task: { projectId: projectIdSchema.parse(task.projectId), taskId: task.taskId } };
    const stored = await service.put(owner, { purpose: "ticket-file", contentType: "image/png", bytes });
    if (!stored.ok) throw new Error(stored.message);
    const chunks = await test.db.blobChunk.findMany({ where: { blobId: stored.value.blobId }, orderBy: { ordinal: "asc" } });
    expect(chunks.map((chunk) => chunk.bytes.length)).toEqual([BLOB_CHUNK_BYTES, BLOB_CHUNK_BYTES, 123]);
    const read = await service.read(task.organizationId, stored.value.blobId, task.taskId);
    if (!read.ok) throw new Error(read.message);
    expect(Buffer.from(read.value.bytes).equals(Buffer.from(bytes))).toBe(true);
    expect((await service.read(task.organizationId, stored.value.blobId, otherTask.taskId)).ok).toBe(false);
    expect(await service.delete(task.organizationId, stored.value.blobId)).toEqual({ ok: true, value: undefined });
    expect(await test.db.blobChunk.count({ where: { blobId: stored.value.blobId } })).toBe(0);
  });
});

describe("blob.gc", () => {
  const ageUpload = async (uploadId: string, ms: number): Promise<void> => {
    await test.db.$executeRaw`UPDATE "blob_upload" SET "updatedAt" = ${new Date(Date.now() - ms)} WHERE "id" = ${uploadId}`;
  };

  it("removes only the uploads left unfinished for 24 h, and keeps every blob", async () => {
    const organizationId: OrganizationId = task.organizationId;
    const staleBytes = randomBytes(800, "stale upload");
    const stale = blobUploadStartResponseSchema.parse((await start(task, staleBytes)).body);
    await put(task, stale.uploadId, 0, staleBytes.subarray(0, 400));
    const freshBytes = randomBytes(800, "fresh upload");
    const fresh = blobUploadStartResponseSchema.parse((await start(task, freshBytes)).body);
    await put(task, fresh.uploadId, 0, freshBytes.subarray(0, 400));
    const kept = await uploadWhole(task, randomBytes(900, "kept blob"));
    await ageUpload(stale.uploadId, STALE_UPLOAD_MS + 60_000);
    await ageUpload(fresh.uploadId, STALE_UPLOAD_MS - 60_000);
    const blobsBefore = await test.db.blob.count({ where: { organizationId } });

    const clock = manualClock(Date.now());
    const deleted = await collectStaleUploads({ db: test.db, clock, logger });
    expect(deleted.unfinished).toBeGreaterThanOrEqual(1);
    expect(await test.db.blobUpload.count({ where: { id: stale.uploadId } })).toBe(0);
    expect(await test.db.blobChunk.count({ where: { uploadId: stale.uploadId } })).toBe(0);
    expect(await test.db.blobUpload.count({ where: { id: fresh.uploadId } })).toBe(1);
    expect(await test.db.blob.count({ where: { organizationId } })).toBe(blobsBefore);
    expect((await download(task, kept.blobId)).status).toBe(200);
    // The stale upload's bytes started again are a new upload, from zero.
    expect(blobUploadStartResponseSchema.parse((await start(task, staleBytes)).body).receivedBytes).toBe(0);
  });
});
