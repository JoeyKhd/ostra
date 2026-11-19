# 35: API: approvals, questions, plans and steering

Status: ready-for-agent
Builder: api
Blocked by: 17, 18, 19
Features: F-026, F-063, F-024
Packages: `packages/api` (`routers/tasks.ts`, `routers/approvals.ts`)
Spec: `../spec.md`, section 4; ADR 0049, ADR 0036

## What to build

- **`approvals.answer`** takes `reason` for a deny, and returns the task rule a `allow_task` added. **`approvals.preview(approvalId)`** returns the rule that asked, the subject and the pattern "for this task" would add, for the card.
- **`questions.answer(questionId, answers)`**, the driver only (`FORBIDDEN` with "Take over to answer" otherwise).
- **`plans.answer(taskId, decision, text)`**, the driver only.
- **`tasks.get`** returns, for the task page: open approvals with their rule, subject and options; open questions; the pending plan with its entries and message; the task rules; whether the agent steers mid-turn; the caller's capabilities (send, interrupt, answer approvals, answer questions, answer the plan, take over).
- **The race and watcher checks** of ticket 19 run against these procedures, plus spike 7's check that two members answering one approval get one win and one `CONFLICT`.

## Done when

- [ ] Tests: each procedure's authorization (any member for approvals, the driver for questions and plans, another organization never); a deny's reason reaches the command; the preview's pattern matches what "for this task" writes; capabilities flip on take-over.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `api`.
- [ ] Committed as `✨ add the approvals, questions and plans API`.

## Decided 2026-11-19

Decided on the maintainer's delegation while preparing the build, from the open points of the milestone 3 targets (`context/brand/app-targets/m3/`) and the spec's gaps. If the maintainer disagrees with one, it goes back to `context/open-questions.md` and this section changes.

- **`plans.answer` takes the plan as structured steps and a message** on an approve, and core renders `text` with the protocol's prompt. It writes `plan.answered { entries, message, text }` (ticket 01).
- **`approvals.answer` accepts an expired approval while its item is open** (`task-approval.md`, point 3; ticket 17), so the receipt's "Answer anyway" works. A cancelled one is refused with `CONFLICT`.
- **`tasks.get` returns a deny's reason** to every member who can open the task (point 1).

## Comments
