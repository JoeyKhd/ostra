# 13: Web: the needs-you blocks, `Something else…` and the pill

Status: ready-for-agent
Builder: web
Blocked by: 08, 09
Features: F-151
Packages: `apps/web` (`src/components/tasks/task-answers.tsx`'s question form, plan block and approval card, `src/components/tasks/needs-you-cards.tsx`, `src/task/thread/jump-pill.tsx`), new `apps/web/e2e/27-thread-asks.spec.ts`
Spec: `../spec.md`, sections 4 and 6
Targets: `context/brand/app-targets/m10-thread/parts.md` part 11 (with "Off screen: the pill"), `s1.md` (the question), `s5.md` (`s5-plan`), `s4.md` (the pill's table), `states-asks.md` (cells 1 to 6)

## What to build

Built to the approved targets, at their sizes, in both themes. Amber stays only here, on the status dot and on the one amber button.

- **The amber rule** flush with the prose (part 11), its title with its icon, as milestone 1 drew it, at this part's sizes.
- **The question:** the choices as a `RadioGroup` (30px rows, 44px on a phone), the enum's values, then `Something else…` (choice 5) when `capabilities.questionFreeText`: it opens a 32px field under it and focuses it. Choosing never sends; `Send answer` is the panel's disabled button until a choice holds a value, `Sending…` in flight, `⌘↵` / `Ctrl+↵` sends. It calls `questions.answer` with `other` naming the fields answered in words. Without the capability the form is milestone 3's. A member who isn't the driver: the quiet block, the choices at 50% and `aria-disabled`, `Take over to answer` (calls `tasks.takeOver` and focuses the first choice) and `{driver} answers questions while driving.` Answered: ticket 12's receipt in its place.
- **The plan:** the entries as a numbered list right inside the rule (no box in a box), `Approve plan`, `Edit and approve`, `Ask for changes to the plan`, the footnote; the editor and the watcher's state as milestone 3 built them, inside the same rule. Answered: the receipt.
- **An approval:** under the asking step (ticket 11 stands it in the live step's place): milestone 3's card at this part's sizes; several open at once, one step and block each, in order. Answered, it leaves the block for the run's tail and the row's receipt words (tickets 03 and 10).
- **Every other need** (a reply, a limit, a crash, a restore conflict, a round cap, a closed ticket, the outside task's approval, the budget's): one block at the thread's end, with its approved words, at this part's sizes; the reply block points up at the agent's message and never repeats it.
- **The pill** (choice 12): while an open block (for the viewer, not the watcher's quiet one) is out of view, the thread's bottom 46px is a solid `--bg` band with an 18px fade, and the pill centred in it (`Needs you · question ↓`, `· plan`, `· approval`, `· 2 approvals`, `Needs you ↓`); a `button` that scrolls the block into view and focuses its first control; gone once the block is in view. The text scrolls behind the band; the composer doesn't move.

## Done when

- [ ] Tests named for `F-151/c5`: picking `Something else…` focuses its field; `Send answer` stays asleep until it holds words; sending calls `questions.answer` with the words and `other`; with `questionFreeText` false there's no `Something else…`; a watcher's form is disabled with `Take over to answer`; the answered block becomes its receipt.
- [ ] Tests named for `F-151/c5`: the pill shows while the question block is scrolled out of view and not while it's in view, names what waits, and pressing it brings the block into view and focuses its first choice; no pill for a watcher's quiet block.
- [ ] Tests named for `F-151/c4`: an approval's block sits under its asking step; two open approvals are two steps and two blocks in order.
- [ ] `apps/web/e2e/27-thread-asks.spec.ts` (run once at the milestone's end) over the seeded S1 question, S5 plan and an approval.
- [ ] Screenshots at 1440 px, both themes, compared with `s1`, `s5-plan`, `s4` and `states-asks`, under `## Comments`.
- [ ] Checks for `apps/web` pass; the keyboard walk and contrast check stay green.
- [ ] Committed as `✨ restyle what waits on you, with a pill`.

## Comments
