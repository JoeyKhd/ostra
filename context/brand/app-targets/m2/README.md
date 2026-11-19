# Milestone 2 screen targets

The design targets for milestone 2's screens (`context/specs/m2-tickets-in/spec.md`, section 12; ticket 32). They're made the same way as milestone 1's (`../m1/README.md`): image first with the `ui-taste` skill on Higgsfield `gpt_image_2_6`, using the approved milestone 1 targets, the graphite concepts and the Hinge logo as references.

| File | What it is |
|---|---|
| `<screen>.webp` | The picture, at CSS scale: 1440 px wide, and phone frames at their CSS width. One image pixel is one CSS pixel. |
| `<screen>.md` | The build spec: purpose, route, layout, every state with its copy, components, tokens, differences from the current code, and what the picture gets wrong |
| `<screen>.prompt.txt` | The prompt that made the picture |

**Status: approved for the build on 2026-11-19 by the lead, on the maintainer's delegation, pending the maintainer's own review.** The maintainer asked for the work to go on through the night ("continue working on everything throughout the night, would be nice to wake up to the finished product"), so tickets 33 to 37 build to these targets now. If the maintainer rejects a screen, its target is remade and the screen rebuilt.

## Screens

| # (spec §12) | Screen | Target |
|---|---|---|
| 1 | Connect Linear | `connect-linear` |
| 2 | Home's first-run checklist, with the Linear step live | `home-first-run` |
| 3 | The project's boards and the status mapping | `project-boards` |
| 4 | The project's Inbox, and its empty state | `inbox`, `inbox-empty`, `inbox-empty-illustration` |
| 5 | The task page for a ticket task | `task-ticket` |
| 6 | Reopening a task | `task-reopen`, `task-reopen-stopped` |
| 7 | Limits and crashes on the task page | `task-limits` |
| 8 | Repo checks on the project | `repo-checks` |
| 9 | The ticket template editor | `ticket-template` |
| 10 | Storage and retention | `storage-settings` |
| 11 | The Inbox and the ticket task at phone width | `phone-inbox`, `phone-task` |

## Rules

Milestone 1's rules hold (`../m1/README.md`):
- the spec wins over the picture
- one sidebar, built from the shared shell, never from a picture
- real data only
- the brand's fonts and logo
- check by eye against the picture

These hold too:
- **The sidebar grows by what milestone 2 ships.**
  - A project's items: Tasks, Inbox, Environment, Boards, Repos and Settings (the ticket template lives under Settings).
  - Organization: Runners, Models, GitHub, Linear and Storage.
  - Rows for later milestones (Agent profiles, Insights, Memory, Members, Audit log, Background work) appear in some pictures as flavour only.
- **Decorative areas use the Deep water illustration** (`../../files/web/sign-in-illustration.webp`, B-017), never a mock of the product.
- **Decisions the specs leave open.** Each `.md` lists them under its differences or open points (for example the member view of the Linear page, the "Skip for now" state of the Linear setup step, and the extra `linear.status` fields). The build takes the spec's recommended option, and records it in the ticket that builds the screen. **Settled on 2026-11-19** by the lead, on the delegation. Each ticket's `## Decided 2026-11-19 (ticket 40)` section holds the answer, under `context/specs/m2-tickets-in/issues/`. Where a target's open point and its ticket disagree, the ticket wins.
