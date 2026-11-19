# 42: Web: agent profiles and the profile picker

Status: ready-for-agent
Builder: web
Blocked by: 34, 41
Features: F-021, F-026, F-063
Packages: `apps/web` (`src/app/(panel)/organization/agent-profiles/`, `src/components/agent-profiles/` (new), `components/tasks/new-task-form.tsx`, the Inbox's start, `components/projects/project-properties.tsx`, the sidebar)
Spec: `../spec.md`, section 12 (`agent-profiles`, `agent-profile`; and `m1/project`, `m1/task-new`, `m2/inbox` growing)

## What to build

- **The profiles page** (`agent-profiles`) and **the editor** (`agent-profile`), to their targets: every field of ticket 34, the four presets as one-click rules that open editable, a custom rule's tool and match, the coverage line from `ruleCoverage`, MCP headers entered once and shown as "set", skills with their files, plan first with its one-line explanation, who may use it, archive with the count of projects that default to it.
- **The project's defaults** per task kind in the project's properties (`m1/project` grows).
- **The picker** in "New task" and the Inbox's "Start task" (`m1/task-new`, `m2/inbox` grow): the member's profiles, the project's default first, with plan first and the rules shown as small facts under the name.
- **The sidebar:** "Agent profiles" under Organization, for everyone (members see what they may use; admins edit).
- Every string in the message files; dark first; phone width per F-075.

## Done when

- [ ] The screens match their targets, checked by eye against the pictures, with the differences recorded here.
- [ ] Playwright: an admin makes a profile with a preset rule, plan first and a member limit; a listed member sees it in the picker and an unlisted one doesn't; a project default is picked first.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `web`.
- [ ] Committed as `✨ add the agent profiles screens`.

## Comments
