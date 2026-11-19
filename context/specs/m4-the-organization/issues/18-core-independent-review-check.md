# 18: Core: the independent-review check

Status: ready-for-agent
Builder: core
Blocked by: 06, 08
Features: F-104
Packages: `apps/core` (`src/code-host/`, `src/reactions/review-check.ts`), `packages/domain` (`evaluateIndependentReview`)
Spec: `../spec.md`, section 4 ("The independent-review check"); ADR 0040 (amended)

## What to build

- **`review.evaluate`,** keyed by the PR and its head, `singletonSeconds` 10, enqueued on: a `pull_request_review` delivery for a task's PR; a `pull_request` `synchronize`; a PR opened by ostra; a member linking or unlinking GitHub (every open PR of the organization's tasks where that GitHub user reviewed); a new co-author trailer on the task; and milestone 2's PR reconcile.
- **The evaluation:** `listReviews`, each reviewer mapped by GitHub user ID to an active member of the task's organization through the verified link (F-119), the drivers from `TaskCoAuthor`, spike 4's evaluator (ticket 06), and the result written to `ReviewCheck` for the head. Only when the result changed: `publishCheckRun` for a new head as `in_progress` ("Waiting for an independent reviewer") and `updateCheckRun` to `success` ("Approved by <member>") or back; then a `review.check_updated` event. The reason says why it waits: no approval, only drivers approved, the approval is stale, or the approver isn't linked.
- **`action_required`.** A setting-free switch in the adapter's call: the check reports `in_progress` while waiting until ticket 41's live test on `test1` records that this doesn't block a merge under branch protection. If it doesn't, this ticket's follow-up changes the waiting state to `completed` with `action_required`, and ADR 0040 records the answer.
- **Never** a review's body in a log line or an event; logins and IDs only.

## Done when

- [ ] Tests named `it("F-104: ...")` against the fake code host: an approval by a linked non-driver passes; by a driver, a bot or an unlinked user it waits with its reason; a new head waits; a dismissal or a withdrawn approval sets a pass back to waiting; changes requested after an approval waits; a replayed webhook writes nothing; both branch-protection modes of ticket 03.
- [ ] Break-it: the driver filter dropped fails its test; recorded in `context/proof/F-104.md`.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add the independent-review check`.

## Comments
