# 19: Core: reviewers and their needs-you

Status: done
Builder: core
Blocked by: 06, 08
Features: F-102, F-036 (the reviewer audience)
Packages: `apps/core` (`src/review-loop/reviewers.ts`, milestone 3's audience resolver), `packages/domain`
Spec: `../spec.md`, section 4 ("Reviewers"); ADR 0050, ADR 0058

## What to build

- **`reviewers.refresh`,** keyed by the task repo, `singletonSeconds` 10, on `review_requested`, `review_request_removed`, a PR opening, a push and the reconcile: `listRequestedReviewers`; `readCodeOwners` at the PR's base and `ownersFor` the PR's changed paths; each GitHub user mapped to an active member through the verified link (F-119); `TaskReviewer` rows written, teams kept as rows of their own with no member; `reviewers.updated` when the set changes. A user's latest review state is kept from milestone 4's review handling.
- **The audience:** milestone 3's resolver returns the matched reviewers for the `reviewer` audience, and the driver when none is matched (ADR 0050). A task entering "waiting for a reviewer" writes a needs-you item (`waiting_for_reviewer`) and a `review_requested` notification on every channel the member wants; a reviewer whose review is in clears their own item.
- ostra requests nobody on GitHub.

## Done when

- [x] Tests named `it("F-102: ...")`: reviewers from requested users and from CODEOWNERS for the changed paths, matched by the link; a team kept and not expanded; an unlinked reviewer listed with no member; the needs-you item for the matched reviewers; the driver when none matched.
- [x] A test named `it("F-036: ...")`: the reviewer audience reaches the panel, the ticket and email, by the member's choices.
- [x] Break-it: CODEOWNERS' last-match rule reversed fails its test; recorded in `context/proof/F-102.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add reviewers`.

## Comments

- 2026-11-20, committed as `✨ add reviewers`. `refreshReviewers` (`packages/domain/src/review-loop/reviewers.ts`) and `reviewers.refresh` (`apps/core/src/review-loop/reviewers.ts`), asked for by the `pull_request_reviewers` hint, a PR's opening or push and the reconcile. Choices made here:
  - A CODEOWNERS user has only a login. They're keyed by the requested user of that login, else the linked account's `githubLogin`, else `login:<login>` in `githubUserId` (`codeOwnerLoginKey`), listed with no member.
  - A team is kept by its slug in small letters, the `org/` prefix dropped, so a requested team and the same CODEOWNERS team are one row.
  - The changed paths come from `compare(base, head)` (a rename counts both paths). With no `compare` capability, CODEOWNERS isn't read.
  - A row whose user reviewed stays when GitHub drops their request on review. Each user's latest review state is kept by milestone 4's `review.evaluate` (`recordReviewerStatesInTx`, called when its deps carry `jobs`).
  - The item: `moveTaskInTx` writes the `waiting_for_reviewer` item (audience `reviewer`, moment `review_requested`) when a code task starts waiting for a reviewer, and dismisses it when the task stops waiting. "Clears their own item" is per member: a reviewer's review since the item answers their own notification, and the item is answered once every matched reviewer's notification is closed. The panel's one rule (`openNeedsYouWhere` in `packages/api`) shows a reviewer item to each matched reviewer without a closed notification of it, and to the driver when nobody matched.
  - A change to the reviewer set while the task waits enqueues the item's `notify.fanout` again, which writes only the new reviewers' notifications.
  - The mail's footer says "a member of the project" for a reviewer (`AudienceReason` unchanged).
- 2026-11-20: landed on main as cae998fa; its test's review times were fixed in 2ccc6f4a.
