# 12: Web: Organization › Trackers

Status: ready-for-agent
Builder: web
Blocked by: 09, 11
Features: F-152, F-008, F-005
Packages: `apps/web` (new `src/app/(panel)/organization/trackers/page.tsx`, new `src/components/trackers/` (`trackers-view.tsx`, `trackers-panel.tsx`, `tracker-picker.tsx`), `src/app/(panel)/organization/linear/page.tsx` (the redirect), `src/components/shell/places.ts`), `apps/web/messages/` (`trackers.*`)
Spec: `../spec.md`, sections 1, 12 and 13
Targets: `context/brand/app-targets/m11-trackers/trackers.md` (`trackers`, `trackers-light`, `trackers-picker`, `trackers-picker-light`, `trackers-empty`, `trackers-empty-light`, `trackers-states`, `trackers-phone`)

## What to build

Built to the approved target, at its sizes, in both themes and at the phone width (`context/brand/app-design.md`). Its build spec holds the layout, every state's words and the components; this ticket holds what the target can't.

- **The route** `/organization/trackers` on `trackers.list`: the table (Connection with its 20px brand mark, Workspace or site, Mode, Last event, Status with its reason), the properties panel for the selected connection (Connection, Boards on it, "What <kind> does here" from the connection's `capabilities`, `Open <name> →`), the kept-apart line, the loading skeleton.
- **The picker** (a dialog; a bottom sheet on a phone): Linear and Jira tiles with their capabilities' chips from the adapters' declarations, Trello and Notion `Coming soon` (disabled, not focusable, no link), `Continue with <kind>` calling `trackers.create` and opening the new connection's page.
- **The empty state:** the picker's tiles on the page, the panel's "How it works" and "Kept apart".
- **States:** Connected (webhooks, polling), Pending (`No delivery yet`, `Not authorized yet`), Failed with its reason, Silent, Token expires; a member's view (no `Connect a tracker`, the member line).
- **Navigation:** the organization panel's Connections group shows `Trackers` (Lucide `ticket`, the count in mono) instead of `Linear`; `/organization/linear` redirects to the first Linear connection's page, or to Trackers when there's none.
- **The keyboard** as the target says (`↑`/`↓`, `Enter`, `c`; the picker's `←`/`→`, `Space`, `Enter`, `Esc`, the Coming-soon tiles skipped); milestone 7's keyboard walk and contrast check stay green on the page.
- **Messages** under `trackers.*`, as the target lists them.

## Done when

- [ ] The targets are approved, recorded under `## Comments` with the date and the maintainer's words.
- [ ] Tests named for `F-152/c1`: a Playwright spec (`apps/web/e2e/28-trackers.spec.ts`, run once at the milestone's end) lists four connections of two kinds with their marks, names, modes, states and panel; `/organization/linear` lands on the first Linear connection's page.
- [ ] Tests named for `F-152/c8`: the picker's Trello and Notion are disabled, unfocusable and say `Coming soon`.
- [ ] Tests named for `F-152/c3`: a member sees the list without `Connect a tracker` and with the member line.
- [ ] Tests named for `F-008/c9`: Jira's panel lists `Agent mode – not in Jira` and nothing else of agent mode.
- [ ] Screenshots of the built page at 1440 px and 390 px, both themes, compared with the targets, under `## Comments`.
- [ ] Checks for `apps/web` pass (spec section 10).
- [ ] Committed as `✨ list every tracker connection`.

## Comments

- 2026-11-23, lead: the maintainer approved the m11 targets ("yes to all"), recorded in `context/brand/app-targets/m11-trackers/README.md`. This ticket waits for tickets 09 and 11; its components can be built against the targets first.
