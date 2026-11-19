# 12: Core: the blob service and the runner's bulk path

Status: ready-for-agent
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

- [ ] The blob contract suite (ticket 04) passes against the built-in store on Postgres.
- [ ] Tests: an upload dropped mid-chunk resumes; a stale epoch is refused; a runner can't download another task's blob or another organization's; a blob over the cap is refused and the session goes on; `blob.gc` removes only stale uploads.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add the blob service and bulk path`.

## Comments
