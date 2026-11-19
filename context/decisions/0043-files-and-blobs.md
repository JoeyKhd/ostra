# Files go through a blob store adapter, kept in Postgres by default

**Status:** accepted (2026-11-18, from the delegated answers in `context/history/answers-2026-11-18.md`). Settles Q76. Ledger: F-114. Extends ADR 0017 and ADR 0025.

ostra stores files: a session's archive, the images a member attaches to a refine draft, and later the screenshots of a running app (F-121). They go through a **`BlobStoreAdapter`**, the eighth adapter kind (ADR 0025).

- **The built-in adapter keeps blobs in Postgres.** They sit in their own table, in chunks, with a size cap per blob of 64 MiB *(working value)*. A fresh install needs nothing else, and one backup still covers everything (ADR 0017).
- **An adapter for any S3-compatible store is optional.** It's recommended above a few hundred tasks a day. It needs an S3 client library, such as `@aws-sdk/client-s3`, which is a new dependency and is confirmed with the maintainer before it's added.
- **Runners upload through the server.** A runner and a box's sidecar still need only one address. They use the bulk path of the runner protocol: plain HTTPS, chunked, resumable, with a digest, never on the session socket (`research/runner-transport.md` §1, ADR 0034).
- **Copies for people go where they work.** A tracker adapter that can take attachments gets a copy, and it declares that as a capability. On GitHub, ostra links to the file. It doesn't upload it. As far as the answers know, GitHub has no API for putting an image in a PR comment. That stays to verify.

## The adapter

`BlobStoreAdapter` follows the rules of ADR 0025.

- **Operations:** write a blob in chunks with its digest, read it back as a stream, check that it exists, delete it. The spec names them exactly.
- **Capabilities:** a declared size limit. Optional abilities are declared, never assumed.
- **Shared plumbing, written once:** retries with backoff, idempotency keys (a chunk sent twice is stored once), Zod validation at the boundary, and logs that carry blob IDs and never content.
- **A contract suite.** Both adapters pass it. The S3-compatible adapter is tested against a fake S3-compatible server.
- **A blob has its own branded ID and records which store holds it.** An admin can change the default store, and old blobs stay readable where they are.

## Why not Postgres alone

A session archive is uploaded after every turn, because a fresh box is the normal case once boxes stop after 15 idle minutes (Q42, Q53, ADR 0039). At 1,000 tasks at once (Q18), the answers' arithmetic was several megabytes per task every few minutes. Spike 2 measured less: a 200-turn archive is 175,891 bytes gzipped (1,088,403 raw) and a 1,000-turn one 875,644 gzipped, but every turn uploads the whole archive again, so the traffic still adds up at 1,000 tasks, and writing it into the database that also carries the event log is too much. `research/runner-transport.md` already plans a bulk path off the session, and `research/elastic-sandboxes.md` notes that ostra had no blob store.

Spike 2 recorded the real size of an archive, above. Archives are small and gzipped before upload, against a cap of 64 MiB, so Postgres alone is enough for far longer than the answers assumed.

## Considered options

- **An S3-compatible store as a requirement.** Rejected: a fresh install must work with only the required settings, and it would add a service to the default compose file. It stays an option.
- **Postgres only, with no adapter.** Rejected: it works at small scale and then needs a rewrite. The adapter makes the move a setting.
- **A volume on the server's disk.** Rejected: every server process is stateless and any replica can serve any request (Q18, ADR 0016). A local disk breaks that.
- **Runners upload straight to the S3 store with signed URLs.** Rejected: runners would need a second address and a second path through proxies. Q76 keeps one address.
- **A hosted blob service.** Rejected: it would be a vendor the maintainer hasn't chosen (AGENTS.md), and a self-hoster couldn't run it.
- **Uploading images to GitHub PR comments.** Not possible as far as we know. ostra links instead.

## Consequences

- **A blob over the cap is refused.** For a session archive that means the next reopen uses the rebuild template (ADR 0039) and doesn't fail, so a size limit never strands a task.
- **Blobs belong to an organization and a project, like every row** (ADR 0026). Blobs follow the retention of the record that owns them (F-079).
- **Blobs are untrusted data.** A member's upload or an agent's file is never served as a page. The panel serves it as a download with a fixed content type.
- **With the S3 adapter, the admin backs up the bucket as well.** The configuration reference says so. Each new setting ships with a working default, which is Postgres, and its line in the reference (AGENTS.md).
- **A personal runner and a pool runner upload the same way,** so runner parity holds.
