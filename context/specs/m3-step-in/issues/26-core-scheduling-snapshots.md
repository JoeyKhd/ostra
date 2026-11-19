# 26: Core: scheduling snapshots

Status: ready-for-agent
Builder: core
Blocked by: 07, 14
Features: F-051
Packages: `apps/core` (`src/snapshots/` (new), `src/dispatch/`), `packages/domain` (`scheduleSnapshot`, `recordSnapshotResult`)
Spec: `../spec.md`, section 4 ("Snapshots"); ADR 0038 (amended)

## What to build

- **Triggers:** `snapshot.schedule` (key: project and reason, one a minute at most) on an environment's change, on a `push` to a default branch that touches a lockfile (the paths ticket 09's hint carries; without them, a compare), and `snapshot.nightly` at `OSTRA_SNAPSHOT_NIGHTLY_HOUR` for projects whose default branch moved since the last ready snapshot.
- **The build:** a `Snapshot` row (`queued`), and a `snapshot-build` command to a `docker` runner of the project's pools that's online, the one that ran the project's last task first. Its setup secrets come from the credentials endpoint after the runner's check, as a task's do. `snapshot.built` and `snapshot.failed` move the row (`building`, `ready`, `failed`), set `runnerId`, and replace the previous ready one; a failed build leaves the previous ready one in use (`domain-model.md`).
- **Use:** the dispatch writes `snapshot: { kind: "image", ... }` into a task's spec when the chosen runner holds the ready snapshot, and nothing when it doesn't; for a `host` runner it writes `{ kind: "host-cache", cacheKey }`. No runner is passed over because it lacks the snapshot (ADR 0038, amended).
- **No `docker` runner:** the row stays `queued`, and the environment page says why.

## Done when

- [ ] Tests: each trigger queues one build; two triggers in a minute queue one; a failed build keeps the previous snapshot in use; the dispatch picks the spec's snapshot by runner; a `host` runner gets the cache key; another organization's snapshots are untouched.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `core` and `domain`.
- [ ] Committed as `✨ schedule environment snapshots`.

## Comments
