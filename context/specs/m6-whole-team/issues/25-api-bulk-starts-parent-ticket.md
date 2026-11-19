# 25: API: bulk starts and the parent ticket

Status: ready-for-agent
Builder: api
Blocked by: 11, 12
Features: F-107, F-077, F-010
Packages: `packages/api` (`src/routers/inbox.ts`, `src/routers/tickets.ts`)
Spec: `../spec.md`, section 4 ("A bulk start", "Sub-issues")

## What to build

- `inbox.startMany({ projectId, ticketIds, kind, agentProfileId, requestKey })` → the bulk start's ID; `inbox.bulkStart({ id })` and a live subscription of its items' outcomes.
- `inbox.list` gains each ticket's sub-issue count and "starts N tasks" for a code start.
- `tickets.parent({ ticketId })` → the children with their tasks' states, PRs and needs-you, the children on no board of the project, and the parent's refine task; `tickets.startSubIssues({ ticketId, requestKey })`.

## Done when

- [ ] Tests: 50 accepted, 51 refused; a replayed request key returns the same bulk start; outcomes stream; the parent's view for a three-level tree; access as the project's.
- [ ] The touched packages' checks pass (spec section 9).
- [ ] Committed as `✨ add bulk starts and the parent ticket API`.

## Comments
