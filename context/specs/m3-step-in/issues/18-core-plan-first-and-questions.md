# 18: Core: plan first and questions

Status: ready-for-agent
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

- [ ] Tests: a plan raises one item; approve, edit and approve, and ask for changes each write the right event and command; a non-driver's answer is refused with `FORBIDDEN`; an answer after the box idled out reopens the task in the right mode; a question's answer is validated and its command sent once; another organization's task is untouched.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `core` and `domain`.
- [ ] Committed as `✨ add plan first and question answers`.

## Comments
