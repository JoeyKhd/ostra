# Milestone 4 screen targets

These are the design targets for milestone 4's screens (`context/specs/m4-the-organization/spec.md`, ticket 31). They're made the same way as the earlier milestones' targets (`../m1/README.md`, `../m2/README.md`, `../m3/README.md`). Each screen has three files:
- `<screen>.webp`, the picture at CSS scale
- `<screen>.md`, the build spec
- `<screen>.prompt.txt`, the prompt that made the picture

**Status:** approved for the build on 2026-11-19 by the lead, on the maintainer's delegation, pending the maintainer's own review. The lead reviewed every picture by eye. If the maintainer rejects a screen, its target is remade and the screen rebuilt.

**Postponed 2026-11-19:** the targets that exist only for several organizations wait for F-134, after v1. One team runs each install, with its clients as projects inside one organization; the lead proposed moving F-049's multi-organization features after v1, and the maintainer answered "sure". So `org-switcher`, `org-switcher-create` and `org-switcher-switched`, and `instance-settings.webp` (the instance's Organizations page) aren't built in milestone 4 (its ticket 44 is `wontfix`). Their files stay, as approved, for when F-134 is built. `instance-settings-accounts.webp` (the Accounts page) is built, from `instance-settings.md`'s page 2 (ticket 33). Until then the sidebar's organization row shows the organization's name, as milestone 1 built it.

**Added 2026-11-19 (ticket 52, F-135 and F-136):** `models-keys`, `project-models-keys`, `agent-profile-model`, `no-key-for-model` and `github-organizations`, made the same way, one generation each, approved 2026-11-19 by the lead on the maintainer's delegation, pending the maintainer's review. The screens that only grow with them (spec section 12) get no new picture: their changes are listed in tickets 53 and 54's `## Comments`.

**Added 2026-11-19 (ticket 62, F-137, ADR 0066):** `agent-profile-effort`, `task-effort` and `model-reasoning`, made the same way, one generation each, approved 2026-11-19 by the lead on the maintainer's delegation, pending the maintainer's review. Ticket 63 builds their UI. `app-targets/m1/models`, the one screen spec section 12 says grows with F-137 (a model's row shows whether it reasons and its levels), is drawn by `model-reasoning`'s `Models` tab, so it gets no other picture.

**Moved to the panel's graphite theme, 2026-11-20:** `accept-invite`, `accept-invite-inbox`, `reset-password` and `reset-password-link` re-composited with the regraded Deep water picture (B-017 in `../../assets.md`) at their original placement; `search-empty-illustration` regraded with the empty-state art's grade and alpha mask; `org-switcher-switched`'s right column is Home's empty right panel, as `../m2/home-first-run.md` now says. No generation: the pictures were blue-green, the panel isn't.

## Screens

| Screen | Target |
|---|---|
| Members | `members` |
| Inviting a member, and the link shown once | `member-invite`, `member-invite-link` |
| Accepting an invitation, and "Check your inbox" | `accept-invite`, `accept-invite-inbox` |
| Forgot your password, and the reset link's page | `reset-password`, `reset-password-link` |
| A project's Access tab | `project-access` |
| A project's Repos tab | `project-repos` |
| The organization switcher, creating one, switched. *Postponed (F-134, after v1)* | `org-switcher`, `org-switcher-create`, `org-switcher-switched` |
| Instance settings: Organizations (*postponed, F-134, after v1*) and Accounts | `instance-settings`, `instance-settings-accounts` |
| The audit log | `audit-log` |
| A task's event log | `task-event-log` |
| The search palette and the search page | `search-palette`, `search`, `search-empty`, `search-empty-illustration` |
| Spend and budgets, and a model's price | `spend-budgets`, `spend-budgets-price` |
| Insights | `insights` |
| Memory, a note and proposals | `memory`, `memory-note`, `memory-proposals` |
| The account mails, light and dark | `email-account` |
| Organization, Models: each provider as a key, the projects that use it, the default list (F-135) | `models-keys` |
| A project's Models and keys, with the save's preview (F-135) | `project-models-keys` |
| The agent profile's model, chosen by name (F-135) | `agent-profile-model` |
| No key for this model in this project: New task, and the copy for a queued task, a held message and the needs-you row (F-135) | `no-key-for-model` |
| Organization, GitHub: several Apps and their installations, linked, waiting or removed (F-136) | `github-organizations` |
| The agent profile's effort: the model's own levels, each with its hint (F-137) | `agent-profile-effort` |
| A task's effort: the driver's control, "from the next turn", the marker, each turn's level and reasoning tokens (F-137) | `task-effort` |
| Organization, Models: each model's reasoning and its source, a custom model's "Reasons" beside its limits, the reasoning-price mark (F-137) | `model-reasoning` |

## Rules

The earlier milestones' rules hold:
- The spec wins on copy, states, components and behaviour.
- The picture wins on size, spacing and contrast.
- One sidebar, built from the shared shell, holding only what's shipped.
- Real data only.
- The brand's fonts and logo.
- Decorative areas use the Deep water illustration, in its graphite grade.
- Check each screen by eye against its picture.

The pages outside the panel (accepting an invitation, the password reset) use the sign-in frame and its scale.
