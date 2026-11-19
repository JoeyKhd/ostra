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
- **The ledger:** in the same commit as the record, set each row of section 2 to the status its "At M2's end" column says, if and only if every condition in its "done when" holds. Rows that wait for Linux, for milestone 4's invites or milestone 7's second agent stay `building`, each with a short dated note naming what's left.

## Done when

- [ ] `pnpm e2e:m2` passes on this machine twice in a row from an empty data folder.
- [ ] A ticket in `OST` became a PR on `ostra-test/test1` from the Inbox, linked on the ticket, the ticket moved, and the task reopened a day later on a fresh worktree and another runner with its context, all recorded in `demo.md`.
- [ ] Every check after the run passes, and ticket 38's suite passes.
- [ ] What waits for Linux is listed in `demo.md` and in the ledger notes.
- [ ] All the checks for the whole repo pass.
- [ ] Committed as `✅ add the milestone 2 end-to-end demo`, and the record and ledger as `📝 set milestone 2's ledger statuses`.

## Comments
