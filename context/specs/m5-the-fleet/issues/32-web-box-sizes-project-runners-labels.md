# 32: Web: box sizes, project runners and profile labels

Status: ready-for-agent
Builder: web
Blocked by: 27, 29
Features: F-095, F-069, F-086
Packages: `apps/web` (`src/app/(panel)/organization/box-sizes/`, `src/app/(panel)/projects/[slug]/settings/runners/`, `src/components/agent-profiles/`, `messages/en.json`)
Spec: `../spec.md`, sections 3 (steps 1, 5 and 7) and 12

## What to build

- **Box sizes** (`m5/box-sizes`): the three sizes, editable by admins, where each is a project's default, and the `host` line.
- **A project's Runners** (`m5/project-runners`): the allowed pools in order with drag and keyboard reorder, each share, the default size, and the line on personal runners.
- **The profile's "Runner labels"** against `app-targets/m3/agent-profile`, with the reserved prefixes refused inline.

## Done when

- [ ] Playwright, named for `F-095`, `F-086` and `F-069`: an admin edits a size; a project admin reorders pools with the keyboard and sets a share; a label with a reserved prefix is refused.
- [ ] Committed as `✨ add sizes, project runners and labels`.

## Comments
