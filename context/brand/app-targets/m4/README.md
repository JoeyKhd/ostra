# Milestone 4 screen targets

These are the design targets for milestone 4's screens (`context/specs/m4-the-organization/spec.md`, ticket 31). They're made the same way as the earlier milestones' targets (`../m1/README.md`, `../m2/README.md`, `../m3/README.md`). Each screen has three files:
- `<screen>.webp`, the picture at CSS scale
- `<screen>.md`, the build spec
- `<screen>.prompt.txt`, the prompt that made the picture

**Status:** approved for the build on 2026-11-19 by the lead, on the maintainer's delegation, pending the maintainer's own review. The lead reviewed every picture by eye. If the maintainer rejects a screen, its target is remade and the screen rebuilt.

## Screens

| Screen | Target |
|---|---|
| Members | `members` |
| Inviting a member, and the link shown once | `member-invite`, `member-invite-link` |
| Accepting an invitation, and "Check your inbox" | `accept-invite`, `accept-invite-inbox` |
| Forgot your password, and the reset link's page | `reset-password`, `reset-password-link` |
| A project's Access tab | `project-access` |
| A project's Repos tab | `project-repos` |
| The organization switcher, creating one, switched | `org-switcher`, `org-switcher-create`, `org-switcher-switched` |
| Instance settings: Organizations and Accounts | `instance-settings`, `instance-settings-accounts` |
| The audit log | `audit-log` |
| A task's event log | `task-event-log` |
| The search palette and the search page | `search-palette`, `search`, `search-empty`, `search-empty-illustration` |
| Spend and budgets, and a model's price | `spend-budgets`, `spend-budgets-price` |
| Insights | `insights` |
| Memory, a note and proposals | `memory`, `memory-note`, `memory-proposals` |
| The account mails, light and dark | `email-account` |

## Rules

The earlier milestones' rules hold:
- The spec wins on copy, states, components and behaviour.
- The picture wins on size, spacing and contrast.
- One sidebar, built from the shared shell, holding only what's shipped.
- Real data only.
- The brand's fonts and logo.
- Decorative areas use the Deep water illustration.
- Check each screen by eye against its picture.

The pages outside the panel (accepting an invitation, the password reset) use the sign-in frame and its scale.
