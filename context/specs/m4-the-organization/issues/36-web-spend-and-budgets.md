# 36: Web: spend and budgets

Status: ready-for-agent
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

- [ ] Playwright, named `it("F-037: ...")`: an admin sets a project budget below the spend, a new task in it shows the reason before Start, a message to an idle task shows as held, and raising the budget starts both.
- [ ] Each screen checked by eye against its target, dark and light, at 1440 px and phone width.
- [ ] Committed as `✨ add spend and budgets to the panel`.

## Comments
