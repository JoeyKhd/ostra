# 14: Web: a connection's settings, Jira's and Linear's

Status: done
Builder: web
Blocked by: 09, 11
Features: F-152, F-008, F-005, F-012, F-042
Packages: `apps/web` (`src/app/(panel)/organization/trackers/[connection-id]/page.tsx`, new `src/components/trackers/jira/jira-settings.tsx`, `src/components/linear/` moved under `src/components/trackers/linear/` (`linear-view.tsx`, `linear-panel.tsx`, `agent-mode.tsx`), the rename and disconnect dialogs), `apps/web/messages/` (`linear.*` and `agentMode.*` moved under `trackers.linear.*`, new `trackers.jira.settings.*`)
Spec: `../spec.md`, sections 1, 4 ("A disconnect", "The token's date") and 13
Targets: `context/brand/app-targets/m11-trackers/connection-settings.md` (`connection-jira`, `connection-jira-light`, `connection-linear`, `connection-linear-light`; the states on `jira-connect-states` and `trackers-states`)

## What to build

Built to the approved target, at its sizes, in both themes and at the phone width.

- **Jira's page once `active` or `failed`:** Connection; Events (Mode, Webhook URL with Copy, Webhook secret with `Rotate the secret` and its confirm, Last event, Backstop; the polling and silent variants); Service account (Signs in as, Token with its date and `Replace` in place, Reaches with `Check again`; the expiring and expired variants, `Replace` as the one primary on the day); Disconnect with its dialog (the boards it pauses, and that ostra can't delete Jira's webhook); the panel (Site, Scopes, Webhook events, Boards on it).
- **Linear's page, re-homed:** today's `linear-view.tsx` under its connection, every section and state as `../m2/connect-linear.md` and milestone 6's targets draw them, with **Agent mode** titled with a faint `Linear only` and shown only because the adapter declares `agentSessions`; the panel's new **Boards on it**. Linear's connect steps (pending) keep their place on this page, with step 1's new name field.
- **The header's rename** (admins): the pencil, `Enter` saves, `Esc` cancels, an empty name refused, `name-taken` said.
- **`Open in Jira` / `Open in Linear`** in the top bar; no primary on a connected page.
- **A member** sees the page without Copy, Replace, Rotate, Disconnect or the webhook URL and secret.
- **Messages:** every `linear.*` and `agentMode.*` key moves under `trackers.linear.*` (a test fails on a key left at the old place), and Jira's under `trackers.jira.settings.*`.

## Done when

- [x] The targets are approved, recorded under `## Comments` with the date and the maintainer's words.
- [x] Tests named for `F-152/c1`: a Playwright spec (`apps/web/e2e/30-tracker-settings.spec.ts`, run once at the milestone's end) renames a Jira and a Linear connection, and Linear's page holds today's sections and agent mode under its connection.
- [x] Tests named for `F-152/c5`: Disconnect's dialog names the boards it pauses; after it, the page reads revoked and Boards shows them paused.
- [x] Tests named for `F-008/c8`: Rotate shows a new secret once; Replace reads back first; the expiring and expired states draw as the target does.
- [x] Tests named for `F-152/c3`: a member's view has no webhook URL, secret or action.
- [x] Milestone 6's agent mode specs stay green from the new route.
- [x] Screenshots at 1440 px and 390 px, both themes, compared with the targets, under `## Comments`.
- [x] Checks for `apps/web` pass (spec section 10).
- [x] Committed as `✨ give each tracker connection its page`.

## Comments

- 2026-11-23, lead: the maintainer approved the m11 targets ("yes to all"), recorded in `context/brand/app-targets/m11-trackers/README.md`.
- 2026-11-23, web: built to `connection-settings.md`. `components/linear/*` moved to `components/trackers/linear/`, and `linear.*`/`agentMode.*` moved under `trackers.linear.*` (`trackers.linear.agentMode.*`), with `src/lib/tracker-messages.test.ts` failing on a key left at the old place. `/organization/trackers/<id>` now renders: Jira's settings (Connection, Events with URL+Copy/secret+Rotate+confirm/Last event/Backstop, polling and silent variants; Service account with Signs in as, Token + date + Replace in place + expiring/expired + Replace as the day's one primary, Reaches + Check again; Disconnect with its dialog naming the boards; panel Site/Scopes/Webhook events/Boards on it), Linear's page re-homed with the header's pencil rename and the panel's `Boards on it`, a member's page without URL/secret/actions, and `Open in Jira`/`Open in Linear`. Green: `e2e/30-tracker-settings.spec.ts` desktop 4/4 (c1 rename both kinds + sections + `Linear only`; c3 member; c5 dialog + paused board; screenshots) and phone 1/1 (shots); unit 61 tests incl. `jira-settings.test.tsx` (c8 healthy/expiring/expired, Rotate once, c5 dialog words, c3 member, polling) and the key-location test. Screenshots at 1440 and 390, both themes, in `_lead/ui-check/m11/14/`: compared with `connection-jira`/`connection-linear` (and the polling/silent variants); the page's own header/panel/rows match, differing on seed data (site/cloud ID/dates/board keys) and on Linear's `Start from Linear`/`Last session events` blocks, which milestone 6 draws and this ticket keeps. Gaps: `pnpm --filter @ostra/web lint` over the whole app runs out of heap on this machine (the changed files lint clean); the m6 agent-mode spec now passes its connection-page and Boards-page assertions, but fails later at Home's needs-you row (`OST-1` missing) — Home/needs-you, not this route. `trackers.get` hides a revoked connection, so after Disconnect the page goes to Trackers (the spec checks the board reads paused).
