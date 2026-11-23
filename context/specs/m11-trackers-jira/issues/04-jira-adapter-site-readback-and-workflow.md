# 04: Jira adapter: the site, the token's read-back and the workflow

Status: ready-for-agent
Builder: adapters
Blocked by: 02, 03
Features: F-008
Packages: `packages/adapters/adapter-jira` (new `connect.ts`, `jira-adapter.ts`'s `readWorkflow` and `via`, `jira-adapter.live.test.ts`), `packages/adapter-sdk/src/testing/fake-jira/` (the routes the kit reads)
Spec: `../spec.md`, sections 5.3 (ticket 04's list) and 5.4 (the `JiraConnectKit` port); ADR 0047; `research/trackers.md` §2.1–2.4, S-10, S-12

## What to build

- **The connect calls,** `jiraConnect` in `src/connect.ts`, each taking `{ apiUrl, fetch, timeoutMs }`, answering `adapter-jira`'s own result types (`adapter-jira` never imports the domain; ticket 09's `packages/api/src/services/jira-connect.ts` implements the domain's `JiraConnectKit` port on them, as `services/linear-app.ts` does for Linear):
  - `findSite(siteName)`: `_edge/tenant_info` for the cloud ID; `not-found`, `data-center`, `unreachable`;
  - `checkToken({ cloudId, email, token })`: the four checks (`/myself` and its `accountType`, the project search, `/mypermissions` per project for the five permissions, the workflow search), each `ok | warn | fail` with IDs and names; `refused` with the status code on 401 or 403;
  - `scopes`, `webhookEvents`, `suggestedJql(projectKeys)`, `webhooksPage(host)`.
  The token is held in a local for the calls and goes nowhere else.
- **`readWorkflow`** on `JiraAdapter` through `/workflows/search` for the project's issue types, the union of their workflows, global transitions as `any`, `readable: false` on 403; **`via`** on every move.
- **The fake Jira** serves `tenant_info` (a Cloud site, a Data Center host), `/myself` (a service account and a person), the project search, `/mypermissions` with a project short of two permissions, and the workflow search, refusable per token.
- **The live test,** skipped without `OSTRA_JIRA_LIVE_SITE`, `OSTRA_JIRA_LIVE_EMAIL` and `OSTRA_JIRA_LIVE_TOKEN` (from `~/.config/ostra-dev/jira.env`, ticket 19): the four checks, the workflow read (records S-12's answer in its output), and one move along a route on a throwaway issue it deletes after.

## Done when

- [ ] Tests named for `F-008/c1`: against the fake Jira, `findSite` answers the cloud ID, `not-found` and `data-center`; `checkToken` answers each check's three outcomes, a person's account `fail`, no project `fail`, a short permission `warn` naming it, no workflow access `warn`, a 401 `refused` with its code.
- [ ] Tests named for `F-008/c5`: `readWorkflow` against the fake Jira lists a project's statuses with categories and its transitions, a global one as `any`, and `readable: false` for a token without workflow access; a move answers its transitions in `via`.
- [ ] Tests named for `F-008/c2`: no check's answer, error or log line holds the token or Jira's body.
- [ ] The live test exists and is skipped in CI; ticket 18 runs it.
- [ ] Checks for `adapter-jira` pass, and the whole-repo checks (spec section 10).
- [ ] Committed as `✨ read back a Jira token before it's saved`.

## Comments
