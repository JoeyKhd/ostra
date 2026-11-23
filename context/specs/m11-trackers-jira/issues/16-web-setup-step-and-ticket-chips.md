# 16: Web: Home's tracker step and the ticket chips

Status: ready-for-agent
Builder: web
Blocked by: 09, 10, 11
Features: F-152, F-008, F-076
Packages: `apps/web` (`src/components/home/setup-checklist.tsx`, `setup-steps.tsx`, `src/components/inbox/inbox-view.tsx`, `src/components/tasks/task-ticket.tsx`, `ticket-icons.tsx`, the thread's "What the agent got" meta line, the sidebar's live tasks, search results, New task's prompt-ticket line), `apps/web/messages/` (`checklist.tracker.*`, `taskPage.tracker.*`)
Spec: `../spec.md`, sections 1 and 13
Targets: `context/brand/app-targets/m11-trackers/setup-checklist.md` (`setup-checklist`, `setup-checklist-light`; the step's states on `trackers-states`) and `ticket-chips.md` (`ticket-chips`, `ticket-chips-light`)

## What to build

Built to the approved targets, at their sizes, in both themes and at the phone width.

- **Home's step 4,** `Connect a tracker`: its id `tracker`, the body with both marks, `Connect a tracker →` to `/organization/trackers`, `Skip for now`; Pending, Failed, Done and Skipped naming the connection, each kind's words, from `setup.status`'s `tracker` step.
- **The ticket chips,** with each ticket payload's `connection`:
  - Inbox rows: the one-colour mark before the key, its tooltip `<Kind> · <connection>`, the sub-tasks or sub-issues count;
  - a task's header: the brand mark, `<KEY> · from <Kind>`, Jira's status with its category square, `Open in <Kind> ↗`;
  - the Ticket group: `Tracker`, `Status` with its square or icon, `Sub-tasks` or `Sub-issues`; the "On <Kind>" group with each write's `via` (`Moved to In Progress · by Start progress`);
  - "What the agent got"'s meta line, the sidebar's live tasks, search results (one-colour), New task's line (brand).
- **The words** by kind (`Sub-tasks` and `Sub-issues`, `Jira` and `Linear`); the capability decides whether a row shows.
- **Milestone 10's open tickets** on `task-ticket.tsx` or the thread's meta line: this ticket waits for one on the same file, and says so here.

## Done when

- [ ] The targets are approved, recorded under `## Comments` with the date and the maintainer's words.
- [ ] Tests named for `F-152/c7`: Home's step 4 in its five states for both kinds (component tests), and a Playwright case (in `apps/web/e2e/02-setup.spec.ts`) connecting Jira ticks it.
- [ ] Tests named for `F-152/c4`: a Playwright spec (`apps/web/e2e/32-ticket-chips.spec.ts`, run once at the milestone's end) shows a Linear and a Jira ticket in the Inbox with their marks and tooltips, a Jira task's header, Ticket group and On Jira rows, and the sidebar's line.
- [ ] Tests named for `F-008/c6`: a Jira ticket's sub-task count and status square show where the target draws them.
- [ ] Screenshots at 1440 px and 390 px, both themes, compared with the targets, under `## Comments`.
- [ ] Checks for `apps/web` pass (spec section 10).
- [ ] Committed as `✨ name each ticket's tracker with its mark`.

## Comments

- 2026-11-23, lead: the maintainer approved the m11 targets ("yes to all"), recorded in `context/brand/app-targets/m11-trackers/README.md`.
