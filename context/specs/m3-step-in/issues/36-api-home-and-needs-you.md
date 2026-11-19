# 36: API: Home and the needs-you list

Status: ready-for-agent
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

- [ ] Tests: Home lists only the member's projects' items, every needs-you reason renders (each seeded once), the board groups by state, unread counts move on read and on answer; a member of another organization sees nothing.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `api`.
- [ ] Committed as `✨ add the Home and needs-you API`.

## Comments
