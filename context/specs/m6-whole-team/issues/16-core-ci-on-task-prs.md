# 16: Core: CI on the task's PRs

Status: done
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

- [x] Tests named `it("F-035: ...")` on the fake code host: each verdict, with ostra's own check left out; "no CI" at the deadline with no webhook; the wait limit; a failed verdict's log tails stored, capped, at most five; a replayed webhook writes nothing new; the sub-state follows two PRs' verdicts.
- [x] Break-it: ostra's own check counted (so its pending state blocks forever) fails its test; recorded in `context/proof/F-035.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ read CI on the task's PRs`.

## Comments

- 2026-11-20, core: built as `✨ read CI on the task's PRs` (a2fa20a9). Readings and differences:
  - **`ci.evaluate`** (`apps/core/src/review-loop/ci.ts`, the domain's `evaluateCi` in `packages/domain/src/review-loop/evaluate-ci.ts`): keyed by the task repo and the head, 10 s apart (`singletonSeconds`), enqueued by a `ci` hint from the App's webhook (`check_run`, `check_suite`, `status`; ostra's own App's runs are no hint), by a PR's opening or new head (`pull_request` `opened`, `reopened`, `synchronize`, `ready_for_review`), and by milestone 2's PR reconcile, which covers an App without the check events. A head with its verdict already isn't read again, so the reconcile costs nothing after that. The two delayed evaluations carry a `deadline` (`none`, `wait`) in the payload, an additive field keyed apart, so a waiting timer never holds back a webhook's evaluation under the one-per-key rule.
  - **A person's push.** The head the host reports is recorded on the task repo, which until now only the runner's saves moved; while the AI review reads the old head, that review run fails and the code task goes back to "CI running" (ticket 17's `failReviewOnHeadMoveInTx`).
  - **The verdict and the sub-state** as the ticket says; the combined verdict waits while any open PR's head is pending or unread. `timed_out` moves on as a pass, with `ci.updated` saying `timed_out`.
  - **The logs:** each failing check's tail is a blob of the task (purpose `ci-log`), its ID and the check's name on `CiRun.logBlobIds`. The file the agent reads is named `<blobId>.log`, not `<check>.log`: a check's name is untrusted text and may not be a file name.
  - **An optional capability.** All of it runs only when the code host declares `ciResults` (and `reviewComments` for the AI review): the GitHub adapter has them off until ticket 08, so a live install keeps milestone 5's path until then. The fake code host has them off by default too, and the review loop's tests turn them on (`reviewLoop`).
  - **Proof:** `apps/core/src/review-loop/ci.test.ts`, on the fake code host, with a harness (`apps/core/src/testing/review-loop.ts`) that runs the loop's jobs from a recorded queue and the agent's turns through core's real ingest. Break-it: counting ostra's own App's check (`ownAppSlug` `null` in `evaluateCi`) left its pending independent-review check holding CI, and the verdict test failed. Recorded in `context/proof/F-035.md`.
  - **Checks:** whole-repo typecheck, lint of `packages/domain` and `apps/core`, their tests, `check:licenses` and `check:proof`.
