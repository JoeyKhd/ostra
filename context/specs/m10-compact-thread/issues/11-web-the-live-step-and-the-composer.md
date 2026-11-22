# 11: Web: the live step and the composer

Status: ready-for-agent
Builder: web
Blocked by: 09
Features: F-151
Packages: `apps/web` (`src/task/thread/live-step.tsx`, `src/task/thread/composer.tsx`; `src/components/tasks/task-effort.tsx` for the model and level menu under the box), new `apps/web/e2e/27-thread-live.spec.ts`
Spec: `../spec.md`, sections 4 and 5.3
Targets: `context/brand/app-targets/m10-thread/parts.md` parts 5 and 14, `s1.md` (`s1-working`, the composer in both states), `s5.md` (the live step with the plan step), `states-steps.md` (cell 1), `states-asks.md` (cell 1: the asking step in the live step's place)

## What to build

Built to the approved targets, at their sizes, in both themes.

- **The live step** (part 5), from `liveStepOf` and `liveStepWords`: in the place its run's line will take; a 12px spinner (still as a ring with reduced motion), what the agent does now in `--text-2` with its subject mono, the progress in `--faint` (`8 steps done, 1 failed` with red only on `failed`, the plan step, the time `m:ss` from the turn's start ticking each second), a chevron; a `button` that opens the run so far, using ticket 10's opened run.
- **Prose closes a run:** when the agent writes, the run so far becomes its line above the prose and a new live step starts under it; when the turn ends, the last live step becomes the last run's line in the same place. Nothing moves after the prose.
- **An approval waits** (choice 9): the asking step stands in the live step's place, still, with `pause` and `Wants to run {command}` + amber `needs approval`; the approval's block under it is ticket 13's.
- **Screen readers:** the live step's words are a polite live region that announces at most once every 10 seconds (a new step), never each tick.
- **The composer** (part 14, choice 14): one box (52px, radius 12px, `--control-line`), the paperclip, the field growing to 8 lines, `Interrupt and send` (outline, `pause`, labelled) while a turn runs and `capabilities.interrupt`, Send as a 32px `--primary` square with `arrow-up`; both asleep while the field is empty; milestone 9's tray inside the box above the field. Under it: the hint at the left (milestones 1 to 3's per-state hints, `s1.md`'s words) and the next turn's model and level at the right as the existing menu (F-137). The watcher's bar takes the box's place as now.
- **Milestone 9's files** keep working in the moved composer: every `F-148/c1`, `c2` and `c5` test passes.

## Done when

- [ ] Tests named for `F-151/c4`: with fake timers, the live step over S1-working reads `Running pnpm test history · 8 steps done, 1 failed · 3:52` and ticks; the live region announces a new step once and not on ticks, and not twice within 10 s; a text part arriving closes the run into its line above it; the pending approval's step stands in its place; S5's build turn names `Plan step 1 of 6`.
- [ ] Tests named for `F-151/c4`: the composer shows `Interrupt and send` only while running with `capabilities.interrupt`, both buttons asleep on an empty field, the hint and the model menu under the box.
- [ ] Every `F-148/c1`, `F-148/c2` and `F-148/c5` test still passes.
- [ ] `apps/web/e2e/27-thread-live.spec.ts` (run once at the milestone's end) over the seeded S1-working.
- [ ] Screenshots at 1440 px, both themes, compared with `s1-working` and `s5-approved`, under `## Comments`.
- [ ] Checks for `apps/web` pass; the keyboard walk and contrast check stay green.
- [ ] Committed as `✨ show what the agent does now in one line`.

## Comments
