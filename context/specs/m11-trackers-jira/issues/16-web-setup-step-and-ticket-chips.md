# 16: Web: Home's tracker step and the ticket chips

Status: in-review
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

- [x] The targets are approved, recorded under `## Comments` with the date and the maintainer's words.
- [x] Tests named for `F-152/c7`: Home's step 4 in its five states for both kinds, as component tests (`setup-steps.test.tsx`), and a Playwright case in `apps/web/e2e/02-setup.spec.ts` asserting step 4's words, both marks, `Skip for now` and the link to `/organization/trackers`.
- [ ] Tests named for `F-152/c7`, the other half: "connecting Jira ticks it". **Blocked on ticket 13 (2026-11-23):** Trackers (t12) lists connections and its picker leads to a connection's page, which draws no Jira connect steps yet (t13 writes them), so there is no site/token/webhook flow to drive. The step's own assertions are already in `02-setup.spec.ts`; add the connect case when t13 lands.
- [x] Tests named for `F-152/c4`: `apps/web/e2e/32-ticket-chips.spec.ts` (with its `chips` scenario in `e2e/seed-boards-mixed.ts`) shows a Linear and a Jira ticket in the Inbox with their marks and tooltips, a Jira task's header, Ticket group and On Jira rows, the sidebar's line, a search result and New task's line; run: 1 passed (desktop).
- [x] Tests named for `F-008/c6`: a Jira ticket's sub-task count and status square show where the target draws them (component test and the Playwright spec above).
- [x] Screenshots at 1440 px and 390 px, both themes, compared with the targets, under `## Comments`: `_lead/ui-check/m11/16/`, twelve files.
- [x] Checks for `apps/web` pass (spec section 10): typecheck clean, 110 touched tests pass, eslint clean on the touched files.
- [x] Committed as `✨ name each ticket's tracker with its mark` (19b8d1ea).

## Comments

- 2026-11-23, lead: the maintainer approved the m11 targets ("yes to all"), recorded in `context/brand/app-targets/m11-trackers/README.md`.

- 2026-11-23, web (t16), built: step 4 `Connect a tracker` (`checklist.tracker.*`) in its five states for both kinds — open with both 14px marks, `Skip for now` and `Connect a tracker →` to `/organization/trackers`; pending/failed naming the newest connection, `Continue →`/`Replace the token →`/`Authorize again →` on `/organization/trackers/<id>`; done `Connected <mark> <name>.`; skipped — and the chips with each payload's `connection`: the Inbox row's one-colour mark (14px, tooltip `Jira · Globex Jira`) and its sub-tasks/sub-issues chip word; the task key line's 14px brand mark; the Ticket group's `Tracker` (16px mark, name, `· <connection>`), `Status` with Jira's category square, `Sub-tasks`/`Sub-issues` with `· 1 done`; `On Jira` with each move's `by <transition>` and Jira's `remote link`; the thread meta's 13px mark; the sidebar's 12px mark; search's mark and connection name; New task's 15px mark. Also the Inbox lede and the sub-task page's `Open in <tracker>` no longer say Linear. `taskPageTrackerOf` deleted with its uses in `task-files.ts`; `trackerName` names Jira. Tests: `setup-steps.test.tsx` (F-152/c7, five states × both kinds), `inbox-view.test.tsx` (F-152/c4 rows, chips, panel, lede), `task-ticket.test.tsx` (F-152/c4 Tracker/On Jira/via; F-008/c6 sub-tasks, done share, category square), `ticket-context.test.tsx`, `live-task-row.test.tsx`, `task-heading`, `phone-task-sections`, `ticket-parent-view` pass (110 tests).
- 2026-11-23, web (t16), written and unrun: `apps/web/e2e/32-ticket-chips.spec.ts` with its `chips` scenario in `e2e/seed-boards-mixed.ts` (a Linear team and a Jira project on one project, their cached tickets, a running `PROJ-12` task with `via` writes). It is a browser spec held for the milestone's end; run it with `OSTRA_E2E_SHOTS=C:/Users/santi/ow/_lead/ui-check/m11/16 pnpm --filter @ostra/web test:e2e -- --project desktop e2e/32-ticket-chips.spec.ts`. No screenshots were taken at 1440/390 in both themes: the box stays open.
- 2026-11-23, web (t16), gap: the `F-152/c7` Playwright half ("connecting Jira ticks it" in `02-setup.spec.ts`) waits on tickets 12 and 13 — `/organization/trackers` and Jira's connect steps are not on `main` yet, so there is no page to connect through. The component half is in place; add the Playwright case when 12 and 13 land.
- 2026-11-23, web (t16), checks: `pnpm turbo run typecheck --filter=@ostra/web --filter=@ostra/api` clean; touched web tests 9 files / 110 tests pass; `eslint apps/web` and `@ostra/api` lint ran once, and its findings (`==` and one default-parameter) are fixed in 19b8d1ea. No whole suite, no Proof run.
- 2026-11-23, web (t16), rebased onto `origin/main` (648d614b, with ticket 12's Trackers page): no conflict, behaviour unchanged.
- 2026-11-23, web (t16), screenshots at 1440 and 390, dark and light, under `C:/Users/santi/ow/_lead/ui-check/m11/16/`: `ticket-chips-inbox` (marks, tooltips, sub-task chip, `Open in Jira`), `ticket-chips-task` (key line, Ticket group, On Jira, sidebar), `setup-checklist` (a fresh organization's step 4). The Inbox's key column was widened (96px at md, 92px at xl) so the 14px mark and the key both fit; the title cell still truncates early at 1440 with the double sidebar (noted by t15), and this ticket changes nothing else there.
- 2026-11-23, web (t16), Playwright commands and results: `OSTRA_E2E_PORT=3200 pnpm --filter @ostra/web test:e2e -- e2e/32-ticket-chips.spec.ts --project desktop --project phone --no-deps` → 1 passed (37.7s; the phone project skips the `@desktop-only` spec by tag); `OSTRA_E2E_PORT=3200 npx playwright test e2e/02-setup.spec.ts --project desktop --no-deps` → 4 passed (39.0s). The `chips` seed also creates a second organization with no tracker (Home's step 4) and its task's title/ticket search entries, and the spec shoots the phone pages in one context.
- 2026-11-23, web (t16), one copy gap against `ticket-chips.md`: an "On Jira" move reads `Moved the ticket · by Start progress`; the target's `Moved to In Progress` needs the move's target status, which `TicketWrite` stores only as the write's payload, not in `tasks.get`'s `move` view. Small follow-up in the API.
