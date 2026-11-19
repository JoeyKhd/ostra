# The audit log and search

**Status:** accepted (2026-11-19, on the maintainer's delegation for milestone 4's spec). Settles Q197 and Q198. Covers F-073 and F-080, and builds on ADR 0017 (Postgres only), ADR 0026 (access), ADR 0031 (the safety minimum) and ADR 0035 (the event log, and what a tool call records for the audit).

Two ways to find out what happened: the audit log says who did what to the organization, and search finds the task where something was said or done.

## The audit log

- **Two records, one answer.** `AuditEntry` (milestone 1) is the record of people and the system acting on the organization: who, what, when, on which entity, with IDs and settings and never content. The task's event log is the record of what an agent did, with every tool call's input in full (ADR 0035, Q161). An entry about a task links to its event log, so an audit can say what the agent ran and read, and not only that a task started.
- **What is recorded** (Q197): every task start, reopen, stop, takeover and driver change; every approval answered and every plan decision; every invitation, acceptance, removal, role change and project-access change; every reset link and password change; every change to a model provider, a model's price, an agent profile, a budget, a pool, a join token, a runner, a connection, an environment, a project's repos, email settings and memory (a note's creation, edit, archive, and a proposal's decision); every organization created; and **every use of a credential.**
- **A use of a credential is one entry per issuance, not per call.** The task's credentials served to a lease (`task.credentials-issued`, milestone 1), each refresh of a repo token, an MCP server's secret given to the sidecar, and a CLI session created. A model call or a push is counted in the event log and the meter, not here: one entry per call would bury the log, and the issuance says who could do what, for which task, until when.
- **Append-only.** No code path updates or deletes an entry, and a test checks that no Prisma call on `auditEntry` other than `create` exists outside the migration. Entries are kept while the organization exists; milestone 2's retention (F-079) never deletes them.
- **Who reads it.** An organization admin reads the whole log, filtered by actor, action, project, entity and period, and exports the filtered view as CSV. A project admin reads the entries of their own project from its settings. A member reads none. A member of a project reads that project's tasks' event logs, as they read the tasks (ADR 0035).
- **The task's event log view.** The task page gains an "Event log" view: every event in order, each tool call with its kind, its full input (a command and its working folder, the paths read, searched or written, a URL fetched), whether it failed or was refused and its error, and each approval with the command it was asked about. It reads what's stored and never re-runs anything.
- **What it can't show** is said on the page: a record shows a `cat` of a path, not what a program the agent built read, and `host` has no box (ADR 0035).

## Search

Q198.

- **Postgres full-text search, as memory uses** (ADR 0017, ADR 0044). No search engine and no extension: `pg_trgm` and vector search aren't needed for v1, and an extension is one more thing a self-hosted Postgres must have.
- **A search table, written at ingest.** A `SearchEntry` row per searchable piece of a task, written in the transaction that stores it: the task's title, prompt and ticket key and title; each member message; each agent message; each tool call's title and input (the command, the paths, the URL). Not agent thoughts, not tool output and not partial text: they are large and noisy, and output can hold a file's whole content. Each entry keeps at most 8 KiB of text *(working value)*. A `tsvector` column generated from it with the `simple` configuration (code and mixed languages stem badly) and a GIN index.
- **Filters are columns,** not text: project, repo, ticket, member (the task's creator, driver or a message's author), state and period. Text matching uses `websearch_to_tsquery`, with the last word as a prefix, so "migr" finds "migration".
- **Access is in the query.** The `where` holds the organization and the projects the member can open, computed from the member's scope, so a result the member can't open is never fetched, ranked or counted.
- **Results are tasks.** Each task appears once, with its best-ranked snippets (`ts_headline`) and what matched (a message, a command, a path), linking to the place in the thread.
- **Two places:** a palette (Ctrl or ⌘ + K) on every page, with the top results and the filters as typed tokens (`repo:test2`, `status:merged`, `by:sam`), and a search page with the full list and the filters as controls.
- **Existing tasks** get their entries from a one-off backfill job, in batches, idempotent by task and sequence.

## Considered options

- **Writing every tool call to the audit log.** Rejected: the event log already holds it, behind the project's access, and two copies of agent output would double what must be protected.
- **One audit entry per model call or push.** Rejected, as above.
- **Searching the event table's JSON directly.** Rejected: a full-text index over every payload would index tool output, and a query would have to know every event's shape.
- **A search engine (Meilisearch, OpenSearch).** Rejected: a second store to run, back up and keep in step, against ADR 0017.
- **`pg_trgm` for substring search.** Rejected for v1, for the extension. Prefix matching covers what members type. Revisit if members search for fragments of identifiers.

## Consequences

- The schema gains `SearchEntry`, the audit log's indexes for its filters, and an actor's name kept on each entry for removed members (milestone 4's spec, section 5.3).
- Every writer of a task's messages and tool calls writes its search entries in the same transaction, so a result is never ahead of or behind the thread.
- The contract suite's positive control stays: a canary file outside the workspace, a scripted shell call that reads it, and the event log showing the call (ADR 0035).
- The glossary gains Audit log.
