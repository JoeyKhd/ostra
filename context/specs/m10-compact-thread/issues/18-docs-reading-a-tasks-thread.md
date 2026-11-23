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
