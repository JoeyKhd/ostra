# 26: API: agent mode and outside approvals

Status: done
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

- [x] Tests: `enableAgentMode` refused without an admin session; one agent-mode board per team; approve and reject by members with access only, the first answer winning; the switch refused for a project admin; the outside task's view shows no starter's address.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add the agent mode and approvals API`.

## Comments

- 2026-11-20, api: built as `✨ add the agent mode and approvals API`. Agent mode's procedures are in `packages/api/src/routers/linear.ts`; Needs approval, the answers and the switch in `task-approval.ts` (mounted as `tasks.needsApproval`, `tasks.approve`, `tasks.reject` and `projects.setOutsideApproval`); tests in `agent-mode-approvals.test.ts`, and the isolation suite reads `tasks.needsApproval` and `linear.status`'s sessions. Readings and differences:
  - **`linear.enableAgentMode()`** is an organization admin's, and its `OAuthState` is bound to their own panel session (ticket 13's `createLinearAuthorizeUrl(..., { agentMode: true })`). It answers `{ kind: "consent", authorizeUrl }`, or `{ kind: "on" }` at once when the stored token already holds agent mode's scopes (ticket 13's `enableAgentMode`). A connection that polls is refused (`PRECONDITION_FAILED`): agent mode needs Linear's webhooks.
  - **`linear.status`** stays an organization admin's (milestone 2's router), and grows one field, `agentMode` (`null` until the connection is active): on and since when, who turned it on (the audit entry), the granted and missing agent scopes, whether Linear can reach the install, the token's next renewal (an hour before it expires, core's margin), each board with its team key, project and switch, the session counts (open, awaiting approval, posted today) and the last ten sessions. The screen target's "last renewed" and per-event outcome words aren't stored anywhere yet; the panel derives the outcome from the session's and task's states.
  - **`linear.setBoardAgentMode`** is a member procedure whose use case checks the project admin (organization admins administer every project, the screen target's recommendation); a second board of a team is `CONFLICT` with the project named.
  - **`tasks.needsApproval({ projectId | null })`** lists every task waiting for approval in the projects the member can open, outside tasks and a rule's that asks for approval alike, each with who started it (the tracker's name, never an address or the tracker's ID), its ticket, its profile and the project's pools in order; with a project, also the project's switch and who last changed it. Ostra stores no starter address at all, so there is none to leak; the test also checks the tracker user's ID never appears.
  - Proof: rows added to `context/proof/F-012.md` and `F-040.md` (F-040's second row is now `proved`); break-its recorded there. F-012 stays `building`: the live run waits for the maintainer's Authorize click (ticket 40), with its plan in `F-012.md`.
