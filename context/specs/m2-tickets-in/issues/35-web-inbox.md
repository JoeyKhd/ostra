# 35: Web: the Inbox

Status: done
Builder: web
Blocked by: 29, 32 (the targets' approval, for the UI)
Features: F-010, F-007
Packages: `apps/web` (`src/app/(panel)/projects/[project-id]/inbox/`, `src/components/inbox/`, `messages/en.json`)
Spec: `../spec.md`, sections 3 (steps 3 and 4) and 12 (screens 4 and 11)

## What to build

To the approved targets for screens 4 and 11.

- **The list:** one row per ticket: key, title, status, labels, priority, the board when the project has several, the time of its last change, and its task when it has one (state and link). Paged by cursor; the newest change first.
- **Filters:** status (the mapped open ones by default), label, priority, assignee and text, kept in the URL.
- **The preview:** the ticket's cached description and a link to Linear, rendered as untrusted markdown (no raw HTML, links open in a new tab with `rel="noopener noreferrer"`).
- **Start task:** one action, with the kind and the agent profile prefilled from the project's defaults and changeable, and "run on" as in milestone 1. A ticket that already has an active task offers "Open task" instead.
- **Live:** a change notice refreshes the list, so a ticket made in Linear shows without a reload.
- "Inbox" in the project's navigation (`app-design.md`). At phone width: one column, the preview as a sheet.

## Decided 2026-11-19 (ticket 40)

The lead, on the maintainer's delegation, settled the open points the milestone 2 targets (`context/brand/app-targets/m2/`) and ticket 40 left. They're part of what to build:

- **`cmdk` is allowed** for the filters' `Command` (ticket 34 adds it first; whoever lands first adds it, pinned, with the lockfile).
- **The sidebar's Inbox count** reads `projects.list`'s `inboxCount` (ticket 29).
- **Start task and New task share the `Run on` logic:** pull it out of `new-task-form.tsx`, don't copy it.
- **Below `xl`,** the ticket panel opens as a right `Sheet`. At phone width it's a bottom `Sheet`, a side `components/ui/sheet.tsx` gains (`phone-inbox.md`).

## Done when

- [x] Component tests: rows, filters in the URL, the existing task, start, the empty state ("no boards yet" and "nothing open").
- [x] A Playwright run against the fake Linear server: a ticket created in the fake shows without a reload and starts a task.
- [x] Committed as `✨ add the Inbox`.

## Comments

- 2026-11-19, web: built and committed (`✨ add the Inbox`, `05ceba5`) to `inbox`, against ticket 29's `inbox.list`, `inbox.get`, `inbox.filters` and `tasks.startFromTicket`, and checked side by side at 1440×956 on the dev board for ostra-test's `OST` team, with cached tickets seeded into the dev database (core's polling, ticket 14, isn't on main yet).
  - `components/inbox/`: `inbox-view.tsx` (rows on one grid, the Board and Task columns only when they hold something; `?ticket=` selection; the four filters and the text filter in the URL; the lede with the cache's age, `polling every 60 s`, and the red stale line; the panel with the untrusted description, Start task or the active task, an earlier task named; the three empty states with `inbox-empty-illustration.webp`, now in `public/`), `inbox-words.ts`, `ticket-icons.tsx` (priority bars and status marks, drawn once, `--muted`), `safe-markdown.tsx` (paragraphs, lists, code, bold and http(s) links only, built as React elements, images counted not shown). Tested.
  - **Run on is shared:** `components/tasks/run-on.tsx` (`useRunOn`, `RunOnPicker`, `POOLS`, the composer `Trigger`) is pulled out of `new-task-view.tsx`, which now imports it.
  - Pages are fetched with the plain tRPC client inside `useInfiniteQuery`, because tRPC's infinite options add a `direction` that `inbox.list`'s strict input refuses.
  - The project's navigation gains `Inbox` (with `projects.list`'s `inboxCount`) between Tasks and Environment.
  - **Not built yet:** "Live" is a 10 s refetch of the first page and the selected ticket, not a change-notice subscription (the stream has no project-scoped notices for the panel yet); below `xl` the panel stacks under the list rather than opening as a right `Sheet`, and at phone width there's no bottom `Sheet` (`phone-inbox`); `↑`/`↓` don't move the selection; the Kind select shows `Code` only and the profile is read-only. **The Playwright run against the fake Linear server** has ticket 33's blocker (no setting points the panel at another Linear) and also needs core's ingest (ticket 14).
- 2026-11-20, m2-linear-e2e: the Playwright run is in (`✅ prove Connect Linear and the Inbox end to end`, `bd3b538`, on `✨ follow OSTRA_LINEAR_API_URL in Connect Linear`, `d7ebfae`). Every box holds.
  - `apps/web/e2e/22-linear-inbox.spec.ts`, second case (`F-007/c1, F-010/c1,c2, F-042/c1`), after the first connects Linear: **the board is attached through the panel** (the project's Boards page, the fake's team `OST`, its mapping drafted), not seeded. With the Inbox open, a ticket is made on the fake through the shipped adapter; it reaches the cache by core's poll (the connection polls: core is on loopback) and shows with no reload or navigation. The text filter narrows the list to it; its panel offers Start task with `Code` and the project's own default profile prefilled; Start task makes the task (`Queued` on the row, `Open task`), whose page shows the ticket and the profile.
  - **Live is two paths now:** the project's change notice, which core's poll sends, invalidates the Inbox (`task/change-scopes.ts`, milestone 6), and the 10 s refetch backs it up. The break-it cut both (`inbox-view.tsx`, `change-scopes.ts`), and the case failed; cutting only the refetch didn't.
  - F-010 is `done` (`context/proof/F-010.md`). F-042's row stays `partial`: the case doesn't measure the 60-second bound.
