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
