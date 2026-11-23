# 12: Web: Organization › Trackers

Status: done
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

- [x] The targets are approved, recorded under `## Comments` with the date and the maintainer's words.
- [x] Tests named for `F-152/c1`: a Playwright spec (`apps/web/e2e/28-trackers.spec.ts`, run once at the milestone's end) lists four connections of two kinds with their marks, names, modes, states and panel; `/organization/linear` lands on the first Linear connection's page.
- [x] Tests named for `F-152/c8`: the picker's Trello and Notion are disabled, unfocusable and say `Coming soon`.
- [x] Tests named for `F-152/c3`: a member sees the list without `Connect a tracker` and with the member line.
- [x] Tests named for `F-008/c9`: Jira's panel lists `Agent mode – not in Jira` and nothing else of agent mode.
- [x] Screenshots of the built page at 1440 px and 390 px, both themes, compared with the targets, under `## Comments`.
- [x] Checks for `apps/web` pass (spec section 10).
- [x] Committed as `✨ list every tracker connection`.

## Comments

- 2026-11-23, lead: the maintainer approved the m11 targets ("yes to all"), recorded in `context/brand/app-targets/m11-trackers/README.md`. This ticket waits for tickets 09 and 11; its components can be built against the targets first.
- 2026-11-23, builder: built to `trackers.md`. `/organization/trackers` on `trackers.list`: the table (each kind's 20px brand mark, name over kind, site, mode, last event, status with Pending's/Failed's reason), the properties panel (status and its since, mode incl. Silent since, last event with its ticket, signs in as, token, the boards, "What <kind> does here" from the adapter's declarations, `Open <name> →`), the `Kept apart` line, the loading skeleton and every state the target draws. The picker (dialog at 600px, bottom sheet on a phone) with Linear and Jira tiles and their declared-capability chips, Trello and Notion `Coming soon` (aria-disabled, unfocusable, no link/form), `Continue with <kind>` → `trackers.create` → the new connection's page. The empty page's tiles and the panel's How it works/Kept apart. Members read the list under the member line, with no Connect and no sign-in/token rows. Keys: `c` opens the picker (or the empty tiles take focus), `↑`/`↓` move the selection, `Enter` opens, `Space` selects; the picker's `←`/`→`/`Tab`, `Space`, `Enter`, `Esc`, Coming-soon skipped. Navigation: the Connections group's row is `Trackers` (Lucide `ticket`, count in mono) for every member, and `/organization/linear` redirects to the first Linear connection's page or to Trackers. Linear's page re-homed to `/organization/trackers/<id>`; Jira's `[connection-id]/page.tsx` stays the panel stub for ticket 13, and `tracker-mark.tsx` is unchanged.
- 2026-11-23, builder, tests: `apps/web/e2e/28-trackers.spec.ts` (+ `e2e/seed-trackers-world.ts`) names `F-152/c1` (four connections of two kinds with marks, names, sites, modes, last events, states and Globex's panel; `/organization/linear` lands on the first Linear connection) and passes; `trackers-view.test.tsx` names `F-152/c1`, `F-152/c3`, `F-152/c8`, `F-008/c9`; `linear/page.test.tsx` names the redirect. `e2e/routes.ts`/`seed-routes-world.ts` now walk both new routes (and Linear's old one), so milestone 7's built walk still covers every `page.tsx`. Commands: `pnpm turbo typecheck lint test --filter=@ostra/web --cache-dir=C:/Users/santi/ow/.turbo-cache` → 25/25 tasks green (870 tests on the rebased tree); `npx playwright test 28-trackers.spec.ts --project desktop` against the e2e stack → 1 passed.
- 2026-11-23, builder, screenshots: `_lead/ui-check/m11/12/side-by-side-1440-{dark,light}.png` and `side-by-side-390-{dark,light}.png` (built beside the target; the phone target exists only in dark), with the raw shots in `_lead/ui-check/m11/12/live/`. The layout, sizes, marks and states match. Remaining differences are the seed's data (organization name, `since 2 Nov`, `14 Jan 2028`, project colours) and the app-wide phone type scale (the shell's 54px bar and 26px `h1` against the picture's 52/24; the page's own card and lede sizes match).
- 2026-11-23, builder: rebased onto `origin/main` cleanly (no conflicts; the WIP commit `wip: m11 t12 web trackers` squashed into this one).
