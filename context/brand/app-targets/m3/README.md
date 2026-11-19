# Milestone 3 screen targets

The design targets for milestone 3's screens (`context/specs/m3-step-in/spec.md`; ticket 41). They're made the same way as milestone 1's and 2's (`../m1/README.md`, `../m2/README.md`): image first with the `ui-taste` skill on Higgsfield `gpt_image_2_6`, using the approved earlier targets, the graphite concepts and the Hinge logo as references. Each screen has a `<screen>.webp` at CSS scale, a `<screen>.md` build spec and a `<screen>.prompt.txt`.

**Status: approved for the build on 2026-11-19 by the lead, on the maintainer's delegation, pending the maintainer's own review.** The maintainer asked for the work to go on through the night ("continue working on everything throughout the night, would be nice to wake up to the finished product"). The lead reviewed each picture by eye before approving it. If the maintainer rejects a screen, its target is remade and the screen rebuilt.

## Screens

| Screen | Target |
|---|---|
| Agent profiles, the list | `agent-profiles` |
| One agent profile's editor | `agent-profile` |
| The task page with approvals, and a question | `task-approval`, `task-approval-question` |
| Plan first: proposed, being edited, approved | `task-plan`, `task-plan-edit`, `task-plan-approved` |
| The Changes tab: the diff with comments, update branch | `task-changes` |
| The Checks tab | `task-checks` |
| Take it local | `take-it-local` |
| The Needs you page | `needs-you` |
| Home's board view | `home-board` |
| A member's notification choices | `notification-settings` |
| The instance's email settings (Resend first, SMTP second) | `email-settings` |
| The needs-you email, light and dark | `email-needs-you` |
| Account: the GitHub link and CLI sessions | `account` |
| The environment's services, checks and snapshot | `environment-services` |
| Answering an approval and a plan at phone width | `phone-approval` |

## Rules

Milestone 1's and milestone 2's rules hold:
- The spec wins on copy, states, components and behaviour. The picture wins on size, spacing and contrast.
- One sidebar, built from the shared shell, never from a picture. It holds only what's shipped.
- Real data only, with the brand's fonts and logo.
- Decorative areas use the Deep water illustration.
- Check each screen by eye against its picture.

The email is the one screen outside the panel's graphite chrome. It's built as an HTML email with inline styles and a plain-text part, as `email-needs-you.md` says. Amber stays a fill with dark text, never text on Shell.
