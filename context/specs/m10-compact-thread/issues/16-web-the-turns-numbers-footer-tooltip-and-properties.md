# 16: Web: the turn's numbers: footer, tooltip and the properties panel

Status: ready-for-agent
Builder: web
Blocked by: 08, 09
Features: F-151
Packages: `apps/web` (`src/task/thread/turn-numbers.tsx` with `RunFooter` and `TurnTime`, `src/components/tasks/task-properties.tsx`, `src/components/tasks/task-properties.test.tsx`), new `apps/web/e2e/27-thread-numbers.spec.ts`
Spec: `../spec.md`, sections 5.2 and 5.5
Targets: `context/brand/app-targets/m10-thread/parts.md` part 6 ("The footer"), part 9 and part 15 ("The panel's `Session` group"), `s2.md` (the tooltip, the panel), `s1.md`, `s3.md` and `s5.md` (each scene's Properties), `states-steps.md` (cells 5 and 6: subagents' tokens, the clamp)

## What to build

Built to the approved targets, at their sizes, in both themes. A turn's numbers live here and nowhere in the column (choice 1).

- **`RunFooter`** (part 6), the opened run's last row: `footerFacts` mono `--faint`, each fact kept whole when it wraps, and at its right `Event log ›` to `?tab=events&seq={the turn's first seq}`; every run of a turn shows the same footer; a review or refine task shows no saved fact; the clamp's fact carries its sentence as a tooltip.
- **`TurnTime`** (part 9, choice 2): the turn's time on its first line, focusable, with a dotted underline on hover and focus; its tooltip (268px, `--raise`, above it, flipping below when there's no room) shows after 300 ms of hover and at once on focus, Escape closes it; `tooltipRows`' head and rows. On a phone it isn't a button and has no tooltip: the footer is the way in.
- **The properties panel** (part 15), as each scene's table draws it: `Properties` (status, driver, agent, model, effort, runner; a review task's kind, `Reviews`, `Round`), `Usage` (tokens, reasoning, spend against the cap, time), `Code` (repo, branch, PR, and `Checks` and `CI` in their own words from ticket 04 and 08's jobs), `Session` (`Box` from `box`, `Saved work` from the last turn's `saved`, `Turns`), the plan and ticket groups as their milestones built them, `Attachments` (milestone 9's); a review task's `Result` (`Blocking`, `Nits`, `Open the review`) and no `Code` or `Session` saved work.
- **The same numbers:** a turn's footer, its tooltip and `tasks.get`'s `usage.turns` for it agree; the panel's totals are the task's.

## Done when

- [ ] Tests named for `F-151/c3`: S4's footer reads its facts in order with `Event log ›` to the turn's first seq; a review task's footer has no saved fact; with fake timers, hovering S2's turn 4 time shows its tooltip after 300 ms, focus shows it at once, Escape closes it; the tooltip's numbers equal the footer's and `usage.turns`' for that turn.
- [ ] Tests named for `F-151/c3`: the panel's groups for a code task (Properties, Usage, Code with Checks and CI, Session with Box, Saved work and Turns, Attachments) and a review task (its Result group, no Code group, no saved work).
- [ ] `apps/web/e2e/27-thread-numbers.spec.ts` (run once at the milestone's end) over the seeded S2 and S3, the tooltip by keyboard.
- [ ] Screenshots at 1440 px, both themes, compared with `s2` and `s4`, under `## Comments`.
- [ ] Checks for `apps/web` pass; the keyboard walk and contrast check stay green.
- [ ] Committed as `✨ put a turn's numbers in its footer and panel`.

## Comments
