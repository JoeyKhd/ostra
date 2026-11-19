import { createHash } from "node:crypto";

import { defineBlobStoreContractSuite, memoryAdapterContext } from "@ostra/adapter-sdk/testing";
import { organizationIdSchema, uploadIdSchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { createMemoryBlobRows } from "./blob-rows.ts";
import { PostgresBlobStore } from "./postgres-blob-store.ts";

const orgA = organizationIdSchema.parse("org-a");
const orgB = organizationIdSchema.parse("org-b");
const scope = { organizationId: orgA, purpose: "session-archive" };
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

defineBlobStoreContractSuite({
  name: "postgres blob store, in-memory rows",
  create: () => Promise.resolve({ adapter: new PostgresBlobStore({ rows: createMemoryBlobRows(), maxBytes: 4096 }), fixture: { maxBytes: 4096 } }),
});

const setup = (maxBytes?: number) => {
  const rows = createMemoryBlobRows();
  const context = memoryAdapterContext();
  const store = new PostgresBlobStore({ rows, ...(maxBytes === undefined ? {} : { maxBytes }) }, context);
  return { rows, context, store };
};

const must = <T,>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly message: string } }): T => {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
};

describe("the postgres blob store", () => {
  it("round-trips bytes whole, with their digest", async () => {
    const { store } = setup();
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
    const stored = must(await store.put(scope, bytes, "application/octet-stream"));
    expect(stored).toMatchObject({ size: 6, sha256: sha(bytes) });
    expect(stored.key.startsWith("postgres:")).toBe(true);
    expect(await store.get(orgA, stored.key)).toEqual({ ok: true, value: bytes });
  });

  it("never lets another organization read or delete a blob, and deletes for its own", async () => {
    const { store } = setup();
    const stored = must(await store.put(scope, bytesOf("mine"), "text/plain"));
    expect(await store.get(orgB, stored.key)).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(await store.delete(orgB, stored.key)).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(await store.delete(orgA, stored.key)).toEqual({ ok: true, value: undefined });
    expect(await store.get(orgA, stored.key)).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(await store.get(orgA, "other-store:123")).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("refuses a blob over the cap", async () => {
    const { store } = setup(8);
    expect(await store.put(scope, new Uint8Array(9), "x/y")).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(await store.startUpload(scope, sha(new Uint8Array(9)), 9)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
  });

  describe("resumable uploads", () => {
    const whole = bytesOf("0123456789abcdefghij");

    it("takes chunks in order, checks the digest and stores the blob", async () => {
      const { store } = setup();
      const started = must(await store.startUpload(scope, sha(whole), whole.length));
      expect(started.receivedBytes).toBe(0);
      expect(must(await store.appendUpload(started.uploadId, 0, whole.subarray(0, 8))).receivedBytes).toBe(8);
      expect(must(await store.appendUpload(started.uploadId, 8, whole.subarray(8))).receivedBytes).toBe(20);
      const stored = must(await store.finishUpload(started.uploadId));
      expect(stored).toMatchObject({ size: 20, sha256: sha(whole) });
      expect(await store.get(orgA, stored.key)).toEqual({ ok: true, value: whole });
      // Finishing again answers the same.
      expect(await store.finishUpload(started.uploadId)).toEqual({ ok: true, value: stored });
    });

    it("resumes after a drop: the same upload started again says where it stopped", async () => {
      const { store } = setup();
      const first = must(await store.startUpload(scope, sha(whole), whole.length));
      await store.appendUpload(first.uploadId, 0, whole.subarray(0, 12));
      const resumed = must(await store.startUpload(scope, sha(whole), whole.length));
      expect(resumed).toEqual({ uploadId: first.uploadId, receivedBytes: 12 });
      must(await store.appendUpload(resumed.uploadId, 12, whole.subarray(12)));
      expect(must(await store.finishUpload(resumed.uploadId)).sha256).toBe(sha(whole));
    });

    it("stores a chunk sent twice once, and refuses a gap or a different repeat", async () => {
      const { store } = setup();
      const { uploadId } = must(await store.startUpload(scope, sha(whole), whole.length));
      await store.appendUpload(uploadId, 0, whole.subarray(0, 10));
      expect(must(await store.appendUpload(uploadId, 0, whole.subarray(0, 10))).receivedBytes).toBe(10);
      // A resend that reaches past what's there adds only the new bytes.
      expect(must(await store.appendUpload(uploadId, 5, whole.subarray(5, 15))).receivedBytes).toBe(15);
      expect(await store.appendUpload(uploadId, 18, whole.subarray(18))).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await store.appendUpload(uploadId, 0, bytesOf("XXXXXXXXXX"))).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await store.appendUpload(uploadId, 15, new Uint8Array(40))).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    });

    it("refuses to finish short, or with bytes that don't match the digest, and stores nothing", async () => {
      const { store, rows } = setup();
      const { uploadId } = must(await store.startUpload(scope, sha(whole), whole.length));
      await store.appendUpload(uploadId, 0, whole.subarray(0, 5));
      expect(await store.finishUpload(uploadId)).toMatchObject({ ok: false, error: { code: "conflict" } });
      await store.appendUpload(uploadId, 5, bytesOf("XXXXXXXXXXXXXXX"));
      expect(await store.finishUpload(uploadId)).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(rows.blobs.size).toBe(0);
    });

    it("refuses a bad digest, and an upload that doesn't exist", async () => {
      const { store } = setup();
      expect(await store.startUpload(scope, "not-a-digest", 3)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
      expect(await store.appendUpload(uploadIdSchema.parse("nope"), 0, bytesOf("a"))).toMatchObject({ ok: false, error: { code: "not-found" } });
      expect(await store.finishUpload(uploadIdSchema.parse("nope"))).toMatchObject({ ok: false, error: { code: "not-found" } });
    });
  });

  it("logs IDs and sizes, never the bytes", async () => {
    const { store, context } = setup();
    const stored = must(await store.put(scope, bytesOf("the-secret-archive-contents"), "application/octet-stream"));
    await store.delete(orgA, stored.key);
    const logged = JSON.stringify(context.logger.records);
    expect(context.logger.records.length).toBeGreaterThan(0);
    expect(logged).not.toContain("secret-archive");
  });

  it("answers unavailable, not a throw, when its rows fail", async () => {
    const rows = createMemoryBlobRows();
    const store = new PostgresBlobStore({ rows: { ...rows, insertBlob: () => Promise.reject(new Error("database down")) } });
    expect(await store.put(scope, bytesOf("x"), "x/y")).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
});
