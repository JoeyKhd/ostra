# 34: Milestone 1 screen targets

Status: ready-for-agent
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

- [ ] The nine screens exist as HTML and PNG in `context/brand/app-targets/m1/`.
- [ ] The maintainer approves them (recorded under `## Comments` with the date). Until then, tickets 35, 37 and 38 build against the concept screens and restyle after.
- [ ] Committed as `🎨 add milestone 1 screen targets`.

## Comments
