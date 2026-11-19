# 43: Web: the task page for approvals, questions, plans, steering and usage

Status: ready-for-agent
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

- [ ] The screens match their targets, checked by eye, with the differences recorded here.
- [ ] Playwright, on the scripted fake agent: two members answer one approval and one sees "Someone answered this first"; "for this task" shows its pattern and then the rule's receipt; a deny with a reason; a plan approved after an edit; a watcher can't send and can take over; usage shows and matches the API.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `web` and `task-view`.
- [ ] Committed as `✨ answer approvals and plans on the task page`.

## Comments
