# 41: Milestone 3 screen targets

Status: resolved
Builder: web
Blocked by: none
Features: F-021, F-024, F-026, F-063, F-062, F-036, F-115, F-027, F-072, F-028, F-103, F-070, F-054, F-051, F-094, F-119, F-075 (their screens)
Packages: `context/brand/app-targets/m3/` (new)
Note: the maintainer requires `ui-taste` plus Higgsfield targets, approved before any of tickets 42 to 48 builds its UI.
Spec: `../spec.md`, section 12

## What to build

`build-order.md` says a milestone's screens are designed first, image first, and the approved pictures land in `context/brand/app-targets/`. Follow `context/brand/brief.md` and `context/brand/app-design.md`, start each screen from the target the spec names, and use the `higgsfield-brandkit` skill's state in `context/brand/kit/`.

The fifteen new targets are spec section 12's first table. Make them as milestones 1 and 2's approved targets were made (`context/brand/app-targets/m1/README.md`, `../m2/README.md`): image first with the `ui-taste` skill on Higgsfield, from the M1 or M2 target the spec names, and for each screen three files: `<screen>.webp` at CSS scale (1440 px wide; phone width for `phone-approval`; a mail client's width, 640 px, for `email-needs-you`, in light and dark), `<screen>.md` (the build spec: purpose, route, layout, every state with its copy, components, tokens, differences from the current code, and what the picture gets wrong) and `<screen>.prompt.txt`. Add the folder's `README.md` with the screen list and the approval status.

The screens that only grow (section 12's second list) get no new picture: their changes go into the building ticket's `## Comments` as a short list against the existing target.

`email-needs-you` is a mail, not a panel screen: its build spec also gives the HTML's constraints (tables, inline styles, a 600 px body, the dark-mode colours as `prefers-color-scheme` overrides that clients may ignore, the text part's layout).

## Done when

- [ ] The fifteen targets exist in `context/brand/app-targets/m3/`, three files each, with the README.
- [ ] They're approved, recorded under `## Comments` with the date. Until then, tickets 42 to 48 build their data and tests, not their UI.
- [ ] Committed as `🎨 add milestone 3 screen targets`.

## Comments

- 2026-11-19, lead: 18 pictures for 15 screens are in `context/brand/app-targets/m3/`. The lead reviewed each by eye and approved them for the build on the maintainer's delegation, pending the maintainer's own review; `README.md` there records it.
