# 03: Adapter SDK: reviews, check runs and PR bodies

Status: done
Builder: adapters (contracts, first)
Blocked by: none
Features: F-104, F-098
Packages: `packages/adapter-sdk` (`src/code-host/`, `src/testing/code-host-suite.ts`, the fake code host)
Spec: `../spec.md`, section 5.2; ADR 0040 (amended), ADR 0027 (amended)

## What to build

- `listReviews(access, number)` with the review shape of section 5.2: the user's ID and login, `isBot`, the state, the commit it reviewed, and when.
- `publishCheckRun` and `updateCheckRun`, idempotent by `(headSha, name)`: a second publish for the same head and name returns the existing run.
- `updatePullRequestBody(access, number, body)`, unless milestones 1 to 3 already added it (say so in `## Comments`).
- `parseWebhook` hints for `pull_request_review` (submitted, edited, dismissed) and `pull_request` `synchronize`.
- The capability `reviews: boolean`.
- **The fake code host** gains reviews with dismissals and bot users, check runs, and branch protection that requires a named check, in two modes: `in_progress` blocks a merge, or only a failing or `action_required` check does. Both modes are test fixtures, so ADR 0040's open question is tested whichever way GitHub answers.
- **The code host contract suite** gains: reviews listed in order with dismissals; a check run published once per head and name; an update changes its status and conclusion; a body update keeps the rest of the PR.

## Done when

- [x] The suite passes against the fake, and against GitHub once ticket 08 is in.
- [x] Every caller compiles; an adapter without reviews declares `reviews: false`.
- [x] Committed as `✨ add reviews and check runs to code hosts`.

## Comments
- 2026-11-19, adapters (contracts): done in `✨ add reviews and check runs to code hosts` (COMMIT). **`CodeHostAdapter`** gains, each answering `unsupported` by default: `listReviews(access, number)` → `PullRequestReview[]` oldest first (`reviewId`, `userId`, `login`, `isBot`, `state` of `pullRequestReviewStates`, `commitId | null`, `submittedAt | null` in ms); `publishCheckRun(access, CheckRunInput)` → `{ checkRunId }`, idempotent by `(headSha, name)`, and `updateCheckRun(access, checkRunId, CheckRunInput)`. `CheckRunInput` is `{ name, headSha, title, summary, externalId }` with `CheckRunState`, a union that makes `in_progress` carry no conclusion and `completed` carry `success` or `action_required`. `CodeHostWebhookEvent` gains `pull_request_review` (`action` submitted, edited or dismissed, `number`, `headSha`, `review`); a new head is the `pull_request` event's existing `synchronize` action, with its `headSha`. Capability `reviews: boolean` (`checkRuns` was there). **`updatePullRequestBody` already existed** (milestone 1, F-030, with GitHub's implementation), so this ticket adds only its contract case. Every caller compiles: GitHub declares `reviews: false` until ticket 08 (its `checkRuns: true` stays, and the new check-run cases skip on it until ticket 08 adds the fixture), core's and the API's fake hosts declare `reviews: false`, and core's PR webhook handler ignores `pull_request_review` until ticket 18. **The fake code host:** `FakeReviewsAndChecks` (`@ostra/adapter-sdk/testing`, for any fake host to reuse): reviews with dismissals and bots, check runs keyed by repo, head and name, and branch protection requiring a named check in two modes, `in_progress-blocks` and `only-failing-blocks` (a check that never ran blocks in both; `merge()` answers whether a PR's head may merge). The tiny code host keeps its state there (`reviewsAndChecks`, `pushHead`, `mergePullRequest`), declares `reviews` and `checkRuns`, stores a PR's body and reads the `pull_request_review` webhook. **Suite** (`code-host-suite.ts`): reviews in order with a dismissal, a bot and an approval (or `unsupported` without `reviews`); one check run per head and name; an update changes status, conclusion and words; a body update keeps the PR's number, title, branches and state; the review webhooks submitted and dismissed, and `synchronize`. They pass on the tiny host, and on GitHub's fake with the review and check-run cases skipped until ticket 08. Proof: `context/proof/F-104.md`, four rows `partial` (the fake's own tests in `fake-reviews-and-checks.test.ts`). Break-it checks: a second publish adding a run; a dismissal keeping its state; `in_progress` blocking in both modes; the required check read on any head. Each failed its cases.
