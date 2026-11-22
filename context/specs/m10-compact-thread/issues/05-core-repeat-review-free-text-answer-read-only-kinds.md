# 05: Core: a repeat review, a free-text answer, and read-only kinds

Status: ready-for-agent
Builder: core
Blocked by: 01
Features: F-151
Packages: `packages/domain` (`src/review-loop/review.ts`, `src/use-cases/plans-questions.ts`, `src/use-cases/record-session-end.ts`, `src/prompts/`), `apps/core` (`src/runner-http/review.ts`)
Spec: `../spec.md`, sections 4 and 5.1; the targets' README, choice 5 and content fixes 5, 6, 11

## What to build

- **A repeat `submit_review`** (content fix 6). In `submitReview`, under the review task's lock as now: when the review task's newest run is `submitted` or `posted` (this round's review is in), and its code task is still at that run's heads, answer `{ ok: true, reviewRunId, already: true }`, write no finding, enqueue no `review.post`, leave the run as it is, and append `review.submitted` with the run's `blocking`, `nits` and `repeat: true` to the review task's log only (the code task's thread doesn't hear of it). A run whose PR moved on, or a code task no longer in review, keeps its `not-in-review` refusal; too many findings keeps `limit-reached`.
- **The endpoint** (`apps/core/src/runner-http/review.ts`): answers through the protocol's `reviewAnswerFor(minor, saved)`, with the minor of the runner the call came from (`Runner.minor`, by the task's lease, or the `host` runner's own access token). A runner with no recorded minor counts as 8.
- **A free-text answer** (choice 5, content fix 11). `answerQuestion` and `checkQuestionAnswers` take `other: readonly string[]`: a select field named in `other` takes any non-blank words within `steerTextMaxChars`, a select field not in it must still be one of its options, and an `other` naming a field the question doesn't have, or a text field, is `invalid-input`. `question.answered` records `other` when it isn't empty. The `question-answer` command carries the words as the field's answer, as any answer. A late answer's prompt (`lateQuestionAnswerPrompt`) says which answers are the member's own words.
- **A draft's counts:** the use case that writes `draft.submitted` (milestone 6's `submit_draft` endpoint) adds the draft's `acceptanceCriteria` and `subTickets` counts, for the refine task's result line.
- **Read-only kinds' bookkeeping** (content fix 5): a refine or review task's session end raises no "ended without changes" needs-you item and records no PR outcome for it (check `recordSessionEnd` and its callers; change only what reads a read-only kind as a code task), and an empty `session.saved.repos` (ticket 06) reads as nothing unsaved. A review or refine task's reopen still restores its session archive.
- **Never logged:** an answer's words, the review's text, as before; the new log lines carry the IDs and `repeat`.

## Done when

- [ ] Tests named for `F-151/c7`: a second hand-in for a submitted round answers `already`, leaves the run, its findings and the job queue unchanged, and writes `review.submitted` with `repeat` in the review task's log only; the same after the round posted; refused `not-in-review` once the code task's head moved; the endpoint sends `already` to a minor-9 runner and not to a minor-8 one (break-it: enqueue `review.post` on a repeat, and the queue test fails).
- [ ] Tests named for `F-151/c5`: an answer with `other` for a select field is accepted with words outside its options, written with `other`, and reaches the outbox's `question-answer` as those words; a value outside the options without `other` is refused; `other` naming an unknown field or a text field is refused; another organization's question is `not-found`.
- [ ] Tests named for `F-151/c7`: a review task's session ending without changes opens no needs-you item; a code task's still does; a submitted draft's `draft.submitted` carries its counts.
- [ ] Checks for the whole repo pass (spec section 10: what a runner answers an agent).
- [ ] Committed as `✨ confirm a repeat review, take answers in words`.

## Comments
