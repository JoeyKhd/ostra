# 15: Web: a review task's page and the status line

Status: ready-for-agent
Builder: web
Blocked by: 08, 09
Features: F-151
Packages: `apps/web` (`src/components/tasks/task-top-bar.tsx`, `src/components/tasks/task-status-line.tsx`, the key line, title and tabs in `src/components/tasks/task-view.tsx`), new `apps/web/e2e/27-thread-review-task.spec.ts`
Spec: `../spec.md`, section 5.5
Targets: `context/brand/app-targets/m10-thread/s3.md` (with `s7-s3-light`), `parts.md` part 15 (the status line and the tabs), `s1.md`, `s2.md` and `s5.md` (each scene's top bar and status line)

## What to build

Built to the approved targets, at their sizes, in both themes. A review task's page says only what a review does (choice 10).

- **The tabs:** a review task gets `Activity` and `Event log` only; a refine task `Activity`, `Draft`, `Event log`, as milestone 6 built it; a code task `Activity`, `Changes {n}`, `Checks` with ticket 14's marker, `Event log {n}`. A `?tab=` naming a tab the kind hasn't opens Activity.
- **The top bar:** a review task: copy link, `Properties` as a single toggle (no app to preview), `Open the code task` (to its code task), `PR #n`; no `Take it local`, no `Stop` once no turn runs. A refine task: no `Take it local`. A code task as each scene draws it (`Preview | Properties`, copy link, `PR #n` once there's one, `Take it local`, `Stop` while a session is live).
- **The key line and title:** a review task's `{code task key} · AI review` and `Review of PR #n` (its crumb too), from `tasks.get`'s `review`.
- **The status line** (part 15, choice 15, content fix 15): the state's dot and words, then `--muted` parts: the activity while a turn runs and `Started {age} ago on {runner}`; the sub-state's place (`PR #483`); a review task's `round 2 of 3: nothing blocking, 1 nit`; and when no turn runs, the box: `box idle, stops in {n} min` (from `box`'s idle stop, rounded up, updated each minute), `box stopped`, `box released`.
- **No line of a kind's impossible work** on a review or refine task's page: no saved work, no PR, no "ended without changes" (ticket 02 took them out of the parts; this ticket checks the page's header and strip too).

## Done when

- [ ] Tests named for `F-151/c7`: a review task's page has exactly the `Activity` and `Event log` tabs, `Open the code task` and `PR #n`, no `Take it local`, `Changes`, `Checks` or `Stop`, its key line and title; a refine task keeps `Draft` and has no `Take it local`; a code task's tabs and top bar are unchanged.
- [ ] Tests named for `F-151/c9`: with fake timers, the status line reads `box idle, stops in 11 min` and counts down, then `box released`; `box stopped`; while a turn runs, the activity and `Started … on {runner}`, and no box words.
- [ ] `apps/web/e2e/27-thread-review-task.spec.ts` (run once at the milestone's end) over the seeded S3 and S2.
- [ ] Screenshots at 1440 px, both themes, compared with `s3` and `s7-s3-light`, under `## Comments`.
- [ ] Checks for `apps/web` pass; the keyboard walk and contrast check stay green.
- [ ] Committed as `✨ give a review task only its own tabs`.

## Comments
