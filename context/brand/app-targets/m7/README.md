# Milestone 7 screen targets

The design targets for milestone 7's screens (The second agent, and launch; `context/specs/m7-launch/spec.md`, section 13, ticket 12). They're made the same way as the earlier milestones' targets. Each screen has a `<screen>.webp` picture at CSS scale, a `<screen>.md` build spec and a `<screen>.prompt.txt`.

**Status:** approved for the build on 2026-11-19 by the lead, on the maintainer's delegation, pending the maintainer's own review.
- The lead reviewed every picture by eye.
- If the maintainer rejects a screen, its target is remade and the screen rebuilt.

## Screens

| Screen | Target |
|---|---|
| The docs site's landing page, dark and light | `docs-home`, `docs-home-light` |
| A docs guide page, at desktop and phone width | `docs-guide`, `docs-guide-phone` |
| The configuration reference | `docs-reference` |
| The docs search, and its empty state | `docs-search`, `docs-search-empty` |
| The command palette, at desktop and phone width | `command-palette`, `command-palette-phone` |
| The keyboard shortcut sheet | `shortcut-sheet` |
| An agent profile with Claude Code chosen | `agent-profile-claude-code` |
| A runner's agents | `runner-agents` |
| A Claude Code task with subagents, and while it prepares | `task-subagent`, `task-subagent-preparing` |
| Account > Appearance | `account-appearance` |
| Home and the task page in the light theme | `light-home`, `light-task` |

The screens that only grow (spec section 13's second list) get no new picture: their changes go into the building ticket's `## Comments` as a short list against the existing target.

## Rules

The earlier milestones' rules hold (`../m1/README.md` to `../m6/README.md`):
- **The spec wins** on copy, states, components and behaviour. Each `.md` ends with "Wrong in the image": build from the file, not the picture, where they differ.
- **The picture wins** on size, spacing and contrast.
- **One sidebar,** built from the shared shell. It holds only what has shipped.
- **Real data only,** with the brand's fonts and logo.
- **Decorative areas** use the Deep water illustration.
- **Check each screen by eye** against its picture.

These hold too:
- **The docs site is a public page, not the console.** It follows `brief.md`'s palette on Abyss and Shell, with the console's type and the Hinge logo, and no amber. `docs-home.md` holds its token table.
- **The light theme is set by `light-home` and `light-task`.** Every other screen follows their token rules without a picture of its own.
- **The page behind the docs search** is invented in the picture. Build the real page behind the dialog, dimmed as `docs-search.md` says.

## Decided 2026-11-19

The open points in the build specs were settled by the lead on the maintainer's delegation, each as its spec recommends:
- **Light page colour** (`light-home.md`, open point 1): the page is Shell lifted, `#FBFAF6`, with Shell for the sidebar and raised surfaces, and Mist only as control borders. The brand file's exact light set makes fields and code blocks green-grey at panel density.
- **`--amber-text`** (`light-home.md`, open point 2): one token, `#FFB224` in dark and `#8A5300` in light.
- **Charts in light** (`light-home.md`, open point 3): `#748A85`, which passes 3:1.
- **The approval rule in light** (`light-task.md`): 3px, so it stays visible on the pale page.
- **Field and button borders on the docs site** (`docs-home.md`): `#5A7A76` dark and `#7D8B87` light, so they pass 3:1. The pictures draw them in Kelp, which doesn't.
- **"Not isolated"** is its own red callout on the docs site, separate from warnings.

Each one changes many screens, so it's the first thing for the maintainer's review.
