# 11: The S3-compatible blob store adapter

Status: ready-for-agent
Builder: adapters
Blocked by: 04, 40 (the maintainer's yes to an S3 client library, Q127)
Features: F-114
Packages: `packages/adapters/adapter-blob-s3` (new, Apache-2.0), `apps/core` (the setting's wiring), `docs/configuration.md`
Spec: `../spec.md`, sections 5.4 (settings) and 10 (dependencies)

## What to build

- **The adapter,** extending `BlobStoreAdapter` one level deep: whole puts, chunked uploads as S3 multipart uploads (resumable: a start with the same digest finds the open upload), reads as a stream, delete, `health()` as a head-bucket. The capability `resumableUpload: true` and its size limit declared.
- **The library** is the one the maintainer approves (`@aws-sdk/client-s3` is the candidate), pinned exactly, its license checked. Nothing is added before the yes.
- **The settings** `OSTRA_BLOB_STORE=s3`, `OSTRA_S3_ENDPOINT`, `OSTRA_S3_BUCKET`, `OSTRA_S3_REGION`, `OSTRA_S3_ACCESS_KEY_ID` and `OSTRA_S3_SECRET_ACCESS_KEY`, read only when the store is `s3`, each with its line in `docs/configuration.md`, which also says to back up the bucket.
- **Old blobs stay readable:** each `Blob` row names its store, and core reads a blob from the store that holds it, whatever the default is now (ADR 0043).
- **The fake S3-compatible server,** in-process in the package's tests: put, get, multipart, delete, and a dropped connection mid-part.

## Done when

- [ ] The blob store contract suite passes against the fake S3 server.
- [ ] Core switches stores by the setting; a blob written to Postgres before the switch is still read after it.
- [ ] `pnpm check:licenses` passes.
- [ ] Committed as `✨ add the S3-compatible blob store`.

## Comments
