import { createHash, randomBytes, randomUUID } from "node:crypto";

import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { defineBlobStoreContractSuite } from "@ostra/adapter-sdk/testing";
import { organizationIdSchema } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { S3BlobStore } from "./s3-blob-store.ts";

// The blob store against a real S3-compatible server, not the fake: a local one started by hand
// (`moto_server -p 9407` from the `moto[server]` Python package, or MinIO, Garage, SeaweedFS). It
// runs only with the endpoint set, and skips otherwise:
//
//   OSTRA_S3_TEST_ENDPOINT=http://127.0.0.1:9407 \
//   OSTRA_S3_TEST_ACCESS_KEY_ID=test OSTRA_S3_TEST_SECRET_ACCESS_KEY=test pnpm vitest run s3-blob-store.live
//
// It makes its own bucket and removes it, and prints no key or secret.

const env = z
  .object({
    OSTRA_S3_TEST_ENDPOINT: z.url(),
    OSTRA_S3_TEST_ACCESS_KEY_ID: z.string().min(1),
    OSTRA_S3_TEST_SECRET_ACCESS_KEY: z.string().min(1),
    OSTRA_S3_TEST_REGION: z.string().min(1).default("us-east-1"),
  })
  .safeParse(process.env);

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

if (env.success) {
  const { OSTRA_S3_TEST_ENDPOINT: endpoint, OSTRA_S3_TEST_ACCESS_KEY_ID: accessKeyId, OSTRA_S3_TEST_SECRET_ACCESS_KEY: secretAccessKey, OSTRA_S3_TEST_REGION: region } = env.data;
  const bucket = `ostra-live-${randomUUID().slice(0, 8)}`;
  const admin = new S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
  const stores: S3BlobStore[] = [];
  const newStore = (maxBytes: number): S3BlobStore => {
    const store = new S3BlobStore({ endpoint, bucket, region, accessKeyId, secretAccessKey, maxBytes });
    stores.push(store);
    return store;
  };

  beforeAll(async () => {
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
  });
  afterAll(async () => {
    for (const store of stores) {
      store.close();
    }
    let token: string | undefined;
    do {
      const page = await admin.send(new ListObjectsV2Command({ Bucket: bucket, ...(token === undefined ? {} : { ContinuationToken: token }) }));
      for (const object of page.Contents ?? []) {
        await admin.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
      }
      token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
    await admin.send(new DeleteBucketCommand({ Bucket: bucket }));
    admin.destroy();
  });

  defineBlobStoreContractSuite({
    name: "the S3-compatible store, against a real S3-compatible server",
    create: () => Promise.resolve({ adapter: newStore(4096), fixture: { maxBytes: 4096 } }),
  });

  describe("the S3-compatible blob store, against a real S3-compatible server", () => {
    it("is healthy, and stores a multi-part blob by 1 MiB chunks that comes back byte for byte", async () => {
      const store = newStore(64 * 1024 * 1024);
      expect(await store.health()).toEqual({ status: "ok" });
      const scope = { organizationId: organizationIdSchema.parse("live-org"), purpose: "session-archive" };
      // 13 MiB: an 8 MiB part and a 5 MiB last one, over the server's own part-size rule.
      const whole = randomBytes(13 * 1024 * 1024);
      const started = await store.startUpload(scope, sha(whole), whole.length);
      if (!started.ok) throw new Error(started.error.message);
      for (let offset = 0; offset < whole.length; offset += 1024 * 1024) {
        const sent = await store.appendUpload(started.value.uploadId, offset, whole.subarray(offset, offset + 1024 * 1024));
        expect(sent).toMatchObject({ ok: true });
      }
      const stored = await store.finishUpload(started.value.uploadId);
      if (!stored.ok) throw new Error(stored.error.message);
      expect(stored.value).toMatchObject({ size: whole.length, sha256: sha(whole) });
      const back = await store.get(scope.organizationId, stored.value.key);
      expect(back.ok && Buffer.from(back.value).equals(whole)).toBe(true);
      expect(await store.delete(scope.organizationId, stored.value.key)).toEqual({ ok: true, value: undefined });
    }, 120_000);

    it("health is down for a bucket that does not exist", async () => {
      const missing = new S3BlobStore({ endpoint, bucket: `${bucket}-missing`, region, accessKeyId, secretAccessKey });
      stores.push(missing);
      expect(await missing.health()).toMatchObject({ status: "down" });
    });
  });
} else {
  describe.skip("the S3-compatible blob store, against a real S3-compatible server", () => {
    it("runs only with OSTRA_S3_TEST_ENDPOINT set", () => undefined);
  });
}
