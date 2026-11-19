# 62: Screen targets: reasoning effort

Status: ready-for-agent
Builder: web
Blocked by: none
Features: F-137 (its screens)
Packages: `context/brand/app-targets/m4/`
Note: the maintainer requires `ui-taste` plus Higgsfield targets, approved before ticket 63 builds its UI. The approval is also the maintainer's review of ADR 0066's choices that the lead settled.
Spec: `../spec.md`, section 12 ("Added 2026-11-19 with F-137")

## What to build

Targets 24 to 26 of section 12's table, made the way tickets 31 and 52 made theirs: image first with the `ui-taste` skill on Higgsfield, from the targets the table names, against `context/brand/brief.md` and `context/brand/app-design.md`. Three files each: `<screen>.webp` at CSS scale (1440 px wide), `<screen>.md` (the build spec) and `<screen>.prompt.txt`. Add them to the folder's `README.md`.

Notes for each target:
- **`agent-profile-effort`:**
  - The control offers only the model's levels, `Default` first.
  - Each level has a one-line hint of what it trades: speed and cost against depth.
  - A model that doesn't reason shows a quiet line instead of the control.
  - A stored level the model lacks shows the level the next task will run at.
  - Use the copy of the research's examples: GPT-5.5 offers Off to Extra high, and DeepSeek V4 Pro offers Low, High and Max.
- **`task-effort`:**
  - The driver sees the levels; everyone else sees the level, with "Take over to change".
  - While a turn runs, a new level reads "from the next turn".
  - The thread's marker names who changed it.
  - Each turn's usage line shows its level and its reasoning tokens.
  - A clamped turn says why, in one line.
- **`model-reasoning`:**
  - A model's reasoning reads "from the catalog" or "set by an admin".
  - A custom model's "Reasons" sits beside its limits.
  - The reasoning-price mark explains, in a line, that v1 prices reasoning as output.

## Done when

- [ ] The three targets exist in `context/brand/app-targets/m4/`, three files each, with the README updated.
- [ ] They're approved, recorded under `## Comments` with the date, together with the maintainer's word on ADR 0066's settled choices (Q285 to Q292). Until then, ticket 63 builds its data and tests, not its UI.
- [ ] Committed as `🎨 add the reasoning effort targets`.

## Comments
