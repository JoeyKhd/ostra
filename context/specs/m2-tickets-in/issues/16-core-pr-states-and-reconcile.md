# 16: Core: PR states and the GitHub reconcile

Status: ready-for-agent
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

- [ ] Tests against the fake code host: a merge by webhook and by reconcile give the same result, once; a replayed delivery changes nothing, and a control handler without the state lookup does act twice (F-046, ADR 0037); closing every PR stops the task; one PR merged and one closed unmerged gives `merged`, in both orders of the two events; a reopened PR moves the repo back, and the task back to in review; another organization's PR with the same number is untouched.
- [ ] Gated on `github-test.env`: a PR merged on `test1` moves its task to merged within 5 min with the webhook route blocked.
- [ ] Committed as `✨ add PR states and the GitHub reconcile`.

## Comments
