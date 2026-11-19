# 08: GitHub adapter: reviews, check runs, PR bodies and the review webhooks

Status: ready-for-agent
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

- [ ] The code host contract suite of ticket 03 passes against the fake and, gated on `github-test.env`, against `ostra-test/test1`.
- [ ] Gated on `github-test.env` and `GITHUB_TEST_REVIEWER_TOKEN`: on a PR in `test1`, the reviewer user's approval, its dismissal and a new push each arrive as their webhook hint, and a check run is published once per head, recorded in `## Comments`.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add reviews and check runs on GitHub`.

## Comments
