# 16: Core: PR states and the GitHub reconcile

Status: done
Builder: core
Blocked by: 09, 13
Features: F-031, F-044, F-046, F-079
Packages: `apps/core` (`src/code-host/`), `packages/domain` (`recordPullRequestState`)
Spec: `../spec.md`, section 4 ("A PR's state")

## What to build

- **The App's webhook,** through ticket 13's inbox: a `pull_request` delivery for a task repo's PR (matched by the repo and the PR number) runs `recordPullRequestState`.
- **`recordPullRequestState`:** moves the task repo to `merged` or `closed_unmerged` (and back to `pr_open` on `reopened`), records `mergedAt` or `closedAt`, and feeds the task's transitions through ticket 06's rule over the task's task repos (Q107, settled 2026-11-19): while one PR is open the task is in review; none open and at least one merged → `merged`; none open and none merged → `stopped` (`prs_closed`). The answer is the same whichever event arrives last, and a webhook and the reconcile agree. A PR reopened on GitHub puts a `merged` task, or one stopped as `prs_closed`, back in review. A repo whose PR closed unmerged shows that on the task. Each move writes ticket 15's rows (the merge's "done", the comment edit) and, when no PR is left open, a `box.release` job (ticket 20).
- **`github.reconcile-prs`:** a schedule every `OSTRA_RECONCILE_MINUTES` (5) per organization, over task repos with a PR open, reading each PR through `getPullRequest` within the rate budget. With webhooks off, a merge reaches the task within 5 min (F-044).
- A PR the App didn't open, or a repo outside the project, is ignored.

## Done when

- [x] Tests against the fake code host: a merge by webhook and by reconcile give the same result, once; a replayed delivery changes nothing, and a control handler without the state lookup does act twice (F-046, ADR 0037); closing every PR stops the task; one PR merged and one closed unmerged gives `merged`, in both orders of the two events; a reopened PR moves the repo back, and the task back to in review; another organization's PR with the same number is untouched.
- [x] Gated on `github-test.env`: a PR merged on `test1` moves its task to merged within 5 min with the webhook route blocked.
- [x] Committed as `✨ add PR states and the GitHub reconcile`.

## Comments

- 2026-11-19, core (m2-core-a): built. **Domain:** `recordPullRequestState`'s body (`use-cases/pull-request-states.ts`) and the pure Q107 rule `pullRequestsOutcome` (in review while a PR is open; merged when none is open and one merged; stopped when none merged). The PR is found by the connection, the code host's repo ID and its number, under the task's row lock, so the webhook and the reconcile meet in one place; merged is final, a report older than the recorded close or merge is `stale`, and a PR seen closed then merged is reopened, then merged. Each change writes ticket 15's rows (the merge's "done" when the board's `doneBy` is `ostra`, the comment's edit) and an audit entry; the task's move writes its own comment edit; no PR left open enqueues `box.release` (reason `prs-closed`) per box not released, for ticket 20's handler. **Contract changes, additive:** a task input `pr_reopened` (a merged task, or one stopped as `prs_closed`, back to in review, waiting for a reviewer; refused anywhere else, with lifecycle tests), and `taskOutcome` gained `"in-review"`. **Core:** `code-host/pull-requests.ts` has `webhook.process`'s GitHub handler (it reads the stored body through the adapter's `parseWebhook`; the inbox verified it), `github.reconcile-prs` over the connection's task repos with a PR open (at most 200 a pass, stopping at the App's rate limit), and a schedule per active GitHub connection every `OSTRA_RECONCILE_MINUTES`, made from the rows in core's 30 s tick. Tests: `pull-requests.test.ts` (8 cases on the fake code host, the F-046 control included: a handler acting on every delivery without the state lookup records the merge twice, the real one once). **Live, on `ostra-test/test1`** (github.env and github-test.env, 2026-11-19): a PR opened by the App and merged through the API moved its task to merged on the first reconcile pass, with no webhook route at all; the test deletes its branch after.
