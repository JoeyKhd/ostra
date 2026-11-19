# 52: Screen targets: keys per project and GitHub organizations

Status: ready-for-agent
Builder: web
Blocked by: none
Features: F-135, F-136 (their screens)
Packages: `context/brand/app-targets/m4/`
Note: the maintainer requires `ui-taste` plus Higgsfield targets, approved before tickets 53 and 54 build their UI.
Spec: `../spec.md`, section 12 ("Added 2026-11-19 with F-135 and F-136")

## What to build

Targets 19 to 23 of section 12's table for F-135 and F-136, made the way ticket 31 made the first eighteen: image first with the `ui-taste` skill on Higgsfield, from the target the table names, against `context/brand/brief.md` and `context/brand/app-design.md`, with the `higgsfield-brandkit` skill's state in `context/brand/kit/`. Three files each: `<screen>.webp` at CSS scale (1440 px wide), `<screen>.md` (the build spec: purpose, route, layout, every state with its copy, components, tokens, differences from the current code, and what the picture gets wrong) and `<screen>.prompt.txt`. Add them to the folder's `README.md`.

The screens that only grow (section 12's list) get no new picture: their changes go into tickets 53 and 54's `## Comments` as a short list against the existing target.

Notes for some targets:
- `models-keys` shows at a glance which projects use each key, and that a key on no list is used by nothing.
- `project-models-keys` shows the save's preview of what moves or is left with no key, and the read-only state a project admin or member sees.
- `agent-profile-model` makes clear that the profile names a model, not a key, and which projects have no key for it.
- `no-key-for-model` gives the copy for every place it appears: New task, the queued task, the held message and the needs-you row.
- `github-organizations` shows a stranger's waiting installation calmly, with "Remove", and the one-way note on making the App public.

## Done when

- [ ] The five targets exist in `context/brand/app-targets/m4/`, three files each, with the README updated.
- [ ] They're approved, recorded under `## Comments` with the date. Until then, tickets 53 and 54 build their data and tests, not their UI.
- [ ] Committed as `🎨 add the keys and GitHub organizations targets`.

## Comments
