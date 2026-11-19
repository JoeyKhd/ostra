# Milestone 6 screen targets

The design targets for milestone 6's screens (The whole team, and autonomy; `context/specs/m6-whole-team/spec.md`, ticket 30). They're made the same way as the earlier milestones' targets. Each screen has a `<screen>.webp` picture at CSS scale, a `<screen>.md` build spec and a `<screen>.prompt.txt`.

**Status:** approved for the build on 2026-11-19 by the lead, on the maintainer's delegation, pending the maintainer's own review.
- The lead reviewed every picture by eye.
- If the maintainer rejects a screen, its target is remade and the screen rebuilt.

## Screens

| Screen | Target |
|---|---|
| Automations, and its empty state | `automations`, `automations-empty` |
| Editing a rule or schedule | `automation-edit` |
| A rule's history | `automation-history` |
| Starting several tickets from the Inbox | `inbox-bulk-start` |
| A parent ticket | `ticket-parent` |
| Agent mode on the Linear page | `linear-agent-mode` |
| Outside tasks that need approval | `needs-approval` |
| A refine draft, and once applied | `refine-draft`, `refine-draft-applied` |
| The review screen | `review-screen` |
| Review settings | `review-settings` |
| Review rounds on the task page | `task-rounds` |
| An environment proposal | `environment-proposal` |

## Rules

The earlier milestones' rules hold (`../m1/README.md` to `../m4/README.md`):
- **The spec wins** on copy, states, components and behaviour.
- **The picture wins** on size, spacing and contrast.
- **One sidebar,** built from the shared shell. It holds only what has shipped.
- **Real data only,** with the brand's fonts and logo.
- **Decorative areas** use the Deep water illustration.
- **Check each screen by eye** against its picture.
