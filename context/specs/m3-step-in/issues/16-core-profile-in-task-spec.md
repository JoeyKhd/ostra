# 16: Core: the profile in the task spec

Status: ready-for-agent
Builder: core
Blocked by: 06, 07
Features: F-021
Packages: `apps/core` (`src/dispatch/`), `packages/domain` (`dispatch-task.ts`, `issue-task-credentials.ts`)
Spec: `../spec.md`, section 4 ("A task starts with its profile"); ADR 0049

## What to build

- **The task's profile.** A task records the profile it started with (`Task.agentProfileId`): the member's choice at the start, else the project's default for the kind, else the organization's built-in OpenCode profile. A reopen keeps it. An archived profile still serves the tasks that have it; it's offered to no new task.
- **The spec's agent section** from the profile: instructions (beside the repo's `AGENTS.md`, never replacing it), skills (each skill's files copied into the blob store as blobs of the task, and named in the spec), MCP servers (an HTTP server becomes a `proxyPath` on the sidecar's MCP proxy; a stdio one keeps its command and non-secret variables), the profile's approval rules, the task's rules (`TaskApprovalRule` rows), and `planFirst`.
- **`firstTurnMode: "plan"`** only on a task's first session when the profile has plan first and the task's `planState` is `none`.
- **The credentials endpoint** adds each HTTP MCP server's URL and headers, read from the secret store after the lease check, for the sidecar only (ADR 0030). Never in the spec, never in a log line.
- **A runner too old for the profile** (minor 1): a task whose profile has rules, plan first, skills or MCP servers isn't offered to it, and the dispatch note says "needs a runner at protocol 2 or later".
- **Who may use a profile:** a start or a reopen with a profile the member may not use is refused with a clear message (the API checks it too; this is the dispatch's own guard).

## Done when

- [ ] Tests: a task's spec carries its profile's sections; the default chain (member's choice, project default, built-in) holds; an archived profile still dispatches its tasks; the MCP headers are in the credentials response and absent from the spec and the event log; a minor-1 runner isn't offered a task that needs minor 2; another organization's profile is never used.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ put the agent profile in the task spec`.

## Comments
