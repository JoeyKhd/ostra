# 28: API: Insights

Status: resolved
Builder: api
Blocked by: 14
Features: F-108
Packages: `packages/api` (`src/routers/insights.ts` (new))
Spec: `../spec.md`, section 4 ("Insights"); ADR 0055

## What to build

- **`insights.get({ projectId | null, period })`:** the period as a preset (7, 30, 90 days) or two UTC dates. Returns the six figures of ADR 0055 from `InsightDaily` and `TaskMetric` (medians computed here, over the period's `TaskMetric` rows, with the count each is over), a series per day for PRs opened and merged, waiting by reason, tokens and spend by project and model from `SpendDaily`, and `computedAt` from `InsightRun`.
- **Access:** an organization's Insights for any member, with hidden projects folded into "Other projects"; a project's for members who can open it.
- **No live numbers:** nothing here reads tasks, PRs or events directly.

## Done when

- [x] Tests named `it("F-108: ...")`: each figure equals ticket 06's reference for a fixture and period; "—" for a merge rate with no closed PR; the medians' counts; a hidden project's name never appears; `computedAt` is the job's.
- [x] Committed as `✨ add Insights to the API`.

## Comments
