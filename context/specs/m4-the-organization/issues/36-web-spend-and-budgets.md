# 36: Web: spend and budgets

Status: resolved
Builder: web
Blocked by: 27, 31
Features: F-037
Packages: `apps/web` (`src/app/(panel)/organization/spend/`, `src/app/(panel)/organization/models/`, the project page, the task page, New task, Inbox)
Spec: `../spec.md`, sections 3 (step 6) and 12; target `spend-budgets`

## What to build

- **Spend** (`/organization/spend`) to the `spend-budgets` target: the month picker, the total against the organization's budget, each project with its budget bar and state, each model, the four token kinds, the overshoot, the unpriced-model warning with a link to the model's price, and "Set budget" for admins.
- **A model's price** on the Models page: its four prices and their source, "Edit price" for admins (growing `app-targets/m1/models`).
- **The project page** shows the month's spend and its budget's share (growing `app-targets/m1/project`).
- **The budget's states elsewhere,** each growing its target, with the changes under `## Comments`: the held-turn marker in the thread and a held message's state (`m1/task`); the reason before Start on New task and in the Inbox (`m1/task-new`, `m2/inbox`); a task queued by the budget (`m2/task-limits`); the budget notices among the needs-you rows (`m1/home`, `m3/needs-you`).
- Charts follow the `dataviz` guidance and the target's build spec.

## Done when

- [x] Playwright, named `it("F-037: ...")`: an admin sets a project budget below the spend, a new task in it shows the reason before Start, a message to an idle task shows as held, and raising the budget starts both.
- [x] Each screen checked by eye against its target, dark and light, at 1440 px and phone width.
- [x] Committed as `✨ add spend and budgets to the panel`.

## Comments

- 2026-11-20, web builder B: Spend (`/organization/spend`, `components/spend/`) to the `spend-budgets` target: the month picker (`?month=`), the total against the organization's budget with its bar, warn tick and overshoot, each project's row with its bar and state, each model's four token kinds, the no-price warning, and the panel's budget form (Waiting group, "After the raise", remove with a confirm) and four-price form; a member gets `AdminOnly`. The budget's states elsewhere: New task and the Inbox show the gate's reason before Start (`tasks.startCheck`; the task still starts, queued); the task page words a task queued by the budget, a held message reads `Held`, and the thread draws the held and released rows (`turn.held`/`turn.released` now fold to `data-held`/`data-released` in `@ostra/task-view`); Models shows the four prices and their source with `Edit price` (the custom model form no longer edits prices: they're set on Spend); the project page's panel shows the month's spend and its budget's share (`spend.project`); Home's and Needs you's rows list the member's budget notices this month through a new `notifications.budgetNotices` (additive). One API fix: `spend.month`'s `queuedTasks` counted only held turns of origin `dispatch`, which a new task's dispatch never writes; it now also counts a queued task whose dispatch note is the budget's. Proof: `apps/web/e2e/14-spend.spec.ts` (core runs in the stack; with no runner connected, "starts both" is the held turn released with its steer handed to the runner's outbox and the waiting task offered again), `budget-notices-panel.test.ts`, a new `spend-page.test.ts` case, `budget-notices.test.tsx` and two fold cases, with break-its in `context/proof/F-037.md`. Checked by eye at 1440 px and 412 px in the dark theme against `spend-budgets.webp` and `spend-budgets-price.webp` (finals in the session's `ui-check/m4-spend-*-final.png`); the panel has no light theme yet, so there is none to check. Commit: see the git log for `✨ add spend and budgets to the panel`.
- 2026-11-20: the commit is `66742757` on main. The e2e seed then moved onto the stack's own GitHub App (`ensureGitHub` in `apps/web/e2e/helpers.ts`), so a later spec isn't handed a stand-in connection: see `✅ seed the budget world on the stack's App`.
