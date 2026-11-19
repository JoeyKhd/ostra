# 32: Milestone 2 screen targets

Status: ready-for-agent
Builder: web
Blocked by: none
Features: F-005, F-007, F-010, F-064, F-031, F-032, F-033, F-047, F-055, F-060, F-068, F-079, F-114 (their screens)
Packages: `context/brand/app-targets/m2/` (new)
Note: the maintainer requires `ui-taste` plus Higgsfield targets, approved before any of tickets 33 to 37 builds its UI.
Spec: `../spec.md`, section 12

## What to build

`build-order.md` says a milestone's screens are designed first, image first, and the approved pictures land in `context/brand/app-targets/`. The maintainer requires the `ui-taste` skill and Higgsfield targets, approved before anything is built. Follow `context/brand/brief.md` and `context/brand/app-design.md`, start each screen from the concept the spec names, and use the `higgsfield-brandkit` skill's state in `context/brand/kit/`.

The eleven screens are spec section 12's list. Make them as milestone 1's approved targets were made (`context/brand/app-targets/m1/README.md`): image first with the `ui-taste` skill on Higgsfield, from the M1 target or concept the spec names, and for each screen three files: `<screen>.webp` at CSS scale (1440 px wide; phone width for screen 11), `<screen>.md` (the build spec: purpose, layout, every state with its copy, components, tokens, and what the picture gets wrong) and `<screen>.prompt.txt`. Add the folder's `README.md` with the screen list and the approval status.

## Done when

- [ ] The eleven screens exist in `context/brand/app-targets/m2/`, three files each, with the README.
- [ ] The maintainer approves them, recorded under `## Comments` with the date. Until then, tickets 33 to 37 build their data and tests, not their UI.
- [ ] Committed as `🎨 add milestone 2 screen targets`.

## Comments
