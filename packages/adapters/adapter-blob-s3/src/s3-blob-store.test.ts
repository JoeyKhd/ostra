import { createHash, randomBytes } from "node:crypto";

import { defineBlobStoreContractSuite, memoryAdapterContext } from "@ostra/adapter-sdk/testing";
import { organizationIdSchema } from "@ostra/protocol";
import { afterAll, describe, expect, it } from "vitest";

import { createFakeS3 } from "./fake-s3.ts";
import type { FakeS3 } from "./fake-s3.ts";
import { S3BlobStore } from "./s3-blob-store.ts";
import type { S3BlobStoreOptions } from "./s3-blob-store.ts";

const orgA = organizationIdSchema.parse("org-a");
const orgB = organizationIdSchema.parse("org-b");
const scope = { organizationId: orgA, purpose: "session-archive" };
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

const fakes: FakeS3[] = [];
const stores: S3BlobStore[] = [];
afterAll(async () => {
  for (const store of stores) {
    store.close();
  }
  await Promise.all(fakes.map((fake) => fake.close()));
});

const start = async (
  fakeOptions: Parameters<typeof createFakeS3>[0] = {},
  storeOptions: Partial<S3BlobStoreOptions> = {},
): Promise<{ readonly fake: FakeS3; readonly store: S3BlobStore; readonly context: ReturnType<typeof memoryAdapterContext> }> => {
  const fake = await createFakeS3(fakeOptions);
  fakes.push(fake);
  const context = memoryAdapterContext();
  const store = new S3BlobStore(
    {
      endpoint: fake.endpoint,
      bucket: fake.bucket,
      region: fake.region,
      accessKeyId: fake.accessKeyId,
      secretAccessKey: fake.secretAccessKey,
      ...storeOptions,
    },
    context,
  );
  stores.push(store);
  return { fake, store, context };
};

const must = <T,>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly message: string } }): T => {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
};

// The blob store contract suite, against the fake S3 server.
defineBlobStoreContractSuite({
  name: "the S3-compatible store, against a fake S3 server",
  create: async () => {
    const { store } = await start({}, { maxBytes: 4096 });
    return { adapter: store, fixture: { maxBytes: 4096 } };
  },
});

describe("the S3-compatible blob store", () => {
  it("round-trips whole bytes under a key of the organization's, and declares its capability", async () => {
    const { store, fake } = await start();
    expect(store.capabilities).toEqual({ resumableUpload: true });
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
    const stored = must(await store.put(scope, bytes, "application/octet-stream"));
    expect(stored).toMatchObject({ size: 6, sha256: sha(bytes) });
    expect(stored.key.startsWith("blobs/org-a/")).toBe(true);
    expect(fake.objects.get(stored.key)?.body).toEqual(bytes);
    expect(await store.get(orgA, stored.key)).toEqual({ ok: true, value: bytes });
  });

  it("never lets another organization read or delete a blob, even by building its key", async () => {
    const { store, fake } = await start();
    const stored = must(await store.put(scope, bytesOf("mine"), "text/plain"));
    expect(await store.get(orgB, stored.key)).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(await store.delete(orgB, stored.key)).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(fake.objects.has(stored.key)).toBe(true);
    // Neither a key of the right shape for the wrong organization, nor a path out of the prefix.
    const id = stored.key.slice("blobs/org-a/".length);
    expect(await store.get(orgB, `blobs/org-b/${id}`)).toMatchObject({ ok: false, error: { code: "not-found" } });
    for (const key of [`blobs/org-a/../org-b/${id}`, `blobs/org-a/${id}/x`, "uploads/x/meta.json", `blobs/org-a/`, ""]) {
      expect(await store.get(orgA, key), key).toMatchObject({ ok: false, error: { code: "not-found" } });
    }
    expect(await store.delete(orgA, stored.key)).toEqual({ ok: true, value: undefined });
    expect(fake.objects.has(stored.key)).toBe(false);
    expect(await store.delete(orgA, stored.key)).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("keeps an organization whose ID has a slash in its own prefix", async () => {
    const { store } = await start();
    const odd = organizationIdSchema.parse("acme/eu-west");
    const stored = must(await store.put({ organizationId: odd, purpose: "x" }, bytesOf("odd"), "text/plain"));
    expect(stored.key).toBe(`blobs/acme%2Feu-west/${stored.key.split("/")[2] ?? ""}`);
    expect(await store.get(odd, stored.key)).toEqual({ ok: true, value: bytesOf("odd") });
    expect(await store.get(organizationIdSchema.parse("acme"), stored.key)).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("refuses a blob over the cap, whole or by upload", async () => {
    const { store, fake } = await start({}, { maxBytes: 8 });
    expect(await store.put(scope, new Uint8Array(9), "x/y")).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(await store.startUpload(scope, sha(new Uint8Array(9)), 9)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(fake.objects.size).toBe(0);
  });

  describe("health", () => {
    it("is ok for a bucket that exists, and down, with ostra's own words, for one that doesn't", async () => {
      const { store, fake } = await start();
      expect(await store.health()).toEqual({ status: "ok" });
      const missing = new S3BlobStore({ endpoint: fake.endpoint, bucket: "no-such-bucket", accessKeyId: fake.accessKeyId, secretAccessKey: fake.secretAccessKey });
      stores.push(missing);
      expect(await missing.health()).toMatchObject({ status: "down" });
    });

    it("is down for a refused key, and says so without echoing the key or the secret", async () => {
      const { fake } = await start();
      const wrong = new S3BlobStore({ endpoint: fake.endpoint, bucket: fake.bucket, accessKeyId: fake.accessKeyId, secretAccessKey: "the-wrong-secret-0123456789" });
      stores.push(wrong);
      const health = await wrong.health();
      expect(health).toMatchObject({ status: "down" });
      expect(JSON.stringify(health)).not.toContain("the-wrong-secret");
      const unknown = new S3BlobStore({ endpoint: fake.endpoint, bucket: fake.bucket, accessKeyId: "AKIANOTAKEY", secretAccessKey: fake.secretAccessKey });
      stores.push(unknown);
      expect(await unknown.put(scope, bytesOf("x"), "x/y")).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    });

    it("is down when the store cannot be reached", async () => {
      const dead = new S3BlobStore({ endpoint: "http://127.0.0.1:1", bucket: "b", accessKeyId: "a", secretAccessKey: "s", maxAttempts: 1, connectTimeoutMs: 500 });
      stores.push(dead);
      expect(await dead.health()).toMatchObject({ status: "down" });
      expect(await dead.get(orgA, "blobs/org-a/x")).toMatchObject({ ok: false, error: { code: "unavailable" } });
    });
  });

  describe("chunked uploads", () => {
    it("takes 1 MiB chunks of a blob that needs several parts, and stores it as a multipart upload with the right bytes", async () => {
      const { store, fake } = await start();
      // 11 MiB: an 8 MiB part and a 3 MiB last one, from eleven chunks, with S3's 5 MiB floor enforced by the fake.
      const whole = randomBytes(11 * 1024 * 1024);
      const started = must(await store.startUpload(scope, sha(whole), whole.length));
      for (let offset = 0; offset < whole.length; offset += 1024 * 1024) {
        const sent = must(await store.appendUpload(started.uploadId, offset, whole.subarray(offset, offset + 1024 * 1024)));
        expect(sent.receivedBytes).toBe(Math.min(offset + 1024 * 1024, whole.length));
      }
      const stored = must(await store.finishUpload(started.uploadId));
      expect(stored).toMatchObject({ size: whole.length, sha256: sha(whole) });
      expect(Buffer.from(fake.objects.get(stored.key)?.body ?? new Uint8Array()).equals(whole)).toBe(true);
      // It went up as parts, and nothing of the upload stays: no multipart in flight, no chunk.
      expect(fake.requests.filter((request) => request.method === "PUT" && request.query["partNumber"] !== undefined)).toHaveLength(2);
      expect(fake.multipart.size).toBe(0);
      expect([...fake.objects.keys()].filter((key) => key.includes("/c/"))).toEqual([]);
      expect(must(await store.get(orgA, stored.key)).length).toBe(whole.length);
    }, 60_000);

    it("keeps a small blob as one object, and answers a second finish with the same blob", async () => {
      const { store, fake } = await start();
      const whole = bytesOf("0123456789abcdefghijklmnopqrstuvwxyz");
      const started = must(await store.startUpload(scope, sha(whole), whole.length));
      must(await store.appendUpload(started.uploadId, 0, whole));
      const stored = must(await store.finishUpload(started.uploadId));
      expect(fake.requests.some((request) => request.query["uploads"] !== undefined)).toBe(false);
      expect(await store.finishUpload(started.uploadId)).toEqual({ ok: true, value: stored });
      expect(fake.objects.size).toBe(2);
    });

    it("resumes after a drop in another process: a new store on the same bucket finds the open upload and says where it stopped", async () => {
      const { store, fake } = await start();
      const whole = randomBytes(50_000);
      const first = must(await store.startUpload(scope, sha(whole), whole.length));
      must(await store.appendUpload(first.uploadId, 0, whole.subarray(0, 20_000)));
      // Another replica: no memory of the first, only the bucket.
      const other = new S3BlobStore({ endpoint: fake.endpoint, bucket: fake.bucket, accessKeyId: fake.accessKeyId, secretAccessKey: fake.secretAccessKey });
      stores.push(other);
      const resumed = must(await other.startUpload(scope, sha(whole), whole.length));
      expect(resumed).toEqual({ uploadId: first.uploadId, receivedBytes: 20_000 });
      must(await other.appendUpload(resumed.uploadId, 20_000, whole.subarray(20_000)));
      // The first replica finishes what the second continued.
      expect(must(await store.finishUpload(first.uploadId)).sha256).toBe(sha(whole));
    });

    it("stores a chunk sent twice once, takes a resend that starts earlier, and refuses one that differs", async () => {
      const { store, fake } = await start();
      const whole = randomBytes(30_000);
      const started = must(await store.startUpload(scope, sha(whole), whole.length));
      must(await store.appendUpload(started.uploadId, 0, whole.subarray(0, 10_000)));
      const chunkObjects = () => [...fake.objects.keys()].filter((key) => key.includes("/c/"));
      expect(must(await store.appendUpload(started.uploadId, 0, whole.subarray(0, 10_000))).receivedBytes).toBe(10_000);
      expect(chunkObjects()).toHaveLength(1);
      // A resend that overlaps what is held and goes on: only the new bytes are stored.
      expect(must(await store.appendUpload(started.uploadId, 5_000, whole.subarray(5_000, 20_000))).receivedBytes).toBe(20_000);
      expect(chunkObjects()).toHaveLength(2);
      expect(await store.appendUpload(started.uploadId, 8_000, randomBytes(4_000))).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await store.appendUpload(started.uploadId, 25_000, whole.subarray(25_000))).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await store.appendUpload(started.uploadId, 20_000, new Uint8Array(20_000))).toMatchObject({ ok: false, error: { code: "invalid-input" } });
      must(await store.appendUpload(started.uploadId, 20_000, whole.subarray(20_000)));
      expect(must(await store.finishUpload(started.uploadId)).sha256).toBe(sha(whole));
    });

    it("drops an upload whose bytes don't match the digest, with nothing of it left, and a retry starts clean", async () => {
      const { store, fake } = await start();
      const claimed = bytesOf("the bytes the digest is for");
      const started = must(await store.startUpload(scope, sha(claimed), claimed.length));
      must(await store.appendUpload(started.uploadId, 0, new Uint8Array(claimed.length).fill(88)));
      expect(await store.finishUpload(started.uploadId)).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(fake.objects.size).toBe(0);
      const again = must(await store.startUpload(scope, sha(claimed), claimed.length));
      expect(again.uploadId).not.toBe(started.uploadId);
      expect(again.receivedBytes).toBe(0);
      expect(await store.appendUpload(started.uploadId, 0, claimed)).toMatchObject({ ok: false, error: { code: "not-found" } });
    });

    it("aborts a multipart upload whose digest fails, so no part is left behind", async () => {
      const { store, fake } = await start();
      const claimed = randomBytes(9 * 1024 * 1024);
      const started = must(await store.startUpload(scope, sha(claimed), claimed.length));
      const wrong = randomBytes(claimed.length);
      for (let offset = 0; offset < wrong.length; offset += 1024 * 1024) {
        must(await store.appendUpload(started.uploadId, offset, wrong.subarray(offset, offset + 1024 * 1024)));
      }
      expect(await store.finishUpload(started.uploadId)).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(fake.multipart.size).toBe(0);
      expect(fake.objects.size).toBe(0);
    }, 60_000);

    it("starts a new upload for the same bytes once the first finished, as the built-in store does", async () => {
      const { store } = await start();
      const whole = bytesOf("same bytes twice");
      const first = must(await store.startUpload(scope, sha(whole), whole.length));
      must(await store.appendUpload(first.uploadId, 0, whole));
      const stored = must(await store.finishUpload(first.uploadId));
      const second = must(await store.startUpload(scope, sha(whole), whole.length));
      expect(second.uploadId).not.toBe(first.uploadId);
      expect(second.receivedBytes).toBe(0);
      must(await store.appendUpload(second.uploadId, 0, whole));
      expect(must(await store.finishUpload(second.uploadId)).key).not.toBe(stored.key);
    });

    it("abortUpload removes the chunks, the record and the pointer, and doing it twice is fine", async () => {
      const { store, fake } = await start();
      const whole = randomBytes(5_000);
      const started = must(await store.startUpload(scope, sha(whole), whole.length));
      must(await store.appendUpload(started.uploadId, 0, whole.subarray(0, 2_000)));
      expect(fake.objects.size).toBe(3);
      expect(await store.abortUpload(started.uploadId)).toEqual({ ok: true, value: undefined });
      expect(fake.objects.size).toBe(0);
      expect(await store.abortUpload(started.uploadId)).toEqual({ ok: true, value: undefined });
      expect(await store.appendUpload(started.uploadId, 0, whole)).toMatchObject({ ok: false, error: { code: "not-found" } });
    });

    it("lists more than one page of chunks when an upload has many", async () => {
      const { store } = await start({ listPageSize: 3 });
      const whole = randomBytes(10 * 1000);
      const started = must(await store.startUpload(scope, sha(whole), whole.length));
      for (let offset = 0; offset < whole.length; offset += 1000) {
        must(await store.appendUpload(started.uploadId, offset, whole.subarray(offset, offset + 1000)));
      }
      expect(must(await store.startUpload(scope, sha(whole), whole.length))).toEqual({ uploadId: started.uploadId, receivedBytes: 10_000 });
      expect(must(await store.finishUpload(started.uploadId)).sha256).toBe(sha(whole));
    });
  });

  describe("a flaky network", () => {
    it("retries a part whose connection drops mid-body, and the blob comes out right", async () => {
      const { store, fake } = await start({}, { partBytes: 5 * 1024 * 1024 });
      const whole = randomBytes(6 * 1024 * 1024);
      const started = must(await store.startUpload(scope, sha(whole), whole.length));
      for (let offset = 0; offset < whole.length; offset += 1024 * 1024) {
        must(await store.appendUpload(started.uploadId, offset, whole.subarray(offset, offset + 1024 * 1024)));
      }
      // The first part upload loses its connection after a few bytes.
      fake.faults.push({ match: (request) => request.method === "PUT" && request.query["partNumber"] === "1", action: { kind: "drop" } });
      const stored = must(await store.finishUpload(started.uploadId));
      expect(Buffer.from(fake.objects.get(stored.key)?.body ?? new Uint8Array()).equals(whole)).toBe(true);
      expect(fake.requests.filter((request) => request.method === "PUT" && request.query["partNumber"] === "1").length).toBeGreaterThanOrEqual(2);
    }, 60_000);

    it("retries a 503 SlowDown, and gives up with rate-limited when it never clears", async () => {
      const { store, fake } = await start();
      const stored = must(await store.put(scope, bytesOf("kept"), "text/plain"));
      fake.faults.push({ match: (request) => request.method === "GET" && request.key === stored.key, action: { kind: "status", status: 503, code: "SlowDown" } });
      expect(await store.get(orgA, stored.key)).toEqual({ ok: true, value: bytesOf("kept") });
      fake.faults.push({ match: (request) => request.method === "GET" && request.key === stored.key, action: { kind: "status", status: 503, code: "SlowDown" }, times: 20 });
      expect(await store.get(orgA, stored.key)).toMatchObject({ ok: false, error: { code: "rate-limited" } });
      fake.faults.length = 0;
    }, 60_000);

    it("answers unavailable for a 500 that does not clear, and forbidden for AccessDenied", async () => {
      const { store, fake } = await start({}, { maxAttempts: 2 });
      fake.faults.push({ match: (request) => request.method === "PUT", action: { kind: "status", status: 500, code: "InternalError" }, times: 5 });
      expect(await store.put(scope, bytesOf("x"), "x/y")).toMatchObject({ ok: false, error: { code: "unavailable" } });
      fake.faults.length = 0;
      fake.faults.push({ match: (request) => request.method === "PUT", action: { kind: "status", status: 403, code: "AccessDenied" } });
      expect(await store.put(scope, bytesOf("x"), "x/y")).toMatchObject({ ok: false, error: { code: "forbidden" } });
    });
  });

  describe("what never reaches a log or an error", () => {
    it("holds no bytes, no secret and no key ID in a log line or an error", async () => {
      const { store, fake, context } = await start();
      const secretBytes = bytesOf("SESSION-CONTENT-THAT-MUST-NOT-BE-LOGGED");
      const stored = must(await store.put(scope, secretBytes, "text/plain"));
      const started = must(await store.startUpload(scope, sha(secretBytes), secretBytes.length));
      must(await store.appendUpload(started.uploadId, 0, secretBytes));
      must(await store.finishUpload(started.uploadId));
      fake.faults.push({ match: () => true, action: { kind: "status", status: 403, code: "AccessDenied" } });
      const failed = await store.get(orgA, stored.key);
      fake.faults.length = 0;
      const everything = JSON.stringify([context.logger.records, failed]);
      expect(everything).not.toContain("SESSION-CONTENT");
      expect(everything).not.toContain(fake.secretAccessKey);
      expect(everything).not.toContain(fake.accessKeyId);
    });
  });
});
