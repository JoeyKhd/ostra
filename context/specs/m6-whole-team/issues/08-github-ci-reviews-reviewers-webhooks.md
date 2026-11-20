# 08: GitHub adapter: CI, reviews, reviewers, CODEOWNERS and the webhooks

Status: done
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

- [x] Ticket 03's contract suite passes against the fake code host with GitHub's adapter.
- [x] Live tests on `test1` (live evidence, cited by their run's log): a check run's log read from a workflow run; a comment-type review with one line comment and one off-diff finding moved into the body; the requested reviewers of a PR; `CODEOWNERS` read.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add CI, reviews and reviewers on GitHub`.

## Comments

- 2026-11-20 (from ticket 03): GitHub's adapter declares the five capabilities `false` until this ticket sets them. Use `logTail` from `@ostra/adapter-sdk` for the log's cut, return `{ code: "line-outside-diff", commentIndex }` for the 422, and route `pull_request` deliveries whose action is `review_requested` or `review_request_removed` to the `pull_request_reviewers` hint. The suite's new fixture fields (`ci`, `ciLogs`, `commentReview`, `requestedReviewers`, `codeOwners`, `ciWebhooks`) are skipped until the GitHub fake gives them; `contract-suites.test.ts` shows them filled for the fake code host.
- 2026-11-20 (ticket 08, commit `✨ add CI, reviews and reviewers on GitHub`): built in `packages/adapters/adapter-github` (`github-adapter.ts`, `schemas.ts`, `manifest.ts`, the fake GitHub's check runs, statuses, job logs, reviews, requested reviewers and `filesAt`), with `statuses` added to the SDK's `RepoPermission` in its own commit (`✨ let repo tokens read commit statuses`). The code host suite's six milestone 6 fixtures are filled (`milestone6Fixture` in `github-adapter.test.ts`) and pass, with the adapter's own tests beside them. Live on `test1`: `context/specs/m6-whole-team/live/github-adapter-m6-live.txt` (`github-adapter.live.test.ts`, the milestone 6 block). Proof rows in `context/proof/F-035.md`, `F-100.md`, `F-102.md` (new) and `F-105.md` (new), all `partial` until core and the panel finish them. Notes:
  - **Found live:** `GET /pulls/{n}/reviews/{id}/comments` answers each comment's diff `position`, with no `line` or `side`. So `listReviewComments` reads `GET /pulls/{n}/comments` and keeps the review's comments by `pull_request_review_id`. The fake GitHub now answers both endpoints as GitHub does.
  - **The 422:** GitHub doesn't say which comment is off the diff, so `createReview` reads `diffLines` after the refusal and names the first comment outside it (`{ code: "line-outside-diff", commentIndex }`). Before posting, it looks for a bot's review of the same commit with the same body, so a retry never posts twice.
  - **Health:** the warning for an App without `check_run`, `check_suite` and `status` is `appHealth(app)` (it reads `GET /app`'s events), not the adapter's `health()`, which takes no App. New Apps already subscribe through the manifest's `appEvents`.
  - **Requested reviewers live:** the live PR had none, since asking a person would notify them and the App can't list the org's teams. A non-empty list (people and a team) is proved on the fake.
  - An Actions job's log is fetched from the signed download with no token and a `Range` of its last bytes, then cut to the cap with `logTail`'s character rule. 404 and 410 mean `expired`.
