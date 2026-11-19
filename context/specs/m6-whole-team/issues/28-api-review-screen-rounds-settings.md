# 28: API: the review screen, rounds and review settings

Status: ready-for-agent
Builder: api
Blocked by: 16, 17, 18, 19, 20
Features: F-102, F-100, F-101, F-035, F-105, F-111
Packages: `packages/api` (`src/routers/review.ts`, `src/routers/projects.ts`)
Spec: `../spec.md`, section 4

## What to build

- `review.screen({ taskId })` → per PR: the diff (milestone 3's compare, cached by head) with the file tree, the findings of every review run on it with their state, the reviewers and their states; the ticket with its acceptance criteria (the accepted draft's, or the ticket's text); the round line (the sub-state, each kind's rounds used, automatic turns used).
- `review.fixThis({ findingId })` → the finding added to the member's draft diff comments (milestone 3), on its line, so "Send to agent" sends it with the rest as one prompt; `review.rememberFinding({ findingId })` → a proposal (ticket 17).
- `tasks.rounds({ taskId })` → each round with its kind, number, cause (the failing checks with their log files' names, the findings sent, the review by whom), its state, and a held round's reason.
- `projects.reviewSettings` and `projects.setAiReview({ projectId, on })` for a project admin; the round limits read-only from the settings.

## Done when

- [ ] Tests: the screen's parts for a task with two PRs; "Fix this" lands on the right line as a draft; "Remember this" makes one proposal; the rounds' view after a CI and a findings round; the switch by a project admin only.
- [ ] The touched packages' checks pass (spec section 9).
- [ ] Committed as `✨ add the review API`.

## Comments
