# The event log and the live streams

**Status:** accepted (2026-11-18, from the delegated answers in `context/history/answers-2026-11-18.md`). Settles Q23 and carries the outcome of `research/live-sync.md`, including the answers' decisions to run no Zero spike and to bundle no TLS. Covers F-023, F-062, F-067 and F-108. It adds one sentence to ADR 0011's first guarantee.

The panel moves two kinds of data, and each half has its own design. Both read only rows that Postgres has committed.

## The event log

The log is append-only and per task. It's the history of every session, and the live view of a running one (F-023).

- **Storage.** An event table keyed by `(task_id, seq)`, with a payload validated by the shared Zod union of agent events (ADR 0018). The server numbers events per task when it saves them, under a lock on the task's counter row in the saving transaction. Writers to one task serialize, numbers commit in order, and a reader never sees a gap. The runner's own per-session number makes saving idempotent (ADR 0034). The two numbers have different jobs: the runner's makes a resend safe, and the server's is the cursor that browsers resume from.
- **Saved before acted on.** Every completed message, tool call, approval and answer, and everything else ostra acts on, is saved first (ADR 0011).
- **Partial text is shown, never saved, and nothing acts on it.** The runner sends partial text at most every 250 ms *(working value)*. The server keeps only the latest accumulated text of each open segment, in one `UNLOGGED` table with a row per segment. A viewer who joins late reads the current partial from that row. The row is deleted when the segment's completed message commits. A partial lost in a runner crash is display only, and the completed message is what counts (ADR 0011, guarantee 5).
- **History.** A paged tRPC query by turn, reading backwards. The live tail starts from the newest `seq` the page returned.
- **Retention.** The table is partitioned by time if retention needs it (F-079).

## Fan-out

- After a commit, the writing replica wakes its own subscribers and sends one `NOTIFY` per writer per batch window. The payload is small: task IDs and their highest `seq`. It's a wake-up and never carries content. It's never sent per event, because a commit that sends one takes a global lock.
- Each replica runs one tailer. On a wake-up, or on a poll about every 250 ms when none arrives *(working value)*, one query reads `seq > cursor` for the tasks the replica has watchers on. Query count scales with notifications, not with watchers.
- Replicas are stateless. Any replica serves any task, and the load balancer needs no sticky sessions. Each replica holds a dedicated, direct `LISTEN` connection (ADR 0034).

## To the browser

- **A tRPC v11 subscription over SSE, one stream per tab.** It multiplexes change notices and, on a task page, that task's events and live-text frames. The whole stream is ostra's own. The task page's use of it is ADR 0036.
- **Resume by sequence number.** Committed events are yielded with `tracked(seq)`, so a dropped stream reconnects with `Last-Event-ID` and reads `seq > lastEventId` from the table. The generator subscribes before it catches up, so nothing slips through.
- **Live frames are untracked.** A viewer gets a snapshot of the current partial first, then deltas by offset, and drops a frame whose segment already has its completed message.
- The endpoint's shape follows the Durable Streams protocol (offsets, and a live tail by long poll or SSE). ostra implements it in its own code, on its own table.

## State

- **No sync engine in v1.** A domain write and its change notice (organization, project, entity, ID) commit in one Prisma transaction. The same tailer delivers notices to the stream. Each notice invalidates or patches the TanStack Query caches it touches, and a reconnect refetches the live views. State is a snapshot that can always be fetched again, so a missed notice costs a refetch, never a wrong screen.
- **Optimistic writes** (approve, answer, stop) use TanStack Query's `onMutate` and roll back on error. The change notice confirms the write.
- **The fleet view** gets a notice only when slots, queue, versions or online state change, never on a heartbeat (F-067).
- **Insights aren't live.** A scheduled job computes them from ostra's own tables every few minutes (Q6, F-108, ADR 0037).

## Authorization

- When a stream opens, the tRPC context resolves the better-auth session, the member and the organization. Every message is filtered again by organization and by project access before it's yielded. A restricted project's records go only to its members and the organization's admins.
- An open SSE response outlives a revoked session, so a stream re-checks membership on a timer, or closes when a membership-change notice arrives.
- Logs carry IDs only.

## Connections and TLS

Browsers allow six HTTP/1.1 connections per origin across all tabs, and use HTTP/2 only over TLS. One multiplexed stream per tab stays inside that limit on plain HTTP, so the default compose file bundles no TLS. A compose profile adds a TLS proxy for installs with a hostname. The panel doesn't work offline.

## Considered options

- **Saving token deltas in merged windows,** as `research/live-sync.md` first proposed and ADR 0011 first read. Rejected: no control acts on partial text, and saving it would multiply the write load roughly tenfold at 1,000 tasks (an estimate from the rates in that file).
- **A `NOTIFY` per event.** Rejected: it serializes commits. DBOS measured a ceiling of about 2.9K writes a second that way, and about 60K with batched notifications.
- **Zero for state.** The strongest sync engine for this stack, and not adopted. It adds a `zero-cache` container, `wal_level=logical` and a replication slot, an S3 bucket on several nodes, no server-side rendering, and a second query language beside tRPC, for a gain nobody has asked for. There is no Zero spike (revisit if hand-written cache updates get unwieldy).
- **ElectricSQL.** Rejected: its team moved to Neon at Databricks on 2026-08-11, its successor runs only on Neon, and its releases stopped in September 2026.
- **PowerSync.** Rejected: offline-first, with SQLite in every tab and a second storage database. Its documented replication of 2,000 to 4,000 operations a second is below the log's peak.
- **Supabase Realtime.** Rejected: it expects Supabase's Postgres roles, promises no delivery, and its replay is alpha.
- **LiveStore and Replicache.** Rejected: LiveStore makes the client's event log the source of truth, and Replicache is in maintenance mode.
- **Neon Realtime.** Excluded: hosted and Neon only.
- **Centrifugo.** The fallback for the fan-out tier, if spike 7 shows the tailer or Node's SSE connections can't hold the target. It replaces only the tailer-to-browser step. It adds a Go container, and its Postgres-only mode is experimental.
- **WebSockets from Next.js.** Not possible: route handlers can't upgrade a connection. SSE is also what tRPC recommends.

## Consequences

- The browser sees only committed rows, plus partial text that is marked ephemeral and replaced by its completed message. ADR 0011's first guarantee gets one sentence saying so.
- Scale floor: 1,000 tasks at once on three core replicas and one Postgres (Q18, F-117). Not saving deltas keeps event writes to a few thousand rows a second. Postgres is the ceiling, then partitioning, and one database per group of organizations is the later step for the hosted version.
- Spike 7 (`live-stream-and-task-view`) gates it:
  - 5,000 events a second sustained and a burst of 10,000, at p99 under 500 ms from runner to browser, with Postgres under 50% of 4 vCPU.
  - A reload shows the partial text again within 1 s, and a 10 s network drop leaves no gap and no duplicate.
  - It also checks that the stream keeps `lastEventId` across untracked frames.
- Fallbacks: if the `UNLOGGED` table costs too much, the partial rides in the batched notification, and still never enters the log. If fan-out fails, evaluate Centrifugo.
- Prisma doesn't declare `UNLOGGED`, so the live-text table is created in a raw SQL migration. Spike 7 verifies that under Prisma 7. Migrations add first.
- Whether Postgres 19 removes the commit lock is unverified, so the design assumes the lock exists.
- No dependency is added beyond `pg`, used directly for the listen connection (ADR 0034). TanStack DB stays optional and needs a yes first.
