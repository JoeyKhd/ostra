# 33: Web: agent mode, Needs approval and the awaiting task

Status: done
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

- [x] Playwright, on the fake Linear server: turn on agent mode, switch a board on, see an outside task in "Needs approval", approve one and reject one.
- [x] Each screen checked against its target at 1440 px and at phone width, in dark and light.
- [x] The touched packages' checks pass (spec section 9).
- [x] Committed as `✨ add the agent mode and approval screens`.

## Comments

- 2026-11-20, web: built as `✨ add the agent mode and approval screens` (c17d958a). "Connect Linear" grows its Agent mode, Start from Linear and Last session events sections and an "Agent sessions" panel group (`apps/web/src/components/linear/agent-mode.tsx`); the project's Boards page gets each board's "Start from Linear" switch; a project's Needs approval (`/projects/[project-id]/needs-approval`, `apps/web/src/components/approvals/`) lists its waiting tasks with "Approve" and "Reject" (with a reason), and its panel holds the "Outside tasks need approval" switch, an organization admin's (disabled for everyone else, with a confirmation before turning it off); the sidebar has "Needs approval" under each project with its amber count; Home's row for an awaiting task says "Approve" and opens the project's list with the task open; the task page shows the same block as a banner and "Started in Linear by …" on its key line. Proved by `apps/web/e2e/20-agent-mode.spec.ts` on the stack's fake Linear as the connection, with break-its recorded in `context/proof/F-012.md` and `F-040.md` (F-040's first row is now `proved`).
  - **API, additive:** `boards.get` gains each board's `startFromLinear` and the connection's `agentMode`, for the Boards page's switch.
  - **"Turn on agent mode" in the e2e:** the consent page is linear.app's, and the panel's OAuth endpoints are constants (only `OSTRA_LINEAR_API_URL` is configurable, ticket 34), so the stack can't run the consent. The seed leaves the token as the consent would (agent mode's scopes granted), and the press turns agent mode on through `linear.enableAgentMode` (its `on` answer). The redirect to the consent page and the live Authorize are ticket 40's run; F-012 stays `building`.
  - **Checked against the targets** at 1440 px and 412 px, dark and light (`_lead/ui-check/m6-linear-agent-mode*`, `m6-needs-approval*`, `m6-light-linear-agent-mode`, `m6-light-needs-approval`, `m6-task-awaiting-approval`). Differences:
    - "Turn on agent mode" is disabled only for a polling connection (the API refuses it); an unreachable address shows its warning but doesn't block the press, so an install can turn agent mode on before its address is public.
    - Needs approval has no Decided tab and no unread dot: `tasks.needsApproval` lists the waiting tasks only. An answered task keeps its outcome line on the page until the next load.
    - The block's reason line says the starter matched no member who can open the project; `tasks.needsApproval` doesn't say which of the target's three reasons it was.
    - Last session events show each session's start (who delegated, matched or not, and the outcome from the session's and task's state); stops and follow-ups aren't listed separately (`linear.status` lists sessions, not their events). The token's "last renewed" isn't stored (ticket 26's note).
    - The panel's "From Linear" group isn't there: `linear.status` is an organization admin's, and Needs approval is any member's.
    - The task page's generic "Needs you" block is hidden while a task waits for approval: the banner says it.
