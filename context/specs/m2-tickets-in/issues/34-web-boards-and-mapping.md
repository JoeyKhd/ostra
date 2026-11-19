# 34: Web: boards and the status mapping

Status: ready-for-agent
Builder: web
Blocked by: 28, 32 (the targets' approval, for the UI)
Features: F-007, F-031
Packages: `apps/web` (`src/app/(panel)/projects/[project-id]/boards/`, `src/components/boards/`, `messages/en.json`)
Spec: `../spec.md`, sections 3 (step 2) and 12 (screen 3)

## What to build

To the approved target for screen 3.

- **The project's boards:** each attached team with its ticket count, its last poll or event, and Detach.
- **Attach a board:** the connection's teams, those already attached marked.
- **The status mapping:** every status of the team, grouped by its category, with a picker for open (several), started, in review and done; "Done is moved by" Linear's GitHub integration or ostra, with the detected state shown; the magic word. Save shows what the next task will do on the ticket, in one sentence per step.
- Project admins only; members see the boards read-only. The Repos and Settings parts of the project's navigation (`app-design.md`) gain "Boards".

## Decided 2026-11-19 (ticket 40)

The lead, on the maintainer's delegation, settled the open points the milestone 2 targets (`context/brand/app-targets/m2/`) and ticket 40 left. They're part of what to build:

- **Dependencies allowed:** `cmdk` (shadcn's `Command`, for the open-status multi-select) and `sonner` (the `Mapping saved.` toast). The maintainer allowed new dependencies for this build. Pin each one exactly, commit the lockfile with it, and keep `check:licenses` green: both are MIT, inside `apps/web`.
- **The project's navigation,** from now on: Tasks, Inbox, Environment, Boards (`square-kanban`), Repos (`git-branch`), Settings (`settings`, project admins only). Each row ships with its own screen's ticket. `app-design.md` lists it.
- **The panel's key is `GitHub`,** not `GitHub integration`, so it fits the 96px key column.
- **The project page's properties** gain a `Boards` row: the boards' keys as a teal link to this page, or `–`.

## Done when

- [ ] Component tests: the drafted mapping, an edit, a status that disappeared, read-only for members.
- [ ] Committed as `✨ add the boards screen`.

## Comments
