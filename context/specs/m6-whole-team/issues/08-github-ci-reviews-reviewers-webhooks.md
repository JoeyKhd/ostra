# 08: GitHub adapter: CI, reviews, reviewers, CODEOWNERS and the webhooks

Status: ready-for-agent
Builder: adapters
Blocked by: 03
Features: F-035, F-100, F-102, F-105
Packages: `packages/adapters/adapter-github`
Spec: `../spec.md`, sections 4 ("CI", "The AI review", "Reviewers", "Changes requested") and 5.2

## What to build

- **`listCiResults`:** `GET /commits/{sha}/check-runs` (paged, with each run's app slug) and `GET /commits/{sha}/status`.
- **`getCiLog`:** for a check run whose app is GitHub Actions, the job's log through `GET /actions/jobs/{job_id}/logs` (the App's `actions: read`, ADR 0040), read from the end up to the cap; for any other app, the run's `output.summary` and `output.text`; for a status, its description and target URL. A log GitHub has expired returns `null` with the reason.
- **`createReview`:** `POST /pulls/{n}/reviews` with `event: "COMMENT"`, the commit ID and the line comments by `line` and `side`; a 422 for a line outside the diff becomes a typed error naming the comment, so core can move it into the body and retry once.
- **`diffLines`:** from milestone 3's `compare`, the new-side and old-side lines each file's hunks cover.
- **`listRequestedReviewers`:** `GET /pulls/{n}/requested_reviewers`. **`readCodeOwners`:** the first of `.github/CODEOWNERS`, `CODEOWNERS` and `docs/CODEOWNERS` at the ref, as GitHub looks for it.
- **`listReviewComments`:** `GET /pulls/{n}/reviews/{id}/comments`.
- **Webhooks:** `check_run`, `check_suite` and `status` hints with the head SHA; `pull_request` `review_requested` and `review_request_removed`.
- **The manifest** gains the events `check_run`, `check_suite` and `status` for new Apps; existing Apps get them from ticket 40's step 2. `health` warns when an App lacks them.
- Never a log line, a review's body or a comment in a log line or an error.

## Done when

- [ ] Ticket 03's contract suite passes against the fake code host with GitHub's adapter.
- [ ] Live tests on `test1` (live evidence, cited by their run's log): a check run's log read from a workflow run; a comment-type review with one line comment and one off-diff finding moved into the body; the requested reviewers of a PR; `CODEOWNERS` read.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add CI, reviews and reviewers on GitHub`.

## Comments

- 2026-11-20 (from ticket 03): GitHub's adapter declares the five capabilities `false` until this ticket sets them. Use `logTail` from `@ostra/adapter-sdk` for the log's cut, return `{ code: "line-outside-diff", commentIndex }` for the 422, and route `pull_request` deliveries whose action is `review_requested` or `review_request_removed` to the `pull_request_reviewers` hint. The suite's new fixture fields (`ci`, `ciLogs`, `commentReview`, `requestedReviewers`, `codeOwners`, `ciWebhooks`) are skipped until the GitHub fake gives them; `contract-suites.test.ts` shows them filled for the fake code host.
