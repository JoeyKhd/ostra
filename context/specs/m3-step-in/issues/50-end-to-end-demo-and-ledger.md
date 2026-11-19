# 50: The end-to-end demo and the ledger

Status: ready-for-agent
Builder: core (lead), with each builder on call for their part
Blocked by: 21, 24, 25, 29, 30, 31, 32, 33, 42, 43, 44, 45, 46, 47, 48
Features: every F-ID in the spec's section 2
Packages: `e2e/m3-step-in/` (new), `package.json` (`pnpm e2e:m3`), `context/features.md`, `context/proof/`, `context/specs/m3-step-in/demo.md` and `demo/` (new), this ticket's `## Comments`, `README.md`
Spec: `../spec.md`, section 3

## What to build

- **`e2e/m3-step-in/`:** a script that runs spec section 3 against a fresh dev stack and the test workspaces. It signs in as milestone 1's default first admin with `OSTRA_ALLOW_DEFAULT_PASSWORD=true`, seeds Sam with `pnpm dev:seed-member sam`, reuses milestones 1 and 2's helpers for the provider, the App, the projects, Linear and the runner, starts the fake MCP server on loopback, drives both members' browsers with Playwright, uses the test token for the pushes, the merge and the `@ostra` comments, cancels the ticket through Linear's API, sets `OSTRA_EMAIL_DELAY_SECONDS=0`, and reads mail delivery back from Resend's API. Then the checks after the run.
- **The run, by hand, once,** in real browsers as two members, following section 3: the GitHub link's OAuth for real, the mails read in the maintainer's own inbox, the Linear notification seen on the maintainer's Linear account. What was seen goes in `demo.md` (times, URLs, the mails' and comments' screenshots with addresses masked, anything that surprised).
- **The ledger:** in the same commit as the record, set each row of section 2 to the status its "At M3's end" column says, if and only if every condition in its "done when" holds. Rows that wait for Linux (F-051, F-094) or for milestones 4 and 6 (F-036, F-115) stay `building`, each with a short dated note naming what's left.
- **The proofs** (`context/proof/README.md`): every row set to `done` has its `context/proof/F-nnn.md`, every condition `proved` by a test that names the row's ID and has a break-it check, or by live evidence from this run kept in `context/specs/m3-step-in/demo/` (logs and screenshots, secrets and addresses masked). The `building` rows get their proof files too, with what's proved so far.
- **The README:** milestone 3's status line, as it is.

## Done when

- [ ] `pnpm e2e:m3` passes on this machine twice in a row from an empty data folder.
- [ ] Every step of section 3 happened in the manual run, recorded in `demo.md`.
- [ ] Every check after the run passes.
- [ ] What waits for Linux is listed in `demo.md` and in the ledger notes.
- [ ] `pnpm check:proof` passes with every `done` row of section 2 proved.
- [ ] All the checks for the whole repo pass.
- [ ] Committed as `✅ add the milestone 3 end-to-end demo`, and the record and ledger as `📝 set milestone 3's ledger statuses`.

## Comments
