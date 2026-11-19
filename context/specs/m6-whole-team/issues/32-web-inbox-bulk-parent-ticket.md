# 32: Web: the Inbox's bulk start and the parent ticket

Status: ready-for-agent
Builder: web
Blocked by: 25, 30
Features: F-107, F-077, F-010
Packages: `apps/web` (the Inbox, `src/routes/projects/$projectId/tickets/$ticketId.tsx`)
Spec: `../spec.md`, section 12 (`inbox-bulk-start`, `ticket-parent`, and the Inbox and New task growing)

## What to build

- The Inbox's checkbox column, the selection bar, the kind and profile for all, and each ticket's streamed result; sub-issues folded under their parent with "starts N tasks".
- The parent ticket's page with its children, their tasks and PRs, the children elsewhere, and "Start sub-issues".
- New task: "This starts N tasks, one for each sub-issue".

## Done when

- [ ] Playwright: select four tickets and start them, one skipped with its reason; open a parent's page and see its children move.
- [ ] Each screen checked against its target at 1440 px and at phone width, in dark and light.
- [ ] The touched packages' checks pass (spec section 9).
- [ ] Committed as `✨ add bulk starts and the parent ticket`.

## Comments
