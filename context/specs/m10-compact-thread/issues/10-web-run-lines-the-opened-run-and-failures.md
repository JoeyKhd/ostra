# 10: Web: runs' lines, the opened run and failures

Status: ready-for-agent
Builder: web
Blocked by: 09
Features: F-151
Packages: `apps/web` (`src/task/thread/run-line.tsx`, `run-steps.tsx`, `step-output.tsx`, `failure-line.tsx`, `captures.tsx`; the diff and output blocks moved out of `src/task/renderers.tsx`; `src/components/tasks/subagents-badge.tsx` for its placement only), new `apps/web/e2e/27-thread-runs.spec.ts`
Spec: `../spec.md`, sections 5.3 and 13
Targets: `context/brand/app-targets/m10-thread/parts.md` parts 4, 6 and 7, `s4.md`, `states-steps.md` (cells 2 to 6), `s1.md` (the closed runs and the capture), `s3.md` (23 steps and the unrecovered fetch)

## What to build

Built to the approved targets, at their sizes, in both themes. Their build specs hold the layout, every state's words and the data.

- **A run's line** (part 4): a `button` with `aria-expanded`, its words from `runLineWords` with `--red` only on `failed` and `denied`, the chevron turning when open, the turn's time on its first line only (the `TurnTime` component of ticket 16, placed here), the subagents badge after the chevron opening the subagents window (F-138).
- **The opened run** (part 6): a list (`role="list"`) under its line on the strict `22px icon | 72px verb | subject` grid; every step kind of ticket 03 with its icon, verb, subject (relative path or command, the full value in `title`), result and link; an answered approval's receipt words on its row; `RunFooter` (ticket 16's) as its last row. Opening is per viewer, not saved, and survives new events.
- **One more level** (`step-output.tsx`): `output ›` opens a command's output (`.out`, 320px then it scrolls, a running command's output streaming in and kept in view unless scrolled up), `diff ›` milestone 1's diff block, `show ›` a thought's full text; each link reads `hide … ›` while open and names its step for a screen reader.
- **Failures** (part 7): an unrecovered failure's own line under its run with `details ›` / `output ›` that opens the run at that step with its output open; a failed turn, a crashed session and a lost box as the same line without a subject; a limit, a budget hold and an expired approval as `.notice` (`--muted`, the action teal: `Keep working`, `Open spend`, `Raise the cap`, `Answer anyway`).
- **Captures** (choice 13): milestone 8's strip under the line of the run that took them, the caption reading the capture's own route (`1280 · /history`).
- **The old rows** of `renderers.tsx` that items replace (`ToolRow`'s `Line`, `Show the output`, `Show the diff`) stop being drawn in the thread; the subagents window still draws its calls with them until ticket 17 tidies.

## Done when

- [ ] Tests named for `F-151/c2`: component tests over S1 and S3: the lines' words and their red words, a recovered failure only in the tail, the unrecovered fetch on its own line with `details ›` opening the run at it, a cancelled step not red.
- [ ] Tests named for `F-151/c3`: pressing a run's line opens its rows in order with their results and links; `output ›` opens and becomes `hide output ›`; a long path shows relative with the full value in `title`; the footer is the opened run's last row.
- [ ] Tests named for `F-151/c8`: a generic tool's row reads `Used` and its name, its MCP server faint before it, and `other` appears nowhere; `Submitted the review` with `already submitted, kept as it was`; the capture's caption reads `/history`.
- [ ] `apps/web/e2e/27-thread-runs.spec.ts` (run once at the milestone's end) over the seeded S1 and S3.
- [ ] Screenshots at 1440 px, both themes, compared with `s4` and `states-steps`, under `## Comments`.
- [ ] Checks for `apps/web` pass; the keyboard walk and contrast check stay green.
- [ ] Committed as `✨ fold a turn's steps into one line`.

## Comments
