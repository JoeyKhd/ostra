# 29: Milestone 5 screen targets

Status: resolved
Builder: web
Blocked by: none
Features: F-091, F-092, F-095, F-067, F-069, F-120, F-061, F-013, F-086 (their screens)
Packages: `context/brand/app-targets/m5/` (new)
Note: the maintainer requires `ui-taste` plus Higgsfield targets, approved before any of tickets 30 to 33 builds its UI.
Spec: `../spec.md`, section 12

## What to build

`build-order.md` says a milestone's screens are designed first, image first, and the approved pictures land in `context/brand/app-targets/`. Follow `context/brand/brief.md` and `context/brand/app-design.md`, start each screen from the target the spec names, and use the `higgsfield-brandkit` skill's state in `context/brand/kit/`.

The eight new targets are spec section 12's first table. Make them as milestones 1 to 4's approved targets were made (`context/brand/app-targets/m1/README.md` and the m2 to m4 READMEs): image first with the `ui-taste` skill on Higgsfield, from the target the spec names, and for each screen three files: `<screen>.webp` at CSS scale (1440 px wide), `<screen>.md` (the build spec: purpose, route, layout, every state with its copy, components, tokens, differences from the current code, and what the picture gets wrong) and `<screen>.prompt.txt`. Add the folder's `README.md` with the screen list and the approval status.

The screens that only grow (section 12's second list) get no new picture: their changes go into the building ticket's `## Comments` as a short list against the existing target.

Notes for some targets:
- `pool` shows a queue of at least six tasks across two projects, one project at its share, and a `kubernetes` pool's internet line; its build spec gives the queue's columns at phone width.
- `pool-join` shows the three install paths as tabs over one code box, and its build spec says the token is shown once and what "Copy" copies for each (no shell interpolation of the token: an environment variable or a file).
- `runner` shows a runner on HTTP with an "outdated" state and its fix, and its build spec covers every state of the domain model's table.
- `runner-approval` is an approval, not a task: its build spec says how it differs from `task-approval`'s card.
- `box-sizes` and `project-runners` follow the `dataviz` guidance for the shares' bars, in the brand's palette, in light and dark.

## Done when

- [x] The eight targets exist in `context/brand/app-targets/m5/`, three files each, with the README.
- [x] They're approved, recorded under `## Comments` with the date. Until then, tickets 30 to 33 build their data and tests, not their UI.
- [x] Committed. Planned as `🎨 add milestone 5 screen targets`; they landed in four commits instead (46dcbb24, 821f4534, 0bf070ac, 930f12ec), recorded under `## Comments` on 2026-11-20.

## Comments

- 2026-11-19, lead: the targets are in `context/brand/app-targets/m5/`. The lead reviewed each picture by eye and approved them for the build on the maintainer's delegation, pending the maintainer's own review; the folder's README records it.
- 2026-11-20, review fix: the first and third boxes were left unticked although the work was done. The eight targets (24 files: `<screen>.webp`, `.md` and `.prompt.txt` for `pool`, `pool-new`, `pool-join`, `runner`, `runner-approval`, `box-sizes`, `project-runners`, `registry`) landed on 2026-11-19 in three commits rather than the planned single `🎨 add milestone 5 screen targets`: 46dcbb24 `📝 add milestone 5 targets: project-runners, registry`, 821f4534 `📝 add milestone 5 targets: runner, runner-approval, box-sizes` and 0bf070ac `📝 add milestone 5 targets: pool, pool-new, pool-join`. The README and the approval came in 930f12ec `📝 approve the milestone 5 and 6 targets`. `scripts/m5-tickets.test.ts` now fails for any milestone 5 ticket marked `done` or `resolved` with an unticked "Done when" box, and checks that the 24 target files and the README are there.
