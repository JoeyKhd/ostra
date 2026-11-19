# 35: Web: the Inbox

Status: ready-for-agent
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

## Done when

- [ ] Component tests: rows, filters in the URL, the existing task, start, the empty state ("no boards yet" and "nothing open").
- [ ] A Playwright run against the fake Linear server: a ticket created in the fake shows without a reload and starts a task.
- [ ] Committed as `✨ add the Inbox`.

## Comments
