# 41: The end-to-end demo and the ledger

Status: ready-for-agent
Builder: core (lead), with each builder on call for their part
Blocked by: 09, 13, 14, 18, 19, 20, 21, 32, 33, 34, 35, 36, 37, 38, 39, 40, 48, 49, 53, 54 (and ticket 55's second key and second GitHub organization for the live half of steps 15 to 17)
Features: every F-ID in the spec's section 2
Packages: `e2e/m4-the-organization/` (new), `package.json` (`pnpm e2e:m4`), `context/features.md`, `context/proof/`, `context/specs/m4-the-organization/demo.md` and `demo/` (new), this ticket's `## Comments`, `README.md`
Spec: `../spec.md`, section 3

## What to build

- **`e2e/m4-the-organization/`:** a script that runs spec section 3 against a fresh dev stack and the test workspaces. It signs in as milestone 1's default first admin with `OSTRA_ALLOW_DEFAULT_PASSWORD=true` and `OSTRA_INSIGHTS_INTERVAL_MINUTES=1`, starts ticket 40's mail sink and points SMTP at it, reuses milestones 1 to 3's helpers for the provider, the App, the projects, Linear, the runner and the `Careful` profile, drives three browsers (Demo, Sam, Rae) with Playwright, reads the invitation, verification and reset links from the sink, links the reviewer user to Sam with `pnpm dev:link-github`, sets and removes branch protection with the test token, approves and dismisses reviews with `GITHUB_TEST_REVIEWER_TOKEN` and the test token, and merges with the test token. For steps 15 to 17 (added 2026-11-19, ADR 0065) it uses ticket 55's `model-b.env` and second GitHub organization when they exist, and otherwise two stub model endpoints and the fake GitHub's second account, and writes which into `demo.md`. Then the checks after the run.
- **The run, by hand, once,** in real browsers as three people, following section 3: mail through Resend to the maintainer's own address and plus addresses, the reviewer user linked to Sam through the App's OAuth for real, and the check's state read on GitHub's own PR page. What was seen goes in `demo.md` (times, URLs, the mails' and the check's screenshots with addresses masked, anything that surprised), and **which of `in_progress` or `action_required` GitHub needed to block the merge,** written also into ADR 0040's amendment.
- **The ledger:** in the same commit as the record, set each row of section 2 to the status its "At M4's end" column says, if and only if every condition in its "done when" holds. F-111 stays `building` with a dated note (the AI finding's "Remember this", milestone 6). F-110's note says that ADR 0044's Q91 changes are built. F-086, F-033 and F-036 get dated notes for what milestone 4 added. F-135 and F-136 go to `done` only if every condition holds; F-021, F-088, F-089, F-006 and F-078 get dated notes for what tickets 45 to 51 added.
- **The proofs** (`context/proof/README.md`, spec section 9.1): every row set to `done` has its `context/proof/F-nnn.md`, every condition `proved` by a test that names the row's ID and has a break-it check, or by live evidence from this run kept in `context/specs/m4-the-organization/demo/` (logs and screenshots, secrets and addresses masked). The `building` rows get their proof files too, with what's proved so far.
- **The README:** milestone 4's status line, as it is.

## Done when

- [ ] `pnpm e2e:m4` passes on this machine twice in a row from an empty data folder.
- [ ] Every step of section 3 happened in the manual run, recorded in `demo.md`.
- [ ] Every check after the run passes.
- [ ] `pnpm check:proof` passes with every `done` row of section 2 proved.
- [ ] All the checks for the whole repo pass.
- [ ] Committed as `✅ add the milestone 4 end-to-end demo`, and the record and ledger as `📝 set milestone 4's ledger statuses`.

## Comments
