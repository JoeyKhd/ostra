# Target: what waits on a person (waits for the maintainer's approval)

> **Committed image:** `states-asks.png` (2880×1912) with `states-asks.webp` (1440×956), from `html/states.html?sheet=asks`. Six numbered cells at the thread's scale. Sizes are CSS px; the parts are `parts.md`'s (part 11).

| Cell | State | Approved target it keeps |
|---|---|---|
| 1 | An approval waits: `Read 3 files, edited 1 file` `11:40`; the step that asks stands where the live step was, still: `pause` + `Wants to run pnpm db:migrate` + `needs approval` (amber words); under it the block: `Needs you · approval`, `**Database changes** asks before OpenCode runs this command:`, the chip `pnpm db:migrate`, `Deny` · `Approve once` (amber) · `Approve for this task`, `Approve for this task also approves commands that start with pnpm db.`, `Any member of calculator can answer. The first answer wins.` | m3 `task-approval.md` |
| 2 | Answered: the line `Read 3 files, edited 1 file, ran 2 commands · 1 approved by Sam Rivera`; opened, the row `Ran pnpm db:migrate ✓ exit 0 · 2.3 s approved once by Sam Rivera output ›`. Under it another run: `Ran 1 command · 1 denied by Alex Kim, with a reason` (red only on `denied`) | m3 `task-approval.md` (receipts) |
| 3 | The question for a member who isn't the driver: the block quiet (a `--line-2` rule, the title `--muted`), the choices at 50%, `Take over to answer` + `Sam Rivera answers questions while driving.` | m3 `task-approval.md` (the watcher), m1 `task.md` |
| 4 | The driver picks `Something else…`: its radio ringed, a 32px field under it with the focus ring and the words typed (`Replace it, but keep the expression in the line above`), `Send answer` amber | m3 `task-approval.md` (the form) |
| 5 | Any other need: OpenCode ended its turn with a question in its prose; one block at the end of the thread: `Needs you`, `OpenCode asked you something in its message above. Reply below.` | `app-design.md` rule 3, `needs-you-cards.tsx` |
| 6 | A round limit: `Needs you · CI round limit`, milestone 6's sentence, `Keep working` (amber) and `Open the checks`, the footnote; then answered as the receipt `Alex Kim pressed Keep working 11:07` | m6 `task-rounds.md` |

## Notes per cell

1. **The asking step leaves the fold.** While an approval is open, its step isn't hidden in a closed run: the live step's slot holds it (`Wants to run …`, `Wants to edit …`, `Wants to reach …`, `Wants to call …`), still, with the amber `needs approval`, and the block follows it. Several open at once: one asking step and block each, in order; the header reads `Needs you · 2 approvals`. A subagent's approval names it in the sentence (milestone 7). Deny opens milestone 3's reason field in the block.
2. **The answered approval** goes back into its run: the run's line says it in its tail, and the row carries the receipt words. Cancelled and expired approvals read milestone 3's receipts on the row (`cancelled`, `expired` `--faint`); `Nobody answered in 15 minutes, so the turn was cancelled.` + teal `Answer anyway` stays visible as a notice line under the run while the item is open.
3. **The watcher's form** shows the same choices, so everyone sees what was asked. `Take over to answer` calls `tasks.takeOver` and focuses the first choice. The composer's place holds the watcher's bar.
4. **`Something else…`** is always the last choice of an enum question. It never sends on its own: `Send answer` does, with `⌘↵` too. How its words reach the agent is open point 5 in the README.
5. **The reply block** never repeats the agent's message: it points up at it.
6. **The round cap** keeps milestone 6's copy and buttons; only its sizes are this milestone's.

The restore conflict (milestone 2), the closed ticket, the outside task's approval, a crash's needs-you and the budget's are the same block with their approved words.

## Wrong in the image (build from this file)

- **The sheet** is not a screen; each cell is a piece of the thread with a dashed edge the build doesn't have.
- **Cell 4's caret** is drawn; the build's field has the browser's.
