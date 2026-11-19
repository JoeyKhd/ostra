# 20: Core: cleanup and retention

Status: done
Builder: core
Blocked by: 16, 17
Features: F-079, F-096
Packages: `apps/core` (`src/cleanup/`), `packages/domain` (`releaseBox`, `sweepCleanup`, `sweepRetention`)
Spec: `../spec.md`, sections 4 ("A PR's state") and 11 (item 11)

## What to build

- **`box.release`:** when a task's last PR merges or closes (ticket 16), send the runner that holds the box a `release` command (minor ≥ 1), mark the box `released` on the ack, and end its lease. A runner that's offline gets the command when it reconnects; the box counts as released for dispatch at once, so a reopen goes to a fresh box.
- **`box.release-after-idle`:** one delayed job per box at `OSTRA_BOX_RELEASE_IDLE_DAYS` (14) after it goes idle, keyed by the box, cancelled when a new turn starts in it. It wakes, checks the box's state, and releases it only if it's still idle or stopped (ADR 0037's timer shape).
- **The hidden ref** is deleted with `deleteRef` in each repo once the task is merged or stopped with its PRs closed and its box is released. A stopped task that can still be reopened keeps it. Cleanup deletes refs, never LFS objects, and the docs say so (ADR 0039, Q120).
- **A release that didn't finish** (the runner never acked) is retried when the runner reconnects, from the unacked command, never by a second command.
- **`retention.sweep`:** a daily schedule that does nothing unless `OSTRA_RETENTION_DAYS` (or the instance setting) is set; then it deletes the events, live-text rows, session archives and task blobs of tasks finished longer ago than that, keeping the task row, its task repos and an audit entry. A task that is reopened later shows that its history was removed.
- **On `host`,** OpenCode's tool outputs under the machine's temp folder for the task (M1's demo gap) are removed by the runner on release (Q134's interim answer, ticket 23).

## Decided 2026-11-19 (ticket 40)

The lead, on the maintainer's delegation, settled the open points the milestone 2 targets (`context/brand/app-targets/m2/`) and ticket 40 left. They're part of what to build:

- **Retention uses `retentionDaysInEffect`** (ticket 06): a saved instance setting, including "keep", wins over `OSTRA_RETENTION_DAYS`. The sweep records each run, with its time and counts, as an audit entry `retention.swept`. The storage screen's "last run" reads it (ticket 31).

## Done when

- [x] Tests: a merge releases the box once and deletes the hidden ref; an offline runner gets its `release` later; a box idle for 14 days is released by its delayed job, and one that ran a turn in between isn't; retention off deletes nothing; retention on deletes only finished tasks' content past the period and records it; another organization's rows are untouched.
- [x] Committed as `✨ add cleanup and retention`.

## Comments
- 2026-11-20, core (sessions): done in `9e8c4fa` (`✨ add cleanup and retention`). Core and domain typecheck, lint and test green, check:licenses green. For tickets 16, 31, 37, 38 and 39:
  - **`releaseBox`** (`packages/domain/src/use-cases/cleanup.ts`): under the task's lock, a ready or idle box stops and is released with its reason at once (so the dispatch never picks it again), its lease ends, and its runner gets one `release` command (a week's `notAfter`, so an offline runner gets it from the outbox when it reconnects; a retry of the job finds the command already there). A runner below minor 1 gets none, and the box's `releasedAt` is set then; otherwise the runner's `done` ack sets it (`applyReleaseResultsInTx` in `apps/core/src/cleanup/cleanup.ts`, from `onCommandResultsInTx`).
  - **Ticket 16 sends `box.release`** (reason `prs-closed`) when the task's last PR merges or every PR closes: `recordPullRequestState` is still its stub, so the tests here set the task merged as 16 would. The handler releases the box, then deletes the hidden ref (`hiddenRefFor(taskId)`) from each repo through `deleteRef` once the task is merged or stopped with `prs_closed` and none of its boxes is kept (`hiddenRefsToDelete`), and clears `hiddenRefSha` and `hiddenRefBaseSha`. A task that can still be reopened keeps its ref. An `unsupported` code host is logged and skipped; any other failure throws so the job retries.
  - **`box.release-after-idle`** (sent by ticket 17 when a box goes idle or stops, cancelled when a turn starts in it) releases the box with `idle_expired` only if it's still idle or stopped. The daily retention pass also runs `sweepCleanup`, which enqueues `box.release` for any box idle or stopped past the idle days whose timer was lost.
  - **`retention.sweep`** (`41 3 * * *` UTC): reads `retentionDaysInEffect` (a saved setting, "keep" included, wins over `OSTRA_RETENTION_DAYS`) and does nothing when it's `null`. Otherwise, for at most 500 tasks a run that are stopped, merged or done, last changed before the cutoff and still holding events or blobs, it deletes the blobs through the blob service (the S3 objects too), the events and the live-text rows, clears the sessions' archive columns, and writes `task.history_removed` on the task (events, blobs, the days). Each run records one `retention.swept` per organization with `{ tasks, events, blobs, retentionDays }`, zero included, for the storage page's "last run". The task row, its task repos, its turns and its audit entries stay.
  - **On `host`,** the runner removes OpenCode's tool outputs on `release` (ticket 23, `f036a04`). The configuration reference already says cleanup deletes refs, never LFS objects (Q120).
