# The review loop: CI, AI review, rounds and reviewers

**Status:** accepted (2026-11-19, on the maintainer's delegation for milestone 6's spec). Settles Q222 to Q227. Covers F-035, F-100, F-101, F-102 and F-105, and puts ADR 0028 (the review kind) and ADR 0041 (the loops and their caps) into practice, with ADR 0040 (the App, the independent-review check) and ADR 0055 (the budget gate). **Amended 2026-11-21, the maintainer's decision** ("all yes" to milestone 6's review follow-ups): a review run again on a new head counts toward the review rounds' cap (the section "A review run again on a new head").

ADR 0041 says what sends a task back to its agent and how often. This ADR says what ostra reads to know CI's result, how one review covers several PRs, what counts as an automatic turn, how logs reach the agent, and who the reviewers are.

## CI

- **CI is the PR head's check runs and commit statuses, with ostra's own App's check runs left out** (the independent-review check would otherwise keep CI pending until someone approves).
- **Failed** when any check run concludes `failure`, `timed_out` or `action_required`, or any status is `failure` or `error`. **Passed** when everything finished otherwise. **No CI** when nothing appeared within 2 minutes *(working value)* of the push: the loop moves on, as for a pass. **Timed out** after 60 minutes *(working value)* pending: the AI review starts and the task shows CI still running, with no fixing round.
- ostra reads it on `check_run`, `check_suite` and `status` webhooks, which the App gains, and in milestone 2's PR reconcile, so an install without webhooks still gets every verdict, later.

## Logs to the agent

- **The tails of at most 5 failing checks, 64 KiB each** *(working values)*, are files in the task's config folder under `ci/`, never in a repo, and the prompt names them. A GitHub Actions job's log comes through the App's `actions: read` (ADR 0040); another check's log is its output's summary and text, and a status's is its description and link.
- **A log is untrusted text.** It's a file the agent reads, wrapped as data in the prompt's framing, never logged and never posted anywhere.

## One review task per code task

- **A code task has one review task,** created at its first review and reopened for each round, so its thread holds every round. It reviews **every open PR of the task at once,** each repo checked out at its PR's head, read-only (ADR 0028), on the project's default review profile, with its own box, session and spend cap.
- **It hands in typed findings,** each with a repo, a file, a line and a side, blocking or a nit, and at most 30 *(working value)*.
- **ostra posts one comment-type review per PR,** with the event `COMMENT`: each finding on a line the PR's diff covers as a line comment, the others listed in the review's body (GitHub refuses a line comment outside the diff). The code host interface accepts no other event, so nothing can approve or request changes for the agent.
- A head that moves while the review runs ends that review; CI and the loop start again on the new head.

## What counts as an automatic turn

- **An automatic turn is a turn of the coding agent that no person asked for:** a CI round or a findings round. The review task's own turns don't count; the rounds they cause do.
- **The counts run since a person last acted on the task:** a message, a reopen, an answer, "Keep working", "Fix this" sent, a "changes requested" review. "At most 4 before a person has to act" (ADR 0041) then means exactly that.
- Every automatic turn goes through the budget gate with the origin `automatic-round` and the task's spend cap, before it starts.
- A question the agent asks in an automatic turn gets the fixed neutral reply (Q160), never a decline.

## A review run again on a new head

Added 2026-11-21, the maintainer's decision. Milestone 6's review found that a head moving during a review (a person or a bot pushing to the PR) voids that review and starts another on the new head, every time, with no cap: the review task's turns aren't automatic turns, so only the budget gate stood in the way.

- **A review that runs again because the last one never posted is one of the task's review rounds.** It counts toward `OSTRA_REVIEW_ROUNDS` with the findings rounds, since a person last acted, and is checked before its run is made. It isn't an automatic turn: the coding agent takes no turn for it, so `OSTRA_AUTOMATIC_TURNS` doesn't count it.
- **Past the cap, a new head gets no automatic review.** The task goes to "needs you" with the same "round cap reached" item as every capped loop, for its driver, and "Keep working" or a message starts the count again.
- The first review of a loop, and the review of a round's fix (the last run posted), are no reruns.
- *Considered:* a cap of review runs of their own (one more setting, for the same question the review rounds answer); and counting the rerun when the head moves (CI on the new head may fail, and then a CI round, not a review, comes next).

## Reviewers

- **A task's reviewers are the PR's requested users, and the users `CODEOWNERS` names for the changed paths,** each matched to a member through the verified GitHub link (F-119). ostra requests nobody on GitHub.
- **A team, requested or in `CODEOWNERS`, is shown and not expanded:** the App asks for no `members` permission, and one more permission is approved again by every install (ADR 0040). GitHub's own code-owner request still reaches the team's people on GitHub.
- **A PR waiting for a reviewer is in its matched reviewers' "needs you",** and in the driver's when nobody is matched (ADR 0050).

## "Changes requested"

- **A `changes_requested` review from a GitHub user linked to an active member who can open the project reopens the task** with the review's body and its line comments as one prompt, after the running turn. A bot's, an unlinked user's and anyone else's are ignored.
- **No round cap applies** (a person asked), and it counts as a person's action. The spend cap and the budget still do.
- **The reviewer gets no co-author trailer for it** (ADR 0040, amended): asking for changes is reviewing, and a trailer would make the reviewer a driver, so their next approval wouldn't count for the independent-review check.

## Considered options

- **Check suites instead of check runs.** Rejected: GitHub creates a suite for every App that can write checks, and one with no runs stays queued forever.
- **CI logs in the prompt.** Rejected: 320 KiB of untrusted text in a prompt costs tokens every turn; a file is read once, when the agent needs it.
- **A review task per PR.** Rejected: ADR 0041's caps are per task, and a change across two repos is reviewed as one.
- **Requesting reviewers from ostra.** Rejected for v1: a repo's own rules (CODEOWNERS, branch protection) say who reviews; ostra reads them.
- **Expanding teams.** Rejected above.

## Consequences

- The schema gains CI runs, rounds, review runs, findings and reviewers (milestone 6's spec, section 5.3); the code host interface gains CI results and logs, comment-type reviews, requested reviewers, CODEOWNERS and a review's comments.
- The App's manifest gains three events, and existing installs add them once.
- Revisit "no CI after 2 minutes" if slow CI providers report later than that; revisit team expansion if teams own most paths.
