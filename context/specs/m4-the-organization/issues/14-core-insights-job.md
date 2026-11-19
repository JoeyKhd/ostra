# 14: Core: the Insights job

Status: ready-for-agent
Builder: core
Blocked by: 06, 12
Features: F-108
Packages: `apps/core` (`src/reactions/insights.ts`), `packages/domain` (`computeInsights`)
Spec: `../spec.md`, section 4 ("Insights"); ADR 0055, ADR 0035

## What to build

- **`insights.compute`:** a pg-boss schedule every `OSTRA_INSIGHTS_INTERVAL_MINUTES` (5). Per organization, it finds the days whose source rows changed since `InsightRun.lastRunAt` (task PRs opened or closed, needs-you items ended, tasks created), always including today and yesterday, and recomputes those days' `InsightDaily` rows (the organization's and each project's) and the touched tasks' `TaskMetric`, from ticket 06's definitions. It records `lastRunAt` in the same transaction.
- **Idempotent:** a run twice over the same data writes the same rows; two runs at once take a per-organization advisory lock.
- **Read only ostra's own tables** (ADR 0035): `TaskPullRequest`, `NeedsYouItem`, `Task`, `SpendDaily`. No code host or tracker call.
- **Medians** are computed at read time over `TaskMetric` in the period (ticket 28), so the job stores facts, not medians.

## Done when

- [ ] Tests named `it("F-108: ...")` on a fixture with tasks, PRs (merged, closed unmerged, open), and needs-you items of several reasons across a period's edges: each figure equals ticket 06's reference; a second run changes nothing; a PR merged after the run appears after the next one.
- [ ] Break-it: an off-by-one-day window in the job fails a test; recorded in `context/proof/F-108.md`.
- [ ] Committed as `✨ add the Insights job`.

## Comments
