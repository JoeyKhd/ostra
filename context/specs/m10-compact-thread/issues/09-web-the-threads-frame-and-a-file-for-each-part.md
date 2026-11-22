# 09: Web: the thread's frame, and a file for each part

Status: ready-for-agent
Builder: web
Blocked by: 02, 03, 04
Features: F-151
Packages: `apps/web` (`src/task/task-thread.tsx`, `src/task/renderers.tsx`, `src/task/effort-marks.tsx`, new `src/task/thread/`, `src/components/tasks/task-view.tsx`, new `src/components/tasks/task-top-bar.tsx`, `task-status-line.tsx`, `task-properties.tsx`), new `apps/web/e2e/seed-thread-world.ts`
Spec: `../spec.md`, sections 4, 8 and 9
Targets: `context/brand/app-targets/m10-thread/parts.md` ("The rule of the column", parts 1 and 3), `s1.md` (the frame of `s1` and `s1-working`)

## What to build

Built to the approved targets, at their sizes, in both themes. This ticket lays the column and **splits the files** so tickets 10 to 16 can each own theirs and run at once.

- **The split, behaviour unchanged,** first, as its own commit if the builder likes: `Composer` out of `task-thread.tsx` into `src/task/thread/composer.tsx`; `Properties` out of `task-view.tsx` into `src/components/tasks/task-properties.tsx`; the status line (`data-testid="task-doing"`) into `task-status-line.tsx`; the top bar's actions into `task-top-bar.tsx`. Every existing test passes untouched.
- **One file per part** under `src/task/thread/`, each exporting its component with its final props over ticket 03's items and ticket 04's words, and a stub body that draws the part plainly with the new words until its ticket lands: `run-line.tsx`, `run-steps.tsx`, `step-output.tsx`, `failure-line.tsx`, `captures.tsx` (ticket 10); `live-step.tsx` (11); `bubble.tsx`, `receipt.tsx`, `divider.tsx` (12); `jump-pill.tsx` (13, with the needs-you blocks in their existing files); `result-line.tsx`, `pr-card.tsx` (14); `turn-numbers.tsx` with `RunFooter` and `TurnTime` (16). Their owners are listed in a comment at the top of each file.
- **The column** (part 1): 720px, left-aligned in the page's padding, the composer the same width; the thread scrolls and opens at its end; the rhythm's margins.
- **The agent's prose** (part 3): full width, `.agent-md` as today, no avatar, name, time or status word.
- **`MessageView`** renders an assistant message as `turnItemsOf(message, …)`'s items, each through its part's component, and a member's message through `bubble.tsx`. `MessageHeader`'s avatar column and `TurnUsage` go from the thread (the numbers wait in the footer and the panel). The fold gets `turnSpend` from `tasks.get`'s `usage.turns`, and the items get the task's checkout folders and MCP servers.
- **The rule of the column:** no part draws a bookkeeping row (ticket 02 took them out of the parts); nothing the fold puts in a turn is drawn twice.
- **The seeded world** `apps/web/e2e/seed-thread-world.ts`: ticket 02's recorded scenes written into a real database through core's ingest, a task for each scene, for every web ticket's spec file.

## Done when

- [ ] Tests named for `F-151/c1`: a component test renders S2 through `MessageView` and finds no `Work saved`, `The session ended`, `The runner connected` or token line, prose with no avatar or header, and every item kind drawn by its part; a Playwright spec, `apps/web/e2e/27-thread-frame.spec.ts` (run once at the milestone's end), over the seeded S1 and S2.
- [ ] Every test of the moved components passes unchanged (the split changed no behaviour).
- [ ] A screenshot at 1440 px, both themes, of the frame against `s1` under `## Comments`.
- [ ] Checks for `apps/web` pass; the keyboard walk and contrast check stay green on the task page.
- [ ] Committed as `♻️ split the task page for the compact thread` and `✨ lay out the compact thread's column`.

## Comments
