# 18: Docs: reading a task's thread

Status: done
Builder: core
Blocked by: 04, 10, 11, 12, 13, 14, 15, 16
Features: F-151
Packages: `apps/docs` (`content/using-ostra/tasks.mdx`, `steering.mdx`, `review-loops.mdx`, `budgets.mdx`, and any page that names the thread's old rows)
Spec: `../spec.md`, section 1

## What to build

The docs describe the thread as it is built, in the panel's words (ticket 04's), with no screenshot of the old one.

- **`tasks.mdx`** gains "Reading a task": a member's and ostra's messages, the agent's prose, a run's line and what opens under it, the live step, failures (one red word when the agent fixed it, its own line when not), what a turn made, receipts, where a turn's numbers are (the opened run's footer, the time's tooltip, the properties panel, the Event log), and the box in the status line.
- **`steering.mdx`:** answering a question with `Something else…`, and the pill when a block is scrolled away.
- **`review-loops.mdx`:** checks (the environment's, in the box, before the push) and CI (the code host's, on the PR, in jobs), and the CI round's failing jobs; a review task's page and its repeat hand-in.
- **`budgets.mdx`:** a turn's spend in its footer and tooltip, the task's in the panel.
- **Every other page** that names `Show the output`, the token line, `Work saved after turn …` or CI counted in checks, found by a search and changed.
- The docs' build and link check pass.

## Done when

- [x] Each page above describes the built thread in ticket 04's words, and a search of `apps/docs/content` finds none of the old rows' words and no CI counted in checks.
- [x] The docs site's build and its link check pass.
- [x] Committed as `📝 document reading a task's thread`.

## Comments

**2026-11-23, built (core)** as `📝 document reading a task's thread` (the ticket's line asked for `📝 document the compact thread`; the assignment names the message above). What it does, page by page:

- **`tasks.mdx`, "Read the thread":** the column's table (a member's bubble, ostra's and GitHub's outlined bubbles, the agent's prose with no header, a run's line, the live step, a turn's result line, the needs-you block, and where the numbers live), then a section for each: the run's line and its counts (`Edited 2 files, ran 2 commands, took a screenshot · 1 failed, then passed`, the shared-noun rule, `23 steps:` past 20), what opens under it (`Read`, `Edited`, `Ran`, `Thought`, `Searched`, `Fetched`, `Used`, `Captured`, each with its result and `output ›`/`diff ›`/`show ›`), the footer with `Event log ›`; the live step (its words, progress, plan step, the approval in its place, the 10-second announcement); failures (one red word when recovered, its own line when not, a cancelled step and a quiet notice named); what a turn made (push with checks in the box, the PR card once with CI in jobs, review, draft, preview, memory; a save is bookkeeping); where a turn's numbers are (footer, tooltip, panel's Usage and Session, Event log; no tooltip on a phone); the status line (state, activity, `Idle, the box stops in 11 min` — ticket 15's built words, not the target's `box idle, stops in …`, and the Session group); what waits on you and the pill; checks and CI as two words; phone, light and the keyboard (`j`/`k`, Enter/Space, the time's tooltip and Escape, `⌘↵`, reduced motion). "Follow it" is gone; its app-pictures paragraph sits under "What a turn made".
- **`steering.mdx`, "Answer a question":** the driver answers, the choices as a radio group, `Something else…` on every question with choices where the agent takes words (OpenCode does; `capabilities.questionFreeText`), a field of its own, `Send answer` asleep until every field holds a value, `⌘↵`/`Ctrl+↵`, the watcher's `Take over to answer`, the receipt (`Sam answered “Use a queue”`) and the pill (`Needs you · question`, `· plan`, `· approval`).
- **`review-loops.mdx`:** the rounds table now says failing CI **jobs**; "Checks, then CI" (checks in the box are counted in checks, CI on the PR in jobs, both in the Checks tab and its marker); the CI round's outlined bubble (`CI round 1 of 2 · automatic turn 1 of 4`, a row per failing job with its conclusion and `log ›`, "The failing CI jobs weren't recorded." when none were); "A review task's page" (Activity and Event log only, `Open the code task` and `PR #483`, no Take it local/Changes/Checks/Code group, the first bubble `AI review of PR #483, round 1 of 2`, the outcome `Review posted on PR #483 · 2 blocking, 1 nit`, `Open the review`); "Ask it to review again" (`Review on PR #483 confirmed · already posted this round, unchanged`, nothing red, nothing posted twice while the PR hasn't moved).
- **`budgets.mdx`, "Where a turn's spend shows":** the opened run's footer (`≈` and ` so far`), the time's tooltip, the panel's Usage group, the Event log; the task's total in the panel and Insights.
- **Every other page:** `files.mdx` says the files sit above the bubble, right-aligned; `the-running-app.mdx` says a capture shows under the line of the run that took them, captioned with its route; `30-minute-path.mdx` reads the thread, not a "timeline"; `approvals.mdx` links to "Answer a question". A search of `apps/docs/content` finds no `Show the output`, no token line, no `Work saved after turn …`, no CI counted in checks.
- **Nav:** no change: "Reading a task" is a section of `tasks.mdx`, so `using-ostra/meta.json` keeps its pages, and `check:export` still finds the section's navigation links.
- **Checks:** in `apps/docs`, `pnpm build` (exit 0) then `pnpm check:export` (vitest, 5 tests passed), on the tree as committed.
- **Screenshots:** the docs site holds none of the panel, so there was no screenshot of the old thread to replace.
- **For later tickets:** nothing here changes code. Ticket 19 sets F-151's ledger status and runs the demo; the pages describe what tickets 10 to 17 built as it is on `main`.


- 2026-11-23, core: docs build and link check pass; committed locally as `4367e1c1` (`📝 document reading a task's thread`). Rebased onto `origin/main` after this note.

- 2026-11-23, browser pass (web): the thread's older browser specs now run on the compact layout, and the combined by-eye pass of tickets 09–17 against `context/brand/app-targets/m10-thread/` is done. The specs the pass names were run on the production build (`next build`, external stack on 3810), never the whole suite.

  **Realigned to what tickets 09–17 built (real selectors, not guesses):**
  - `e2e/21-task-answers.spec.ts`: the three `F-026` tests read an answered approval where it now lives — the answered call's row in the turn's run (`[data-part='run-steps'] li[data-step='command'|'edit']`, `approved once by …` / `denied by …`), opened through the live step's line. The deny's reason and `Approve for this task`'s pattern are asserted through `tasks.get` (`denyReason`, `forThisTask.pattern`) and the panel's `task-rule`. `F-084/c1,c3` reads each turn's figures in `[data-part='run-footer'] [data-part='footer-facts']`; `e2e/seed-answers.ts` now gives each counted turn one call, so each turn draws a run with its footer.
  - `e2e/21-subagents.spec.ts`: a subagent is a step of the opened run (`li[data-step='subagent']`, with a `data-subagent` id added to `run-steps.tsx`), never a `data-part='subagent-row'` row; the run opens through the live step's line while the turn still runs.
  - `e2e/19-review.spec.ts`: the stage strip is gone; the status line (`task-doing`, `[data-part='status-place']`) and the panel's `rounds-group` say where the review stands, and the review screen is its own route (`/tasks/<id>/review`, the top bar's Review button went in ticket 17).
  - `e2e/22-linear-inbox.spec.ts`: Home's checklist step is `data-step="tracker"`; the ticket is read on the key line (`<key> · from Linear`, the header strip went in ticket 17); the Boards picker's combobox is named `Attach`.
  - `e2e/27-thread-results.spec.ts`: the status line's `In review · CI running` and `PR #483` replace the stage line's job count; jobs are still counted on the PR card (`CI on GitHub: running, 2 of 4 jobs done`) and on Home's board, which the file's first test checks before the test that finishes CI.
  - `e2e/27-thread-review-task.spec.ts`: the removed header line's `task-prs` gives way to `[data-part='status-place']` absent on a review task.
  - Commands: `pnpm --filter @ostra/web typecheck` clean; `eslint` on the touched files clean; the six spec files, `--project desktop --no-deps` on the build, all 28 tests green; `21-subagents` also green on `--project phone --no-deps` (5 tests). Shots from `e2e/27-thread-phone.spec.ts` (6 passed) under `C:/Users/santi/ow/m10-shots/`.

  **What still differs from the targets, and why:**
  - The properties panel's `Effort` is milestone 2's `<select>` with its arrow where the targets draw plain `High`; m10 changed no control.
  - `Model` and `Profile` print the seeded world's long names, truncated (`Claude Sonnet 5.5 Key · t…`), where the targets' demo data is short — screenshot data, not layout.
  - An opened run's footer on a phone adds `· not saved yet` while the turn is open, where `s6-phone-open` ends at the spend; `parts.md` lists the saved facts in the footer and `s6.md`'s picture leaves the open-turn one out.
  - At 390 px the page scrolls as a document: milestone 8's 54 px phone top bar and the `Chat | Preview` switch scroll away, so the phone shots catch the thread below them where `s6` draws both pinned. That is the shell's layout, not the thread's parts.
  - The question block takes the focus on a load with no pointer use, so its teal `:focus-visible` ring shows where the targets draw none (ticket 13's decision, already noted by ticket 17).
  - The `…` menu sits inside the composer, left of Send (m2's `phone-task` rule), where `s6` draws it only in the top bar (ticket 17's note).

  **Gaps found by the pass (not one-line mismatches; for the ledger and the maintainer):**
  - An answered approval's receipt lost the deny's reason and the rule's pattern (the row says `denied by {name}` / `approved for this task by {name}`), and a losing member's `Someone answered this first.` no longer has a place: `ApprovalNote`, which words both, is drawn only while a block is pending. `tasks.get` still carries `denyReason` and `forThisTask` to every member (the specs assert it), so `F-026/c4`'s "the receipt shows it to every member" is now the answer's figure, not its words, and `F-026/c5`'s lost-race line is unproved on the page.
  - The task page has no link into a review screen while a review waits for its human reviewer: ticket 17 took the top bar's Review button, and the panel's `task-open-review` link exists only on a review-kind task. The spec navigates to `/tasks/<id>/review` directly.
  - Seeded worlds are never cleaned between runs, so Home's Live list and the screenshots accumulate tasks (`Live 10`) where the targets draw five.
