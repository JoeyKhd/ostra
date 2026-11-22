# Target: the steps' states (approved 2026-11-22)

> **Committed image:** `states-steps.png` (2880×1912) with `states-steps.webp` (1440×956), from `html/states.html?sheet=steps`. A sheet of six numbered cells, each a piece of the thread at its real scale in a 660px column (the thread's column is 720px). Sizes are CSS px; the parts are `parts.md`'s.

The approved targets list these states; this sheet shows how each looks in the compact thread.

| Cell | State | Approved target it keeps |
|---|---|---|
| 1 | The live step's words: `Thinking · 0:06`; `Running pnpm test history · 8 steps done, 1 failed · 3:52`; `Writing · 11 steps done · 5:10`; `Reading .ostra/attachments/4/history-panel-mock.png · 1 step done · 0:12` | m1 `task.md` (the running verbs, `doing.*`), m9 `message-attachments.md` (the agent reading a member's file) |
| 2 | A running command, its run opened: two edits, then `Running pnpm test history · 12 s · hide output ›` with a spinner, and its output streaming in its block | m1 `task.md` (`Running`, the output block) |
| 3 | A failure the turn recovered from: the line's tail `1 failed, then passed`; opened, the failing run's output (`✗ panel renders an empty history`, `TypeError…`, `Tests 1 failed | 13 passed`) with the failing line in `--red`, then the fix and the passing run | m1 `task.md` (`exit 1`), m4 `task-event-log.md` (the failed call) |
| 4 | A failure the turn didn't recover from: `Command failed pnpm build · exit 2 after 38 s · output ›` on its own line; the prose after it; a failed turn `The turn failed · the model's provider answered 529 Overloaded. Send a message to try again.`; and a limit (muted, not red): `timer-off` `Stopped at the turn's 60-minute limit.` + teal `Keep working` | m1 `task.md` (crash lines in `--red`), m2 `task-limits` (limits) |
| 5 | Subagents: `Ran 3 subagents, read 2 files` + the badge `4 subagents · 1 running`; opened, a row per subagent (`explore · Find the history store · 12 calls · 41 s ✓ · open ›`, … `general · Write the panel tests · 9 calls · running`) and the reads; the footer adds `subagents 31.4k tokens` | m7 `task-subagents-tree.md` (the badge, the rows, the window) |
| 6 | Effort: the marker `Alex Kim set effort to Low, from the next turn 14:11` as a divider; a clamped turn's footer `Turn 3 · Max, asked Extra high · 48k in · 9.1k out · 6.4k reasoning · $0.41` | m4 `task-effort.md` (the marker, the per-turn level and reasoning, the clamp line) |

## Notes per cell

1. **The live step's words** come from the running part (`parts.md` part 5). A path in the words is relative to the workspace root (content fix 7); an attachment's path reads as the box has it (`.ostra/attachments/4/…`, milestone 9).
2. **A running command's output** streams into its block while its link reads `hide output ›`; the block keeps its last 320px in view and scrolls with new lines unless the member scrolled it up. The live step above it reads `3 steps done · 1:04`.
3. **The recovered failure's output** isn't opened for the member; the picture shows it opened by a press. Its link reads `hide output ›` while open. The failing test line is `--red` only where the output itself marks it (`✗`); ANSI colours are stripped as milestone 3's checks do, and ostra colours nothing else in an output.
4. **The order** is the thread's: the run's line, its unrecovered failure under it, the prose. A turn that failed ends with its red line; the composer's hint then reads milestone 1's. A limit isn't an error, so it's `.notice`: `--muted` icon and words, and its action teal. The stall limit reads `Stopped: no progress for 10 minutes.`; the spend cap `Stopped at the task's spend cap of $25.00.` + teal `Raise the cap` for the driver.
5. **A subagent row** opens the subagents window on it (F-138). A subagent's own calls are never rows in the thread, and its approval shows as cell 1 of `states-asks.md` with `explore · Find the version source asks before…` as the sentence (milestone 7).
6. **The marker** sits in time order among the thread's items, as milestone 4 settled. The clamp moves from its own line under the usage line to the footer's level fact; its full sentence `Ran at Max: this model has no Extra high.` is the fact's tooltip.

## Wrong in the image (build from this file)

- **The sheet** is not a screen: each cell is a piece of the thread, drawn without the shell and with a dashed `--line-2` edge at its left that the build doesn't have.
- **The spinners** are still frames.
