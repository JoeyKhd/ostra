# 27: API: spend, budgets and prices

Status: resolved
Builder: api
Blocked by: 12, 13
Features: F-037
Packages: `packages/api` (`src/routers/spend.ts` (new), `src/routers/providers.ts`, `src/routers/tasks.ts`, `src/routers/projects.ts`)
Spec: `../spec.md`, section 4 ("Spend and the gate"); ADR 0055

## What to build

- **`spend.month(month)`:** the organization's total, each project's (a hidden project folded into "Other projects" for a member who can't open it), each model's, the four token kinds, the unpriced tokens and the models they came from, each budget with its share, its state and its overshoot. From `SpendDaily` only.
- **`spend.project(projectId, month)`** for the project page, and the task's spend as milestone 3's usage already returns it.
- **`budgets.set` / `budgets.clear`** (organization admin): the organization's or a project's monthly budget in dollars, an audit entry, and `budget.check` at once (ticket 13).
- **`providers.setModelPrice`** (organization admin): the four prices per million tokens for a model, with `priceSource: "admin"`, from now on; an audit entry.
- **The gate's reason** for the panel: `tasks.startCheck(projectId, profileId)` → `open`, or the reason a new task would wait (budget reached, model has no price), used by the New task page and the Inbox before Start.

## Done when

- [x] Tests named `it("F-037: ...")`: the month's totals equal the sum of its tasks' spend; a hidden project's spend shows only as "Other projects"; a member can't set a budget or a price; a budget set below the spend reports reached at once; `startCheck` gives each reason.
- [x] Committed as `✨ add spend and budgets to the API`.

## Comments

- 2026-11-19 (api builder B): built and pushed as `✨ add spend and budgets to the API`. `spend.month`, `spend.project` and `spend.currentMonth` read `SpendDaily` only, fold a hidden project into "Other projects" (and leave its budget out), and give spend per model and per provider (ticket 50's grouping), the unpriced tokens and each budget's share, state and overshoot. `budgets.set` and `budgets.clear` (organization admins, ADR 0055) call ticket 13's `setBudget`; `providers.setModelPrice` writes the four prices with `priceSource: "admin"` (new `setModelPrice` in `packages/domain/src/use-cases/model-price.ts`, audit `model.price-changed`), and `syncProviderModels` now keeps an admin's price on a catalog refresh. `tasks.startCheck` runs the dispatch's provider check, then `checkBudget` with the origin `dispatch`. Tests: `packages/api/src/routers/spend.test.ts` and `task-start-check.test.ts`, each with its break-it in `context/proof/F-037.md`. Note: ticket 13's `setBudget` also lets a project admin set a project budget; the router keeps it to organization admins, as ADR 0055 says.
- 2026-11-20: the commit is `fe771102` on main.
