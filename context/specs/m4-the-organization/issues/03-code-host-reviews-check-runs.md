# 03: Adapter SDK: reviews, check runs and PR bodies

Status: ready-for-agent
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

- [ ] The suite passes against the fake, and against GitHub once ticket 08 is in.
- [ ] Every caller compiles; an adapter without reviews declares `reviews: false`.
- [ ] Committed as `✨ add reviews and check runs to code hosts`.

## Comments
