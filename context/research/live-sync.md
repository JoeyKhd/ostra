# Research: getting live data from Postgres to the browser

**Question:** How should the panel get live data out of Postgres? That covers the Home "needs you" list, task state, approvals, the runner fleet view, Insights, and each running task's stream of agent messages, tool calls and file changes (F-023). Which sync engine or streaming design fits ostra's fixed stack and its scale target?
**Checked:** 2026-11-18. Every source below was read on that date unless noted. Versions come from npm, Docker Hub and GitHub on that date ([Versions checked](#versions-checked)). Claims I could not confirm from a primary source (official docs, README, source, registry) are marked **unverified**. Secondary sources (press, vendor blogs about competitors, HN) are labelled as such.
**Informs:** F-023, F-026, F-062, F-067, F-075, F-079, F-084; round-7 Q5 (fleet view), Q6 (Insights) and Q18 (scale target); ADRs 0010, 0011, 0016 and 0017.

Recommendations are marked as such. They aren't decisions.

---

## Summary

**The two kinds of data**
- **The panel moves two different kinds of data, and no one tool serves both well.**
  - **State:** tasks, needs-you items, runners, slots and queues. It's small and changes a few times a minute per task. Every member of a team reads it, and members write it only rarely (approve, answer, stop, reopen).
  - **The agent event log:** append-only and per task. It can reach thousands of rows a second across an install, the few members watching a task read it, and it has to resume from an offset with no gaps.
- **The split design is right.** The question is only what serves each half.

**Candidates that drop out**
- **Electric is no longer a safe base.**
  - Electric joined Neon at Databricks on 2026-08-11, and Electric Cloud was wound down ([blog](https://electric.ax/blog/2026/08/11/electric-joining-databricks)).
  - The same team shipped **Neon Realtime** on 2026-10-15. It runs only on Neon. Neon calls it "the successor to Electric" and recommends that Electric users migrate ([Neon docs](https://neon.com/docs/realtime/overview)).
  - The open-source sync engine stays Apache-2.0, but its releases stopped at 1.8.1 on 2026-09-07 ([Docker Hub](https://hub.docker.com/r/electricsql/electric/tags)).
- **PowerSync** relicensed its service from FSL to Apache-2.0 on 2026-11-03 ([blog](https://powersync.com/blog/moving-the-powersync-service-to-apache)).
  - It's an offline-first design: SQLite in the browser, a separate bucket-storage database, and JWT auth.
  - Its documented replication rate is 2,000–4,000 small operations a second ([limits](https://docs.powersync.com/resources/performance-and-limits)). That's built for offline mobile apps, more than ostra needs for state, and below the event-log rate.
- **Supabase Realtime** expects Supabase's own Postgres roles. It "does not guarantee message delivery", and its replay feature is alpha, at 25 messages a request ([repo](https://github.com/supabase/realtime), [replay](https://supabase.com/features/realtime-broadcast-replay)).
- **LiveStore** (0.5, event-sourced, SQLite on the client, no built-in auth) and **Replicache** (maintenance mode, replaced by Zero) don't fit a Postgres database that Prisma owns.

**What's left**
- **Zero** is the strongest sync engine for this stack.
  - Version 1.0 shipped on 2026-03-24 and 1.12 on 2026-11-12. It's Apache-2.0.
  - It generates its schema from Prisma (`prisma-zero`) and runs server mutators through Prisma (`zeroPrisma`).
  - Reads are authorized by queries your server defines, which can receive the better-auth cookie ([docs](https://zero.rocicorp.dev/docs/auth)).
  - The costs:
    - a `zero-cache` container, plus `wal_level=logical` and a replication slot
    - an S3 bucket once it runs on several nodes
    - no server-side rendering
    - a second query language next to tRPC
- **tRPC v11 subscriptions over SSE** give typed streams with resume (`tracked()` plus `Last-Event-ID`) with no new service and no new dependency ([docs](https://trpc.io/docs/server/subscriptions)). There are two catches:
  - Browsers allow only 6 HTTP/1.1 connections per origin, and they use HTTP/2 only over TLS ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/EventSource)).
  - Next.js route handlers can't accept WebSockets ([RFC, draft](https://github.com/vercel/next.js/discussions/95514)).
- **LISTEN/NOTIFY works as a wake-up signal, never per event.**
  - A `NOTIFY` takes a global lock at commit, which serializes the transactions that send one ([Recall.ai](https://www.recall.ai/blog/postgres-listen-notify-does-not-scale)).
  - DBOS measured a ceiling of about 2,900 writes a second with one `NOTIFY` per write, and about 60,000 a second with batched notifications ([vendor benchmark](https://www.dbos.dev/blog/postgres-listen-notify-scalability)).
- **Centrifugo** (Apache-2.0, Go) is the best ready-made fan-out tier if a home-grown one doesn't hold. It has offset and epoch recovery, one connection for many channels, and a connect proxy that forwards cookies. Since v6.8 it can run on several nodes with Postgres alone, which is experimental ([docs](https://centrifugal.dev/docs/server/engines)).

**Recommendation**
- **Split the design:**
  1. **Event log:** build it ourselves. Events go into Postgres with a per-task sequence number. Every replica tails Postgres, woken by batched `NOTIFY` with polling as the fallback. The browser gets a typed tRPC v11 SSE subscription with `tracked(seq)`.
  2. **State:** v1 has no sync service. A typed subscription to per-team "change notices" invalidates TanStack Query caches, and optimistic updates go through TanStack Query.
- **Spike Zero for state** in milestone 0 or 1. Adopt it only if it clearly wins.
- **Centrifugo is the fallback** for the fan-out tier.

**Biggest risk:** the event write and fan-out path at 1,000 concurrent tasks, together with the policy for token-level deltas. Both are untested assumptions, and the first spike should measure them ([Unknowns / spike](#unknowns--spike)).

---

## Comparison

"Extra service" means another container in `docker compose`. "Types" means types that flow from Prisma or Zod without being written again by hand. Maturity is as of 2026-11-18.

| Candidate | Extra service | License | Team-scoped auth | Prisma · better-auth · App Router | Thousands of events/s | Resume and catch-up | Optimistic writes | Types end to end | Horizontal scale | Self-host weight | Maturity | Fit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Home-grown: Postgres log + batched NOTIFY + tRPC SSE** | None | ostra's own (AGPL) | In each tRPC procedure, from the better-auth session | Native to all three | Yes, if batched (to measure) | `tracked()` id + `Last-Event-ID`, read from the table | TanStack Query `onMutate` | Yes: Prisma → domain → tRPC | Stateless replicas; Postgres is the bus | Lightest | Parts are mature; the design is ours | **Event log: yes. State: yes for v1** |
| **tRPC v11 subscriptions** (transport) | None (SSE in Next.js); WS needs the core service | MIT | As above | Native | Transport only | Built in | n/a | Yes | Any replica serves any stream | None | v11.29.4, mature | The transport for both halves |
| **Zero** (Rocicorp) | `zero-cache` (1 replication-manager + N view-syncers) | Apache-2.0 | Server-defined queries get a `ctx` from forwarded cookies | `prisma-zero` schema, `zeroPrisma` mutators, Next.js route handlers; **no SSR** | Not designed for it; keep events out (**unverified** load) | Client store + server CVRs; diffs on reconnect | Yes, built in | Yes, generated from Prisma | Yes, view-syncers; S3 needed for multi-node | Medium: logical WAL, slot, volume, S3 | 1.0 Mar 2026, 1.12 Nov 2026, active | **State: the one to spike** |
| **ElectricSQL** | Electric sync service (Elixir) | Apache-2.0 | Shapes restricted by your proxy (`where`) | Proxy route in Next.js; writes through tRPC + txid | Yes on the read path | `offset` + `handle`, long-poll or SSE | Through TanStack DB | Row types supplied by hand | One instance plus CDN collapsing | Medium: logical WAL, slot, volume | 1.x, **releases stalled since Sep 2026**, team moved to Neon | No |
| **PowerSync** | PowerSync Service + bucket storage DB | Apache-2.0 (since 2026-11-03) | Sync Streams parameterized by JWT claims | JWT from better-auth's JWT plugin; client-only SQLite | Replication 2–4k ops/s documented | Bucket checkpoints, deltas | Yes: local SQLite + upload queue to your API | Client schema written separately | API scales; one replicator | Heavy: service, storage DB, WASM SQLite | Mature, active | No (offline-first overkill) |
| **Supabase Realtime** | Realtime (Elixir) | Apache-2.0 | RLS on `realtime.messages` + JWT | Needs Supabase's Postgres roles; JWT minting | Broadcast scales; Postgres Changes single-threaded | Replay: alpha, 72 h, 25 msgs | No | No | **unverified** for self-host | Heavy outside Supabase | Mature inside Supabase | No |
| **LiveStore** | A sync backend you build or pick | Apache-2.0 | None built in | Event log replaces Prisma as source of truth | Per-store total order, one push at a time | Event-log cursors | Yes (local-first) | Its own schema | Per store | Medium | 0.5, pre-1.0 | No |
| **Replicache** | Your own push/pull endpoints | Open-sourced, free | Yours | Yours | n/a | Cookie-based pull | Yes | Its own | Yours | Light | **Maintenance mode** | No |
| **Centrifugo** | Centrifugo (Go) | Apache-2.0 (centrifuge-js MIT) | Connect proxy forwards the session cookie; per-channel permissions | Publish from SQL in the same transaction (PG broker) | Built for fan-out at scale | Offset + epoch recovery with bidirectional SDKs | No | Payloads typed by our Zod schemas | Yes; Redis, NATS, or Postgres-only (experimental) | One small container | v6.10.3, mature core; PG broker experimental | **Fallback for fan-out** |
| **Durable Streams** (protocol) | Its reference server, or our own implementation | MIT (repo) | Yours | Yours | Built for agent token streams | Offsets, long-poll, SSE | n/a | Yours | CDN-friendly | Light | 0.x; last push Sep 2026 | Borrow the protocol's shape |
| **Neon Realtime** | Hosted only | Proprietary service | No RLS yet | Neon-only | n/a | Reloads the query result | Yes | Yes | Neon's | Not self-hostable | Public beta since Oct 2026 | Excluded |

---

## What ostra needs

These requirements come from the brief and the ledger.

| Need | Source | What it implies |
|---|---|---|
| A task's page shows messages, tool calls and file changes as they happen, and the full history afterwards | F-023, ADR 0018 | An ordered, resumable, per-task stream, plus paged history from the same table |
| Approvals and questions appear instantly, and members answer them, on a phone too | F-026, F-062, F-075 | Low-latency state changes to every member of the team. Optimistic answer and approve |
| Home leads with "needs you" | F-062 | A per-team live list, read by many members at once |
| Runner fleet: slots, queue, versions, labels | F-067, round-7 Q5 | Live state, but changes only on transitions, never on every heartbeat |
| Insights charts | round-7 Q6 | Aggregates. Refreshing them every minute is enough (recommendation) |
| Every record belongs to one team, and no query crosses teams | ADR 0010 | Every stream is authorized per team when it opens, and every message is filtered too |
| Every event is saved before it's acted on | ADR 0011 | The stream reads from Postgres after commit. Nothing reaches the browser that isn't stored |
| 1,000 concurrent tasks per install, with the core service on several replicas | round-7 Q18 *(working value)* | Any replica must serve any stream, and the bus can't be one process's memory |
| One `docker compose up`; extra services cost | ADR 0001, F-001 | Prefer no new container. An extra container needs a strong reason |
| Strictly typed end to end | ADR 0008, AGENTS.md | Event and change payloads are the shared Zod unions, never retyped on the client |

**Load estimate (working numbers, unverified, for the spike to measure):**
- **Token deltas:** Claude Code through ACP streams `agent_message_chunk` and `agent_thought_chunk` token deltas (`research/agent-harnesses.md`, streaming table).
- **Event rate:** if the runner merges deltas into windows of about 100 ms, a generating task emits at most about 10 events a second.
  - A thousand tasks all generating at once would make about **10,000 events a second** at the peak.
  - The usual rate is lower, because agents spend much of their time waiting on tools.
- **State changes:** a few per task per minute, so tens a second across an install.
- **Watchers:** members times open tabs. A team of 20 with three tabs each holds about 60 state streams. A hosted install with hundreds of teams holds thousands.

---

## Candidates

### 1. ElectricSQL

**Status: no longer a safe base.**
- **The company:**
  - Electric "is joining Neon at Databricks", announced 2026-08-11. Electric Cloud "is winding down", and cloud users must self-host or move. "Everything Electric has previously open sourced stays open source: Postgres Sync, PGlite, TanStack DB, Durable Streams" ([Electric blog](https://electric.ax/blog/2026/08/11/electric-joining-databricks); press: [TechTarget](https://www.techtarget.com/news/Databricks-Electric-acquisition-adds-embeddable-PostgreSQL/842094)).
  - The repo moved to [`neondatabase/electric`](https://github.com/neondatabase/electric). Its tagline is now "The agent platform built on sync".
- **Its successor is closed and hosted.**
  - **Neon Realtime** entered public beta on 2026-10-15 ([Neon blog](https://neon.com/blog/neon-now-has-realtime)). Neon's docs say: "Realtime is the successor to Electric, developed by the Electric team inside Neon. It's a new system rather than a version of the Electric sync engine … We recommend that teams using Electric migrate to Realtime."
  - It runs only on Neon ("available only on Neon for now"), and it has no RLS yet ([Neon docs](https://neon.com/docs/realtime/overview)).
- **Releases have slowed sharply.**
  - The sync service shipped about weekly through 1.7.x. The last release is **1.8.1 on 2026-09-07**, followed only by a `canary` tag on 2026-10-06 ([Docker Hub](https://hub.docker.com/r/electricsql/electric/tags)). `@electric-sql/client` was last published 2026-09-09 (npm).
  - The commit history of `packages/sync-service` shows the last human-authored change on 2026-09-28 ([commits](https://github.com/neondatabase/electric/commits/main/packages/sync-service), read through a fetcher, so treat it as indicative).
  - The same history includes a fix for an authentication bypass on `/v1/shape` (#4765, 2026-08-20). That is a reminder that the proxy and the sync service form a security boundary someone has to keep patching.

**How it works:**
- **Architecture:**
  - An Elixir sync service reads Postgres through a logical replication slot and serves **shapes** over HTTP.
  - A shape is one table, plus a `where` clause and a column list. Subqueries can filter on related tables, but a shape returns only the root table's rows ([shapes guide](https://electric.ax/docs/guides/shapes)).
  - Electric is "a read-path sync engine". Writes go through your own API ([writes guide](https://electric.ax/docs/guides/writes)).
  - It needs a persistent storage directory that must stay consistent with its slot ([deployment](https://electric.ax/docs/guides/deployment)).
- **Auth:**
  - Production apps request shapes through a backend proxy, which sets the `where` clause from the session. Client-sent subset `where` clauses are combined with `AND`, so they can only narrow the result ([auth guide](https://electric.ax/docs/guides/auth)).
  - For ostra, that would be a Next.js route handler that reads the better-auth session and pins `team_id`.
- **Resume:** a shape log addressed by `offset` and `handle`, read by long-poll or SSE (`live_sse`) ([auth guide, parameter table](https://electric.ax/docs/guides/auth)).
- **Optimistic writes:**
  - These come through TanStack DB's Electric collection, or a pattern you write yourself.
  - The API returns the Postgres transaction ID, and the client waits until that ID appears in the stream ([writes guide](https://electric.ax/docs/guides/writes)). With Prisma, that means a raw `pg_current_xact_id()` in each write transaction.
- **Types:** shape rows are typed by a generic the app supplies. I found no Prisma generator (**unverified**), so the types would be written a second time, which breaks the AGENTS.md rule.
- **Scale:**
  - Electric "is designed to run behind a CDN, using the CDN's request collapsing", and it reports one server handling 100k to 1M concurrent users with a CDN in front ([benchmarks](https://electric.ax/docs/reference/benchmarks)).
  - A self-hosted `docker compose` has no CDN.
  - Running several active instances against one database isn't covered in the docs I read (**unverified**).
- **Self-host weight:** one container with a volume, `wal_level=logical`, a slot and a publication.

**Verdict:** **no.** The technical fit was reasonable for state. But the team has moved on to a closed, hosted successor that ostra can't self-host, and it's telling its own users to migrate.

### 2. Zero (Rocicorp)

**Status:** generally available and active.
- `@rocicorp/zero` 1.0.0 was published 2026-03-24, and 1.12.0 on 2026-11-12. A 1.13 canary was out on 2026-11-17 (npm, [Docker Hub](https://hub.docker.com/r/rocicorp/zero/tags)).
- 1.12 added synced aggregates and JSON-path filters.
- The status page: "As of March 2026, Zero is generally available and fully-supported", and breaking changes are to be rare ([status](https://zero.rocicorp.dev/docs/status)).
- License Apache-2.0 ([`rocicorp/mono`](https://github.com/rocicorp/mono)).
- Press coverage of 1.0: [InfoQ, 2026-06-08](https://www.infoq.com/news/2026/06/zero-version-1).

**How it works:**
- **Architecture:**
  - `zero-cache` replicates Postgres through logical replication into a **SQLite replica**. It runs ZQL queries incrementally (IVM) and pushes row diffs to clients over WebSockets.
  - The client keeps a local store and answers queries from it first.
  - On several nodes, it's one **replication-manager**, which owns the slot and backs up the replica to S3 through Litestream, plus N **view-syncers** that serve clients and scale horizontally. With several view-syncers, the docs suggest sticky sessions, which avoid "Rehome" reconnects ([self-hosting](https://zero.rocicorp.dev/docs/deployment)).
  - A single node needs no S3.
- **Auth:**
  - Queries are named and defined on your server. `zero-cache` calls your `queries` endpoint, which "returns the resulting ZQL", and authorization happens there through a `context` object ([queries](https://zero.rocicorp.dev/docs/queries)).
  - With `ZERO_QUERY_FORWARD_COOKIES` and `ZERO_MUTATE_FORWARD_COOKIES`, `zero-cache` forwards the browser's cookies to your endpoints ([auth](https://zero.rocicorp.dev/docs/auth)).
  - The better-auth session cookie therefore works unchanged. A Next.js route handler calls `auth.api.getSession` and returns ZQL pinned to `teamId`.
- **Prisma:**
  - `prisma-zero` is a Prisma generator for Zero's schema, maintained by Rocicorp since 0.25 ([0.25 notes](https://zero.rocicorp.dev/docs/release-notes/0.25)).
  - Server-side mutators can run through Prisma with `zeroPrisma(schema, prisma)` from `@rocicorp/zero/server/adapters/prisma` ([docs, llms-full](https://zero.rocicorp.dev/llms-full.txt)).
  - Types flow from Prisma, which satisfies the "written once" rule.
- **Next.js:**
  - The docs carry Next.js variants throughout.
  - However, "we don't recommend using Zero with SSR" ([docs](https://zero.rocicorp.dev/llms-full.txt), SSR section). Panel views on Zero would render on the client, without the server-component prefetch that ADR 0007's tRPC setup allows.
- **Optimistic writes:**
  - Mutators run on the client first, then on your server's `push` endpoint inside a transaction ([mutators](https://zero.rocicorp.dev/docs/mutators)).
  - Mutators are rejected while offline, and there are no offline writes ([when to use](https://zero.rocicorp.dev/docs/when-to-use)). That's fine for ostra.
- **High-frequency events:**
  - Zero targets "productivity apps … broadly like Linear", and recommends datasets under about 100 GB ([when to use](https://zero.rocicorp.dev/docs/when-to-use)).
  - How the IVM engine copes with thousands of appended event rows a second is **unverified**.
  - Replication can be limited with a custom app publication ([Postgres notes](https://zero.rocicorp.dev/llms-full.txt)), so the event table can stay out of it.
- **Self-host weight:**
  - one more image (`rocicorp/zero`) with a volume
  - `wal_level=logical`
  - a slot, whose WAL retention needs `max_slot_wal_keep_size`; Zero re-syncs if the slot is invalidated
  - an S3-compatible bucket once multi-node
- **Client size:** a 718 KB uncompressed, 232 KB gzipped bundle was reported in coverage of 1.0 (secondary: [InfoQ](https://www.infoq.com/news/2026/06/zero-version-1)).
- **Company risk:** Rocicorp is a small company funding Zero through Cloud Zero ([pricing](https://zero.rocicorp.dev)). That's mitigated by the Apache-2.0 license and by Zero being "just a fancy cache" in front of your own Postgres (founder, via InfoQ, secondary).

**Verdict:** the one sync engine worth a spike, **for state only**. It would replace hand-written invalidation, give instant board and inbox interactions, and keep types flowing from Prisma. Against it: a second container, a slot, no SSR, and two API styles in the panel (ZQL for reads and live views, tRPC for everything else).

### 3. tRPC v11 subscriptions (SSE or WebSocket)

**Status:** `@trpc/server` 11.29.4, published 2026-11-18, MIT. tRPC is already in the stack (ADR 0007).

**How it works:**
- **Server:**
  - Subscriptions are async generators.
  - Yielding `tracked(id, data)` lets the client reconnect automatically and resume from `lastEventId`. For SSE that's the standard `Last-Event-ID`, and `wsLink` sends it over WebSocket ([subscriptions](https://trpc.io/docs/server/subscriptions)).
  - tRPC recommends SSE "as it's easier to setup and doesn't require setting up a WebSocket server".
- **Keepalive:** server pings, `maxDurationMs` and client `reconnectAfterInactivityMs` handle proxies that cut idle connections ([httpSubscriptionLink](https://trpc.io/docs/client/links/httpSubscriptionLink)).
- **Auth:**
  - `EventSource` can't send headers, and the docs warn that tokens in `connectionParams` land in URLs and logs. They recommend cookies ([docs](https://trpc.io/llms-full.txt), auth notes).
  - The better-auth session cookie is same-origin, so the tRPC context resolves the member and team for each subscription, exactly as for queries.
- **Next.js:**
  - SSE works through the fetch adapter in a route handler.
  - WebSockets do not. Next.js route handlers can't upgrade a connection, and native support is only a draft RFC (`NextResponse.upgrade()`, [discussion #95514](https://github.com/vercel/next.js/discussions/95514)).
  - A `wsLink` setup would have to live in the core service (ADR 0016), behind the same origin.
- **The browser connection limit:**
  - `httpSubscriptionLink` uses `EventSource`, and **each subscription is its own HTTP request** (**unverified** from source, but implied by `EventSource`).
  - "When not used over HTTP/2, SSE suffers from a limitation to the maximum number of open connections … (6)", counted per browser and domain across all tabs ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/EventSource)).
  - Browsers only speak HTTP/2 over TLS, so a self-hosted install on plain `http://` is HTTP/1.1.
  - Three tabs with two streams each exhaust the pool, and ordinary requests to the same origin then queue behind them.
  - Mitigations (spike): one live stream per tab, a leader tab that shares the team stream with the others (BroadcastChannel plus Web Locks), a TLS reverse proxy in the default compose, or `wsLink` from the core service.
- **Types:** end to end with no extra work. The yielded value's type is the procedure's output type, and the payloads are the shared Zod unions (ADR 0008, ADR 0018).
- **Scale:** each stream is an open HTTP response in a Node process. Any replica can serve any stream as long as the source of events is shared, which is what section 4 covers.

**Verdict:** **yes, as the transport** for both halves. It adds nothing new to the stack and keeps one typed API. It needs a cross-replica source of events (section 4) and a deliberate answer to the connection limit.

### 4. Home-grown: Postgres as the log, LISTEN/NOTIFY as the wake-up, SSE to the browser

**The building blocks:**
- **`NOTIFY` delivery:**
  - Delivered after commit, in commit order.
  - The payload must be under 8,000 bytes, and the docs advise storing larger data "in a database table and send the key of the record".
  - The queue is 8 GB. A listener stuck in a long transaction blocks cleanup ([NOTIFY docs](https://www.postgresql.org/docs/current/sql-notify.html)).
- **The commit lock:**
  - A transaction that issued `NOTIFY` takes a global lock during commit, "effectively serializing all commits". Recall.ai traced three outages in March 2025 to it ([Recall.ai](https://www.recall.ai/blog/postgres-listen-notify-does-not-scale)).
  - DBOS hit "no more than 2.9K stream writes per second" with a `NOTIFY` from a trigger on every write. With batched notifications they reached "up to 60K stream writes per second … with 15–100 ms latency" ([DBOS, vendor benchmark](https://www.dbos.dev/blog/postgres-listen-notify-scalability)).
- **Postgres 19:**
  - Recall.ai's post now carries an update, "Fixed in Postgres core", linking commit [`282b1cde`](https://github.com/postgres/postgres/commit/282b1cde9dedf456ecf02eb27caf086023a7bb71).
  - That commit's message describes a shared map of which backend listens on which channel, so uninterested listeners aren't woken. PG19's release notes describe it the same way: "Improve NOTIFY to only wake up backends that are listening" ([release notes](https://www.postgresql.org/docs/19/release-19.html)).
  - Whether PG19 still serializes commits that issued `NOTIFY` is **unverified**.
  - PG19 is at RC 2 (2026-11-12) and not GA ([announcement](https://www.postgresql.org/about/news/postgresql-187-1712-1616-1520-1425-and-19-rc-2-released-3442)). ostra should assume the lock exists.
- **Prior art:**
  - tRPC's own subscription example reads from the database by `lastEventId` and subscribes to the emitter before catching up, so no event slips through ([subscriptions](https://trpc.io/docs/server/subscriptions)).
  - Centrifugo's Postgres broker polls an outbox table every 100 ms, uses `NOTIFY` only to cut latency, and partitions the table by day ([engines](https://centrifugal.dev/docs/server/engines)).
  - Durable Streams defines resumable, offset-based HTTP reads with long-poll and SSE tails (section 9).

**What it costs ostra:**
- no new container
- no logical replication slot, so no WAL-retention trap on self-hosted disks
- no new dependency: Prisma 7 talks to Postgres through `@prisma/adapter-pg` on `pg` ([Prisma docs](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/database-drivers)), and a dedicated `LISTEN` connection uses the same `pg` driver (**to confirm** that `pg` counts as already chosen under AGENTS.md's dependency rule)
- the cost is the design work and the tests, sketched in [The split design](#the-split-design)

**Pitfalls to design around:**
- **Never `NOTIFY` per event.** Notify once per writer per batch window, with a small payload (task IDs and their highest sequence number), and fall back to polling when a `NOTIFY` is missed.
- **Ordering.** A `bigserial` ID isn't committed in order. Per-task sequence numbers, assigned under a lock on the task's counter row, are committed in sequence order.
- **Pooling.** `LISTEN` doesn't work through a transaction-mode pooler (secondary source, [nerdleveltech](https://nerdleveltech.com/postgres-listen-notify-job-queue); Centrifugo's `notify_dsn` option exists for the same reason, [engines](https://centrifugal.dev/docs/server/engines)). Keep a direct connection for it.

**Verdict:** **yes for the event log, and as the bus for state change notices.** It's the only option that writes nothing outside Postgres, adds no service, and keeps ADR 0011's "saved before acted on" literal: the browser only ever sees committed rows.

### 5. Supabase Realtime (self-hosted)

**Status:** `supabase/realtime` v2.171.0, published 2026-11-17 ([Docker Hub](https://hub.docker.com/r/supabase/realtime/tags)), Apache-2.0, Elixir and Phoenix.

**How it works:**
- **Three features:**
  - Broadcast and Presence over WebSockets.
  - Postgres Changes, read from WAL.
  - Broadcast from the database, through `realtime.broadcast_changes` and the `realtime.messages` table.
- **Delivery:** "The server does not guarantee that every message will be delivered to your clients" ([README](https://github.com/supabase/realtime)).
- **Postgres requirements:**
  - The supported-Postgres table names the `supabase_admin` role and says "Realtime needs a superuser" for migrations ([README](https://github.com/supabase/realtime)).
  - It's built around Supabase's Postgres image and `supautils`. Running it against a stock `postgres` image is **unverified**.
- **Auth:**
  - Private channels are authorized with RLS policies on `realtime.messages`, evaluated against the client's JWT when it joins, and cached for the connection ([authorization](https://supabase.com/docs/guides/realtime/authorization)).
  - ostra would mint JWTs with better-auth's JWT plugin, which publishes a JWKS ([better-auth JWT](https://www.better-auth.com/docs/plugins/jwt)).
  - The example policies call Supabase's `auth.uid()` helper, so the policies would need rewriting on vanilla Postgres.
- **Scale:**
  - Postgres Changes are "processed on a single thread to maintain the change order", and every change is checked against RLS once per subscriber.
  - Supabase's own advice at scale is to re-stream through Broadcast ([benchmarks](https://supabase.com/docs/guides/realtime/benchmarks)).
- **Resume:** Broadcast Replay is public alpha, works only for database broadcasts on private channels, and has 72-hour retention and 25 messages per request ([feature page](https://supabase.com/features/realtime-broadcast-replay), [limits](https://supabase.com/docs/guides/realtime/limits)). That isn't enough to rebuild a task's history.
- **Types and optimistic writes:** none built in.

**Verdict:** **no.** It's Supabase-shaped, gives no delivery guarantee, and resumes too little.

### 6. PowerSync

**Status:**
- `@powersync/service-core` 1.29.0 (2026-11-17) and `@powersync/web` 2.7.0 (2026-11-09).
- The service moved from FSL to **Apache-2.0**. The update notice is dated 2026-11-03 ([new open era](https://www.powersync.com/blog/new-open-era-for-powersync), [Apache post](https://powersync.com/blog/moving-the-powersync-service-to-apache)).
- It's open core: an Enterprise Self-Hosted edition has closed-source features.

**How it works:**
- **Architecture:**
  - The service replicates Postgres into **buckets**, stored in a separate MongoDB or Postgres database.
  - Clients sync buckets into a local **SQLite** database: wa-sqlite on IndexedDB or OPFS in the browser ([self-hosted config](https://docs.powersync.com/configuration/powersync-service/self-hosted-instances), [web SDK](https://docs.powersync.com/client-sdks/reference/javascript-web)).
- **Auth:**
  - JWTs verified against a JWKS URI or static keys. Sync Streams filter by token claims, such as `auth.user_id()` ([config](https://docs.powersync.com/configuration/powersync-service/self-hosted-instances), [Sync Streams](https://docs.powersync.com/sync/streams/overview)).
  - better-auth's JWT plugin could issue these.
- **Writes:** writes go to local SQLite and an upload queue, and an `uploadData()` function you write sends them to your backend. That would be tRPC. It's optimistic by construction (secondary: [Offline Protocol comparison](https://www.offlineprotocol.com/learning/offline-first/offline-protocol-vs-powersync); PowerSync's [migration guide](https://powersync.com/blog/migrate-from-electric-cloud-to-powersync-cloud)).
- **Limits** ([performance and limits](https://docs.powersync.com/resources/performance-and-limits)):
  - Replication runs at "2,000–4,000 operations per second" for small rows.
  - There's a default of 1,000 buckets per user, raised only on request.
  - The event log alone could exceed that replication rate at the peak.
- **Types:** the client SQLite schema is declared separately in TypeScript. I found no Prisma generator (**unverified**).
- **Fit:** PowerSync's advantage is offline-first, especially on mobile. ostra's panel is desktop-first and has no offline requirement (F-075).

**Verdict:** **no.** It's the heaviest option to self-host (a service plus a bucket store plus WASM SQLite in every tab), for a capability ostra doesn't need.

### 7. LiveStore

**Status:** `@livestore/livestore` 0.5.0 (2026-10-15), Apache-2.0, before 1.0.

**How it works:**
- **Event sourcing on the client.** An event log is "the single source of truth", and its state is materialized into reactive SQLite on the client ([how it works](https://docs.livestore.dev/overview/how-livestore-works)).
- **Sync.** A sync backend enforces one total order per store and must process "one push request at a time" ([custom sync provider](https://docs.livestore.dev/sync-providers/custom)).
- **Auth.** "LiveStore doesn't include built-in authentication or authorization support" ([auth](https://dev.docs.livestore.dev/patterns/auth)).
- **Postgres.** Its Electric provider stores events in its own `eventlog_*` tables, and an existing database can't be used unless it's already modelled that way ([Electric provider](https://dev.docs.livestore.dev/sync-providers/electricsql)).
- **Mismatch with ostra.** Its own comparison page points apps whose existing Postgres "should remain your source of truth" to Electric, Zero or PowerSync instead ([comparison](https://docs.livestore.dev/overview/technology-comparison)). ostra's agent events come from runners through the core service, not from browser clients.

**Verdict:** **no.** It inverts ostra's model, where Prisma tables are the truth and the server is the writer.

### 8. Replicache

**Status:** "Replicache is now in maintenance mode. We have open-sourced the code and no longer charge for its use … Existing users should migrate to Zero" ([replicache.dev](https://replicache.dev)).
- The last npm release is 15.3.0, from 2025-07-02.
- The `rocicorp/replicache` GitHub repo is archived (GitHub API).

**Verdict:** **no.** Its successor is Zero, covered in section 2.

### 9. Others relevant in 2026

**Centrifugo**, the best ready-made fan-out tier:
- **Status:** Apache-2.0 ([repo](https://github.com/centrifugal/centrifugo)). v6.10.3 was published 2026-11-08 ([Docker Hub](https://hub.docker.com/r/centrifugo/centrifugo/tags)). The browser SDK, `centrifuge` 5.8.0, is MIT.
- **Transports:** WebSocket, SSE, HTTP streaming and others, with many channels over one connection ([README](https://github.com/centrifugal/centrifugo)). That avoids the HTTP/1.1 limit without TLS.
- **Recovery:**
  - Each channel stream carries an `offset` and `epoch`, and bidirectional SDKs replay missed messages on resubscribe.
  - The docs say recovery is for reconnect gaps, not long-term delivery: "for that, design around your database" ([history and recovery](https://centrifugal.dev/docs/server/history_and_recovery)). That matches ostra's design, where the table is the truth.
- **Postgres alone:**
  - Since v6.8.0, the OSS build has a **PostgreSQL stream broker** and **controller**, so several nodes can run with no Redis or NATS ([blog](https://centrifugal.dev/blog/2026/05/25/pg-controller-multi-node)).
  - It publishes inside your transaction (`cf_stream_publish`), uses a daily-partitioned stream table, polls every 100 ms with optional `LISTEN/NOTIFY`, and requires Postgres 16 or later.
  - It's marked **experimental** ([engines](https://centrifugal.dev/docs/server/engines), [highlights](https://centrifugal.dev/docs/getting-started/highlights)).
- **Auth:** the connect proxy forwards allow-listed headers such as `Cookie` to the backend, so the better-auth session authenticates the connection ([proxy](https://centrifugal.dev/docs/server/proxy)). Channel permissions per team and per task follow from there.
- **Types:** payloads are opaque JSON. The shared Zod unions would parse them on both ends.
- **Verdict:** **the fallback** if the home-grown fan-out misses the spike's targets. It's one Go container with mature core features, but its Postgres-only mode is new.

**Durable Streams**, a protocol to borrow from rather than a dependency:
- **What it is:** a "minimal HTTP-based protocol for durable, offset-based streaming". It's resumable from any offset, with long-poll and SSE live tails, and CDN-friendly. It's pitched explicitly at AI token streaming, and "based on 1.5 years of production use at Electric" ([repo](https://github.com/durable-streams/durable-streams), MIT).
- **Status:**
  - Packages are 0.x: client 0.2.7 and server 0.3.9, both 2026-09-10 (npm).
  - The repo's last push was 2026-09-28 (GitHub API), and its authors are now at Neon.
- **Verdict:** shape ostra's event-log endpoint like it (offsets, a live tail, catch-up from any offset), but implement it in our own code, reading from our own table.

**TanStack DB**, a client store that can sit on top of tRPC:
- **Status:** 1.0.0-rc.1 (2026-10-29), latest `1.0.0-rc.1.5` (2026-11-11), MIT.
- **What it offers:**
  - Live queries and optimistic mutations over collections.
  - A Query Collection whose "direct writes" (`writeInsert` and `writeUpsert`) put server data into the synced store without a refetch ([Query Collection](https://tanstack.com/db/latest/docs/collections/query-collection), [1.0 RC migration](https://tanstack.com/db/latest/docs/guides/migrate-to-1-0-rc)).
  - A tRPC subscription could feed direct writes into it, giving Zero-like client queries without a sync service.
- **The catch:** it's another dependency, so ask first, and it's still a release candidate.
- **Verdict:** optional. Consider it only if hand-written cache updates on TanStack Query get unwieldy.

**Neon Realtime:** live SQL inside Neon, with type-safe live queries, SSR and optimistic mutations, in public beta ([docs](https://neon.com/docs/realtime/overview)). It's **excluded** because it's hosted only and Neon-only, which breaks ADR 0001 and the self-hosting rule. It's worth watching as a signal of where Electric's ideas went.

**Rejected quickly:**
- **Convex self-hosted:** licensed FSL-1.1-Apache-2.0 ([LICENSE](https://github.com/get-convex/convex-backend/blob/main/LICENSE.md)), not OSI open source. Its own database replaces Prisma and Postgres as the source of truth.
- **InstantDB:** Apache-2.0, but its own data model and server.
- **Triplit:** AGPL, last pushed 2026-01-19 (GitHub API).
- **Jazz:** MIT, but its own database.
- **Prisma Pulse:** no longer exists (secondary: [prisma/orm#298](https://github.com/prisma/orm/issues/298), Oct 2025 comments).

---

## The split design

The brief asked whether to pair a sync engine for state with a separate SSE stream for the raw event log. The split matches the two data shapes, so keep it. The recommended v1 version of each half is below.

```
 runner ──ACP events──▶ core replica (holds the runner connection)
                          │ 1. parse with the shared Zod union (ADR 0018)
                          │ 2. merge token deltas per task into ~100 ms windows
                          │ 3. one transaction per window: lock task counter row,
                          │    INSERT the batch with seq = last_seq+1…, COMMIT   ← saved (ADR 0011)
                          │ 4. after commit: wake local subscribers, and
                          │    NOTIFY ostra_live '[{task, maxSeq}, …]' once per window
                          ▼
                       Postgres ── NOTIFY (wake-up only) ──▶ every replica's tailer
                                                             │ one query per wake-up for
                                                             │ the tasks it has watchers on:
                                                             │ seq > cursor, by PK index
                                                             │ (poll every ~250 ms if no NOTIFY)
                                                             ▼
                                       tRPC subscription generators ── SSE ──▶ browser
                                       yield tracked(String(seq), event)       (resume via Last-Event-ID)
```

### Event log (F-023)

- **Storage:** an event table keyed by `(task_id, seq)` (or by session), with a JSON payload validated by the shared Zod union.
  - `seq` comes from a counter on the task row, taken under that row's lock in the writing transaction. Writers to one task serialize, and sequence numbers commit in order, with no gaps visible to readers.
  - Partition by time if retention needs it (F-079).
- **History:** a normal paged tRPC query, reading backwards. The live tail is a subscription that starts from the newest `seq` the page returned.
- **Resume:** `tracked(String(seq), event)`. On reconnect, the generator reads `seq > lastEventId` from the table before tailing. Following tRPC's advice, it subscribes before catching up so nothing slips through ([subscriptions](https://trpc.io/docs/server/subscriptions)).
- **Fan-out:**
  - Replicas are stateless. Any replica serves any task, and the load balancer needs no sticky sessions.
  - Each replica runs one tailer. Its query count scales with notifications, not with watchers.
- **Token deltas:** ADR 0011 says every agent event is saved before it's acted on, so the deltas shown are the deltas saved, merged into windows. Whether raw deltas may instead stream unsaved, with only the merged message stored, is a question for the maintainer ([Unknowns](#open-questions-for-the-maintainer)).

### State (needs you, tasks, runners)

- **Change notices.** A domain write and its "change notice" (team, entity, ID) commit in the same Prisma transaction. The same tailer delivers them to a per-team tRPC subscription, `live.team()`.
- **On the client,** each notice invalidates, or patches through `setQueryData`, the typed TanStack Query caches it touches. On reconnect, the client refetches its live views.
  - State is a snapshot that can always be fetched again, so a missed notice costs a refetch, not a wrong screen.
  - That keeps this half simpler than the event log: notices need no gapless offsets.
- **Optimistic writes** (approve, answer, dismiss, stop) use TanStack Query's `onMutate` and roll back on error. The server's change notice then confirms the write.
- **Runner fleet:** notices fire only when slots, the queue, versions or online status change, never on each heartbeat.
- **Insights:** aggregates computed on the server and refreshed every minute or so, or when a relevant notice arrives. They aren't synced live (recommendation).

### Authorization on long-lived streams

- **When a stream opens,** the tRPC context resolves the better-auth session, the member and the team (ADR 0010). Every message is filtered by `team_id` again before it's yielded.
- **Revocation:** an open SSE response outlives a revoked session or a removed member. Streams must re-check membership on a timer, or close when a membership-change notice arrives. Every candidate in this document has this problem, including Zero's forwarded cookies.
- **Logs:** they carry task and team IDs only, never payloads (AGENTS.md).

---

## Recommendation

*(A proposal, to settle with the maintainer and record as an ADR if accepted.)*

1. **Split the design:** a state feed and an event-log stream, both over tRPC v11 subscriptions on SSE, both reading only committed rows from Postgres.
2. **Build the event log ourselves, in the shared domain packages.** That means per-task `seq` under a row lock, writes batched per window, one `NOTIFY` per window as a wake-up, a polling fallback, one tailer per replica and `tracked(seq)` resume.
   - No candidate does this better within ostra's constraints.
   - Electric and Durable Streams are built for it, but Electric has lost its team, and Durable Streams is 0.x and in the same position.
   - Zero, PowerSync and Supabase Realtime aren't built for append-heavy logs.
3. **Give state change notices plus TanStack Query invalidation in v1. Add no sync service.**
   - Zero is the single candidate to replace this half. Spike it before milestone 3, where Home, approvals and plan-first make state liveness matter (`build-order.md`).
   - Adopt Zero only if it clearly beats the baseline on the same screens, and the maintainer accepts the extra container, the replication slot, and client-only rendering for those views.
4. **Keep Centrifugo as the fallback** for the fan-out tier, if the spike shows the tailer or Node's SSE connections can't hold the target. It replaces only the "tailer → SSE" box. Storage stays in our table, and it can publish from the same transaction.
5. **Don't adopt** Electric (stalled, its successor closed), Neon Realtime (hosted only), PowerSync (offline-first weight), Supabase Realtime (Supabase-shaped, no delivery guarantee), LiveStore (event-sourced on the client) or Replicache (maintenance mode).
6. **Rules that hold whichever way the spike goes:**
   - never `NOTIFY` per event
   - the browser sees only committed rows
   - every live endpoint authorizes by team when it opens and filters every message
   - streams resume by offset
   - heartbeats never enter the change feed
   - Insights aren't live
7. **Dependencies:** the baseline adds none beyond the chosen stack, with `pg` coming through Prisma's adapter (to confirm). TanStack DB, Zero and Centrifugo each need the maintainer's yes first (AGENTS.md).

---

## Unknowns / spike

### Spike: live event stream at target load (milestone 0, alongside spike 1)

This should be milestone 0's seventh spike, because F-023 is in milestone 1, and every later live feature builds on the same path. Throwaway code goes in `spikes/live-event-stream/`.

**Steps:**
1. **Write load.** Three simulated core replicas write ACP-shaped events for 1,000 tasks, at configurable rates, into Postgres 18. Optionally repeat on 19 RC to see the `NOTIFY` change.
   - Compare Prisma `createMany` with raw `pg` multi-row inserts.
   - Compare 50 ms and 100 ms merge windows.
   - Use a per-task counter row lock.
2. **Fan-out.** Two panel replicas serve a tRPC v11 `httpSubscriptionLink` stream with `tracked(seq)`: one through a Next.js 16 route handler, one from a plain Node process, standing in for the core service.
   - Use batched `NOTIFY` wake-ups with polling as the fallback.
   - Run 2,000 simulated watchers, plus a few real browsers.
3. **Measure:**
   - end-to-end p50 and p99 latency, from runner event to browser
   - Postgres CPU, commits a second, and lock waits on `NOTIFY`
   - Node memory per open stream
   - tailer queries a second
4. **Failure.** Kill a replica mid-stream and restart Postgres. Check that resume gives no gaps and no duplicates.
5. **Browser.** Open four tabs on plain `http://` (HTTP/1.1) and confirm the 6-connection starvation. Then try the fixes: one stream per tab, a leader tab sharing over BroadcastChannel plus Web Locks, and HTTP/2 behind a TLS proxy.
6. **Auth.** The better-auth cookie authenticates the stream. Removing a member from the team closes their stream within N seconds. Logs carry no payloads.

**Pass** *(working values)*:
- p99 under 500 ms at a sustained 5,000 events a second, and survives a 10,000-a-second burst
- zero gaps or duplicates across the failure cases
- Postgres CPU under 50% on 4 vCPU

**Fail:** rerun step 2 with Centrifugo v6.10's Postgres broker in place of the tailer, then bring the result to the maintainer.

### Spike: Zero for state (milestone 0 or 1, time-boxed to about 3 days)

Build the Home "needs you" list, the task board and the runner fleet view on Zero 1.12. Then build the same three on tRPC change notices.
- **Schema and writes:** `prisma-zero` for the schema, and `zeroPrisma` mutators for approve, answer and stop.
- **Auth:** query and mutate endpoints as Next.js route handlers, using the better-auth cookie forwarded with `ZERO_*_FORWARD_COOKIES`, and pinning the team.
- **Deployment:** a single-node `zero-cache` in the compose file, with the event table left out of its publication.

**Compare the two versions on:**
- code size
- time to first paint without SSR
- bundle size
- how a Prisma migration rolls out across both
- what happens when `zero-cache` is down
- WAL growth when `zero-cache` is stopped for an hour
- whether the second-tab and second-member updates feel different

### Open questions for the maintainer

- **Token deltas** (ADR 0011): save merged windows of deltas, as recommended above, or stream raw deltas unsaved and save only finished messages? The first keeps "saved before acted on" literal, and the second cuts write volume.
- **TLS in the default compose:** if the default `docker compose` ships a TLS reverse proxy, browsers get HTTP/2 and the 6-connection limit goes away. If installs run on plain `http://`, the design has to multiplex.
- **Offline:** does the panel ever need to work offline? (Assumed no, per F-075. That rules out PowerSync and LiveStore.)

### Unverified

- Whether PG19's `NOTIFY` change removes the commit-time serialization.
- Whether `httpSubscriptionLink` opens one `EventSource` per subscription (implied by its design, not confirmed from source).
- How Zero's IVM behaves under thousands of event rows a second (avoided by leaving events out of its publication).
- Running Supabase Realtime against a stock `postgres` image.
- Prisma generators for Electric or PowerSync client schemas (none found).
- Running several active Electric instances against one database.
- The load estimate in [What ostra needs](#what-ostra-needs).

---

## Versions checked

All checked 2026-11-18, on npm unless noted.

| Package / image | Version | Published | License |
|---|---|---|---|
| `@trpc/server`, `@trpc/tanstack-react-query` | 11.29.4 | 2026-11-18 | MIT |
| `next` | 16.4.6 | 2026-11-09 | MIT |
| `@prisma/client` | 7.10.1 | 2026-10-15 | Apache-2.0 |
| `better-auth` | 1.7.25 | 2026-11-14 | MIT |
| `@rocicorp/zero` / `rocicorp/zero` image | 1.12.0 (1.0.0 on 2026-03-24) | 2026-11-12 | Apache-2.0 |
| `@electric-sql/client` | 1.5.28 | 2026-09-09 | Apache-2.0 |
| `electricsql/electric` image (Docker Hub) | 1.8.1 (`canary` 2026-10-06) | 2026-09-07 | Apache-2.0 |
| `@tanstack/db`, `@tanstack/electric-db-collection` | 1.0.0-rc.1.5 | 2026-11-11 | MIT |
| `@tanstack/query-db-collection` | 1.5.2 | 2026-11-11 | MIT |
| `@powersync/service-core` | 1.29.0 | 2026-11-17 | Apache-2.0 |
| `@powersync/web` | 2.7.0 | 2026-11-09 | Apache-2.0 |
| `@supabase/realtime-js` | 2.119.0 | 2026-11-04 | MIT |
| `supabase/realtime` image (Docker Hub) | v2.171.0 | 2026-11-17 | Apache-2.0 |
| `@livestore/livestore` | 0.5.0 | 2026-10-15 | Apache-2.0 |
| `replicache` | 15.3.0 (maintenance mode) | 2025-07-02 | open-sourced ([replicache.dev](https://replicache.dev)) |
| `centrifugo/centrifugo` image (Docker Hub) | v6.10.3 | 2026-11-08 | Apache-2.0 |
| `centrifuge` (JS SDK) | 5.8.0 | 2026-10-20 | MIT |
| `@durable-streams/client` / `server` | 0.2.7 / 0.3.9 | 2026-09-10 | client Apache-2.0 on npm (server not checked); repo MIT |
| PostgreSQL | 18.7 current; 19 at RC 2 | 2026-11-12 | PostgreSQL |
