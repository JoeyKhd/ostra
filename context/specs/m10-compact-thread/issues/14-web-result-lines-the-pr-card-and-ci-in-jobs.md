# 14: Web: result lines, the PR card, and CI in jobs

Status: ready-for-agent
Builder: web
Blocked by: 08, 09
Features: F-151
Packages: `apps/web` (`src/task/thread/result-line.tsx`, `src/task/thread/pr-card.tsx`; the Checks tab's marker in `src/components/tasks/task-checks/`; milestone 6's stage line; the review screen's CI row in `src/components/tasks/review/`; Home's board sub-state), new `apps/web/e2e/27-thread-results.spec.ts`
Spec: `../spec.md`, sections 5.4 and 5.5
Targets: `context/brand/app-targets/m10-thread/parts.md` parts 8, 10 and 13, `s2.md` (the push, the card and every end-of-turn state), `states-messages.md` (cells 1 and 6), `s3.md` (the review's result lines)

## What to build

Built to the approved targets, at their sizes, in both themes. Results have an icon; activity has none.

- **Result lines** (part 8), after the turn's prose: a push (`Pushed {branch} · 3 checks passed in the box`; a failing check `· 1 of 3 checks failed in the box, so the PR is a draft`, red only on `failed`; a later push `Pushed {sha7} · CI passed` once CI says), opening its commits and checks in place; a review posted (`Review posted on PR #n · {verdict}`, teal `Open the review`) and confirmed (`Review on PR #n confirmed · already posted this round, unchanged`); a draft (`Handed in draft v{n} · …`, `Open the draft`); the preview (`Preview {label} :{port} {path}`, `Show`); a memory (`Proposed a memory: {title}`, `Review`). The hidden ref's save is never one.
- **The PR card** (part 10, choice 8): once, under the push that opened it: the icon (open, draft, merged), the number as a link, the title, the size (`+a −d`, summed from the Changes tab's `diff` query), and the live CI line in jobs (`CI on GitHub: running, 2 of 4 jobs done · then the AI review`, `passed · 4 jobs`, `failed: e2e`, `No CI on GitHub`), updating in place. Later pushes are one line.
- **Checks and CI, one vocabulary** (part 13, choice 7), everywhere the panel says either: the Checks tab's marker (spinning while either runs, green when both passed, red with a count when one failed); milestone 6's stage words; the review screen's CI row (`Passed · 3 jobs`); Home's board sub-state (`{k} of {n} jobs`). The properties panel's `Checks` and `CI` rows are ticket 16's, with the same words.

## Done when

- [ ] Tests named for `F-151/c6`: S2's push line says `3 checks passed in the box`; the card shows once, under it, with `running, 2 of 4 jobs done`, and updates to `passed · 4 jobs` when `tasks.get` does; a second push is one line with no second card; the Checks tab's marker, the stage line, the review screen and Home's board count CI in jobs; a failing check makes the push line's red word and the card's draft icon.
- [ ] Tests named for `F-151/c7`: S3's result lines: posted with its verdict, and the repeat's `confirmed` line, neither red; a refine task's draft line and no push or PR line.
- [ ] Tests named for `F-151/c8`: an `ostra_show_preview` call is the preview's result line, not a tool row.
- [ ] `apps/web/e2e/27-thread-results.spec.ts` (run once at the milestone's end) over the seeded S2 and S3.
- [ ] Screenshots at 1440 px, both themes, compared with `s2` and `states-messages`, under `## Comments`.
- [ ] Checks for `apps/web` pass; the keyboard walk and contrast check stay green.
- [ ] Committed as `✨ show what a turn made, and CI in jobs`.

## Comments
