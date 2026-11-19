# 33: Web: agent mode, Needs approval and the awaiting task

Status: ready-for-agent
Builder: web
Blocked by: 26, 30
Features: F-012, F-040
Packages: `apps/web` (Connect Linear, the project's boards, `src/routes/projects/$projectId/needs-approval.tsx`, the task page)
Spec: `../spec.md`, section 12 (`linear-agent-mode`, `needs-approval`, and the task page and boards growing)

## What to build

- "Connect Linear"'s agent-mode section, with "Turn on agent mode" and the board switches (also on the project's boards page).
- "Needs approval" per project and its rows on Home and in the sidebar's count; the task page's awaiting-approval banner with "Approve" and "Reject"; "Started in Linear by …" on the task.
- The project's "Outside tasks need approval" switch, shown to organization admins only (and read-only to others).

## Done when

- [ ] Playwright, on the fake Linear server: turn on agent mode, switch a board on, see an outside task in "Needs approval", approve one and reject one.
- [ ] Each screen checked against its target at 1440 px and at phone width, in dark and light.
- [ ] The touched packages' checks pass (spec section 9).
- [ ] Committed as `✨ add the agent mode and approval screens`.

## Comments
