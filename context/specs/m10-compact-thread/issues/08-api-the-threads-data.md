# 08: API: the thread's data

Status: done
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

- [x] Tests named for `F-151/c5`: `questions.answer` with `other` through the real router reaches the use case and writes `question.answered` with `other`; without `other`, a value outside the options is refused as before.
- [x] Tests named for `F-151/c6`: a `CiRun` with 4 check runs, 2 concluded, gives `jobs: { done: 2, total: 4 }`; a failed one lists every failing job; the home board's task carries the same counts.
- [x] Tests named for `F-151/c7`: a review task's `review` figures for a submitted and a posted round, and `null` on a code task.
- [x] Tests named for `F-151/c9`: `box` still gives the idle stop's due time and the release for the status line (an existing test, named and kept).
- [x] Another organization's task and a restricted project's task stay `NOT_FOUND` for each new field's reader.
- [x] Checks for `packages/api` and `apps/web` pass.
- [x] Committed as `✨ give the thread its CI jobs and review figures`.

## Comments

**2026-11-22, built (api).** What `tasks.get`, Home's board and `questions.answer` give the thread now, and the choices made on the way:

- **`questions.answer`** takes `other: z.array(z.string().max(200)).max(QUESTION_OTHER_MAX).default([])` (the protocol's 100) and passes it to ticket 05's `answerQuestion`; the refusals map as before (`invalid-input` is `BAD_REQUEST`, so `other` on a text field, an unknown field, or a value outside the options without `other`).
- **The failing jobs' list is `failingJobs`, not `failing`.** The ticket names the list `failing: string[]`, and also keeps the existing `failing` (the first failing name, `string | null`) for its reader, milestone 6's `CodeHeadRows`, until ticket 14 moves it: one key can't be both, so each repo's `ci` is `{ state, failing, jobs: { done, total }, failingJobs }`. Ticket 14 reads `jobs` and `failingJobs`.
- **"Running" as `CiRun.checks` stores it.** `ci.evaluate` keeps a running check run's status in `conclusion` (`run.conclusion ?? run.status`), so a job is running when its stored word is `null` or one of `queued`, `in_progress`, `waiting`, `requested`, `pending` (a commit status's `pending` too); the list is typed against adapter-sdk's `CiCheckRunStatus` and `CiStatusState`. Everything else is done. `failingJobs` are the checks whose word is in `CI_FAILING_CONCLUSIONS`, in the stored order (the code host's). `none`, and a head with no `CiRun` yet, are `{ 0, 0 }` with no failing jobs. The counting lives in `packages/api/src/routers/ci-jobs.ts`, which `tasks.ts`'s old `ciOfHead` moved into.
- **Home's board:** an in-review card's status gains `ciJobs: { done, total } | null`: the jobs on each of the task's PRs' heads, added up, while its sub-state is `ci_running`; `null` in any other sub-state.
- **A review task's `review`** is `{ round, limit, state, blocking, nits, url, codeTask: { id, key, title }, prNumber }`, `null` on any other kind, and on a review task with no run or no code task. Three choices:
  - `state` (the newest run's `running`, `submitted`, `posted` or `failed`) is one field more than the ticket names, so the status line tells "reviewing" from "handed in" without reading `reviewOf.run`; `blocking` and `nits` are `0` before the hand-in.
  - `round` and `limit` are the round's as ostra's first message names them (`round 2 of 3`), read back from the review task's prompt with `readAgentMessage` (each round rewrites it). `ReviewRun.round` counts every run of the code task, while the message counts since a person last acted (`recordPersonActionInTx` resets the counters), so after a person's action they differ, and the status line must say what the bubble says. A prompt that doesn't read as a review's falls back to the run's round, of `max(OSTRA_REVIEW_ROUNDS + 1, round)`, the prompt's own formula.
  - `url` is the review task's own `review.posted` for the newest run, the reviewed PR's repo first; `prNumber` the run's first head's, else the code task's first PR.
- **`capabilities.questionFreeText`** reads the adapter's own declaration, not a hand list in the domain as `steersMidTurn` does: OpenCode's `questionFreeText` moved to `@ostra/adapter-opencode/question-free-text` (a constant, as `prompt-images` is), which the adapter and `packages/api/src/services/agent-questions.ts` both read; an agent no adapter declares is `false`. Like `steersMidTurn`, it's the newest session's profile's agent, else the project's default.
- **c9:** the two existing box tests in `task-ticket.test.ts` are named `F-151/c9` and kept; the released box's now also checks `releasedAt`.
- **The web:** only `task-properties.test.tsx`'s fixture gains `review: null` and `questionFreeText: false`. Nothing draws the new fields yet (tickets 13 to 16).
- **Tests:** `packages/api/src/routers/approvals-plans.test.ts` (c5: the router to the use case, the refusals, an agent without the capability, another organization and a restricted project), `thread-data.test.ts` (c6, c7, and who sees them on `tasks.get` and the board), `task-ticket.test.ts` (c9). Checks: typecheck, lint and tests of `@ostra/api`, `@ostra/web` and `@ostra/adapter-opencode`.

**For later tickets:**
- **13:** offer `Something else…` on a select field when `capabilities.questionFreeText`; send the words as `answers[fieldId]` and the field's ID in `other`.
- **14:** the PR card, the Code group and the Checks tab's marker read `repos[].ci.jobs` and `failingJobs`; once `CodeHeadRows` reads `failingJobs`, nothing reads `ci.failing`. Home's board: `apps/web/src/components/home/home-board-view.tsx` maps the in-review status and drops `ciJobs` today; the sub-state's words take it from there.
- **15:** the status line, the top bar and the Result group read `review` (`round`, `limit`, `state`, `blocking`, `nits`, `url`, `codeTask`, `prNumber`); the box's words read `box` (`state`, `idleStopDueAt`, `releasedAt`) as before.
