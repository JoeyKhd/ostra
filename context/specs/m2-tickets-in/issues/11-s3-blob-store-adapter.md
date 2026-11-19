# 11: The S3-compatible blob store adapter

Status: done
Builder: adapters
Blocked by: 04
Features: F-114
Packages: `packages/adapters/adapter-blob-s3` (new, Apache-2.0), `apps/core` (the setting's wiring), `docs/configuration.md`
Spec: `../spec.md`, sections 5.4 (settings) and 10 (dependencies)

## What to build

- **The adapter,** extending `BlobStoreAdapter` one level deep: whole puts, chunked uploads as S3 multipart uploads (resumable: a start with the same digest finds the open upload), reads as a stream, delete, `health()` as a head-bucket. The capability `resumableUpload: true` and its size limit declared.
- **The library** is `@aws-sdk/client-s3` (Apache-2.0), approved by the maintainer on 2026-11-19 (ADR 0043), pinned exactly. It goes in the same commit as the updated `pnpm-lock.yaml`.
- **The settings** `OSTRA_BLOB_STORE=s3`, `OSTRA_S3_ENDPOINT`, `OSTRA_S3_BUCKET`, `OSTRA_S3_REGION`, `OSTRA_S3_ACCESS_KEY_ID` and `OSTRA_S3_SECRET_ACCESS_KEY`, read only when the store is `s3`, each with its line in `docs/configuration.md`, which also says to back up the bucket.
- **Old blobs stay readable:** each `Blob` row names its store, and core reads a blob from the store that holds it, whatever the default is now (ADR 0043).
- **The fake S3-compatible server,** in-process in the package's tests: put, get, multipart, delete, and a dropped connection mid-part.

## Done when

- [x] The blob store contract suite passes against the fake S3 server.
- [x] Core switches stores by the setting; a blob written to Postgres before the switch is still read after it.
- [x] `pnpm check:licenses` passes.
- [x] Committed as `✨ add the S3-compatible blob store`.

## Comments
- 2026-11-19, adapters: done in `19f2d5b` (`✨ add the S3-compatible blob store`), with `abortUpload` in its own small commit before it, `57f2cde`. For tickets 20 (cleanup), 38 (the failure suite) and the maintainer:
  - **One additive change to ticket 04's `BlobStoreAdapter`, named here:** `abortUpload(uploadId)`, which drops an unfinished upload and whatever the store holds for it. It defaults to a success that does nothing (the built-in store keeps its upload in rows core owns and deletes), and the S3 store overrides it. Core's `blob.gc` calls it for `s3` uploads before deleting their records; a record whose bytes the bucket could not drop is kept for the next pass.
  - **The adapter** (`packages/adapters/adapter-blob-s3`, Apache-2.0, `@aws-sdk/client-s3` 3.1165.0 pinned exactly, lockfile in the same commit, `check:licenses` green): `S3BlobStore extends BlobStoreAdapter`, `resumableUpload: true`, the cap as its `maxBytes` option (the capabilities type has no size field, so the limit is the constructor's, as the built-in store's). The client sends the SDK's newer checksums only where S3 requires them (`WHEN_REQUIRED`), because third-party stores reject them.
  - **Every replica serves any upload (ADR 0016), so nothing is kept in memory:** each chunk is its own object under `uploads/<uploadId>/c/<offset>`, because S3 refuses a multipart part under 5 MiB unless last and the runner sends 1 MiB chunks. A start with the same organization, purpose, digest and size finds the open upload through a small pointer object and says where it stopped, from any process. A finish reads the chunks back once, hashing them as they pass, and writes the blob whole when it fits one part (8 MiB) or as an S3 multipart upload when it doesn't, completing only if the digest matches (a mismatch aborts the multipart, drops the chunks and the record, and answers `conflict`, so a retry starts clean). The blob's key follows from the upload's ID, so a finish that dies and runs again writes the same object. Keys are `blobs/<url-encoded organization>/<id>`; another organization's key, a path out of the prefix and a key that isn't a blob's all answer `not-found`.
  - **Tests:** the blob contract suite passes against the fake S3 server (`createFakeS3`, exported from `@ostra/adapter-blob-s3/testing` for core's tests). The fake checks AWS Signature V4 against the key's secret, enforces the 5 MiB floor, paginates listings, and can drop the connection mid-body or fail a request with a status and code. Cases beyond the suite: an 11 MiB blob in 1 MiB chunks stored as two parts byte for byte, a part whose connection drops and is retried, a second replica resuming and a first one finishing, a resend that overlaps, a digest mismatch aborting its multipart, a pointer reused after a finish, 503 SlowDown retried and then `rate-limited`, and no byte, secret or key ID in a log or an error.
  - **Against a real S3 server, not only the fake:** `s3-blob-store.live.test.ts` runs the same suite and a 13 MiB multipart round trip when `OSTRA_S3_TEST_ENDPOINT` is set. MinIO's binaries are gone (410), so it ran on moto 5 (`moto_server`, from the `moto[server]` Python package), which enforces the part-size rule itself: 14 of 14 passed.
  - **Core:** `startCore` builds the adapter from the parsed `OSTRA_S3_*` settings when `OSTRA_BLOB_STORE=s3`, and closes it on stop. The blob service now reads and deletes through the store a `Blob` row names, whatever the default is (a blob kept in Postgres before the switch is still read from Postgres: `s3-blobs.test.ts`), keeps a `BlobUpload` row for each S3 upload (the ownership and lease checks of the bulk path read it; its receivedBytes follow the bucket's), and scopes the adapter's upload purpose by task so two tasks uploading the same bytes never share an upload. Eleven new cases cover the bulk path over HTTP on S3, the switch, another organization's and another task's blobs, and `blob.gc` against the bucket.
  - **Not covered, for the maintainer:** a blob in S3 is read only while the `OSTRA_S3_*` settings are set (they are parsed only when the store is `s3`), so switching back to Postgres leaves S3 blobs unreadable until the settings are put back; core says so in the error, and `docs/configuration.md` says to keep them. A bucket needs a lifecycle rule on `uploads/` and `upload-index/` as a backstop; `docs/configuration.md` says so, along with backing up the bucket. The configuration reference's region default now reads `us-east-1`.
