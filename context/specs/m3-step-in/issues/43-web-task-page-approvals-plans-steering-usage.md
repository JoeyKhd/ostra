# 43: Web: the task page for approvals, questions, plans, steering and usage

Status: resolved
Builder: web
Blocked by: 35, 39, 41
Features: F-026, F-063, F-024, F-084
Packages: `apps/web` (`src/task/renderers.tsx`, `src/task/task-thread.tsx`, `components/tasks/task-view.tsx`, `packages/task-view` where the fold needs a new part)
Spec: `../spec.md`, section 12 (`task-approval`, `task-plan`; and `m1/task` growing)

## What to build

- **The approval card** (`task-approval`), replacing milestone 1's read-only note: the rule and the subject, "Approve once", "Approve for this task" with its pattern, "Deny" with an optional reason; the receipts; several open at once; a closed card nobody can answer. assistant-ui's approval plumbing where it fits (ADR 0036), the closed outcome from `toolMetadata` as spike 7 found.
- **The question card:** the form's fields for the driver; "Take over to answer" for a watcher.
- **The plan** (`task-plan`): the plan turn's marker, the proposed plan as the needs-you block with "Approve plan", "Edit and approve" (an editable list and the message) and "Ask for changes", and the approved plan's receipt. The fold gains `data-plan-proposal` where `data-plan` isn't enough.
- **Steering** (`m1/task` grows): the watcher's read-only composer with "Sam is driving · Take over"; the two hints of ADR 0036 by the agent's capability; queued messages shown "queued" to every viewer until delivered.
- **Usage** (`m1/task` grows): the properties panel's tokens in four kinds, spend and agent time, with "≈" for estimates; each turn's figures in its footer.
- **The `ticket_closed` state** (`m2/task-limits` grows): "Stop the task" and "Keep working".
- Every string in the message files; phone width per F-075 (`phone-approval`).

## Done when

- [x] The screens match their targets, checked by eye, with the differences recorded here. *2026-11-20: `task-approval` against `demo/step04-approval-card.png` and this ticket's run, `task-plan` against `demo/step03-plan-proposed.png`, and the approved plan's receipt as `step04-approval-card.png` shows it. The structure, words, colours and buttons match. Differences: the "Approval rules" group lists the task's rules, not the profile's; the watcher's bar has no avatar before the driver's name; an answered approval's receipt is its own muted line and doesn't name the rule that asked; the plan's block and its receipt sit at the end of the thread, not under the plan turn, and the plan turn has no "Plan first" marker line; the plan's buttons read Ask for changes · Edit and approve · Approve plan (the target puts Approve plan first) and its message shows as plain text, not markdown; the properties panel has no Plan row; during a plan the composer keeps "Message the agent…".*
- [x] Playwright, on the scripted fake agent: two members answer one approval and one sees "Someone answered this first"; "for this task" shows its pattern and then the rule's receipt; a deny with a reason; a plan approved after an edit; a watcher can't send and can take over; usage shows and matches the API. *2026-11-20: `apps/web/e2e/21-task-answers.spec.ts`, six cases on the rows the scripted fake agent leaves (`e2e/seed-answers.ts`), with a second member; all pass alone, and one break-it pass (the lost-race line, the deny's reason, the task-rule pattern, the plan's `edited` marks, the watcher's bar, the cache figures) failed each. The race case found that the member who lost lost the "Someone answered this first." line when the receipt replaced the card: fixed in `3e0bbbe9`.*
- [x] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `web` and `task-view`. *2026-11-20, at `3e0bbbe9`.*
- [x] Committed as `✨ answer approvals and plans on the task page` (`3e0bbbe9`; the screens themselves landed in `3af06b0`).

## Decided 2026-11-19

Decided on the maintainer's delegation while preparing the build, from the open points of the milestone 3 targets (`context/brand/app-targets/m3/`) and the spec's gaps. If the maintainer disagrees with one, it goes back to `context/open-questions.md` and this section changes.

- **A deny's reason** shows in the receipt to every member who can open the task (`task-approval.md`, point 1).
- **"Answer anyway"** shows on an expired approval while its item is open (point 3; tickets 17 and 35).
- **`Take over to answer`** takes over the whole task, as ADR 0049 makes questions the driver's, and the line under it says so (point 4).
- **"Answered by a task rule"** reads the pattern from the rule `approval.auto_answered.ruleId` names (ticket 01).
- **The approved plan** (`task-plan.md`, point 1): the receipt shows only the plan as approved, with `edited` on the steps that differ from the proposal (`plan.answered.entries`, ticket 01). No "Show what was proposed" in milestone 3. `plan.proposed` stays in the log, so it can come later with no contract change.
- **The status during a plan turn** (point 2): `Running · Planning`, from `turn.started.mode`. No new task state.
- **Reordering steps** (point 3): `Alt+↑` / `Alt+↓` and the remove button ship and are tested. Drag uses the browser's own drag events, with no dependency, as the target draws it. At phone width there's no grip.

## Comments
- 2026-11-19, integrate (ticket 50): the approval card, the question form, the plan with Edit and approve, the watcher's bar, the usage rows, the task rules group and the ticket-closed block are wired to `tasks.get`, `approvals.*`, `questions.answer` and `plans.answer` (`3af06b0`), and used live in milestone 3's demo (`../demo.md`). Not done: this ticket's Playwright cases, the by-eye check against the targets, and the differences `demo.md` lists.
- 2026-11-20, resolved: the Playwright cases, the by-eye check with its differences above, and the lost-race line's fix are in `3e0bbbe9` (`✨ answer approvals and plans on the task page`). The proof rows of F-026 (any member answers), F-063 (the plan approved or edited), F-024 (take over) and F-084 (an estimate marked) are `proved`; the features stay `building` for their other rows.
