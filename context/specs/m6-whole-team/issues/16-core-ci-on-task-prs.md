# 16: Core: CI on the task's PRs

Status: ready-for-agent
Builder: core
Blocked by: 06, 08
Features: F-035
Packages: `apps/core` (`src/review-loop/ci.ts`), `packages/domain` (`evaluateCi`)
Spec: `../spec.md`, section 4 ("CI"); ADR 0058

## What to build

- **`ci.evaluate`,** keyed by the task repo and head, `singletonSeconds` 10, enqueued by a `check_run`, `check_suite` or `status` webhook for a task PR's head, a PR opening or a push to it, and milestone 2's PR reconcile (which also covers an App without the events).
- **The verdict:** `listCiResults`, ostra's own App's check runs left out (its slug from the App's record), then `ciVerdict`: `none` when nothing appeared within `OSTRA_CI_NONE_SECONDS` of the push, `pending` while anything runs, `failed` when any run concluded `failure`, `timed_out` or `action_required` or any status is `failure` or `error`, `passed` otherwise; `timed_out` after `OSTRA_CI_WAIT_MINUTES` pending. A delayed `ci.evaluate` at the "none" deadline and the wait limit makes sure each verdict comes without a webhook.
- **`CiRun`** per head, and `ci.updated` in the thread when the state changes. The code task's sub-state follows the combined verdict over its open PRs: any `failed` → a CI round (ticket 18); all `passed` or `none` → the AI review (ticket 17), or "waiting for a reviewer" with AI review off; `timed_out` → the AI review with the CI marked "still running".
- **The logs:** for a `failed` verdict, up to `OSTRA_CI_LOG_CHECKS` failing checks' log tails through `getCiLog`, `OSTRA_CI_LOG_TAIL_KIB` each, stored as blobs (milestone 2) with their IDs on the `CiRun`. Never logged, never in an event.

## Done when

- [ ] Tests named `it("F-035: ...")` on the fake code host: each verdict, with ostra's own check left out; "no CI" at the deadline with no webhook; the wait limit; a failed verdict's log tails stored, capped, at most five; a replayed webhook writes nothing new; the sub-state follows two PRs' verdicts.
- [ ] Break-it: ostra's own check counted (so its pending state blocks forever) fails its test; recorded in `context/proof/F-035.md`.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ read CI on the task's PRs`.

## Comments
