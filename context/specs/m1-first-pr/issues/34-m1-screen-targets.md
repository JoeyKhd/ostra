# 34: Milestone 1 screen targets

Status: done
Builder: web
Blocked by: none
Features: F-076, F-088, F-006, F-086, F-050, F-023, F-025 (their screens)
Packages: `context/brand/app-targets/m1/` (new)
Spec: `../spec.md`, section 3

## What to build

`build-order.md` says a milestone's screens are designed first, image first, and the approved pictures land in `context/brand/app-targets/`. Follow `context/brand/brief.md`, `context/brand/app-design.md` and the `ui-taste` skill, in real HTML on `app-concepts/html/graphite.css`, screenshotted at 1440×900 at 2× as the concepts are.

Screens:
1. First run: "Create the first admin" with the setup-token field.
2. The first-run checklist, as the home of a new organization (six steps, Linear shown as "milestone 2").
3. Add a model provider: the form, Test connection's result, the models list (from `models-graphite`).
4. Connect GitHub: "Use an existing App" and "Create a new App".
5. Create a project: the repo picker and the environment draft with its reasons (from `environment-graphite`, without snapshots and services).
6. Connect a runner: the command, the device approval page, the runner online.
7. The project's tasks, grouped by state (from `project-tasks-graphite`), with the "new task" prompt and "run on".
8. The task page, live (from `task-b-graphite`): no approval card in milestone 1, a Stop button, the PR link, the "personal, not isolated" label.
9. The same at phone width.

## Done when

- [x] The nine screens exist as HTML and PNG in `context/brand/app-targets/m1/`. *Re-worded 2026-11-20, as the comment below asked: the set that exists is twelve screens (14 pictures with `github-not-connected` and `home-banner`), each as `<screen>.webp` at CSS scale with its `<screen>.md` build spec and `<screen>.prompt.txt`, and the folder's `README.md`.*
- [x] The maintainer approves them (recorded under `## Comments` with the date). Until then, tickets 35, 37 and 38 build against the concept screens and restyle after.
- [x] Committed as `🎨 add milestone 1 screen targets`. *Committed as `📝 add the milestone 1 screen targets` (`f05b16e0`), as milestone 2's targets were under `📝`.*

## Comments
- 2026-11-19 (web): checked against `main`. The pictures exist now (`f05b16e`): `context/brand/app-targets/m1/` holds 12 screens as WebP with a build spec and a prompt each, made by the `ui-taste` skill on the concepts. They are not the nine HTML-and-PNG screens this ticket names (the set changed: the sign-in, Home, the New task form and a GitHub "not connected" state were added, and the "Create the first admin" screen was dropped when the maintainer decided on 2026-11-19 that a fresh install creates its first admin from settings), and its README says **waiting for the maintainer's approval**. So the three boxes stay open: nothing is approved, and the panel has not been restyled to them. Tickets 35, 37 and 38 were built against the concept screens, as this ticket allows, and milestone 1's UI has not been checked against an approved target. To close this ticket, the maintainer approves the targets (or says here, with the date, that the concept screens stand for milestone 1), the panel is restyled to the approved ones, and the boxes are re-worded to the set that exists. That call is not the builder's.
- 2026-11-20, audit: **done.** Checked on `origin/main` (`58572d1`):
  - **The targets:** `context/brand/app-targets/m1/` holds the twelve screens of its `README.md` (sign-in, Home, the project's tasks, Create a project, Environment, Task, New task, Runners, Approve a runner, Models, GitHub with its `github-not-connected` state, Choose a new password with the `home-banner`), each as WebP with its build spec and prompt (`f05b16e0` and the commits after it). The "Create the first admin" screen is gone by the maintainer's decision of 2026-11-19 (a fresh install seeds `demo@demo.com` / `demo`, F-001), and the phone width is each `.md`'s phone section rather than a ninth picture. The first box is re-worded to that set.
  - **The approval:** the maintainer approved every target on 2026-11-19 (`ef632603`, `📝 record the screen target approvals`, in the README's Status line), the sign-in column's illustration after it ("Deep water", `87c6f387`), and both moved to the graphite theme on 2026-11-20 (`7f69c696`).
  - **The restyle:** the panel was matched to the approved targets' scale in `b03e0fb5` (`✨ match the panel to the approved targets' scale`; the README's "Scale" table lists every token it moved). Tickets 35, 37 and 38 are `done`.
