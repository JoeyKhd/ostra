# 32: Runner: checks after a turn

Status: ready-for-agent
Builder: runner
Blocked by: 01, 14, 15
Features: F-054
Packages: `apps/runner` (milestone 2's after-every-turn code)
Spec: `../spec.md`, section 4 ("Checks"); ADR 0052

## What to build

- **After a turn with changes,** between the commit and the push (milestone 2's order: commit, then this, then push, hidden ref, archive): run the spec's checks through the executor's `runChecks`, emit `check.started` and `check.finished` per check, upload each full output as a blob (milestone 2's bulk path), and add the results to `session.saved`. A turn without changes runs no checks.
- **Limits:** each check's timeout, and `OSTRA_CHECKS_TOTAL_MINUTES` for all of them; past the total, the rest are reported `timed-out` without running.
- **Nothing blocks the push:** a failing check is reported and the push goes on; the draft is core's (ticket 23).
- **The environment:** a check gets the environment's variables and the task's working tree, never a model key, a GitHub token or the runner's own environment (the executor's contract, ticket 05).
- A check's output is untrusted and is never logged.

## Done when

- [ ] Tests: two checks run in order after a turn with changes and none after one without; a timeout and the total cut; the blob is uploaded and named in the event; the push happens after a failure; on `host` with the real executor.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ run checks after a turn`.

## Comments
