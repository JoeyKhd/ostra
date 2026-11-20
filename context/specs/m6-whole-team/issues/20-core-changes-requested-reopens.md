# 20: Core: "changes requested" reopens the task

Status: done
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

- [x] Tests named `it("F-105: ...")`: a linked member's `changes_requested` reopens with the body and comments as one prompt; anyone else, a bot and an unlinked user are ignored; it waits for the running turn; no round cap, two in a row both run; the spend cap and the budget hold it; no trailer for the reviewer, and the check then passes on their approval; a replayed webhook reopens once.
- [x] Break-it: the link check dropped (an unlinked user's review reopens) fails its test; recorded in `context/proof/F-105.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ reopen a task on changes requested`.

## Comments

- 2026-11-20, committed as `✨ reopen a task on changes requested`, after `✨ read a review's body and page` (46cd0b53 locally before the rebase), which adds `body` and `url` to `PullRequestReview` (optional, so additive) and reads them in GitHub's adapter: the job needs the review's body, and the event carried none. Ticket 19 landed as cae998fa. Choices made here:
  - The job reads the review again on the host (`listReviews`), not from the delivery, and checks the reviewer again, so a link removed meanwhile counts.
  - The reviewer stays a reviewer: `sendMemberMessageInTx` and `reopenTask` gain `keepDriver`, so a reopen from "changes requested" keeps the task's driver. Otherwise the reopen would have made the reviewer the driver.
  - "An event saying so" for an ignored review is the delivery's recorded outcome (`ignored`, with the reason: `a-bot`, `unlinked`, `not-a-member`, `no-access`, `not-a-task-pr`) plus a log line with IDs. The protocol has no thread event for it, and the ticket asks for no reply.
  - The thread's "Changes requested by <member> on GitHub, with a link" is `round.started` (`changes-requested`, not automatic), the `user.message` with intent `changes-requested` from the reviewer, and `pr.comment_received` with the review's page (the PR's when the host gives none). Rendering it is the web's (ticket 35).
  - A task between sessions (queued for its next turn) can't take the message yet. The job throws, and the queue retries it until the session is going. At the spend cap the send is refused and nothing is kept, the counter reset included.
