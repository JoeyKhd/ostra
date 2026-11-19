# 17: Core: the AI review task and posting its findings

Status: ready-for-agent
Builder: core
Blocked by: 06, 08, 16
Features: F-100, F-111 (the finding as a source)
Packages: `apps/core` (`src/review-loop/review.ts`, `src/runner-http/review.ts`), `packages/domain`
Spec: `../spec.md`, section 4 ("The AI review"); ADR 0028 (amended), ADR 0058

## What to build

- **`review.start`,** keyed by the code task and the round: with the project's `aiReview` on, when every open PR's CI is `passed`, `none` or `timed_out`, reopen the code task's one review task (create it the first time, `reviewOfTaskId` set, on the project's default review profile) with `review { codeTaskId, round, repos }` at the PRs' current heads, `tools: ["review", "memory"]`, the git proxy's read-only mode, the review prompt (the ticket, its acceptance criteria from the accepted refine draft or the ticket's text, the PRs). The code task's sub-state is "AI review". Its dispatch goes through the budget gate with `automatic-round` and its own spend cap.
- **`POST /runner/v1/tasks/:taskId/review`:** a review task only, with a `ReviewRun` in `running` (else `not-in-review`); findings checked by the schema and capped; stored as `Finding` rows; `review.submitted` in both tasks' threads.
- **`review.post`,** per review run and repo: `placeFindings` against `diffLines` at the reviewed head; `createReview` with the event `COMMENT`, the summary and the blocking and nit counts in the body, the off-diff findings listed there, the rest as line comments; a 422 on one comment moves it into the body and retries once. Then the review task is done; a finding from an earlier run on a line the new head changed is marked `outdated`, and one whose run's round fixed it `resolved`.
- **After posting:** blocking findings → a findings round (ticket 18); none → "waiting for a reviewer" (ticket 19).
- **A head that moves during the review** (a person pushed) ends the run as `failed` with the reason, and `ci.evaluate` starts the loop again on the new head.
- **"Remember this" on a finding** calls milestone 4's proposal path with `sourceKind: ai_finding` and the finding's text.

## Done when

- [ ] Tests named `it("F-100: ...")`: one review task per code task, reopened per round, in its own box, on the PR's head, read-only, on the review profile and its model; findings typed with severity, file and line; one review per PR with the event `COMMENT`; off-diff findings in the body; AI review off skips it; a code task's token can't post a review.
- [ ] A test named `it("F-111: ...")`: "Remember this" on a finding makes a proposal with the finding as its source.
- [ ] Break-it: the off-diff placement dropped (GitHub's 422 on the whole review) fails its test; recorded in `context/proof/F-100.md`.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add the AI review`.

## Comments
