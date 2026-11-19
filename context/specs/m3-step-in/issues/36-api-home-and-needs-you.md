# 36: API: Home and the needs-you list

Status: done
Builder: api
Blocked by: 20
Features: F-062, F-036
Packages: `packages/api` (`routers/home.ts`, `routers/notifications.ts` (new))
Spec: `../spec.md`, sections 1 ("Home exists"), 2 (F-062, F-036) and 4 ("A notification")

## What to build

`home.overview` exists (`packages/api/src/routers/home.ts`, built on 2026-11-19 to milestone 1's Home target): the member's projects, the first five tasks that need you (from each task's needs-you reason and its latest events), the projects' counts, recent activity from the audit log, spend and runners. Grow it; don't replace it.

- **Needs you from the items:** `home.overview`'s needs-you rows come from the open `NeedsYouItem` rows the member is the audience of, or can answer (every open approval of their projects), newest first, each with its reason, its task (key, title, project) and what's needed to answer inline (an approval's options and pattern, a plan's entries, a question's fields). A task with two open items shows both. **`home.needsYou(cursor)`** pages the full list for "Open all".
- **Running and recent** stay as `home.overview` has them, with the recent activity gaining the milestone 3 actions a person cares about (an approval answered, a plan approved, a take-over, a PR comment accepted).
- **`home.board`:** the organization's tasks grouped by state (`domain-model.md`'s order), each with its project, key, title, driver and age, with a filter by project.
- **`notifications.list(tab: "open" | "done", cursor)`**, **`.markRead(ids)`**, **`.unreadCount`**: the member's own notifications for the "Needs you" page and the sidebar's count.
- Every query is scoped by organization and by the projects the member can open, with indexes for the Home's three lists, and returns in under 200 ms for 1,000 open items on the reference laptop *(working value)*.

## Done when

- [x] Tests: Home lists only the member's projects' items, every needs-you reason renders (each seeded once), the board groups by state, unread counts move on read and on answer; a member of another organization sees nothing.
- [x] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `api`.
- [x] Committed as `✨ add the Home and needs-you API`.

## Decided 2026-11-19

Decided on the maintainer's delegation while preparing the build, from the open points of the milestone 3 targets (`context/brand/app-targets/m3/`) and the spec's gaps. If the maintainer disagrees with one, it goes back to `context/open-questions.md` and this section changes.

- **`home.board` returns what the cards need** (`home-board.md`, "Data"): per card, the status line's source (the open needs-you item's reason and detail, the queue's pool or runner, the latest activity for running and preparing, the in-review sub-state with the PR numbers, the stop reason); the column totals apart from the page of cards, with a cursor per column; and the 7-day window for `merged`, `done` and `stopped`, by the time the task entered that state. Nothing is dropped from the card.

## Comments

- 2026-11-19: done in COMMIT. `home.overview`'s needs-you rows now come from the open items (`routers/needs-you-view.ts`: `listOpenNeedsYou` and `loadNeedsYouViews`, shared with `home.needsYou` and `notifications.list`); `home.board` is `routers/home-board.ts`; `notifications.list`, `.markRead` and `.unreadCount` join `notifications.preferences` in `routers/notifications.ts`. A task in `needs_you` with no open item (one from before items) still shows, as a row with `itemId: null`. A task's "what the agent is doing" moved to `routers/task-doing.ts` (`loadDoingByTask`), which the project list and the board both read. Recent activity gains `approval.answered`, `plan.answered`, `task.driver-changed` and `pr.comment-accepted` (the last is the name ticket 25 is to audit under; no code writes it yet). The 200 ms for 1,000 open items is not measured here: every list is a bulk query by task, kind and project, never one per row, and the Home lists sit on the indexes the migration made (`(memberId, state)`, `(memberId, readAt)`, `(projectId, state)`); a measured run belongs to the end-to-end demo. A finished card's age is its task's `updatedAt`, the nearest thing to when it entered the state. Proof rows: F-062 (3 partial), F-036 (row 2 gains the list's tests).
