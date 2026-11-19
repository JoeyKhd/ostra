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

## Done when

- [ ] Component tests: the drafted mapping, an edit, a status that disappeared, read-only for members.
- [ ] Committed as `✨ add the boards screen`.

## Comments
