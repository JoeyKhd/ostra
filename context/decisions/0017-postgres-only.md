# Postgres only, with the background queue inside it

**Status:** accepted (plan signed off 2026-11-17). Chosen on 2026-11-17 in grilling round 3.

Postgres is the only database, and `docker compose` includes it. The durable queue for background work (ADR 0011) lives in Postgres too, so a job and the change that caused it are saved in the same transaction.

## Considered options

- **SQLite as well, for small installs.** Rejected: it doubles the testing, and the queue, several teams per install (ADR 0010) and the hosted version all need Postgres.

## Consequences

- The Postgres-backed queue library gets chosen during architecture, and AGENTS.md's rule to ask before adding a dependency applies.
- One backup covers everything an install holds.
