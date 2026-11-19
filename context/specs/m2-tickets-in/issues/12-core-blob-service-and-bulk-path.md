# 12: Core: the blob service and the runner's bulk path

Status: done
Builder: core
Blocked by: 02, 05
Features: F-114, F-096, F-064
Packages: `apps/core` (`src/blobs/`), `packages/adapters/adapter-blob-postgres` (unchanged; core backs its `BlobRows`)
Spec: `../spec.md`, sections 4 ("After every turn") and 5.1 (the bulk path)

## What to build

- **The Postgres `BlobRows`:** core's implementation of the built-in store's port on the `Blob`, `BlobChunk` and `BlobUpload` tables, in chunks of at most 1 MiB, inside transactions. The adapter package keeps no import of `packages/db`.
- **The blob service:** one place that picks the store (`OSTRA_BLOB_STORE`, `postgres` by default), writes a `Blob` row with its organization, project, task and store, refuses a blob over `OSTRA_BLOB_MAX_MIB` (64 by default) with a clear error, and reads a blob only for its own organization.
- **The four runner endpoints** of spec section 5.1, on core's HTTP server beside the gateway: each checks the runner's access token, that the task is leased to that runner at that epoch (409 otherwise), and that a download names a blob of that task. Uploads are resumable: a start with the same digest answers the bytes already held. A finish checks the SHA-256 and refuses a mismatch.
- **`blob.gc`:** a daily job that deletes uploads unfinished after 24 h *(working value)*.
- Logs carry blob IDs, sizes and digests, never bytes.

## Done when

- [x] The blob contract suite (ticket 04) passes against the built-in store on Postgres.
- [x] Tests: an upload dropped mid-chunk resumes; a stale epoch is refused; a runner can't download another task's blob or another organization's; a blob over the cap is refused and the session goes on; `blob.gc` removes only stale uploads.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add the blob service and bulk path`.

## Comments

- 2026-11-19, core (m2-core-a): built in `apps/core/src/blobs/`. `postgres-blob-rows.ts` backs the built-in store's `BlobRows` on `Blob`, `BlobUpload` and `BlobChunk` (chunks of at most 1 MiB, one transaction per write; a finished upload's chunks move to its blob rather than being written twice). The rows can be bound to a task, so a resume finds only that task's open upload. `blob-service.ts` is the one place that stores and reads blobs (`RunningCore.blobs`, for tickets 17, 18, 22 and 26): it picks the store, sets the row's project, task, store and content type, refuses over `OSTRA_BLOB_MAX_MIB` with `too-large` (413 on the bulk path, the task untouched), and reads only for the blob's organization and, when asked, its task. `endpoints.ts` serves the four routes of spec 5.1 for a runner's access token or a box's task token, each checking the lease at that epoch (409 `stale-lease` with the current epoch). `gc.ts` is `blob.gc`, daily at 03:17 UTC: unfinished uploads older than 24 h go with their chunks, and finished upload records too (their blobs stay). For the builders: `OSTRA_BLOB_STORE=s3` makes `createBlobService` throw until ticket 11's adapter is passed as `s3`; an S3 adapter that keeps no `BlobUpload` row needs the service's ownership check adjusted then. Known cost: the port hands the whole upload on every chunk, so a 64 MiB archive reads its chunks back once per chunk; fine for M2's archives, worth an additive `appendChunk` on `BlobRows` later. The suite runs in `blobs.test.ts` (24 cases: the contract suite on Postgres, a drop mid-chunk resumed, stale epochs, another task's and another organization's blobs and uploads, the cap, `blob.gc`, logs without bytes).
