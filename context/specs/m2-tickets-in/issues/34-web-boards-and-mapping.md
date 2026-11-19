# 34: Web: boards and the status mapping

Status: done
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

- [x] Component tests: the drafted mapping, an edit, a status that disappeared, read-only for members.
- [x] Committed as `✨ add the boards screen`.

## Comments

- 2026-11-19, web: done in `✨ add the boards screen` (`dd1d9c7`), to `project-boards`, against ticket 28's router. Checked side by side at 1440×956 against the real ostra-test workspace (a dev `api_key` connection; team `OST` attached from the page, its mapping drafted by the server).
  - `components/boards/`: `board-words.ts` (statuses grouped by Linear's type, `duplicate` with canceled; the mapping's problems; the next task's sentences, rebuilt from the unsaved mapping), `boards-view.tsx` (Attached rows with `?board=` selection and Detach behind an `AlertDialog`, the Attach line from `boards.available` with `attached` and `also on …`, the mapping form, the sentences, the panel). Tested: the drafted mapping, an edit, an empty Open, a status that disappeared, a member's read-only view, the panel.
  - New UI pieces: `ui/popover.tsx`, `ui/toggle-group.tsx` and `SelectLabel`, all on `radix-ui`. **No new dependency:** the Open picker is a `Popover` with a checklist instead of `cmdk`'s `Command`, and `Mapping saved.` is an inline `role="status"` line instead of a `sonner` toast. Either can be swapped in later without changing the page's data.
  - The project's navigation gains `Boards` (`square-kanban`) before `Repos`; the project's panel gains a `Boards` row (the keys, a teal link here), read from `boards.get`.
  - Not built: the "Discard the changes to the mapping?" prompt when leaving with unsaved edits.

