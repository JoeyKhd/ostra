# 04: Jira adapter: the site, the token's read-back and the workflow

Status: done
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

- [x] Tests named for `F-008/c1`: against the fake Jira, `findSite` answers the cloud ID, `not-found` and `data-center`; `checkToken` answers each check's three outcomes, a person's account `fail`, no project `fail`, a short permission `warn` naming it, no workflow access `warn`, a 401 `refused` with its code.
- [x] Tests named for `F-008/c5`: `readWorkflow` against the fake Jira lists a project's statuses with categories and its transitions, a global one as `any`, and `readable: false` for a token without workflow access; a move answers its transitions in `via`.
- [x] Tests named for `F-008/c2`: no check's answer, error or log line holds the token or Jira's body.
- [x] The live test exists and is skipped in CI; ticket 18 runs it. *2026-11-23: `jira-adapter.live.test.ts`, skipped here (no `jira.env` on this machine).*
- [x] Checks for `adapter-jira` pass, and the whole-repo checks (spec section 10). *2026-11-23: typecheck, lint and tests of `adapter-jira` and `adapter-sdk`, the root lint, the root `tsc` and `check:licenses` passed before the push; the rest of the repo is CI's run on the push (`AGENT-RULES.md`), and nothing outside the two packages changed.*
- [x] Committed as `✨ read back a Jira token before it's saved`.

## Comments

- 2026-11-23, adapters: built as `1766cfa3` ✨ read back a Jira token before it's saved. What tickets 06, 09 and 10 find:
  - **`jiraConnect`** (`connect.ts`, exported from the package's index), each call taking `{ apiUrl, fetch, timeoutMs }` first:
    - `findSite(options, siteName)` → `JiraSiteLookup`: `found` (`cloudId`, `host`, `title`), `not-found` (`host`, or `null` when the input names no host), `data-center` (`host`) or `unreachable` (`host`). It takes a name, a host or a pasted URL (`jiraSiteHost`). The title is the name's words capitalized (`acme-corp` is `Acme Corp`), for `defaultConnectionName`. Without `apiUrl`, a host that isn't `<name>.atlassian.net` is `data-center` with no call, so ostra asks no other host. With `apiUrl` (the fake), every lookup goes there, the host named in `X-Forwarded-Host`, and a site without tenant info is asked its `/rest/api/2/serverInfo`.
    - `checkToken(options, { cloudId, email, token })` → `JiraTokenReadBack`: `checked`, `refused` (`status` 401 or 403, on `/myself`) or `unreachable` (`status`, or `null`: Jira failing, a 429 or no answer, which can be tried again and isn't a refusal). `checked` holds:
      - `account`: `ok` for `accountType: "app"`, `fail` for a person, `warn` when Jira doesn't say;
      - `projects`: `ok`, or `fail` for none, with each project's `{ id, key, name }`;
      - `permissions`: `ok`, or `warn`, with every project and the `missing` ones of `JIRA_CONNECT_PERMISSIONS` (browse, create, edit, transition, comment);
      - `workflows`: `ok` or `warn`, with `readable` and the `unreadable` projects;
      - `scopes`: each of the four `confirmed`, `refused` or `unchecked`. `write:jira-work` is always `unchecked`, since nothing is written before the token saves.
    - `scopes`, `webhookEvents` (the six), `suggestedJql(projectKeys)` (`null` for none) and `webhooksPage(host)` (`null` for a host that isn't one).
  - **For 06:** a `fail` (the account or the projects) refuses the save; warnings save. `accessCheck` is `permissions.projects` with `workflows.readable`; `scopes` the `confirmed` ones; `appUserId` and `appUserName` are `account.accountId` and `account.name`; `appId` and `externalWorkspaceId` the `cloudId`, `externalWorkspaceKey` the `host`, `externalWorkspaceName` the `title`. The fake kit's outcomes are these unions'.
  - **For 09:** `services/jira-connect.ts` passes `{ apiUrl: OSTRA_JIRA_API_URL or null, fetch, timeoutMs }`. In tests, `createFakeJira({ siteName })`'s `gatewayUrl` is the `apiUrl`, and `siteHost` and `dataCenterHost` are the names to find. `refuseToken(token, 401 | 403)`, `revokePermissions(account, project, [...])` (with `VIEW_READONLY_WORKFLOW` hiding a project's workflows), a `mintToken` without `read:workflow:jira` and `person` give the other outcomes. The panel's refusal says the status code: the kit never reads Jira's body.
  - **For 10 and 15:** `readWorkflow` answers `TrackerWorkflow` from `/workflows/search?projectId=…` (the union of the project's workflows), which the domain's mapping check reads with 02's `reachability`.
  - **The duplicates are gone.** `findTransitionPath`, `distancesTo`, `planMapping` and `WorkflowGraph` gave way to `routeTo` and `reachability`; `JiraAdapter.checkToken()`, `JiraTokenCheck` and the eight `JIRA_PROJECT_PERMISSIONS` to `jiraConnect.checkToken`; `findJiraCloudId` to `jiraConnect.findSite`; `JiraBoardWorkflow` to `TrackerWorkflow`.
  - **The workflow endpoints.** `readWorkflow` reads the spec's `/workflows/search`. A move reads its own issue type's workflow by the bulk read (`POST /rest/api/3/workflows` with `projectAndIssueTypes`): the board's union could route a Bug through a Task's transition and leave it halfway, and with its own workflow it's refused before any step (tested). There's no fallback to the classic `workflow/search`: Atlassian's OpenAPI spec says it "will be removed on June 1, 2026" (CHANGE-2569), and `workflowscheme/project` isn't needed. An empty page reads as `readable: false`, since Jira may hide workflows the account can't administer rather than refuse. Both endpoints document `read:workflow:jira` and ask for Administer Jira or a project's View (read-only) workflow permission: S-12 on the live site decides. The findings are in `research/trackers.md` §2.4 and §2.7, the open questions in the package README's live-only list.
  - **The live test** (`jira-adapter.live.test.ts`) finds the site, prints the read-back (S-10: the account type), reads every project's workflow and prints S-12's answer per project, then moves a throwaway issue to the started status farthest along a route and deletes it after, saying so if the account can't delete. It skips without `OSTRA_JIRA_LIVE_SITE`, `OSTRA_JIRA_LIVE_EMAIL` and `OSTRA_JIRA_LIVE_TOKEN`. Spec section 5.3's "signed delivery through the tunnel" is ticket 18's, with core's route.
