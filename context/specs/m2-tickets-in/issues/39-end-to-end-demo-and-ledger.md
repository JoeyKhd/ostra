# 39: The end-to-end demo and the ledger

Status: ready-for-agent
Builder: core (lead), with each builder on call for their part
Blocked by: 20, 33, 34, 35, 36, 37, 38
Features: every F-ID in the spec's section 2
Packages: `e2e/m2-tickets-in/` (new), `package.json` (`pnpm e2e:m2`), `context/features.md`, `context/specs/m2-tickets-in/demo.md` (new), this ticket's `## Comments`
Spec: `../spec.md`, section 3

## What to build

- **`e2e/m2-tickets-in/`:** a script that runs spec section 3 against a fresh dev stack and the test workspaces. It signs in as milestone 1's default first admin (`demo@demo.com` / `demo` unless `OSTRA_ADMIN_*` says otherwise, with `OSTRA_ALLOW_DEFAULT_PASSWORD=true`), reuses milestone 1's helpers for the provider, the App, the project and the runner, seeds the Linear connection from the values the maintainer's run saved (ticket 40; development only, never in production), attaches `OST`, creates the ticket through the API, starts it from the Inbox with Playwright, waits for the PR and the ticket's moves, lets the box idle (`OSTRA_BOX_IDLE_MINUTES=2`), releases the worktree, reopens on a second runner, merges, and runs the checks after the run. Steps 1 and 8's real day are the manual run's.
- **The run, by hand, once,** in a real browser, following section 3 step by step: Connect Linear for real, and the reopen at least 24 hours after the PR. What was seen goes in `demo.md` (times, the ticket's and the PR's URLs, the archive's size and the after-turn time per turn, the restore time, anything that surprised), with screenshots as milestone 1's demo has them, secrets masked.
- **The ledger:** in the same commit as the record, set each row of section 2 to the status its "At M2's end" column says, if and only if every condition in its "done when" holds. Rows that wait for Linux, for milestone 4's invites or a second agent (F-018, after v1 since 2026-11-19; F-033's note) stay `building`, each with a short dated note naming what's left.

## Decided 2026-11-19 (ticket 40)

The lead, on the maintainer's delegation, settled the open points the milestone 2 targets (`context/brand/app-targets/m2/`) and ticket 40 left. They're part of what to build:

- **Two runs, recorded apart** (spec section 3, "Until the maintainer authorizes the Linear app"):
  - **The overnight run** seeds the connection with `e2e/m2-tickets-in/seed-linear.ts` from `LINEAR_API_KEY`. It registers a workspace webhook on the tunnel with `webhookCreate`, and deletes the webhook when the run ends. It runs steps 2 to 7 and 9, the checks, and the failure suite.
  - **The morning run** does step 1 by hand, then steps 8 and 9.
- **The repo checks** wait on ticket 40's step 3: public repos or a paid plan, `test1`'s ruleset, `test2`'s `ostra-demo-signed-commits` ruleset, and `GITHUB_TEST_ADMIN_TOKEN`. Until then they're recorded as waiting, not as failed.
- **"Starts no CI" (F-096)** is checked again on the demo's own hidden ref: 0 workflow runs for its commit within 60 s.

## Done when

- [x] `pnpm e2e:m2` passes on this machine twice in a row from an empty data folder.
- [ ] A ticket in `OST` became a PR on `ostra-test/test1` from the Inbox, linked on the ticket, the ticket moved, and the task reopened a day later on a fresh worktree and another runner with its context, all recorded in `demo.md`.
- [ ] Every check after the run passes, and ticket 38's suite passes.
- [x] What waits for Linux is listed in `demo.md` and in the ledger notes.
- [ ] All the checks for the whole repo pass.
- [ ] Committed as `✅ add the milestone 2 end-to-end demo`, and the record and ledger as `📝 set milestone 2's ledger statuses`.

## Comments

- 2026-11-19, core (m2-integrate): **the overnight run passes end to end.** `e2e/m2-tickets-in/` (`pnpm e2e:m2`, `✅ add the milestone 2 end-to-end demo`, `8e0b82d`, and the fixes after it) seeds the Linear connection from `LINEAR_API_KEY` with a webhook on a quick tunnel, attaches `OST` in the panel, makes a real ticket, starts it from the Inbox, and follows it to the PR, the idle stop, a reopen on a second runner from the session archive, and the merge, then runs the checks after the run: no duplicates (on Linear, in the writer's outbox, on GitHub), the PR's key, cleanup, no credential anywhere, no CI for a hidden ref, "Create ticket", a reopen that resumes a warm box, a reopen from the rebuild template alone (5 of 5 in the final runs), drift with the webhook gone, and polling mode. It passed **three times in a row from an empty data folder** (runs B, C and D, 22 of 22 checks each); the record, the screenshots and the logs are in `../demo.md`, `../demo/` and `../live/`. The final run's ticket is OST-79 and its PR https://github.com/ostra-test/test1/pull/75 (merged).
  - **Fixed on the way, each with a test:** a runner restarted while a session waited between turns dropped it silently, leaving it idle forever (`ca68b7a`); the first prompt held ostra's own progress comment (`a5608e2`); a failed hidden-ref push now names git's reason (`8b47566`).
  - **Not done:** the reopen "a day later" with a refreshed token, and step 1's real Authorize, are the maintainer's morning run (ticket 40); ticket 38's suite isn't built, so box 3 waits on it and on the repo checks (ticket 40's public repos or paid plan); box 5 is the whole-repo run below. The ledger rows are `building` with dated notes, not `done`: none has its proof file yet, and several rest on ticket 38.
  - **Dependencies:** none added. `@ostra/e2e-m1` gained an exports map and `setup.ts` (milestone 1's demo steps, shared).
