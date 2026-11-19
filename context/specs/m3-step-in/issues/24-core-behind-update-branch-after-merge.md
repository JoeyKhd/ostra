# 24: Core: behind, update branch, and after the merge

Status: done
Builder: core
Blocked by: 07, 09
Features: F-070, F-066
Packages: `apps/core` (`src/reactions/`, milestone 2's ticket ingest and reconcile), `packages/domain` (`recordBehind`, `requestUpdateBranch`, `reopenAfterMerge`, `recordTicketClosed`)
Spec: `../spec.md`, section 4 ("Behind and update branch", "After a merge", "A ticket closed while running"); ADR 0052

## What to build

- **Behind:** the App's `push` webhook on a repo's base branch, and `task.reconcile-behind` every `OSTRA_RECONCILE_MINUTES` (milestone 2's interval), recompute `behindBy` for each task repo with an open PR or a pushed branch, from `compare(head, base)`. A change emits the task's change notice.
- **Update branch:** `requestUpdateBranch` writes one member message (`intent: "update-branch"`) naming each repo that's behind and its base, rendered by the domain's prompt (merge, never rebase; fix conflicts; run the checks), and sends it as the composer does. A task with nothing behind refuses it.
- **After the merge:** `reopenAfterMerge`, called by milestone 2's reopen when a task repo is `merged`: it moves the merged PR into `TaskPullRequest` (already there from the backfill or the opener), gives the repo a new branch (`<old>-2`, then `-3`, by `generation`) from the base's current head, resets its state to `no_branch`, and lets the restore start that repo from the base, not from the hidden ref. Its other repos keep their branches. The first push opens the new PR, linked on the same ticket (milestone 2's tracker writer) and named in the thread. The PR opener writes every PR it opens into `TaskPullRequest`.
- **A ticket closed while its task runs:** milestone 2's ingest, on a ticket moving to a `done` or `cancelled` category not by ostra's own write while the task is running: `ticket.closed`, interrupt the turn (an `interrupt` command), raise `ticket_closed`, notify. "Stop the task" is milestone 1's stop with reason `requested`; "Keep working" dismisses the item and sends "Carry on where you stopped." (`intent: "keep-working"`). A ticket closed by Linear's GitHub integration after the PR merged isn't "while it runs" and does nothing.

## Done when

- [x] Tests: a push to `main` updates `behindBy` once; update branch sends one message naming only the repos behind; a reopen after a merge makes `-2` from the base, keeps the merged PR, leaves an unmerged repo's branch alone, and a second merge and reopen makes `-3`; a ticket cancelled mid-turn interrupts once and raises one item; a close after the merge does nothing.
- [x] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `core` and `domain`.
- [x] Committed as `✨ add update branch and fresh branches`.

## Comments

- 2026-11-19: milestone 2's ticket 46 makes a project's branch names unique in the database (Q136, item 10; `context/open-questions.md`, Settled). A fresh branch's name (`-2`, `-3`) goes through the same check when this ticket makes it. And Q107 is settled: a repo whose PR closed unmerged keeps its branch after a reopen, and the task's next push to it opens a new PR, which `TaskPullRequest` keeps beside the closed one.
- 2026-11-19: done in `9bfc286` (`✨ add update branch and fresh branches`). A push webhook now runs both the behind check and ticket 26's snapshot trigger. A merged task reopens with `reopen_after_merge`; one with a repo merged and another in review reopens as before, and only the merged repo gets `-2`. `e54efcb` keeps milestone 2's refusal (`merged_reopen_later`, PRECONDITION_FAILED) for a merged task whose repos record no merge, which the API's tests expect. Follow-up for tickets 39 and 46: `tasks.ts`'s capabilities still answer `reopenBlocked: "merged_reopen_later"` for every merged task, so the panel hides Reopen on one, though the domain reopens it on a fresh branch. A repo merged while another repo of the task is in review gets its fresh branch in the database, but the task spec still carries one branch name (spec section 11, item 10), so the runner pushing per-repo branches is follow-up work. Proved live on `ostra-test/test1` (`apps/core/evidence/m3-pr-live.txt`): a push to the base made the branch behind by 1 through GitHub's compare; Update branch sent one message; the PR merged on GitHub, the reopen made `-2`, and its first push opened a second PR.
- 2026-11-19, review: the partial-merge reopen was broken end to end: the spec carried one `branchName`, so the runner pushed the merged repo's new work to the old branch while core looked for a PR on `-2`. Fixed by minor 3's per-repo `repos[].branchName` (core fills it; the runner, the git proxy, the host executor, the agent's instructions and the kept-checkout resume use it), proved by the F-066 tests in `after-merge.test.ts`, `host-executor.f066.test.ts` and `repo-branch.test.ts`. The "follow-up work" in the comment above is done.
