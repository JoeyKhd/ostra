# 18: Core: plan first and questions

Status: done
Builder: core
Blocked by: 07, 16
Features: F-063, F-026 (questions)
Packages: `apps/core` (`src/ingest/`, `src/reactions/`), `packages/domain` (`recordPlanProposed`, `answerPlan`, `answerQuestion`)
Spec: `../spec.md`, section 4 ("A question", "Plan first"); ADR 0049

## What to build

- **`plan.proposed`** (ingest): store it, set the task's `planState` to `proposed`, raise a needs-you item (reason `plan`, audience the driver), move the task to needs you, enqueue `notify.fanout`.
- **`answerPlan`:** the driver only, under the task's lock (as `tasks.send`). "Approve" with the plan's text as shown or edited writes `plan.answered { decision: "approve" }`, sets `planState` to `approved`, closes the item, and enqueues the `plan-answer` command; "Ask for changes" writes `plan.answered { decision: "revise" }` and the command, and leaves `planState` at `proposed` until the next `plan.proposed`. With no session going (the box idled out while waiting), the answer reopens the task: an approve in build mode with the approved plan, a revise in plan mode.
- **`question.asked`** (ingest): store it, raise a needs-you item (reason `question`, audience the driver), notify.
- **`answerQuestion`:** the driver only, under the task's lock; validates the answers against the question's fields; writes `question.answered`, closes the item, enqueues `question-answer`. A question closed by the turn's end leaves the item open, and its answer reopens the task with the answer as the first message.
- **The prompts** come from the domain's renderers (ticket 07): the approved plan and the revision request inside marked blocks.

## Done when

- [x] Tests: a plan raises one item; approve, edit and approve, and ask for changes each write the right event and command; a non-driver's answer is refused with `FORBIDDEN`; an answer after the box idled out reopens the task in the right mode; a question's answer is validated and its command sent once; another organization's task is untouched.
- [x] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `core` and `domain`.
- [x] Committed as `✨ add plan first and question answers`.

## Comments

- 2026-11-19: done in `✨ add plan first and question answers`. The effects are `packages/domain/src/use-cases/plans-questions.ts`: `recordPlanProposedInTx` and `recordQuestionAskedInTx`, called from ingest, and `answerPlan` and `answerQuestion`, which ticket 35's routers call. Choices made here:
  - **One plan item per task:** a second `plan.proposed` before an answer raises no second item; the plan shown is the newest. A revise closes the item, and the revised plan raises a new one.
  - **An edited plan** is any change to a step's text, the steps' count or the message; the command then says "with edits" (`approvedPlanPrompt`).
  - **No session going** (the box idled out): the answer is the reopen's message. An approve reopens in build mode (`planState: approved`); a revise writes the reopen's message with `intent: "plan-revision"`, which `profileSpecParts` reads to start that session in plan mode while the plan still waits. A reopen the answer can't make (the spend cap) rolls the answer back.
  - **A question the turn's end closed** keeps its item open. Its answer reopens the task with `lateQuestionAnswerPrompt` (`packages/domain/src/prompts/index.ts`): the question and each answer, by its field's label, in marked blocks.
  - **The answers are checked** against the question's fields: every field answered, no unknown field, a select's value among its options, each within the steer limit. A second answer is refused `already-answered`, under the task's lock.
  - A task with no driver raises its plan or question item for the project's members.
  Tests: `apps/core/src/ingest/plans-questions.test.ts`, nine cases on a real Postgres, each with a break-it (in `context/proof/F-063.md` and `context/proof/F-024.md`).
