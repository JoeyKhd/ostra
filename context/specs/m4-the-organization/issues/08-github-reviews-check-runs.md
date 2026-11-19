# 08: GitHub adapter: reviews, check runs, PR bodies and the review webhooks

Status: resolved (the reviewer's live run waits for ticket 42)
Builder: adapters
Blocked by: 03
Features: F-104, F-098
Packages: `packages/adapters/adapter-github`
Spec: `../spec.md`, section 5.2; ADR 0040 (amended)

## What to build

- **`listReviews`** through `GET /repos/{owner}/{repo}/pulls/{number}/reviews`, every page, mapped to section 5.2's shape: the user's numeric ID and login, `isBot` from the user's type, the state lower-cased, `commit_id`, `submitted_at`.
- **`publishCheckRun` and `updateCheckRun`** through the Checks API, with the installation's token. Idempotent by `(headSha, name)`: before creating, it lists the head's check runs by name and returns the existing one. The `external_id` is the task repo's ID.
- **`updatePullRequestBody`,** if milestones 1 to 3 didn't add it.
- **The webhooks:** `pull_request_review` (`submitted`, `edited`, `dismissed`) and `pull_request` `synchronize`, verified as milestone 1's are, with the App's manifest gaining the `pull_request_review` event (existing Apps need it added once: ticket 42).
- **The review harness** ported from `spikes/github-app-and-git-proxy/src/harness/review-local.ts` as the adapter's local test against the fake.
- **The capability** `reviews: true`.

## Done when

- [x] The code host contract suite of ticket 03 passes against the fake and, gated on `github-test.env`, against `ostra-test/test1`.
- [ ] Gated on `github-test.env` and `GITHUB_TEST_REVIEWER_TOKEN`: on a PR in `test1`, the reviewer user's approval, its dismissal and a new push each arrive as their webhook hint, and a check run is published once per head, recorded in `## Comments`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add reviews and check runs on GitHub`.

## Comments

- 2026-11-19 (adapters builder), commit `✨ add reviews and check runs on GitHub` (d9abf4b): `listReviews` (every page, the author's ID, login and `isBot`, the state lower-cased, commit and time), `publishCheckRun` (looks up this App's runs on the head by name first, then creates one with the task repo's ID as `external_id`) and `updateCheckRun` (PATCH), each with a token for the one repo; `parseWebhook` reads `pull_request_review` (`synchronize` was already read); `reviews: true`. The manifest already subscribed to `pull_request_review`. The fake GitHub holds reviews and check runs, and the code host suite's milestone 4 cases pass on GitHub against it. The spike's review harness is ported as `the review harness (spike 4)` in `github-adapter.test.ts`. Live on `test1` (`packages/adapters/adapter-github/evidence/f-104-reviews-checks-live.txt`): one check run on a PR's head through two publishes, updated to success, and the App's own comment review read as a bot's. Box 2 stays open: the reviewer user's approval, its dismissal and their webhooks need `GITHUB_TEST_REVIEWER_TOKEN` and the App subscribed to `pull_request_review` (ticket 42, the maintainer's step). Checks: typecheck, lint and test of `@ostra/adapter-github`, typecheck of its dependents, core's tests that use the GitHub adapter, `check:proof`, `check:licenses`.
