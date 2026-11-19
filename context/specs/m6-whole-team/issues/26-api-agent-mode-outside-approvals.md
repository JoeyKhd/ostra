# 26: API: agent mode and outside approvals

Status: ready-for-agent
Builder: api
Blocked by: 13, 14
Features: F-012, F-040
Packages: `packages/api` (`src/routers/linear.ts`, `src/routers/tasks.ts`, `src/routers/projects.ts`)
Spec: `../spec.md`, section 4 ("Linear agent mode", "An outside task")

## What to build

- `linear.status` grows: agent mode on or off, the granted scopes, the public address's check (milestone 2's pre-check), the token's next renewal, each board's "Start from Linear", the last session events. `linear.enableAgentMode()` → the consent URL (an organization admin's session only); `linear.setBoardAgentMode({ boardId, on })` for a project admin, refused with the other project named when the team already has one.
- `tasks.needsApproval({ projectId | null })` → outside tasks with who started them, the ticket, the profile and the pool; `tasks.approve({ taskId })` and `tasks.reject({ taskId, reason })` for any member who can open the project.
- `projects.setOutsideApproval({ projectId, on })` for an organization admin only.

## Done when

- [ ] Tests: `enableAgentMode` refused without an admin session; one agent-mode board per team; approve and reject by members with access only, the first answer winning; the switch refused for a project admin; the outside task's view shows no starter's address.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add the agent mode and approvals API`.

## Comments
