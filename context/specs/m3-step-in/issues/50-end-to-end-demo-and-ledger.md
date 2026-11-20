# 50: The end-to-end demo and the ledger

Status: needs-triage
Held: the end-to-end demo runs once, at the launch gate, over the finished product. The maintainer, 2026-11-20: "i think this 'demo' thing you are doing is taking a loooooong time".
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
- [x] What waits for Linux is listed in `demo.md` and in the ledger notes.
- [ ] `pnpm check:proof` passes with every `done` row of section 2 proved.
- [ ] All the checks for the whole repo pass.
- [ ] Committed as `✅ add the milestone 3 end-to-end demo`, and the record and ledger as `📝 set milestone 3's ledger statuses`.

## Decided 2026-11-19

Decided on the maintainer's delegation while preparing the build, from the open points of the milestone 3 targets (`context/brand/app-targets/m3/`) and the spec's gaps. If the maintainer disagrees with one, it goes back to `context/open-questions.md` and this section changes.

- **Mail without a Resend key** (Q186). Until `email.env` holds the key (ticket 51, step 1), the scripted run sets email to SMTP on a local SMTP server that the script starts in-process (ticket 04's `node:net` server), and reads the mails back from it for steps 3 and 15 and the mail checks. With the key, it uses Resend as section 3 says. The live Resend send and its delivery readback stay a maintainer step, and F-115 stays `building` as section 2 already says.
- **`@ostra` (step 10)** needs the test App's webhook and events, and a token for the linked member's GitHub user (ticket 51, steps 9 and 10). Without them the scripted run skips step 10, and this ticket's comments say so. The repo checks of milestone 2 still wait for `test1` and `test2` to be public (milestone 2's ticket 40, step 3).

## Comments

- 2026-11-19, runner (ticket 14): **waits for Linux.** Two live suites, gated on a Docker host with the images built (`OSTRA_TEST_BASE_IMAGE`, `OSTRA_TEST_RUNNER_IMAGE` from `deploy/`), skip themselves on this machine: `packages/adapters/adapter-executor-docker/src/snapshot/snapshot.live.test.ts` (a snapshot built with BuildKit and its setup secret mounted, scanned clean, kept and started from, the box's volume holding the checkouts; a setup that writes the secret's base64 into a file fails with `secret-found` and the image is deleted; a service from `OSTRA_TEST_SERVICE_IMAGE`, default `redis:7-alpine`, healthy by its health check and reached by name from the agent's container) and milestone 1's `docker.live.test.ts`. The nightly rebuild after a default branch moved needs a `docker` pool runner online against the dev stack, as spec section 3 says. List them in `demo.md` and the F-051 and F-094 ledger notes.
- 2026-11-19, integrate (ticket 50): the scripted run, step by step on one fresh stack on `host` against `ostra-test` (`e2e/m3-step-in/`, commit `4eea2cf`; the record in `demo.md` and `demo/`). Steps 1 to 9 and 11 to 16 ran live; step 10 (`@ostra`) waits for ticket 51 steps 9 and 10; mail went over SMTP to the script's own server (Q186). The run found and fixed four bugs (`54194b1`, `b8d9a26`, `60d0a3d`, `761a908`, the last a member's commit lost on a reopen) and wired tickets 43 to 47's screens (`3af06b0`). Not ticked: two passing runs in a row from an empty data folder, the run by hand, and every `done` row proved: no milestone 3 row can be `done` until the panel's Playwright cases land, so the ledger sets them `building` with dated notes.
- 2026-11-19, final check (ticket 50): the whole repo's typecheck, lint, test, `check:licenses` and `check:proof` passed through turbo at `a8f1f0b`. Then one run of section 3 from a fresh clone of `origin/main` (`4ecbd15`) on an empty data folder (`demo.md`, "The final check"): 59 of 60 checks passed. Two earlier starts stopped on bugs, fixed first: a model one provider lists twice (`x` and `x:batch`) resolved to no provider, so no task could start (`896be41`), and `test1`'s main kept the first run's `releaseName`, so the rule never asked (`02dec7e`); the cancel step's turn now runs long enough for Linear's webhook (`0f46480a`). The failed check found a ticket task dispatched by core's requeue sweep before its ticket was rendered, so the agent started with no ticket: fixed in `0c632ad9`. Still not ticked: two runs in a row, the run by hand, every check passing, and the `done` rows: no milestone 3 row is fully proved (the panel's Playwright cases of tickets 43 to 47 are still open), so every row of section 2 stays `building` with its note.
- 2026-11-20: held for the launch gate on the maintainer's word.
