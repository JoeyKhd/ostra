# 25: API: the audit log and the task's event log

Status: ready-for-agent
Builder: api
Blocked by: 10
Features: F-073
Packages: `packages/api` (`src/routers/audit.ts` (new), `src/routers/tasks.ts`), `apps/web` (`/api/audit/export`, the CSV route)
Spec: `../spec.md`, section 4 ("The audit log"); ADR 0054

## What to build

- **`audit.list`** (organization admin: the whole log; project admin: `projectId` required and their project's only): filters for actor, action (one, or a prefix such as `budget.`), project, entity and period; keyset pagination by `(createdAt, id)`; each entry with the actor's name (and "(removed)"), the action, the entity with a link target, the project, and its `data`.
- **The export:** a route on the web app that streams the same query as CSV, one quoted field per column, with the filters as query parameters and the same access check; a header row; no row limit, streamed in pages.
- **`tasks.eventLog`** (any member who can open the task): every event in order, paged by `seq`, with filters by kind; a tool call's full input as stored; failed and refused calls with their error text; approvals with the command they asked about. It reads only, through `taskProcedure("read", …)`.
- **The link:** an audit entry about a task carries the task's ID so the panel can open its event log.

## Done when

- [ ] Tests named `it("F-073: ...")`: an organization admin sees every entry and filters each way; a project admin sees only their project's, and a member none; another organization's entries never; the export's rows equal the list's for the same filters; the event log returns a tool call's full input for `execute`, `read`, `search`, `edit` and `fetch`; a member who can't open the project gets `NOT_FOUND`.
- [ ] Committed as `✨ add the audit log and the event log`.

## Comments
