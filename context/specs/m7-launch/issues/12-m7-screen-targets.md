# 12: Milestone 7 screen targets

Status: ready-for-agent
Builder: web
Blocked by: none
Features: F-018, F-058, F-081, F-082, F-076 (their screens)
Packages: `context/brand/app-targets/m7/` (new)
Note: the maintainer requires `ui-taste` plus Higgsfield targets, approved before any of tickets 13 to 19 and 21 builds its UI.
Spec: `../spec.md`, section 13

## What to build

`build-order.md` says a milestone's screens are designed first, image first, and the approved pictures land in `context/brand/app-targets/`. Follow `context/brand/brief.md` and `context/brand/app-design.md`, start each screen from the target the spec names, and use the `higgsfield-brandkit` skill's state in `context/brand/kit/`.

The twelve new targets are spec section 13's first table. Make them as milestones 1 to 6's approved targets were made: image first with the `ui-taste` skill on Higgsfield, from the target the spec names, and for each screen three files: `<screen>.webp` at CSS scale (1440 px wide), `<screen>.md` (the build spec: purpose, route, layout, every state with its copy, components, tokens, differences from the current code, and what the picture gets wrong) and `<screen>.prompt.txt`. Add the folder's `README.md` with the screen list and the approval status.

The screens that only grow (section 13's second list) get no new picture: their changes go into the building ticket's `## Comments` as a short list against the existing target.

Notes for some targets:
- `docs-home`, `docs-guide`, `docs-reference` and `docs-search` are the docs site's, not the panel's: same tokens and type, no sidebar of the panel, a reading width for prose, both themes. Their build specs name Fumadocs' parts each maps to, and what the fallback (ADR 0063) does instead.
- `command-palette` and `shortcut-sheet` settle the two-key sequences' display, the action that needs a second step, and the palette at phone width.
- `agent-profile-claude-code` holds the words for each capability Claude Code declares, and the one difference, so they're designed once.
- `light-home` and `light-task` settle the light theme's rules (surfaces, borders, the diff's colors, the amber of "needs you") from `brand/files/tokens/`, so every other screen follows them without its own picture.
- Every target is checked against WCAG AA contrast in its build spec, as F-081 asks.

## Done when

- [ ] The twelve targets exist in `context/brand/app-targets/m7/`, three files each, with the README.
- [ ] They're approved, recorded under `## Comments` with the date. Until then, tickets 13 to 19 and 21 build their data and tests, not their UI.
- [ ] Committed as `🎨 add milestone 7 screen targets`.

## Comments
