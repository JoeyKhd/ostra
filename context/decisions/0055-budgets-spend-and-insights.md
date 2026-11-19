# Budgets, spend and Insights

**Status:** accepted (2026-11-19, on the maintainer's delegation for milestone 4's spec). Settles Q199 and Q200. Covers F-037 and F-108, and builds on ADR 0042 (budgets, and metering at the key proxy), ADR 0035 (Insights aren't live), ADR 0037 (background work on pg-boss) and ADR 0050 (notifications).

ADR 0042 says where spend is counted and what a budget does at 80% and 100%. This ADR settles how spend adds up to a month, where the gate stands, what a model with no price does, and what each Insights figure means.

## Spend

- **One rollup, written at ingest.** Milestone 2 prices every `usage.recorded` on its four token kinds and adds it to the session and the task. Milestone 4 adds it, in the same transaction, to a `SpendDaily` row per project, day (UTC) and model, with the four token counts, the money, and the tokens of calls that had no price. The task's, project's and organization's figures, the budgets and Insights all read it, so they can't disagree.
- **Money is US dollars,** in micro-dollars, as milestone 2 stores it. One currency per install for v1.
- **Prices, in order** (ADR 0042): the endpoint's own list, models.dev, then an admin's price. The admin's form for a model has four fields: fresh input, output, cache reads and cache writes. A changed price applies from its change on; spend already counted is never repriced.

## Budgets

Q199.

- **A monthly budget per organization and per project,** set by an organization admin, in dollars. A project budget doesn't need an organization budget, and an organization budget covers every project's spend.
- **The month is the calendar month in UTC** *(working value)*. A budget resets on the first.
- **At 80%** *(working value: `OSTRA_BUDGET_WARN_PERCENT`)* the organization's admins, and for a project budget that project's admins, get one notification per budget and month, in the panel and by mail (`budget_warning`, ADR 0050). Setting or lowering a budget below what's already spent sends it at once.
- **At 100%** (`budget_reached`, once per budget and month), the gate closes:
  - **New tasks wait,** queued, with the reason on the task ("`platform`'s budget for November is reached") and on the New task page before it's started.
  - **No new turn starts.** A member's message, a reopen, an `@ostra` comment, a diff comment send, update branch and "Keep working" are saved and held, and the thread says why. Automatic rounds (ADR 0041, milestone 6) go through the same gate.
  - **A running turn finishes** (ADR 0042: an interrupt can leave work half done). The per-task cap (F-068) still applies inside it.
  - When an admin raises the budget, or the month turns, held turns and waiting tasks go, in the order they were held.
- **The gate is one function** every turn start calls: `budgetGate(projectId, origin)`, where the origin says what wants the turn (a member, a reopen, a PR comment, an automatic round). A test calls it for every origin, so milestone 6's rounds can't skip it.
- **The overshoot is bounded and said.** Spend counted after the 100% line is the turns already running and the messages already handed to a runner before it, each still under the per-task cap. The budget page shows the overshoot.
- **A model with no price can't be counted,** so in a project or organization that has a budget, a task whose model has no price waits with the reason "This model has no price, so the budget can't count it", until an admin enters one. Without a budget it runs and is counted in tokens, as milestone 2 does.

## Insights

Q200. F-108's figures, for an organization or one project, over a period the member picks (7, 30 or 90 days, or two dates; UTC days):

| Figure | Definition |
|---|---|
| PRs opened | Every PR a task opened in the period (`TaskPullRequest.openedAt`), each repo's PR counted |
| PRs merged | Every task PR merged in the period |
| Merge rate | Merged ÷ (merged + closed unmerged), over the PRs that closed in the period. None closed: "—" |
| Median time to a first PR | For each code task whose first PR opened in the period, from the task's creation to that PR. The median, and the count it's over |
| Time waiting on people | For each needs-you item answered or dismissed in the period, from its creation to its end. The total and the median per item, and per reason |
| Tokens and spend | From `SpendDaily`: the four token kinds and the money, by project and by model |

- **Computed, not live** (ADR 0035): a pg-boss schedule every 5 minutes *(working value)* recomputes each organization's last two days and any day whose source rows changed, into `InsightDaily` rows, and keeps one `TaskMetric` row per task for the medians. The page reads only those, and says when they were computed.
- **Access:** an organization's Insights are for its members; a project's for the members who can open it. An organization member who can't open a restricted project sees the organization's totals with that project's share in one line, "Other projects", never its name.

## Considered options

- **Summing task rows at read time.** Rejected: a month of tasks per organization on every page view, and a task's spend moves across a month boundary.
- **A rolling 30-day budget.** Rejected: admins think in invoices, and a calendar month is what the provider bills.
- **Stopping turns at 100%.** Rejected in ADR 0042, and still: half-run migrations cost more than the overshoot.
- **Letting unpriced models through a budget.** Rejected: it's an unlimited hole in a limit (`build-order.md`: anything that spends ships with its limit).
- **Live Insights.** Rejected in ADR 0035.

## Consequences

- The schema gains `Budget`, `SpendDaily`, `InsightDaily`, `TaskMetric`, and the cache prices on `Model` where milestone 2 hasn't added them (milestone 4's spec, section 5.3).
- The notification kinds gain `budget_warning` and `budget_reached`, which completes F-115 (ADR 0050).
- Budgets per member and per agent profile stay after v1 (F-131).
- Revisit if an install needs another currency, or a month in its own time zone.
