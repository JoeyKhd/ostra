# Milestone 7 screen targets

The design targets for milestone 7's screens (Launch; `context/specs/m7-launch/spec.md`, section 13, ticket 12). They're made the same way as the earlier milestones' targets. Each screen has a `<screen>.webp` picture at CSS scale, a `<screen>.md` build spec and a `<screen>.prompt.txt`.

**Status:** approved for the build on 2026-11-19 by the lead, on the maintainer's delegation, pending the maintainer's own review.
- The lead reviewed every picture by eye.
- If the maintainer rejects a screen, its target is remade and the screen rebuilt.

**Postponed 2026-11-19:** Claude Code (F-018) moved after v1 on the maintainer's word, so its targets wait with it: `agent-profile-claude-code`, `runner-agents`, `task-subagent` and `task-subagent-preparing`. Their files stay here, unchanged, for when F-018 is built. Nothing in v1 builds them.

## Screens

| Screen | Target |
|---|---|
| The docs site's landing page, dark and light | `docs-home`, `docs-home-light` |
| A docs guide page, at desktop and phone width | `docs-guide`, `docs-guide-phone` |
| The configuration reference | `docs-reference` |
| The docs search, and its empty state | `docs-search`, `docs-search-empty` |
| The command palette, at desktop and phone width | `command-palette`, `command-palette-phone` |
| The keyboard shortcut sheet | `shortcut-sheet` |
| An agent profile with Claude Code chosen (postponed with F-018) | `agent-profile-claude-code` |
| A runner's agents (postponed with F-018) | `runner-agents` |
| A Claude Code task with subagents, and while it prepares (postponed with F-018) | `task-subagent`, `task-subagent-preparing` |
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
- **The docs site is a public page, not the console.** It wears the console's graphite theme (since 2026-11-20, below), with the console's type and the Hinge logo, and no amber. `docs-home.md` holds its token table.
- **The light theme is set by `light-home` and `light-task`.** Every other screen follows their token rules without a picture of its own.
- **The page behind the docs search** is invented in the picture. Build the real page behind the dialog, dimmed as `docs-search.md` says.

## Decided 2026-11-19

The open points in the build specs were settled by the lead on the maintainer's delegation, each as its spec recommends:
- **Light page colour** (`light-home.md`, open point 1): the page is Shell lifted, `#FBFAF6`, with Shell for the sidebar and raised surfaces, and Mist only as control borders. The brand file's exact light set makes fields and code blocks green-grey at panel density. (Superseded 2026-11-20: the light set is graphite, below.)
- **`--amber-text`** (`light-home.md`, open point 2): one token, `#FFB224` in dark and `#8A5300` in light.
- **Charts in light** (`light-home.md`, open point 3): `#748A85`, which passes 3:1. (Now `#7F8288`, neutral, since 2026-11-20.)
- **The approval rule in light** (`light-task.md`): 3px, so it stays visible on the pale page.
- **Field and button borders on the docs site** (`docs-home.md`): `#5A7A76` dark and `#7D8B87` light, so they pass 3:1. The pictures draw them in Kelp, which doesn't.
- **"Not isolated"** is its own red callout on the docs site, separate from warnings.

Each one changes many screens, so it's the first thing for the maintainer's review.

## Decided 2026-11-20

**The docs follow the panel's graphite theme.** The brief's Abyss palette for the docs (`docs-home`, `docs-guide`, `docs-reference`, `docs-search`) was superseded on 2026-11-20 by the maintainer's word: the live docs read as an older product beside the panel.
- **Dark** is the panel's `:root` tokens; **light** is `light-home`'s table, which the panel's own light theme will build (ticket 18).
- The docs' token names became the panel's (`--link` is `--teal`, `--surface-2` `--sel`, `--dialog` `--raise`, `--highlight` `--line-2`), and `docs-home.md`'s table holds the values. The docs pictures were first kept as drawn; since the targets moved (below), they're captures of the built site.
- The tokens are copied into `apps/docs`, and `apps/docs/src/app/theme-tokens.test.ts` fails when they drift from the panel's or a text pair drops under AA.
- Two docs-only choices stay: field, button and chip borders at 3:1 (`--control`, from 2026-11-19 above; dark is now the neutral `#62656B`, 3.30:1, and light `#7F8288`, 3.69:1), and the Deep water illustration as a rounded window in light, now in the search's empty state too.

**The nine docs and light targets moved to the panel's graphite theme, 2026-11-20; the dark docs targets are captures of the built site.** The maintainer's rule is that every surface wears graphite, and these nine still drew the brief's Abyss and teal. `docs-home`, `docs-guide`, `docs-guide-phone`, `docs-reference`, `docs-search`, `docs-search-empty` and `docs-home-light` are screenshots of `apps/docs` (each `.prompt.txt` names the commit); `light-home` and `light-task` were regenerated on a light token table re-based on graphite (`light-home.md`: the dark greys turned light, no Abyss ink, teal only as link text), which the docs' light theme now wears too.

**Approved: `light-home` and `light-task` are the light theme's targets (the maintainer, 2026-11-20: "sure").** Ticket 18 builds the panel's light theme from `light-home.md`'s token table; the faults each image's `.md` lists under "Wrong in the image" are not to be copied.
