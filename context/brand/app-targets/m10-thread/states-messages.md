# Target: messages, dividers and results (waits for the maintainer's approval)

> **Committed image:** `states-messages.png` (2880×1912) with `states-messages.webp` (1440×956), from `html/states.html?sheet=messages`. Six numbered cells at the thread's scale. Sizes are CSS px; the parts are `parts.md`'s (2, 8 and 12).

| Cell | State | Approved target it keeps |
|---|---|---|
| 1 | A CI round: the outlined bubble `ostra 10:31 · automatic`, `**CI round 1 of 2** · automatic turn 1 of 4`, a row per failing check (`x` red, `unit-tests` mono, `failed` `--faint`, teal mono `ci/test.log`); then the agent's turn as any turn (`Read 2 files, edited 1 file, ran 2 commands` `10:31`) and its result `Pushed 9a03d1e · CI passed ›` | m6 `task-rounds.md` (the round card, its outcome line) |
| 2 | A findings round held by the budget: `**Findings round 1 of 2** · automatic turn 2 of 4`, `Sent 1 blocking finding: The store keeps 51 results. 1 nit listed, not required.`, and inside the bubble `pause-circle` `Held 9 min: calculator's budget for November was reached. Released when Priya Shah raised it.` | m6 `task-rounds.md` (findings, holds), m4's budget gate |
| 3 | A PR comment that asks ostra: outlined, `sam-rivera on GitHub 15:02 · PR comment`, the place `src/history/panel.tsx:42` and the words as a quoted item, then teal `Open on GitHub` and `Remember this` | F-053 (`@ostra` on the PR), m4 `memory-proposals.md` (`Remember this`, F-111) |
| 4 | Comments on the diff: filled, `Sam Rivera 15:06 · 2 comments on the diff`; each comment a quoted item: the place, the quoted line (mono `--muted`), the words | m3 `task-changes.md` ("In the Activity tab") |
| 5 | Between turns: the day `Yesterday`; `history` `Restored from the session archive on alex-desktop · unfinished work restored`; Alex's message tagged `reopened the task`; `user-round` `Sam Rivera is driving now (Alex Kim handed it over)`; Sam's message tagged `queued` | m2 `task-reopen.md` (markers, day dividers, the reopen tag), m1 `task.md` (the driver line, `queued`) |
| 6 | Results a turn leaves: `app-window` `Preview web :5173 /history` + teal `Show`; `file-pen-line` `Handed in draft v2 · 4 acceptance criteria, 2 sub-tickets` + teal `Open the draft`; `lightbulb` `Proposed a memory: Run the tests with pnpm test, not npm` + teal `Review`; a budget hold as a notice `Held: calculator's budget for November is reached. It starts when the budget allows.` + teal `Open spend` | m8 `task-preview.md` (the Preview row), m6 `refine-draft.md`, m4 `memory-proposals.md` (F-111), m4 budget (F-037) |

## Notes per cell

1. **A round is ostra's own message,** so it's outlined and right-aligned like every message sent to the agent; milestone 6's "the one bordered block the thread has" holds: it's the outlined bubble, with no box inside it. The agent's turn under it is a normal turn, not folded under `Show the turn`: its run's line already is the fold. The round's outcome is the turn's push result line, with the CI verdict once known.
2. **A hold** stays inside its round's bubble; a hold of a member's turn (not a round) is the notice line of cell 6.
3. **A PR comment** came from GitHub, so it's outlined and named by its login. `Remember this` opens milestone 4's form under the bubble, as today.
4. **Diff comments** were written in ostra by a member, so the bubble is filled. Each quoted item's place is mono 12.5px `--faint`; the quoted code line one line with an ellipsis; the comment 14px `--text`.
5. **What isn't a divider:** `The runner connected.`, `The box stopped after 15 idle minutes.`, `The box was released.`, `Work saved after turn 3`. They're in the Event log, the status line (`box idle, stops in …`, `box released`) and the panel's Session group.
6. **Results** sit after their turn's prose, one line each. A refine task's draft never shows a PR line or a push.

## Wrong in the image (build from this file)

- **The sheet** is not a screen; each cell is a piece of the thread with a dashed edge the build doesn't have.
- **Cell 1's** turn has no prose between its line and its push, to fit the cell; a real turn has its summary there.
