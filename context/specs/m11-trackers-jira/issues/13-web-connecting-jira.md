# 13: Web: connecting Jira

Status: done
Builder: web
Blocked by: 09, 11
Features: F-008, F-152
Packages: `apps/web` (new `src/app/(panel)/organization/trackers/[connection-id]/page.tsx`, new `src/components/trackers/jira/` (`jira-connect.tsx`, `jira-steps.tsx`, `jira-readback.tsx`, `jira-webhook-step.tsx`)), `apps/web/messages/` (`trackers.jira.connect.*`)
Spec: `../spec.md`, sections 4 ("Connecting Jira") and 13
Targets: `context/brand/app-targets/m11-trackers/jira-connect.md` (`jira-connect`, `jira-connect-light`, `jira-connect-webhook`, `jira-connect-webhook-light`, `jira-connect-polling`, `jira-connect-polling-light`, `jira-connect-states`, `jira-connect-phone`)

## What to build

Built to the approved target, at its sizes, in both themes and at the phone width.

- **The connection's page while `pending`** (`/organization/trackers/<id>`, the same route ticket 14 fills once it's `active` or `failed`): the header with the 36px mark, the lede, the started line with `Start again`, `Connect Jira` and the done count.
- **Step 1, the site:** the `https://` `[name]` `.atlassian.net` field (a pasted URL trimmed), the name prefilled, `Find the site` on `trackers.jira.findSite`; the three errors, the site already connected with `Open it →`; `Change`.
- **Step 2, the token:** the scopes as chips from `trackers.get`, the email, the token (password with an eye), the expiry date; `Check the token` on `trackers.jira.checkToken`, the read-back box with its four lines and their three outcomes, `Save and continue` / `Save anyway` / `Check again`; the refused line with the status code; `Replace`.
- **Step 3, the webhook:** the URL, secret and JQL copy fields, the six events, the lock line, the wait row polling `trackers.jira.webhook` every 3 s, `Use polling instead`; a wrong signature's red row with `Make a new secret`; the first delivery turning the page into the settings with `Just connected`.
- **No public address:** step 3 as `Events: polling`, the reasons in the words of `linear.addressProblem.*` with Jira for Linear, `Finish` on `trackers.jira.finishPolling`.
- **The properties panel:** Mode, The token needs, Webhook events, It sees.
- **The keyboard and screen readers** as the target says: only the current step reachable, copy buttons labelled and announcing `Copied`, the read-back a list, a failed line an alert.
- **Never shown to a member:** the page's steps, the URL, the secret (ticket 09 doesn't send them).

## Done when

- [x] The targets are approved, recorded under `## Comments` with the date and the maintainer's words.
- [x] Tests named for `F-008/c1`: a Playwright spec (`apps/web/e2e/29-jira-connect.spec.ts`, run once at the milestone's end) connects the fake Jira's site through the three steps by webhook (the fake sends the first delivery), and another by polling; each step's failure shows its words.
- [x] Tests named for `F-152/c2`: the site already connected is refused with `Open it →` to the holder.
- [x] Tests named for `F-008/c8`: a token whose date is within 14 days shows the warning on step 2's done line.
- [x] Screenshots at 1440 px and 390 px, both themes, compared with the targets, under `## Comments`.
- [x] Checks for `apps/web` pass (spec section 10).
- [x] Committed as `✨ connect a Jira site in three steps`.

## Comments

- 2026-11-23, lead: the maintainer approved the m11 targets ("yes to all"), recorded in `context/brand/app-targets/m11-trackers/README.md`.
- 2026-11-23, web: built to the target. `/organization/trackers/<id>` while `pending` draws the header (36px mark, eyebrow, name, lede), the started line with `Start again`, `Connect Jira` and the done count, the three checked steps (site, token read-back, webhook or polling) and the panel (Mode, The token needs, Webhook events, It sees); once active it draws the connected row with `Just connected` (ticket 14 grows the settings). `29-jira-connect.spec.ts` (`seed-jira-connect.ts`) connects the fake Jira's site through the three steps by webhook — its first signed delivery reaches core's inbox and activates it — and by polling; it refuses the same site with `Open it →` to the holder, and shows the 13-day token warning on step 2's done line; 6 passed at 1440 and 390. Keyed unit tests (`jira-words.test.ts`, `jira-readback.test.tsx`) read the same words and markup (F-008/c1, F-152/c2, F-008/c8). Web typecheck, lint and 891 tests pass. Screenshots at 1440/390 in both themes in `_lead/ui-check/m11/13/`. Commit `bfe34c17`. Gaps: the connected state is the target's top row only (ticket 14); the step-3 URL in the screenshots is the target's public address, as the e2e stack's is loopback.
