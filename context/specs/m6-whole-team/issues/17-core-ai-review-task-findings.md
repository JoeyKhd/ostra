# 17: Core: the AI review task and posting its findings

Status: done
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

- [x] Tests named `it("F-100: ...")`: one review task per code task, reopened per round, in its own box, on the PR's head, read-only, on the review profile and its model; findings typed with severity, file and line; one review per PR with the event `COMMENT`; off-diff findings in the body; AI review off skips it; a code task's token can't post a review.
- [x] A test named `it("F-111: ...")`: "Remember this" on a finding makes a proposal with the finding as its source.
- [x] Break-it: the off-diff placement dropped (GitHub's 422 on the whole review) fails its test; recorded in `context/proof/F-100.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add the AI review`.

## Comments

- 2026-11-20, core: built as `✨ add the AI review` (38f442fb). Readings and differences:
  - **`review.start`** (`apps/core/src/review-loop/review.ts`, the domain's `startReview` in `packages/domain/src/review-loop/review.ts`): the profile is the project's default review profile, else the organization's built-in Review profile (`builtInKind: review`), else the code task's own. The prompt holds the acceptance criteria of the ticket's applied refine draft, else none, and the ticket's text says them. The review task runs in its own box: its own task, lease and session; a second round reopens it (or, when it never handed in, stops and reopens it) and voids the earlier run.
  - **The spec** (`apps/core/src/dispatch/review-loop-spec.ts`): `review { codeTaskId, round, repos }` from the running review run, `tools: ["review", "memory"]`; `kind: review` is what the runner's git proxy reads for its read-only mode (ticket 22). The dispatch sends a refine or review task only to a runner at minor 5 (ticket 18's commit).
  - **`POST /runner/v1/tasks/:taskId/review`** (`apps/core/src/runner-http/review.ts`) checks the task token as the memory tools' calls do: `authorizeTaskCall`, exported from `apps/core/src/memory/endpoints.ts` for the sidecar's other calls (tickets 15 and 21 may use it too). A body that doesn't parse, over 30 findings included, answers `invalid`, as the protocol's schema caps the list; `limit-reached` stays for `OSTRA_REVIEW_FINDINGS_MAX` below 30.
  - **`review.post`:** the 422 retry moves the refused comment into the body and tries once; the fake host can't refuse a line its own diff covers, so the tested path is the placement, and the break-it shows the 422 when placement is dropped. A review task stays `running` after its turn ends until its review is posted (`findings_posted` takes it to done), as the lifecycle has it.
  - **"Remember this" on a finding** is the domain's `rememberFinding` (`sourceKind: ai_finding`, the finding's ID as its source); the API and the button are tickets 28 and 35.
  - **Proof:** `apps/core/src/review-loop/review.test.ts`. Break-its: every finding a line comment (`placeFindings`) got GitHub's 422 twice and failed the posting test; the code task's profile for the review failed the profile test; the spec without the review parts failed the checkout test; `submitReview` for any kind failed the token test; the rounds without the project's switch failed the switch test; a finding's proposal sourced by its task failed the F-111 test. Recorded in `context/proof/F-100.md` and `context/proof/F-111.md`.
  - **Checks:** as ticket 16's.
