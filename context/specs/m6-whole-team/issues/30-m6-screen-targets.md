# 30: Milestone 6 screen targets

Status: resolved
Builder: web
Blocked by: none
Features: F-011, F-106, F-107, F-077, F-012, F-040, F-099, F-100, F-101, F-102, F-035, F-105, F-113, F-111 (their screens)
Packages: `context/brand/app-targets/m6/` (new)
Note: the maintainer requires `ui-taste` plus Higgsfield targets, approved before any of tickets 31 to 36 builds its UI.
Spec: `../spec.md`, section 12

## What to build

`build-order.md` says a milestone's screens are designed first, image first, and the approved pictures land in `context/brand/app-targets/`. Follow `context/brand/brief.md` and `context/brand/app-design.md`, start each screen from the target the spec names, and use the `higgsfield-brandkit` skill's state in `context/brand/kit/`.

The twelve new targets are spec section 12's first table. Make them as milestones 1 to 4's approved targets were made (`context/brand/app-targets/m1/README.md` to `../m4/README.md`): image first with the `ui-taste` skill on Higgsfield, from the target the spec names, and for each screen three files: `<screen>.webp` at CSS scale (1440 px wide), `<screen>.md` (the build spec: purpose, route, layout, every state with its copy, components, tokens, differences from the current code, and what the picture gets wrong) and `<screen>.prompt.txt`. Add the folder's `README.md` with the screen list and the approval status.

The screens that only grow (section 12's second list) get no new picture: their changes go into the building ticket's `## Comments` as a short list against the existing target.

Notes for some targets:
- `automation-edit` gives the cron field's presets, the sentence's grammar, and how the dry run reads while the filter is being edited (debounced, with its count).
- `linear-agent-mode`'s build spec holds the copy of every activity ostra posts in Linear (ticket 06's renderers), so the words are designed once.
- `review-screen` shows a blocking finding, a nit, a resolved finding and an outdated one on the same diff, and settles how a finding off the diff shows.
- `task-rounds` shows a held round and the cap's needs-you, and how the stage line reads at phone width.
- `refine-draft` shows the agent's version beside a member's edit, and the applied state.

## Done when

- [ ] The twelve targets exist in `context/brand/app-targets/m6/`, three files each, with the README.
- [x] They're approved, recorded under `## Comments` with the date. Until then, tickets 31 to 36 build their data and tests, not their UI.
- [ ] Committed as `🎨 add milestone 6 screen targets`.

## Comments

- 2026-11-19, lead: the targets are in `context/brand/app-targets/m6/`. The lead reviewed each picture by eye and approved them for the build on the maintainer's delegation, pending the maintainer's own review; the folder's README records it.
