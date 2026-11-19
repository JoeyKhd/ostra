# Milestone 5 screen targets

The design targets for milestone 5's screens (The fleet; `context/specs/m5-the-fleet/spec.md`, ticket 29). They're made the same way as the earlier milestones' targets. Each screen has a `<screen>.webp` picture at CSS scale, a `<screen>.md` build spec and a `<screen>.prompt.txt`.

**Status:** approved for the build on 2026-11-19 by the lead, on the maintainer's delegation, pending the maintainer's own review.
- The lead reviewed every picture by eye.
- If the maintainer rejects a screen, its target is remade and the screen rebuilt.

## Screens

| Screen | Target |
|---|---|
| A pool's page | `pool` |
| New pool | `pool-new` |
| A pool's join token, and three ways to start a runner | `pool-join` |
| A runner's page | `runner` |
| Approving a runner | `runner-approval` |
| Box sizes | `box-sizes` |
| A project's runners | `project-runners` |
| The registry | `registry` |

## Rules

The earlier milestones' rules hold (`../m1/README.md` to `../m4/README.md`):
- **The spec wins** on copy, states, components and behaviour.
- **The picture wins** on size, spacing and contrast.
- **One sidebar,** built from the shared shell. It holds only what has shipped.
- **Real data only,** with the brand's fonts and logo.
- **Decorative areas** use the Deep water illustration.
- **Check each screen by eye** against its picture.
