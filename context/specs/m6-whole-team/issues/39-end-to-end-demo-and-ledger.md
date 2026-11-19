# 39: The end-to-end demo and the ledger

Status: ready-for-agent
Builder: core (lead), with each builder on call for their part
Blocked by: 10 to 23, 31 to 38
Features: every F-ID in the spec's section 2, and F-010, F-036, F-111 and F-048
Packages: `e2e/m6-whole-team/` (new), `package.json` (`pnpm e2e:m6`), `context/features.md`, `context/proof/`, `context/specs/m6-whole-team/demo.md` and `demo/` (new), this ticket's `## Comments`, `README.md`
Spec: `../spec.md`, section 3

## What to build

- **`e2e/m6-whole-team/`:** a script that runs spec section 3 against a fresh dev stack and the test workspaces. It signs in as milestone 1's default first admin with `OSTRA_ALLOW_DEFAULT_PASSWORD=true` and `OSTRA_SCHEDULE_MIN_INTERVAL_MINUTES=1`, reuses milestones 1 to 5's helpers (the provider, the App, the projects, Linear, the runners and the pool, the mail sink, `dev:link-github`), invites Sam, sets `test2`'s AI review off, points `test1`'s review profile at the stub reviewer, drives two browsers (Demo, Sam) with Playwright, creates tickets with the personal key, submits and approves reviews with `GITHUB_TEST_REVIEWER_TOKEN`, merges with the test token, stops and starts core for the missed occurrence, and runs steps 9 and 10's agent-mode parts only with `LINEAR_REFRESH_TOKEN` (the fake Linear otherwise, reported as skipped). Then the checks after the run.
- **The run, by hand, once,** in real browsers as two people, following section 3: the real model for both agents, mail through Resend to the maintainer's own address and a plus address, the reviewer user linked to Sam through the App's OAuth, and step 10 with the maintainer's own "Send stop request". What was seen goes in `demo.md` (times, URLs, the reviews' and the agent session's screenshots with addresses masked, what the real review found, anything that surprised).
- **The ledger:** in the same commit as the record, set each row of section 2 to the status its "At M6's end" column says, if and only if every condition in its "done when" holds; F-010, F-036, F-111 and F-048 likewise. F-113 stays `building` with a dated note (the box from the base image and its services wait for Linux). F-012 is `done` only if step 10's stop and ticket 38's run happened with the app token; otherwise `building` with a dated note naming what's left. F-107's note says whether milestone 5's pool cap was in. F-017's note gains the refine, review and onboarding tasks for its Linux run.
- **The proofs** (`context/proof/README.md`, spec section 9.1): every row set to `done` has its `context/proof/F-nnn.md`, every condition `proved` by a test that names the row's ID and has a break-it check, or by live evidence from this run kept in `context/specs/m6-whole-team/demo/` (logs and screenshots, secrets and addresses masked). The `building` rows get their proof files too, with what's proved so far and the plan for the rest in the notes.
- **The README:** milestone 6's status line, as it is.

## Done when

- [ ] `pnpm e2e:m6` passes on this machine twice in a row from an empty data folder.
- [ ] Every step of section 3 happened in the manual run, recorded in `demo.md`, or is recorded as not run with the reason (the app token, a person's stop).
- [ ] Every check after the run passes.
- [ ] `pnpm check:proof` passes with every `done` row of section 2 proved.
- [ ] All the checks for the whole repo pass.
- [ ] Committed as `✅ add the milestone 6 end-to-end demo`, and the record and ledger as `📝 set milestone 6's ledger statuses`.

## Comments
