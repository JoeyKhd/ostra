# 28: API: the review screen, rounds and review settings

Status: done
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

- [x] Tests: the screen's parts for a task with two PRs; "Fix this" lands on the right line as a draft; "Remember this" makes one proposal; the rounds' view after a CI and a findings round; the switch by a project admin only.
- [x] The touched packages' checks pass (spec section 9).
- [x] Committed as `✨ add the review API`.

## Comments

- 2026-11-20: built in `✨ add the review API`. `packages/api/src/routers/review.ts`: `review.screen`, `review.fixThis`, `review.rememberFinding`; `tasks.rounds` (`taskRoundsProcedure`, spread into the tasks router); `projects.reviewSettings` and `projects.setAiReview` (`projectReviewProcedures`). The domain gains `setAiReview` and `acceptedCriteriaOfTicketInTx` (`packages/domain/src/review-loop/review-settings.ts`; the review prompt now reads its criteria through it) and exports `CI_FAILING_CONCLUSIONS`; the audit gains `project.ai-review-set`; milestone 3's diff router exports `diffFileViews`, which the screen draws its files with. Proof: `context/proof/F-102.md`, `F-100.md`, and notes in `F-101.md` and `F-111.md`.
- Choices: the screen is a code task's only (another kind is `NOT_FOUND`), and lists its repos that have a PR. The file tree is the changed files in path order, each with its open findings' count; the panel nests them. "Fix this" writes the draft on the head the review ran on (the run's `heads`), so it's outdated, as milestone 3 shows it, once the head moves; pressed twice it's one draft, a finding in the review's body (off the diff) is refused, and it counts as a person acting (`recordPersonActionInTx`, the `fix-this` action). `tasks.rounds` reads a capped round's reason from the nearest `round.capped` event of its kind (`TaskRound` has no reason column), else the spend cap; a held round's from the task's unreleased held turn (its budget's scope); a "changes requested" round's reviewer from the `pr.changes-requested` audit entry of its review. `review.rememberFinding` checks the finding's project before ticket 17's `rememberFinding`.
- The isolation suite has rows for the three new queries and readers for `CiRun`, `TaskRound`, `ReviewRun`, `Finding` and `TaskReviewer`.
- Checks: typecheck and lint of `@ostra/api`, `@ostra/core`, `@ostra/domain` and `@ostra/web` through turbo; tests of `@ostra/api`, `@ostra/core` and `@ostra/domain`; `check:licenses`; `check:proof`. Break-its, one at a time, each failing its case: every PR given every finding; "Fix this" a line below its finding; "Fix this" without the person's action; "Fix this" answering without saving (the one-prompt case too); passing checks listed as a round's cause; every capped round called the spend cap's; the switch open to anyone who can open the project, in the router and the domain; "Remember this" proposing twice.
