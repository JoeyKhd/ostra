# 08: API: the thread's data

Status: ready-for-agent
Builder: api
Blocked by: 01, 05, 07
Features: F-151
Packages: `packages/api` (`src/routers/tasks.ts`, `src/routers/task-extras.ts`, the questions router, `src/routers/home-board.ts`)
Spec: `../spec.md`, section 5.5; the targets' README, choices 5, 7 and 10, and content fixes 11, 12, 15

## What to build

What the panel's new parts read that `tasks.get` doesn't give yet. Everything else they need exists (section 1's list): the turn's spend in `usage.turns`, the box's idle stop in `box`, the PR's size from the Changes tab's `diff` query.

- **`questions.answer`** takes `other: string[]` (default `[]`, at most 100) and passes it to ticket 05's `answerQuestion`; its refusals map as today's.
- **CI in jobs:** each repo's `ci` gains `jobs: { done, total }` and `failing: string[]` (each failing job's name, in the order the code host lists them), counted from the head's `CiRun.checks`: a check run with no conclusion is running; `none` has `{ 0, 0 }`. The existing `state` and first `failing` name stay for their readers until ticket 14 moves them.
- **A review task's figures:** `review: { round, limit, blocking, nits, url, codeTask: { id, key, title }, prNumber }` on a review task (`null` on any other kind), from its newest review run, the round limit and `reviewOf`; `url` is the posted review's, `null` before it posts.
- **`capabilities.questionFreeText`:** the task's agent's declaration (ticket 07), read as `steersMidTurn` is.
- **Home's board:** a task whose PR is in CI carries its jobs' `{ done, total }` for the sub-state's words.
- **Who sees it:** the same as `tasks.get` today; no new field leaks another organization's or a restricted project's data.

## Done when

- [ ] Tests named for `F-151/c5`: `questions.answer` with `other` through the real router reaches the use case and writes `question.answered` with `other`; without `other`, a value outside the options is refused as before.
- [ ] Tests named for `F-151/c6`: a `CiRun` with 4 check runs, 2 concluded, gives `jobs: { done: 2, total: 4 }`; a failed one lists every failing job; the home board's task carries the same counts.
- [ ] Tests named for `F-151/c7`: a review task's `review` figures for a submitted and a posted round, and `null` on a code task.
- [ ] Tests named for `F-151/c9`: `box` still gives the idle stop's due time and the release for the status line (an existing test, named and kept).
- [ ] Another organization's task and a restricted project's task stay `NOT_FOUND` for each new field's reader.
- [ ] Checks for `packages/api` and `apps/web` pass.
- [ ] Committed as `✨ give the thread its CI jobs and review figures`.

## Comments
