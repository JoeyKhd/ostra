# 32: Runner: checks after a turn

Status: done
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

- [x] Tests: two checks run in order after a turn with changes and none after one without; a timeout and the total cut; the blob is uploaded and named in the event; the push happens after a failure; on `host` with the real executor.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ run checks after a turn`.

## Decided 2026-11-19

Decided on the maintainer's delegation while preparing the build, from the open points of the milestone 3 targets (`context/brand/app-targets/m3/`) and the spec's gaps. If the maintainer disagrees with one, it goes back to `context/open-questions.md` and this section changes.

- **Which checks run** (`task-checks.md`, point 1; Q188). A check that names a repo runs only when the turn changed that repo, in the repo's folder; one that names none runs once, at the workspace root, when the turn changed any repo. The order stays the environment's. A check that doesn't apply to the turn isn't run and emits nothing. Test: a two-repo turn that changed one repo.

## Comments
- 2026-11-19, runner: done in `✨ run checks after a turn` (c0770fc). **The order:** `saveWork` (`apps/runner/src/task-host/task-run.ts`) now commits with the executor's new `commitWork` (committed and pushed nothing, and says which repos the turn changed: each head against where it was when the box got ready, was restored or last committed), runs the checks that apply (`runTurnChecks`, `apps/runner/src/task-host/turn-checks.ts`), then pushes with `commitAndPush({ pushOnly: true })`, so what a check left in the tree isn't in the branch, then the hidden ref and the archive as before; `session.saved` carries `checks: [{ checkId, status }]` when any ran. The contracts (`commitWork`, `pushOnly`) are additive and were pushed in `✨ add setup cache fields and commitWork` (80f733f); `host` implements them and `docker` delegates to its inner host executor on the task volume. **Each check** runs as its own `runChecks` call, so `check.started` goes up as it starts, with `min(its timeout, what's left of the total)`; past the total the rest get `check.started` and `check.finished` with `timed-out`, no exit code and no blob. Its output file is uploaded on the bulk path (`check-output`, `text/plain`) and removed; a failed upload leaves `outputBlobId: null`. The variables are each repo's non-secret ones, as the agent gets them; the secrets stay in the env files. **Not run:** a spec without checks, a peer below minor 2, a turn that changed nothing, and a session being stopped, crashed or cut by its spend cap (the stop isn't held for the checks); a `commitWork` failure falls back to milestone 2's commit and push without checks. Proof: F-054's second row (partial: the panel and the PR body are tickets 23 and 47). Break-it checks: seven (checks on every turn, a failure holding the push, a fresh commit at the push, no total, no upload, a repo's check on any change, every repo changed in `commitWork`), each failing its test.
