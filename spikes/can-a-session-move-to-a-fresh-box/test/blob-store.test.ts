import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { downloadBlob, startBlobStore, uploadBlob, type BlobStore } from "../src/lib/blob-store.ts";
import { blobKey } from "../src/lib/ids.ts";
import { spikeTempDir } from "./temp-dir.ts";

let dir = "";
let store: BlobStore;

beforeAll(async () => {
  dir = await spikeTempDir("test-blobs-");
  store = await startBlobStore(dir);
});

afterAll(async () => {
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the blob store stand-in", () => {
  it("stores and returns a blob, byte for byte", async () => {
    const body = Buffer.from([0, 1, 2, 255, 254]);
    const put = await uploadBlob(store, blobKey("task-1/archive.gz"), body);
    expect(put.bytes).toBe(5);
    expect(await downloadBlob(store, blobKey("task-1/archive.gz"))).toEqual(body);
  });

  it("refuses a wrong token and paths outside its keys", async () => {
    await expect(uploadBlob({ baseUrl: store.baseUrl, token: "wrong" }, blobKey("task-1/x"), "x")).rejects.toThrow(/401/);
    for (const key of ["..%2F..%2Fx/y", "task-1/x/y", "task-1"]) {
      const response = await fetch(`${store.baseUrl}/blobs/${key}`, { headers: { authorization: `Bearer ${store.token}` } });
      expect(response.status).toBe(404);
    }
  });

  it("parses only `<task>/<name>` blob keys", () => {
    expect(blobKey("task-1/archive.gz")).toBe("task-1/archive.gz");
    for (const bad of ["", "task-1", "task-1/x/y", "../x", "task-1/..", "a/b c", "/x", "x/"]) expect(() => blobKey(bad)).toThrow();
  });

  it("answers 404 for a blob it doesn't have", async () => {
    await expect(downloadBlob(store, blobKey("task-1/missing"))).rejects.toThrow(/404/);
  });
});
