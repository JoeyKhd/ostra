# Postgres only, with the background queue inside it

**Status:** accepted (plan signed off 2026-11-17). Chosen on 2026-11-17 in grilling round 3. Amended 2026-11-18: the queue is pg-boss, and files go through the blob store, which keeps them in Postgres by default (Q24, Q76).

Postgres is the only store a fresh install needs, and `docker compose` includes it.

- **The queue.** The durable queue for background work (ADR 0011) is pg-boss, and its tables live in the same Postgres (ADR 0037). A job is enqueued inside the transaction of the change that caused it, so the two are saved together or not at all.
- **Files.** Files go through a blob store adapter (`BlobStoreAdapter`, ADR 0025, ADR 0043). The built-in adapter keeps blobs in Postgres, in chunks, with a size cap per blob (64 MiB *(working value)*). An adapter for any S3-compatible store is optional, and recommended above a few hundred tasks a day (F-114).

## Considered options

- **SQLite as well, for small installs.** Rejected: it doubles the testing, and the queue and several organizations per install (ADR 0026) both need Postgres. *Changed 2026-11-19: this also named the hosted version, and none is planned (ADR 0001).*
- **A required object store for files.** Rejected: a fresh install must work with only the required settings. The S3-compatible adapter stays optional.

## Consequences

- The queue library is pg-boss (Q24). Every import of it sits in one package, `packages/jobs`. DBOS Transact is the fallback if spike 8 shows pg-boss can't cover the work.
- With the default blob store, one backup covers everything an install holds. With an S3-compatible store, its bucket is backed up separately.
