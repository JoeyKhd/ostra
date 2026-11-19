import { createHash, randomUUID } from "node:crypto";

import { organizationIdSchema, uploadIdSchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import type { BlobStoreAdapter } from "../blob-store/base.ts";
import type { AdapterResult } from "../common/result.ts";
import { defineCommonCases, useSubject } from "./common-cases.ts";
import type { ContractSuiteOptions } from "./common-cases.ts";

// The blob store contract suite (ADR 0025, ADR 0043, spec section 5.2): put and get, a chunked
// upload resumed after a drop, a digest mismatch refused, the size cap, another organization's
// key answering `not-found`, and delete. The built-in store runs it on in-memory rows and on
// Postgres (ticket 12); the S3-compatible one on a fake S3 (ticket 11).

export type BlobStoreFixture = {
  /** The store's cap in bytes, as it was built: the suite tries one byte over it. */
  readonly maxBytes: number;
};

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

const must = <T>(result: AdapterResult<T>, what: string): T => {
  if (!result.ok) {
    throw new Error(`${what}: ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
};

/** The first cases only: for a store whose operations aren't built. */
export const defineBlobStoreFirstCases = <Fixture>(options: ContractSuiteOptions<BlobStoreAdapter, Fixture>): void => {
  describe(`blob store contract (first cases): ${options.name}`, () => {
    defineCommonCases(useSubject(options), "blob-store", { resumableUpload: "boolean" });
  });
};

export const defineBlobStoreContractSuite = (options: ContractSuiteOptions<BlobStoreAdapter, BlobStoreFixture>): void => {
  describe(`blob store contract: ${options.name}`, () => {
    const subject = useSubject(options);
    defineCommonCases(subject, "blob-store", { resumableUpload: "boolean" });

    // Each suite run uses its own organizations, so a shared store (a real bucket) can't collide.
    const orgA = organizationIdSchema.parse(`contract-org-a-${randomUUID()}`);
    const orgB = organizationIdSchema.parse(`contract-org-b-${randomUUID()}`);
    const scope = { organizationId: orgA, purpose: "session-archive" };

    it("puts bytes whole and gets them back, with their size and digest", async () => {
      const { adapter } = subject();
      const bytes = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
      const stored = must(await adapter.put(scope, bytes, "application/octet-stream"), "put");
      expect(stored).toMatchObject({ size: bytes.length, sha256: sha(bytes) });
      expect(stored.key.length).toBeGreaterThan(0);
      expect(await adapter.get(orgA, stored.key)).toEqual({ ok: true, value: bytes });
    });

    it("answers another organization's key not-found, for get and for delete", async () => {
      const { adapter } = subject();
      const stored = must(await adapter.put(scope, bytesOf("organization A's"), "text/plain"), "put");
      expect(await adapter.get(orgB, stored.key)).toMatchObject({ ok: false, error: { code: "not-found" } });
      expect(await adapter.delete(orgB, stored.key)).toMatchObject({ ok: false, error: { code: "not-found" } });
      expect(await adapter.get(orgA, stored.key)).toEqual({ ok: true, value: bytesOf("organization A's") });
    });

    it("deletes a blob, after which it's not-found", async () => {
      const { adapter } = subject();
      const stored = must(await adapter.put(scope, bytesOf("short-lived"), "text/plain"), "put");
      expect(await adapter.delete(orgA, stored.key)).toEqual({ ok: true, value: undefined });
      expect(await adapter.get(orgA, stored.key)).toMatchObject({ ok: false, error: { code: "not-found" } });
    });

    it("refuses a blob over the cap, whole or by upload", async () => {
      const { adapter, fixture } = subject();
      const over = fixture.maxBytes + 1;
      expect(await adapter.startUpload(scope, sha(bytesOf("x")), over)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
      // A whole put over the cap: only for a small cap, so the suite doesn't allocate 64 MiB.
      if (over <= 1024 * 1024) {
        expect(await adapter.put(scope, new Uint8Array(over), "application/octet-stream")).toMatchObject({ ok: false, error: { code: "invalid-input" } });
      }
    });

    describe("chunked uploads", () => {
      const whole = bytesOf("0123456789abcdefghijklmnopqrstuvwxyz");

      it("takes chunks in order, checks the digest and stores the blob; finishing twice answers the same", async () => {
        const { adapter } = subject();
        if (!adapter.capabilities.resumableUpload) {
          expect((await adapter.startUpload(scope, sha(whole), whole.length)).ok).toBe(false);
          return;
        }
        const started = must(await adapter.startUpload(scope, sha(whole), whole.length), "startUpload");
        expect(started.receivedBytes).toBe(0);
        expect(must(await adapter.appendUpload(started.uploadId, 0, whole.subarray(0, 16)), "append").receivedBytes).toBe(16);
        expect(must(await adapter.appendUpload(started.uploadId, 16, whole.subarray(16)), "append").receivedBytes).toBe(whole.length);
        const stored = must(await adapter.finishUpload(started.uploadId), "finishUpload");
        expect(stored).toMatchObject({ size: whole.length, sha256: sha(whole) });
        expect(await adapter.get(orgA, stored.key)).toEqual({ ok: true, value: whole });
        expect(await adapter.finishUpload(started.uploadId)).toEqual({ ok: true, value: stored });
      });

      it("resumes after a drop: starting the same upload again says where it stopped", async () => {
        const { adapter } = subject();
        if (!adapter.capabilities.resumableUpload) return;
        const first = must(await adapter.startUpload(scope, sha(whole), whole.length), "startUpload");
        must(await adapter.appendUpload(first.uploadId, 0, whole.subarray(0, 20)), "append");
        const resumed = must(await adapter.startUpload(scope, sha(whole), whole.length), "startUpload again");
        expect(resumed).toEqual({ uploadId: first.uploadId, receivedBytes: 20 });
        must(await adapter.appendUpload(resumed.uploadId, 20, whole.subarray(20)), "append the rest");
        expect(must(await adapter.finishUpload(resumed.uploadId), "finish").sha256).toBe(sha(whole));
      });

      it("refuses a gap, and a resent chunk that differs", async () => {
        const { adapter } = subject();
        if (!adapter.capabilities.resumableUpload) return;
        const { uploadId } = must(await adapter.startUpload(scope, sha(bytesOf(`gap ${randomUUID()}`)), whole.length), "startUpload");
        must(await adapter.appendUpload(uploadId, 0, whole.subarray(0, 10)), "append");
        expect(await adapter.appendUpload(uploadId, 20, whole.subarray(20))).toMatchObject({ ok: false, error: { code: "conflict" } });
        expect(await adapter.appendUpload(uploadId, 0, bytesOf("XXXXXXXXXX"))).toMatchObject({ ok: false, error: { code: "conflict" } });
      });

      it("refuses to finish short, or with bytes that don't match the digest, and stores nothing", async () => {
        const { adapter } = subject();
        if (!adapter.capabilities.resumableUpload) return;
        const expected = bytesOf(`digest ${randomUUID()}`);
        const { uploadId } = must(await adapter.startUpload(scope, sha(expected), expected.length), "startUpload");
        must(await adapter.appendUpload(uploadId, 0, expected.subarray(0, 5)), "append");
        expect(await adapter.finishUpload(uploadId)).toMatchObject({ ok: false, error: { code: "conflict" } });
        must(await adapter.appendUpload(uploadId, 5, new Uint8Array(expected.length - 5).fill(88)), "append wrong bytes");
        expect(await adapter.finishUpload(uploadId)).toMatchObject({ ok: false, error: { code: "conflict" } });
      });

      it("refuses a bad digest, and an upload that doesn't exist", async () => {
        const { adapter } = subject();
        if (!adapter.capabilities.resumableUpload) return;
        expect(await adapter.startUpload(scope, "not-a-digest", 3)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
        const missing = uploadIdSchema.parse(`missing-${randomUUID()}`);
        expect(await adapter.appendUpload(missing, 0, bytesOf("a"))).toMatchObject({ ok: false, error: { code: "not-found" } });
        expect(await adapter.finishUpload(missing)).toMatchObject({ ok: false, error: { code: "not-found" } });
      });
    });
  });
};
