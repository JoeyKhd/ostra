# 20: Core: "changes requested" reopens the task

Status: ready-for-agent
Builder: core
Blocked by: 06, 08, 18
Features: F-105
Packages: `apps/core` (`src/review-loop/changes-requested.ts`, milestone 4's review handler), `packages/domain` (`reopenOnChangesRequested`)
Spec: `../spec.md`, section 4 ("Changes requested"); ADR 0040 (amended), ADR 0041, ADR 0058

## What to build

- **The trigger:** milestone 4's `pull_request_review` handling, for a `submitted` review with `changes_requested` on a task's PR, from a GitHub user linked to an active member who can open the project, enqueues `changes.reopen` keyed by the review ID. A review from anyone else, a bot (ostra's own App included) or an unlinked user is ignored, with an event saying so and no reply.
- **`changes.reopen`:** `listReviewComments` for that review; the body and the comments (each with its file and line) as one member message from the reviewer, intent `changes-requested`, wrapped as data; milestone 4's gate with the origin `changes-requested`; the spend cap. A running turn finishes first, as with `@ostra`. No round cap applies, and the turn is a person's action, so the automatic counters reset.
- **No co-author trailer** for the reviewer from this prompt: `TaskCoAuthor` isn't written for it, so the independent-review check still counts the reviewer's approval (ADR 0040, amended).
- The thread shows "Changes requested by <member> on GitHub", with a link to the review.

## Done when

- [ ] Tests named `it("F-105: ...")`: a linked member's `changes_requested` reopens with the body and comments as one prompt; anyone else, a bot and an unlinked user are ignored; it waits for the running turn; no round cap, two in a row both run; the spend cap and the budget hold it; no trailer for the reviewer, and the check then passes on their approval; a replayed webhook reopens once.
- [ ] Break-it: the link check dropped (an unlinked user's review reopens) fails its test; recorded in `context/proof/F-105.md`.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ reopen a task on changes requested`.

## Comments
