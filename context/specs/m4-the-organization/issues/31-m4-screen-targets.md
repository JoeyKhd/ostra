# 31: Milestone 4 screen targets

Status: resolved
Builder: web
Blocked by: none
Features: F-002, F-003, F-087, F-049, F-073, F-080, F-037, F-108, F-109, F-110, F-111, F-098, F-104, F-115 (their screens)
Packages: `context/brand/app-targets/m4/` (new)
Note: the maintainer requires `ui-taste` plus Higgsfield targets, approved before any of tickets 32 to 39 builds its UI.
Spec: `../spec.md`, section 12

## What to build

`build-order.md` says a milestone's screens are designed first, image first, and the approved pictures land in `context/brand/app-targets/`. Follow `context/brand/brief.md` and `context/brand/app-design.md`, start each screen from the target the spec names, and use the `higgsfield-brandkit` skill's state in `context/brand/kit/`.

The eighteen new targets are spec section 12's first table. Make them as milestones 1 to 3's approved targets were made (`context/brand/app-targets/m1/README.md`, `../m2/README.md`, `../m3/README.md`): image first with the `ui-taste` skill on Higgsfield, from the target the spec names, and for each screen three files: `<screen>.webp` at CSS scale (1440 px wide; 1200 px for `accept-invite` and `reset-password`, as `sign-in`; a mail client's width, 640 px, for `email-account`, in light and dark), `<screen>.md` (the build spec: purpose, route, layout, every state with its copy, components, tokens, differences from the current code, and what the picture gets wrong) and `<screen>.prompt.txt`. Add the folder's `README.md` with the screen list and the approval status.

The screens that only grow (section 12's second list) get no new picture: their changes go into the building ticket's `## Comments` as a short list against the existing target.

Notes for some targets:
- `search-palette` sits over a dimmed page; its build spec gives the keyboard model (arrows, Enter, Escape, Tab to the filters) and the tokens' grammar.
- `spend-budgets` and `insights` follow the `dataviz` guidance for their bars and series, in the brand's palette, and say how each reads in light and dark.
- `email-account` is a mail, not a panel screen: its build spec gives the HTML's constraints as milestone 3's `email-needs-you` does, and the variants' subjects and lines.
- `task-event-log` shows a long command, a list of paths and a refused call with its error, so the build spec settles wrapping and truncation with "Show all".

## Done when

- [ ] The eighteen targets exist in `context/brand/app-targets/m4/`, three files each, with the README.
- [x] They're approved, recorded under `## Comments` with the date. Until then, tickets 32 to 39 build their data and tests, not their UI.
- [ ] Committed as `🎨 add milestone 4 screen targets`.

## Comments

- 2026-11-19, lead: there are 27 pictures for 18 screens in `context/brand/app-targets/m4/`. The lead reviewed each one by eye and approved them for the build on the maintainer's delegation, pending the maintainer's own review. `README.md` there records it.
