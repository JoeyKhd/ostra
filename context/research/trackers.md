# Research: Trackers (Linear, Jira)

**Status:** Research v1 · **Checked:** 2026-11-17 (all sources below were read on this date unless noted) · **Informs:** Q-09, Q-11, Q-12, Q-13, Q-14

Facts come from primary sources: official docs, Linear's published GraphQL SDL, Jira's published OpenAPI spec and official changelogs. Anything that could not be confirmed is marked **unverified**. Recommendations are marked as such and are not decisions.

---

## Summary

**Linear**
- **API.** GraphQL at `https://api.linear.app/graphql`. The full SDL is published in Linear's SDK repo ([schema.graphql](https://raw.githubusercontent.com/linear/linear/refs/heads/master/packages/sdk/src/schema.graphql), about 1.6 MB, last regenerated 2026-11-11), so Rust codegen is straightforward. Relay cursors (page size 1–250), a rich `IssueFilter`, and limits of 5,000 req/h and 2M complexity points/h for OAuth apps.
- **Self-hosted auth is a solved problem.** Any workspace admin can create a private OAuth app. Since June 2026, Linear supports **OAuth app manifests**: a URL that opens a pre-filled "Create OAuth app" form. The docs name "self-hosted or open-source projects" as a target use case. ostra can generate that URL per deployment, with its own redirect and webhook URLs filled in.
- **`actor=app`** installs the app as its own workspace user (admin consent required). A **client-credentials** grant (30-day app tokens, no redirect) also exists.
- **Agent platform (stable, in active development).** An OAuth app with `actor=app`, the `app:assignable`/`app:mentionable` scopes and the "Agent session events" webhook category becomes an agent that can be **delegated** issues and @mentioned. Each run is an **Agent Session**, and the agent reports progress through **Agent Activities** (`thought`, `action`, `elicitation`, `response`, `error`). Users reply with `prompt` activities, which can carry `stop` signals.
  - **Hard timing rules:** return the webhook within 5 s, emit the first activity within 10 s, and keep sending activity at least every 30 min or the session goes `stale`.
- **The agent platform is viable for self-hosted ostra**, with one real constraint: Linear must be able to reach the deployment over **public HTTPS**. Manifest webhook URLs must not be loopback or private-network hosts.
- **PR linking:** Linear's own GitHub integration links PRs whose branch name contains the issue ID (or with magic words) and drives status automations. ostra should work with it, not against it: use `Issue.branchName`, put the identifier in the PR title, add the PR to the session's `externalUrls`, and let the integration move statuses when it is installed.
- **Client libraries:**
  - **Rust** has only small unofficial crates, so ostra would generate its own client (`cynic`/`graphql_client`).
  - **TypeScript** has the **official `@linear/sdk`** (v102, weekly releases). It covers agent sessions and activities and ships typed, signature-verified webhook handlers, including `AgentSessionEvent`.
  - For Jira, the community **`jira.js`** (v6.4, actively maintained) covers v3, `/search/jql`, OAuth 3LO and HMAC webhook verification, but has no ADF helpers.
- **Competitive context:** Linear now ships its **own cloud coding agent** (coding sessions, June 2026; BYOK, 2026-11-12). ostra's differentiators against it are self-hosting, your own runners and compute, and agent choice.

**Jira**
- **Endpoint changes.** REST v3 (ADF rich text) has replaced the old `/rest/api/3/search` with `/rest/api/3/search/jql`, which uses `nextPageToken` and requires bounded JQL. Points-based app rate limits took effect 2026-03-02. API-token traffic is exempt from these quotas.
- **Auth gotcha:** Atlassian's docs say apps that "collect API tokens or instruct customers to create individual 3LO apps" don't comply with its security requirements. That sentence targets vendors, and a self-hosted OSS tool is a grey area (**unverified** how Atlassian treats it).
  - **Recommended for ostra:** a customer-owned **service account** (scoped API token or OAuth 2LO client credentials), plus **admin webhooks** with an HMAC secret. Optionally, a customer-created 3LO app.
- **Webhook gotcha:** dynamic webhooks for OAuth apps expire after 30 days and need refreshing. They allow only 5 per app per user, a JQL subset and a subset of events, and a non-public app only receives them if the app owner registered them. Admin webhooks avoid all of this.
- **Statuses** are a per-workflow **transition graph** (transition IDs, screens, validators), not a free choice of state as in Linear.
- **Agents.** Jira now lets users assign work items to agents ("Agents in Jira", open beta 2026-02-24). Third-party agents plug in through a **Forge `rovo:agentConnector`** (A2A protocol). That route targets multi-tenant SaaS and requires a Forge app on Atlassian's platform, so it does not fit v1.
- **Connect** reaches end of support on **2027-01-31**. Don't build on it.
- **Data Center:** no new-customer sales since 2026-03-30, end of life 2029-03-28. Skip DC.

**Recommendation (for Q-11):** build **one Linear integration with two layers**.
1. **Always:** a plain API client that installs as an `actor=app` OAuth app through a manifest URL. It handles intake, status, comments, attachments and webhooks.
2. **Optional:** **Linear Agent mode**, adding `app:assignable` + `app:mentionable` + `AgentSessionEvent`, turned on when the deployment has a public HTTPS URL.

Agent mode is the best UX in Linear: delegation, the native session panel, stop and elicitation, and follow-up prompts that map onto ostra's reopenable tasks. But it adds strict latency rules, and it must degrade gracefully when the deployment isn't reachable.

---

## 1. Linear

### 1.1 GraphQL API

| Topic | Finding | Source |
|---|---|---|
| Endpoint | `https://api.linear.app/graphql` | [graphql](https://linear.app/developers/graphql) |
| Auth header | OAuth: `Authorization: Bearer <token>`. Personal API key: `Authorization: <key>` (**no** `Bearer`) | [graphql](https://linear.app/developers/graphql) |
| Schema | Introspection is enabled. Browsable schemas on Apollo Studio: [Linear-API](https://studio.apollographql.com/public/Linear-API/variant/current/home) and **Linear-Webhooks** (webhook payload types). Raw SDL in the SDK repo: `packages/sdk/src/schema.graphql`, about 1.58 MB / 46k lines, last updated by a release bot on 2026-11-11 ([commits](https://github.com/linear/linear/commits/master/packages/sdk/src/schema.graphql)). The agent docs point coding agents at this file. | [agent-interaction](https://linear.app/developers/agent-interaction), [SDL](https://raw.githubusercontent.com/linear/linear/refs/heads/master/packages/sdk/src/schema.graphql) |
| Webhook payload types | Included in the same SDL (e.g. `AgentSessionEventWebhookPayload`, `AgentActivityWebhookPayload`), so payloads can be code-generated too | SDL |
| Pagination | Relay-style: `first`/`after`, `last`/`before`, `pageInfo { hasNextPage endCursor }`, and `nodes` shortcut. Default 50, **max 250** per page (stated in SDL argument docs). `orderBy: createdAt` (default) or `updatedAt`. `includeArchived` argument on connections. | [pagination](https://linear.app/developers/pagination), SDL `Query.issues` |
| Filtering | Comparators: `eq`, `neq`, `in`, `nin`, `lt/lte/gt/gte`, `eqIgnoreCase`, `contains[IgnoreCase]`, `startsWith`/`endsWith` (and `not*` forms), `null: true/false`. Implicit AND, explicit `and: [...]` / `or: [...]`. Relation filters nest (e.g. `assignee: { email: { eq } }`). Many-to-many fields (labels) match **any** by default; `every` requires all. Dates accept relative ISO-8601 durations (`"-P2W"`). | [filtering](https://linear.app/developers/filtering) |
| `IssueFilter` fields relevant to intake | `team`, `state` (incl. `type`, `name`), `labels`, `assignee`, `delegate`, `creator`, `subscribers`, `project`, `projectMilestone`, `cycle`, `priority`, `estimate`, `parent`, `children`, `dueDate`, `createdAt`/`updatedAt`, `title`, `description`, `searchableContent`, `id` (accepts UUIDs **or identifiers like `ENG-123`**), `hasActiveAgentSessions`, `hasErroredAgentSessions`, `hasMergedAgentPullRequests`, `attachments`, `comments`, `releases`, `slaStatus` … | SDL `input IssueFilter`, `IssueIDComparator` |
| Rate limits (per hour) | API key: 2,500 requests/user, 3M complexity. OAuth app: 5,000 requests per user **or app user**, 2M complexity. Unauthenticated: 600/IP. Max **10,000 complexity per query**. Complexity: 0.1/property, 1/object, connections multiply by page size (default 50). Business plan 2×, Enterprise 5×. Workspace-level `actor=app` apps "can also get dynamic increases based on the number of paid users". Exceeding a limit returns HTTP 429, `RATELIMITED`, `Retry-After`. Headers `X-RateLimit-Requests-*`, `X-Complexity`, `X-RateLimit-Complexity-*`. | [rate-limiting](https://linear.app/developers/rate-limiting) |
| GraphQL subscriptions | The 2026-03-24 changelog says "GraphQL subscriptions can now be used with the API" and adds filtering on issue created/updated subscriptions. The SDL `Subscription` type includes `issueCreated/Updated`, `commentCreated/Updated`, `agentSessionCreated/Updated`, `agentActivityCreated`, `workflowStateUpdated` and more. **Unverified:** the WebSocket endpoint, protocol (`graphql-ws`?), which token types are allowed, and whether agent sessions are delivered to app tokens. None of this is in the developer docs. | [changelog 2026-03-24](https://linear.app/changelog/2026-03-24-introducing-linear-agent), SDL `type Subscription` |
| MCP | Linear runs an MCP server at `https://mcp.linear.app/mcp`. Runner-side agents could use it, but it needs its own auth. | [docs/mcp](https://linear.app/docs/mcp.md) |
| Docs index | Machine-readable docs index at [linear.app/llms.txt](https://linear.app/llms.txt). Any page can be fetched as `.md`. | — |

### 1.2 Authentication for a self-hosted app

**Options**

| Mode | How it's created | Identity | Lifetime | Fit for ostra |
|---|---|---|---|---|
| **Personal API key** | Settings → Account → Security & access. Can be restricted to permissions (Read, Write, Admin, Create issues, Create comments) and to specific teams. Admins can disable member key creation. | The key's user | No documented expiry | Quick start or dev only. Actions look like a human did them. Shares that user's 2,500 req/h quota. **Cannot publish agent activities** (SDL doc on `agentActivityCreate`). |
| **OAuth, authorization code, `actor=user`** (default) | OAuth app + per-user consent | The consenting user | Access 24 h; refresh 30 d, rotating | Optional: "act as me" for humans (e.g. a member's comment posted from the ostra UI) |
| **OAuth, authorization code, `actor=app`** | OAuth app + **admin** consent (workspace install) | The app's own workspace user ("User (via Application)" if `createAsUser` is set) | Access 24 h; refresh 30 d, rotating | **Primary recommendation.** Required for the agent platform. |
| **OAuth, client credentials** (`actor=app`) | Toggle "client credentials tokens" on the app, then `POST /oauth/token` with `grant_type=client_credentials` | App user, all public teams by default | 30 d, no refresh; re-request on 401 | Server-to-server with no redirect. **Unverified** whether `app:assignable`/`app:mentionable` (agent) scopes can be requested this way. |

Sources: [OAuth 2.0](https://linear.app/developers/oauth-2-0-authentication), [actor authorization](https://linear.app/developers/oauth-actor-authorization), [agents](https://linear.app/developers/agents), [API & webhooks (user docs)](https://linear.app/docs/api-and-webhooks).

**OAuth details that matter**
- **Endpoints:**
  - Authorize: `GET https://linear.app/oauth/authorize` with `client_id`, `redirect_uri`, `response_type=code`, `scope` (comma-separated), `state`, optional `prompt=consent`, `actor=user|app`, PKCE `code_challenge`.
  - Token: `POST https://api.linear.app/oauth/token`.
  - Revoke: `POST https://api.linear.app/oauth/revoke`.
- **PKCE:** supported. The S256 method has been required explicitly since 2026-10-08 ([changelog page 1](https://linear.app/changelog/page/1)). With PKCE, `client_secret` is optional on exchange.
- **Token rules:**
  - Refresh tokens: all OAuth apps were migrated to the refresh-token system on **2026-04-01**. A refresh returns a new pair. If the response is lost, the old refresh token can be retried within 30 min.
  - Rotating the client secret invalidates client-credentials tokens, but not authorization-code pairs.
  - A client-credentials request **replaces** an existing authorization-code installation, and vice versa after a revoke. Don't mix the two grant types.
  - About 1,000 client-credentials tokens are kept per app and workspace (asynchronous cleanup).
- **Scopes:**
  - General: `read` (always granted), `write`, `issues:create`, `comments:create`, `timeSchedule:write`, `admin`.
  - Agent: `app:assignable`, `app:mentionable`.
  - Data: `customer:read|write`, `initiative:read|write`.
  - `actor=app` installs **cannot request `admin`**.
  - Changing scopes on an existing installation: re-authorize with `update_scopes_on_existing_token=true` and the full scope set. Removing scopes requires a revoke and re-install.
- **Per-workspace identity:** query `viewer { id }` after install to get the app user's ID in that workspace, and store it next to the token. This is how ostra recognises its own actions in webhooks.
- **Who can create apps:** apps live under Settings → Administration → API, which is admin-only ([user docs](https://linear.app/docs/api-and-webhooks)). Linear recommends a dedicated workspace for app management, so all admins can reach it. For a self-hosted ostra, the team's own workspace is fine.

**OAuth app manifests (new, 2026-06-18): the key enabler for self-hosting**
- Linear's docs: manifests are "useful for … self-hosted or open-source projects that want to link to a pre-populated app configuration" ([oauth-app-manifests](https://linear.app/developers/oauth-app-manifests), [changelog page 2](https://linear.app/changelog/page/2)).
- **Two forms:**
  - URL parameters on `https://linear.app/settings/api/applications/new`, e.g. `distribution=private`, `oauth.client_name`, `oauth.client_uri`, repeated `oauth.redirect_uris`, `oauth.grant_types=authorization_code|client_credentials`, `webhook.url`, repeated `webhook.resourceTypes`.
  - A JSON manifest passed as `?manifest=` (schema at `https://linear.app/.well-known/oauth-app-manifest.schema.json`, `schemaVersion: "1.0.0"`).
- **Constraints:**
  - `client_name` must not contain "Linear".
  - Redirect URIs: 1–32.
  - `webhook.url` must be `https://` and **must not be a loopback or private-network host**.
  - **Scopes are not part of the manifest.** They are requested at authorize time.
- **Webhook resource types accepted in manifests:** `AgentSessionEvent`, `AppUserNotification`, `Attachment`, `Comment`, `Customer`, `CustomerNeed`, `Cycle`, `Document`, `Initiative`, `InitiativeUpdate`, `Issue`, `IssueLabel`, `IssueSLA`, `OAuthAuthorization`, `PermissionChange`, `Project`, `ProjectLabel`, `ProjectUpdate`, `Reaction`, `Release`, `ReleaseNote`, `User`.

> **Implication.** Proposed ostra setup flow:
> 1. The admin clicks "Connect Linear" in ostra. ostra opens the manifest URL pre-filled with *this deployment's* `https://<host>/integrations/linear/callback` and `/webhook`.
> 2. The admin clicks Create in Linear, then pastes the client ID, client secret and webhook signing secret into ostra.
> 3. ostra redirects to authorize with `actor=app` and the scopes.
>
> That is two copy-pastes and no central ostra app.

### 1.3 Webhooks

- **Three ways to create them:**
  1. Settings → API → New webhook (admin).
  2. The `webhookCreate` mutation (`url`, `teamId` or `allPublicTeams`, `resourceTypes`, optional `secret`). Only admins or OAuth apps with the `admin` scope can create or read webhooks, which rules out `actor=app` apps.
  3. **OAuth app webhook config:** set once on the app, then "each time a new organization authorizes the given application, a webhook will be created for that organization". **This is the path for ostra.** ([webhooks](https://linear.app/developers/webhooks))
- **Stream types:**
  - Manually created webhooks accept `Attachment, AuditEntry, Comment, Customer, CustomerNeed, Cycle, Document, Initiative, InitiativeUpdate, Issue, IssueLabel, IssueSLA, Project, ProjectLabel, ProjectUpdate, Reaction, Release, ReleaseNote, User` (SDL `WebhookCreateInput.resourceTypes`).
  - **Agent and app streams** (`AgentSessionEvent`, `AppUserNotification`, `PermissionChange`, `OAuthAuthorization`) exist **only on OAuth app webhooks**.
- **Actions:** `create` / `update` / `remove` for data changes. IssueSLA uses `set`/`highRisk`/`breached`. `OAuthApp` `revoked` fires when the app is de-authorized.
- **Payload:**
  - Fields: `action`, `type`, `actor` (User, OAuth client or Integration, so ostra can drop its own echoes), `data`, `updatedFrom` (previous values of changed fields), `url`, `createdAt`, `webhookTimestamp`, `webhookId`, `organizationId`.
  - Headers: `Linear-Delivery` (UUID per payload, use it for dedupe), `Linear-Event`, `Linear-Signature`, `Linear-Timestamp`.
- **Verification:**
  - `Linear-Signature` is a hex HMAC-SHA256 of the **raw body** with the webhook's signing secret.
  - Reject if `webhookTimestamp` is more than about 60 s old.
  - Optional source-IP allowlist (15 IPs listed on the [Security page](https://linear.app/docs/security), published as JSON, changes announced about 4 weeks ahead; new IPs were added 2026-09-14).
- **Delivery:**
  - Must be public HTTPS (not localhost), return HTTP 200 within **5 s**.
  - Retried **3 times** (1 min, 1 h, 6 h). Persistently failing webhooks "might" be disabled and need re-enabling by hand.
  - Agent delegation webhooks are also retried (since 2026-04-23, [changelog page 3](https://linear.app/changelog/page/3)).
- **Quotas:** 30 webhooks per team and 50 per workspace (2026-10-08, [changelog page 1](https://linear.app/changelog/page/1)).
- **No server-side filtering.** Linear webhooks have no filter expression, so ostra must evaluate intake rules on every `Issue` event itself.

### 1.4 Linear's agent platform ("Linear for Agents", Agent Interaction APIs)

**Status:** the docs show no preview banner except for **Agent Plans** ("technology preview"). Linear keeps extending the platform through 2026: the `continue` signal, the `stopping` status, multiple `externalUrls`, mention follow-ups and skills. Sources: [agents](https://linear.app/developers/agents), [agent-interaction](https://linear.app/developers/agent-interaction), [best practices](https://linear.app/developers/agent-best-practices), [signals](https://linear.app/developers/agent-signals), [AIG](https://linear.app/developers/aig).

**How an app becomes an agent**
1. Create an OAuth app (UI or manifest) and enable webhooks with the **Agent session events** category. "Inbox notifications" and "Permission changes" are optional.
2. Install with `actor=app` and scopes such as `read,write,app:assignable,app:mentionable`. **Admin permission is required** to install. The app's name and icon are how the agent appears in mention and assignee menus.
3. Store the per-workspace app user ID (`viewer { id }`).
- Agents "do not count as billable users", and development is free.
- **Directory listing is only needed for distributing to *other* workspaces.** Linear says it does not generally accept "scripts, low-effort/vibe coded or apps built by hobbyists" ([integration directory](https://linear.app/developers/integration-directory)). That doesn't matter for ostra: each team runs a **private** app in its own workspace.

**Delegation vs assignment**
- `app:assignable` lets the agent be chosen in the assignee menu. Choosing it sets `Issue.delegate` to the agent, **not** `assignee`, so a human keeps ownership.
- Agents cannot be project members or project leads.
- API: `issueUpdate(input: { delegateId })`, plus the `IssueFilter.delegate` filter (SDL).
- **Best practice:**
  - When delegated an issue that isn't in a `started`/`completed`/`canceled` state, move it to the team's **first `started` state** (lowest `position`).
  - If no delegate is set and the agent is doing implementation work, set itself as delegate.
  - If an *automation* delegated the issue, leave it in triage for a human.

**Agent Sessions**
- **Created** automatically on delegation or @mention (one session per comment thread). Can also be created proactively with `agentSessionCreateOnIssue` (creates a thread) or `agentSessionCreateOnComment` (on an existing root comment).
- **States:** `pending`, `active`, `awaitingInput`, `error`, `complete`, `stale` (docs), plus **`stopping`** (SDL only, undocumented). The state is **derived from the last activity**; agents don't set it.
- **Fields** (SDL `AgentSession`): `issue`, `comment`, `sourceComment`, `creator`, `appUser`, `status`, `plan`, `summary`, `externalLinks`, `url`, `startedAt`/`endedAt`, `dismissedAt`, and `activities(...)` (paginated, frozen snapshots; use these, not comments, to rebuild history).
- **Mutation `agentSessionUpdate(id, input)`:**
  - `externalUrls` (replace) or `addedExternalUrls`/`removedExternalUrls` (incremental): label + URL links, e.g. to the ostra task page and **the GitHub PR**. Linear says adding the PR URL "will unlock additional features related to pull requests in the future".
  - `plan`: a full array of `{content, status: pending|inProgress|completed|canceled}`, technology preview.
  - `summary`.
  - Updating a pending or stale session makes it active.

**Webhook `AgentSessionEvent`** (sent only to the addressed agent)

| `action` | When | Key payload fields |
|---|---|---|
| `created` | Delegation or mention starts a session | `agentSession` (`id`, `issue` with description, `comment`, `creator`, `status`, `url`), `promptContext` (pre-formatted XML-ish string with the issue, parent, project, labels, the directive thread, other threads and guidance), `previousComments`, `guidance[]` (workspace, parent-team or team rules such as preferred repos), `appUserId`, `oauthClientId`, `organizationId` |
| `prompted` | A user posts a follow-up in the session | `agentActivity.content` (user `prompt`), `agentActivity.signal` (e.g. `stop`), `signalMetadata`, `sourceCommentId` |

- Since 2026-09-24, "mentioning a third-party agent in a comment now sends a follow-up to its most recent available session on that issue (working or completed)" ([changelog page 1](https://linear.app/changelog/page/1)). That maps naturally onto ostra's **reopenable tasks** (D-011).
- **Enabling the category shows customers Agent Session UI immediately**, even if the receiver is only for debugging.

**Timing requirements**

| Requirement | Limit |
|---|---|
| Return the webhook HTTP response | within **5 s** |
| After `created`: emit an activity or set an external URL | within **10 s**, or the session is marked unresponsive |
| Ongoing activity | up to **30 min** between activities before the session is `stale` (recoverable by sending another activity) |

**Agent Activities** (`agentActivityCreate(input: { agentSessionId, content, ephemeral?, signal?, signalMetadata?, contextualMetadata? })`)

| Type | Who emits | Content | Notes |
|---|---|---|---|
| `thought` | agent | `body` (markdown) | Can be `ephemeral` (replaced by the next activity), which suits heartbeats and "running tests…" |
| `action` | agent | `action`, `parameter`, optional `result` | Tool call. Send "Searching" then "Searched" with a `result`. Can be ephemeral. |
| `elicitation` | agent | `body` | Asks the user and sets `awaitingInput`. Signals: `select` (options `[{label, value}]`), `auth` (`url`, optional `userId`, `providerName`: "Link account" prompt) |
| `response` | agent | `body` | Completes the turn, **unless** sent with signal `continue` (SDL only), which shows the message while staying active |
| `error` | agent | `body` | Records a failed turn |
| `prompt` | **user only** | `body` | Triggers `prompted`. Signal `stop`: the agent must stop immediately, then emit a final `response`/`error`. |

- `body` and `result` are up to 250,000 characters each (SDL).
- Plain Linear URLs in markdown render as mentions.
- Personal API keys can't publish activities. The SDL also mentions a "**workload identity token**" for agents (**unverified**: undocumented).
- **Other helpers:**
  - `issueRepositorySuggestions(issueId, agentSessionId, candidateRepositories[])`: an LLM ranks *your* candidate repos with confidence scores. Directly useful for Q-09.
  - `issueVcsBranchSearch(branchName)`: resolve an issue from a branch name.
  - Agent **skills** API (`agentSkillCreate/Update/Delete`) for Linear's *own* agent. Not relevant to ostra.
- **Other app webhooks:**
  - `AppUserNotification`: `issueMention`, `issueCommentMention`, `issueAssignedToYou`, `issueNewComment`, `issueStatusChanged`, reactions, etc.
  - `PermissionChange`: `teamAccessChanged` with `addedTeamIds`/`removedTeamIds`/`canAccessAllPublicTeams`.
  - `OAuthApp` `revoked`.

**How the Linear UI shows it** (from the [AIG](https://linear.app/developers/aig) and changelog):
- Agents carry an agent badge in user menus.
- An issue shows "delegated to <agent>" next to the human assignee.
- Each session is a panel or thread in the issue activity, showing thoughts, actions (expandable tool calls), elicitations with select or link-account buttons, the response, a plan checklist, external links and a "Send stop request" button. Session cards have status badges.
- My Issues has a **Delegated** section, and issue views can filter by agent session status (including Error).
- Sessions also appear on mobile.

**What's new in 2026** (from [changelog](https://linear.app/changelog) pages 1–3)

| Date | Change |
|---|---|
| 2026-03-24 | Linear Agent (Linear's own assistant) public beta. API: GraphQL subscriptions usable, `Team.parent` |
| 2026-04-01 | All OAuth apps moved to refresh tokens (24 h access) |
| 2026-04-23 | Agent delegation webhooks retried after a failed delivery |
| 2026-06-11 | **Coding sessions**: Linear's own cloud coding agent (uses Claude Code/Codex), AI credits |
| 2026-06-18 | **OAuth app manifests**; Vercel Eve (OSS agent framework) integrates as delegate/mention agents |
| 2026-08-20 | Coding environments, browser testing; sandbox $0.25 per 20 min plus model cost |
| 2026-09-24 | Mentioning a third-party agent follows up on its latest session on that issue |
| 2026-10-08 | Webhook quotas (30/team, 50/workspace); PKCE requires S256 |
| 2026-11-12 | BYOK for Linear's coding agent |

**Is the agent platform usable by a self-hosted app that each team registers itself? Yes.** Nothing in the docs requires directory listing, partner status or a paid plan. The requirements are:
1. A workspace **admin** to create and install the app.
2. A **publicly reachable HTTPS webhook URL** (not loopback or private network). A deployment behind a firewall needs a reverse proxy or tunnel, e.g. Cloudflare Tunnel or Tailscale Funnel.
3. A server that can answer within 5 s and emit a `thought` within 10 s **on its own**, without waiting for a runner, which may be an offline laptop.
4. A rate-limit budget: 5,000 req/h per app user is shared by *all* concurrent sessions, so tool-call streaming needs batching or ephemeral coalescing.

### 1.5 Issue model

| Concept | Linear | Source |
|---|---|---|
| IDs | `id` (UUID, stable). `identifier` (`ENG-123`), which **changes when the issue moves team**. `number`. `url`. | SDL `Issue` |
| Workflow states | Per **team**. `WorkflowState.type` is one of `triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`, `duplicate`. Names are customisable, and `position` orders them. **No transition graph:** `issueUpdate(stateId)` can set any state of the issue's team (**unverified** whether triage or other rules restrict any moves). | SDL `WorkflowState`, [best practices](https://linear.app/developers/agent-best-practices) |
| Assignee / delegate | `assignee` (human owner), `delegate` (agent) | SDL |
| Labels | `labelIds` (replace) or `addedLabelIds`/`removedLabelIds`. Label groups exist. Labels are team or workspace scoped. | SDL `IssueUpdateInput` |
| Description / comments | **Markdown** (`Issue.description`, `Comment.body`). `commentCreate { issueId, body, parentId (thread reply), createAsUser, displayIconUrl, quotedText }`, `commentUpdate`. A ProseMirror `documentContent` exists (alpha). | SDL |
| Sub-issues | `parentId` / `children` (one level per query; walk for deeper levels). Relations via `issueRelationCreate` (blocks, related, duplicate). | SDL |
| Attachments | Link-style "attachments" to external resources (below). File uploads go through a signed-URL flow ([how to upload](https://linear.app/developers/how-to-upload-a-file-to-linear.md)). | |
| Branch name | `Issue.branchName`: "a suggested Git branch name based on the issue's identifier and title and your branch naming preferences" | SDL |
| Other | `createAsUser` + `displayIconUrl` on `issueCreate`/`commentCreate`/`attachment*` (app actor only): show "Alice (via ostra)". Teams, projects, cycles, priority 0–4, estimates, SLAs. | [actor auth](https://linear.app/developers/oauth-actor-authorization) |

### 1.6 Linking PRs and branches

**Linear's own GitHub integration** ([docs](https://linear.app/docs/github))
- **Links by:**
  - The issue ID in the **branch name**.
  - The ID in the **PR title**.
  - **Magic words** plus the ID in the PR title or description. Closing words: `close(s|d)`, `fix(es|ed)`, `resolve(s|d)`, `complete(s|d)`, `implement(s|ed)`. Non-closing: `ref(s)`, `part of`, `contributes to`, `towards`. Relation only: `relates to`. `skip`/`ignore ENG-123` prevents linking.
  - Commit messages with magic words, which needs a webhook setup.
- **Status automations are per team:** draft PR opened, PR opened, review requested, ready for merge, merged. The defaults are In Progress on open and Done on merge. Target-branch rules (regex) are supported.
- One PR can link many issues, and one issue many PRs: status changes when the *last* linked PR reaches the state.
- Linear posts a **linkback comment** on the PR.
- **GHES:** supports PR and branch linking, but magic words only work in the description, and commit linking is not supported.
- **Unverified:** whether PRs authored by a GitHub App bot (an ostra bot) behave exactly like human PRs. The linking is content-based, so it probably does.

**Attachments API** ([attachments](https://linear.app/developers/attachments), SDL)
- `attachmentCreate { issueId, url, title, subtitle, iconUrl, metadata, groupBySource, commentBody, createAsUser }` is **idempotent by URL per issue**: the same URL updates the existing attachment.
- `attachmentLinkGitHubPR { issueId (UUID or "ENG-123"), url, linkKind: closes|contributes|links }`: "uses the matching GitHub integration when available; may fall back to a URL attachment".
- `attachmentLinkURL` fetches metadata. `attachmentsForURL(url)` gives the reverse lookup.
- Rich metadata (`title`, `messages[]`, `attributes[]`) renders a modal. Subtitles support `{var__since}` date placeholders.

**How ostra and the GitHub integration should interact** (recommendation)
1. Branch: use `Issue.branchName`, or any pattern that **contains the identifier**. The integration then links the PR on its own.
2. Put the identifier in the PR title (e.g. `ENG-123: …`) and `Closes ENG-123` in the body, as configurable defaults.
3. Always also call `attachmentLinkGitHubPR`. It is idempotent and works whether or not the integration is installed. In agent mode, also add the PR to the session's `externalUrls`.
4. **Status ownership:** if the team has the GitHub integration's automations on, ostra should only move the issue to the first `started` state on pickup. It should leave "In Review" and "Done" to the integration (per-team config: `status_driver = linear_github | ostra`). Otherwise both will fight.
5. Add an ostra-owned link attachment (`https://<ostra>/tasks/<id>`) with a status subtitle, so non-agent installs still get a "live" link on the ticket.

### 1.7 Rust options

| Option | Notes | Source |
|---|---|---|
| `lineark-sdk` 5.0.0 | Unofficial, MIT, generated from Linear's schema by a `lineark-codegen` crate, async. README documents API-key auth only, with no mention of agent sessions or webhook verification. About 8.6k downloads, 56 stars, updated 2026-11-17. | [crates.io](https://crates.io/crates/lineark-sdk), [GitHub](https://github.com/flipbit03/lineark) |
| `linear-api` 0.1.0 | Unofficial, API-key auth, 2026-07 | [crates.io](https://crates.io/crates/linear-api) |
| `linear_sdk` 0.0.1 | Abandoned (2022) | crates.io |
| **`graphql_client` 0.16.0** | Schema-first: `.graphql` query files + the SDL produce typed structs at compile time. Only the operations you write get generated, which keeps compile cost tied to usage. Very widely used. | [crates.io](https://crates.io/crates/graphql_client) |
| **`cynic` 3.14.0** | Code-first: Rust structs checked against a registered schema. `cynic-codegen` can pre-register the schema in `build.rs`; the `cynic-querygen` tool generates structs from queries. Strong typing of inputs and filters (useful for building `IssueFilter` from intake rules). | [crates.io](https://crates.io/crates/cynic) |
| `graphql-ws-client` 0.13.0 | WebSocket subscriptions client (works with cynic and graphql_client), if Linear subscriptions prove usable | [crates.io](https://crates.io/crates/graphql-ws-client) |

**Recommendation:**
- Own a thin client: `reqwest` plus either `cynic` or `graphql_client`, with the SDL vendored and pinned, and a CI job that diffs it against upstream.
- Hand-write or generate serde types for webhook payloads (they are in the same SDL), plus a small HMAC verifier.
- Don't depend on `lineark-sdk`: it is API-key oriented, with a single maintainer.
- **Spike:** compile time and ergonomics of cynic against a 1.6 MB schema, compared with graphql_client.

### 1.8 TypeScript option (in case ostra's core is TypeScript)

| Package | Maintenance (npm registry, 2026-11-17) | Webhooks | Agent APIs |
|---|---|---|---|
| **[`@linear/sdk`](https://www.npmjs.com/package/@linear/sdk)**: **official**, MIT, generated from the same SDL ([repo](https://github.com/linear/linear)) | v102.0.0 published 2026-11-11; 46 releases in 2026; about 4.3M downloads/week. Tracks the schema release-bot cadence. | `@linear/sdk/webhooks`: `LinearWebhookClient` with signature and timestamp verification and a typed handler for Express, Fastify or Bun. Typed payloads include `AgentSessionEventWebhookPayload`, `AppUserNotification…`, `AppUserTeamAccessChanged…` (PermissionChange) and `OAuthAppWebhookPayload`. Raw body required. ([sdk-webhooks](https://linear.app/developers/sdk-webhooks)) | Full: `createAgentActivity`, `agentSessionCreateOnIssue/OnComment`, `agentSessionUpdate`, typed activity content. The docs' examples and Linear's sample agent ([weather-bot](https://github.com/linear/weather-bot)) use it, and best practices require `@linear/sdk@^53`. A `@linear/sdk/oauth` entry also exports **DPoP** (RFC 9449) proof helpers, which the developer docs don't mention (**unverified** what they're for). |

**Takeaway:** in TypeScript, Linear has a first-party SDK covering everything ostra needs (queries, agent sessions, typed webhooks), with no codegen to maintain. In Rust, ostra would own a generated client (1.7). This is a real point in favour of TypeScript for the tracker layer.

---

## 2. Jira (enough for the abstraction)

### 2.1 Jira Cloud REST API v3

| Topic | Finding | Source |
|---|---|---|
| v2 vs v3 | Same operations; **v3 uses ADF** for comment bodies, worklog comments, `description`/`environment`, and textarea custom fields. Single-line text fields take plain strings. | [v3 intro](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/) |
| Base URLs | Basic auth (API token): `https://<site>.atlassian.net/rest/api/3/...`. OAuth 3LO, scoped tokens and service accounts: `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/...` (`cloudId` from `GET https://api.atlassian.com/oauth/token/accessible-resources`, or `<site>/_edge/tenant_info`). | [v3 intro](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/), [3LO](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/) |
| Spec | OpenAPI published at `https://dac-static.atlassian.com/cloud/jira/platform/swagger-v3.v3.json` (2.5 MB). Each operation lists classic and granular ("Beta") OAuth scopes. Rust: [`jira_v3_openapi`](https://crates.io/crates/jira_v3_openapi) (generated), [`gouqi`](https://crates.io/crates/gouqi) (hand-written). | spec |
| Search | `GET/POST /rest/api/3/search` is marked deprecated, "currently being removed". Use **`/rest/api/3/search/jql`**: <ul><li>`nextPageToken` (absent on the last page), so no random page access and no total</li><li>JQL **must be bounded** (`order by key` alone is rejected)</li><li>`maxResults` up to 5,000 when requesting only `id`/`key`</li><li>results are **eventually consistent**; `reconcileIssues` (≤ 50 IDs) gives read-after-write</li></ul>`POST /rest/api/3/search/approximate-count` returns counts. | spec, [RFC-61](https://community.developer.atlassian.com/t/rfc-61-evolving-search-capabilities-addressing-scalability-with-a-new-enhanced-search-api/83027) |
| Rate limits | **Points-based, enforced from 2026-03-02** for Forge, Connect and OAuth 3LO apps. <ul><li>Default "global pool": 65,000 points/h per app across tenants</li><li>Per-tenant tiers only by Atlassian review</li><li>Burst: GET/POST 100/s, PUT/DELETE 50/s</li><li>Per-issue writes: 20 per 2 s and 100 per 30 s</li><li>Headers: `Retry-After`, `X-RateLimit-*`, `RateLimit-Reason`</li></ul>**"API token-based traffic is not affected"** by the quotas (burst limits only). | [rate limiting](https://developer.atlassian.com/cloud/jira/platform/rate-limiting/) |

### 2.2 Authentication for a self-hosted app

| Option | Identity | Lifetime | Webhooks | Notes |
|---|---|---|---|---|
| **API token (unscoped)** | a user, Basic `email:token` | 1–365 days (default 1 year) | Can't register dynamic webhooks. Can create **admin webhooks** if the user is a Jira admin. | Works against the site URL. Atlassian wants new integrations to use **scoped** tokens. [Tokens](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/) |
| **Scoped API token** | a user or **service account** | 1–365 days | as above | Must use the `api.atlassian.com/ex/jira/{cloudId}` gateway |
| **Service account** | a bot account, no seat cost | API token, or **OAuth 2.0 client credentials (2LO)** with 60-min access tokens from `https://auth.atlassian.com/oauth/token` | **Unverified** whether 2LO can register dynamic webhooks (the docs say dynamic webhooks are for "Connect and OAuth 2.0 apps") | Created by an org admin in admin.atlassian.com. The page says it needs Atlassian Guard Standard or Enterprise, but also lists "Free: 5". Ambiguous, **unverified**. [Understand service accounts](https://support.atlassian.com/user-management/docs/understand-service-accounts/), [OAuth credential](https://support.atlassian.com/user-management/docs/create-oauth-2-0-credential-for-service-accounts/) |
| **OAuth 2.0 (3LO)** | the consenting **user** (there is no app-actor equivalent) | Access short-lived. Refresh tokens **rotate**, 90-day inactivity expiry, 10-min reuse window, need `offline_access`. | Dynamic webhooks (30-day expiry, see 2.3) | Created in the developer console. Private by default; "Sharing" lets others install via link. Consent picks **one site**. Admins can't revoke a single user's grant. [3LO](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/) |
| **Forge** | app | n/a | Forge triggers | Code runs on Atlassian's platform, deployed with the Forge CLI. Required for Marketplace and for `rovo:agentConnector`. |
| **Connect** | app (JWT) | n/a | descriptor webhooks | **End of support 2027-01-31** (moved from Dec 2026). New Marketplace apps have had to be Forge since 2025-09-17. The changelog also reports that updates to Connect apps were blocked from 2026-03-31 (**unverified**). [Private apps EoS](https://developer.atlassian.com/platform/adopting-forge-from-connect/connect-end-of-support-private-apps/), [changelog](https://developer.atlassian.com/platform/adopting-forge-from-connect/changelog/) |
| **"OAuth credentials" for self-hosted tools (2LO)** | system | client credentials | n/a | A Jira site admin creates these (Settings → Apps → OAuth credentials). **Only** for Dev Info, Builds and Deployments data. Fits self-hosted ostra exactly for pushing branches and PRs to the Development panel. [Self-hosted tools](https://support.atlassian.com/jira-cloud-administration/docs/integrate-with-self-hosted-tools-using-oauth/) |

**Policy gotcha.** The 3LO page says: "Apps that collect API tokens or instruct customers to create individual 3LO apps don't comply with our Security requirements for cloud apps and Acceptable use policy… Build a single, distributable 3LO app." ([3LO](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/))
- This targets vendors. For a self-hosted OSS tool, the "vendor" *is* the customer, and a shared distributable app would mean shipping one client secret to every deployment.
- A developer-community question asking exactly this (2025-09-05) has **no Atlassian answer** ([thread](https://community.developer.atlassian.com/t/clarification-on-oauth2-3lo-app-usage-for-saas-vs-on-premises-jira-cloud-integrations/95089)). **Unverified.**
- Customer-owned **service accounts** avoid the question entirely.

### 2.3 Webhooks

Source: [Jira Cloud webhooks](https://developer.atlassian.com/cloud/jira/platform/webhooks/), spec.

| | Admin webhooks | Dynamic webhooks (OAuth 2.0 / Connect apps) |
|---|---|---|
| Register | Jira admin UI, or `POST /rest/webhooks/1.0/webhook` with admin credentials | `POST /rest/api/3/webhook` (scopes `read:jira-work` + `manage:jira-webhook`) |
| Expiry | none documented | **30 days.** Refresh with `PUT /rest/api/3/webhook/refresh`. Expired webhooks stay refreshable for 3 months. |
| Limits | not documented | OAuth: **5 per app per user per tenant**. Connect: 100 per app per tenant. **One URL per app.** |
| Filter | full JQL | JQL subset: `issueKey`, `project`, `issuetype`, `status`, `priority`, `assignee`, `reporter`, `issue.property`, `cf[id]` (Epic only), with `=`, `!=`, `IN`, `NOT IN`. Optional `fieldIdsFilter`. |
| Events | all, including worklog, attachment, board and user | Subset: `jira:issue_created/updated/deleted`, `comment_created/updated/deleted`, `issue_property_set/deleted`, sprint and version events |
| Auth to receiver | optional secret: `X-Hub-Signature: sha256=<HMAC>` | `Authorization: Bearer <JWT signed with the app's client secret>` |
| Gotcha | — | **Non-public OAuth apps only receive webhooks when the app owner is the user who registered them** (spec note on `POST /webhook`) |

- **Delivery:**
  - At-least-once (duplicates possible). Use `X-Atlassian-Webhook-Identifier`, which is stable across retries, and `X-Atlassian-Webhook-Retry`.
  - Up to **5 retries**, at a random 5–15 min backoff, on 408/409/425/429/5xx or timeouts.
  - "Primary" deliveries within about 30 s; "secondary" (bulk) within 15 min.
  - Payloads over 25 MB are dropped.
  - `GET /rest/api/2/webhook/failed` lists webhooks that failed after all retries.
- **Payload:** `webhookEvent`, `timestamp`, `issue`, `user`, `comment`. `changelog` (field diffs) only on `jira:issue_updated`. Webhooks run "without a specific user context".

### 2.4 Issue model

**Workflows and transitions**
- Each issue type in a project maps to a workflow. Status changes go through **transitions**, whose IDs are workflow-specific: the same "In Progress" can have different transition IDs in different projects.
- `GET /rest/api/3/issue/{key}/transitions?expand=transitions.fields` returns, for the current issue and user, `id`, `name`, `to` (status with `statusCategory`), `hasScreen`, `isConditional`, `isGlobal`, `isAvailable` and required `fields`.
- `POST …/transitions { transition: { id }, fields, update }` performs one. Screens, validators and conditions can block it or require fields (e.g. a resolution). A multi-step path (To Do → In Progress → In Review) means several calls.
- `POST /rest/api/3/bulk/issues/transition` exists.
- **Reading the graph** (checked 2026-11-23 in the v3 OpenAPI spec, `swagger-v3.v3.json`, above):
  - `GET /rest/api/3/workflows/search` ("Search workflows") takes `projectId` ("only workflows associated with the given project are returned"), `expand=values.transitions`, `startAt`, `maxResults`, `queryString`, `scope` and `isActive`. It answers `values` (workflows, each with `statuses[].statusReference` and `transitions[]` of `id`, `name`, `type` `INITIAL`/`GLOBAL`/`DIRECTED`, `toStatusReference` and `links[].fromStatusReference`) and a top-level `statuses` list that maps each `statusReference` to the status's `id`, `name` and `statusCategory` (`TODO`, `IN_PROGRESS`, `DONE`).
  - `POST /rest/api/3/workflows` ("Bulk get workflows") takes `projectAndIssueTypes: [{ projectId, issueTypeId }]` and answers `{ workflows, statuses }` in the same shape: one issue type's workflow exactly.
  - Both: OAuth scope `manage:jira-configuration`, granular (Beta) `read:workflow:jira`. Permissions: "*Administer Jira* global permission to access all, including project-scoped, workflows", or "at least one of the *Administer projects* and *View (read-only) workflow* project permissions to access project-scoped workflows". Their 401 also covers a missing permission. Whether a service account's scoped token reads them is S-12.
  - The classic `GET /rest/api/3/workflow/search` is deprecated: "This will be removed on June 1, 2026 ([CHANGE-2569](https://developer.atlassian.com/cloud/jira/platform/changelog/#CHANGE-2569)); use Search workflows instead." `GET /rest/api/3/workflowscheme/project` stays, needs Administer Jira, and ignores team-managed projects.
- **Stable cross-workflow semantics come only from status *categories***: To Do / In Progress / Done (keys `new` / `indeterminate` / `done`; **unverified** this session because the spec examples show placeholder values).
- Company-managed vs team-managed projects differ in workflow and field configuration.

**ADF (rich text)**
- JSON `{ "version": 1, "type": "doc", "content": [...] }`.
- Block nodes: `paragraph`, `heading`, `bulletList`/`orderedList`/`listItem`, `codeBlock`, `blockquote`, `panel`, `table…`, `rule`, `expand`, `media*`, and others.
- Inline nodes: `text`, `hardBreak`, `mention` (by **accountId**), `inlineCard`, `emoji`, `date`, `status`.
- Marks: `strong`, `em`, `code`, `link`, `strike`, `underline`, `textColor`, `subsup`.
- JSON schema: `http://go.atlassian.com/adf-json-schema`, though the docs say it isn't authoritative. ([ADF structure](https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/))
- ostra must convert agent markdown to ADF. Atlassian ships no markdown converter. Rust has [`htmltoadf`](https://crates.io/crates/htmltoadf) (HTML to ADF), so markdown → HTML (comrak/pulldown-cmark) → ADF works, or ostra can emit ADF directly from pulldown-cmark events.

**JQL for intake**
- Examples: `project = ENG AND labels = ostra AND statusCategory = "To Do"`, `assignee = currentUser()`, `status changed to "Ready for Dev" after -1d`, `updated >= -5m`.
- Validate with `POST /rest/api/3/jql/parse`.
- Dynamic-webhook JQL is a small subset (see 2.3), so full rules must be checked by query or locally.

**Identifiers**
- `id` (numeric string, stable) and `key` (`ENG-123`, **changes when moved to another project**).
- Users are `accountId`s (emails are often hidden by privacy settings).

**Other**
- Comments have optional `visibility` (role or group).
- **Issue properties** (`PUT /rest/api/3/issue/{key}/properties/{propertyKey}`) can hold ostra metadata invisibly. 3LO apps can't make them JQL-searchable.
- Sub-tasks and hierarchy use `parent` (epics are a hierarchy level).
- Labels are free-form strings, and components are per project.

### 2.5 Linking dev work

- **Issue keys** (uppercase) in the branch name, commit message, or **PR title or source branch** link work in the Development panel, once an admin has connected GitHub through Atlassian's **GitHub for Atlassian** app. Linking can take minutes to sync. ([Reference work items](https://support.atlassian.com/jira-software-cloud/docs/reference-issues-in-your-development-work/))
- **Development Information API** `POST /rest/devinfo/0.10/bulk` (repositories, branches, commits, PRs with `issueKeys`, `updateSequenceId` ordering, 202 async). Callable by Connect (`jiraDevelopmentTool`), Forge (`devops:developmentInfoProvider`) or **self-hosted tools via admin-created 2LO "OAuth credentials"** (scope `write:dev-info:jira`). ([Dev info API](https://developer.atlassian.com/cloud/jira/software/rest/api-group-development-information/))
- **Remote links** `POST /rest/api/3/issue/{key}/remotelink { globalId, application, relationship, object: { url, title, summary, icon, status } }` upserts by `globalId`. This is the Jira equivalent of a Linear URL attachment: ostra's task link and the PR link.
- **Recommendation:** put the key in the branch and PR title (free when GitHub for Atlassian is installed), always add a remote link to the ostra task, and use Dev Info via 2LO credentials only when GitHub for Atlassian isn't installed (**spike**).

### 2.6 Atlassian agent framework (Rovo, "Agents in Jira")

- **Agents in Jira:**
  - Open beta announced 2026-02-24 ([press release](https://businesswire.com/news/home/20260224033792/en/Atlassian-Introduces-Agents-in-Jira-to-Drive-Human-AI-Collaboration-at-Enterprise-Scale)).
  - Users assign work items to agents through the agent picker, @mention them in comments, or attach them to a workflow transition or board column.
  - Agent output is **private to the invoking user until they share it as a comment**.
  - Consumes **Rovo credits**, with allowances enforced from 2026-12-03.
  - GitHub Copilot coding agent is "the first of many partner agents".
  - ([Collaborate with AI agents](https://support.atlassian.com/jira-software-cloud/docs/collaborate-on-work-items-with-ai-agents/))
- **Third-party integration is the Forge `rovo:agentConnector` module** (last updated 2026-10-09; no preview label). ([module](https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-agent-connector/), [guide](https://developer.atlassian.com/platform/forge/remote-agents-in-jira/))
  - Protocol: **A2A 1.0** over JSON-RPC (`SendMessage`, `SendStreamingMessage`, `GetTask`, `CancelTask`, `SubscribeToTask`).
  - Auth: Jira calls your remote with a Forge Invocation Token (verify via JWKS), optionally passing 4-hour system or user OAuth tokens for calling Jira back.
  - Invocations: `ISSUE_ASSIGNMENT`, `ISSUE_COMMENT_MENTION`, `ISSUE_WORKFLOW_ASSIGNMENT`, `ISSUE_MANUAL_TRIGGER`, `AUTOMATION`, chat.
  - Task states `SUBMITTED`/`WORKING`/`INPUT_REQUIRED`/`AUTH_REQUIRED`/`COMPLETED`/`FAILED`/`CANCELED`/`REJECTED`.
  - Timeouts: 55 s sync, 900 s streaming (auto-reconnect), 60 min for work-item triggers.
  - ADF is flattened to plain text for the agent.
- **Fit for ostra: poor for now.**
  - The guide says it "targets multi-tenant SaaS services, not on-premise deployments behind customer firewalls".
  - It needs a **Forge app** built and deployed by someone with the Forge CLI, installed per site.
  - Results aren't posted to the issue automatically.
  - Possible later: an "ostra connector" Forge app that each team deploys (`forge deploy` + `forge install`) pointing at its own ostra URL (**spike**).

### 2.7 Jira Data Center / Server (brief)

- **API:** REST **v2 only** (`/rest/api/2`, versioned docs such as [v10002](https://developer.atlassian.com/server/jira/platform/rest/v10002/)). Rich text is **wiki markup** strings, with no ADF. There is no `api.atlassian.com` gateway, no dynamic webhooks and no Forge.
- **Auth:**
  - **Personal access tokens** (`Authorization: Bearer`, Jira 8.14+, admin-capped expiry) ([PATs](https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html)).
  - OAuth 2.0 provider via incoming application links (auth code + PKCE, 2 h access tokens, scopes READ/WRITE/ADMIN/SYSTEM_ADMIN) ([DC OAuth](https://confluence.atlassian.com/adminjiraserver/jira-oauth-2-0-provider-api-1115659070.html)).
  - DC service accounts with client credentials ([overview](https://confluence.atlassian.com/enterprise/service-accounts-overview-1627095923.html)).
- **Webhooks:** admin-only (`/rest/webhooks/1.0/webhook`; 10.x docs also mention `/rest/jira-webhook/1.0/webhooks`). Asynchronous only since 10.0. No signing secret is documented. JQL filters are unreliable for comment events ([DC webhooks](https://developer.atlassian.com/server/jira/platform/webhooks/)).
- **Lifecycle:** no new DC subscriptions for new customers since **2026-03-30**. Existing customers can expand until 2028-03-30. **End of life 2029-03-28** ([Ascend](https://www.atlassian.com/blog/company-news/atlassian-ascend), [reminder](https://community.atlassian.com/forums/Atlassian-Migration-Program/Reminder-Upcoming-changes-to-Data-Center-products/ba-p/3210687)).
- **Telling it apart:** `GET /rest/api/2/serverInfo` "can be accessed anonymously", and on Cloud its `deploymentType` "is always returned as *Cloud*" (v3 OpenAPI spec, checked 2026-11-23). Server and Data Center answer `Server` or `DataCenter` there (**unverified** this session), and have no `/_edge/tenant_info`. ostra's connect step asks only `<name>.atlassian.net` hosts, so any other host reads as Data Center without a call (ticket 04).
- **Recommendation:** don't target DC. If it is ever needed, it is a separate adapter (v2 + wiki markup + PAT).

### 2.8 Client libraries (Rust and TypeScript)

| Package | Status | Notes |
|---|---|---|
| Rust: [`jira_v3_openapi`](https://crates.io/crates/jira_v3_openapi) 1.6.1 (2026-02), [`gouqi`](https://crates.io/crates/gouqi) 0.20.0 (2025-10) | Community | Generated from OpenAPI, or hand-written. Generating ostra's own client from the published OpenAPI spec is also feasible. |
| **TS: [`jira.js`](https://www.npmjs.com/package/jira.js)**, community (MrRefactoring), MIT ([GitHub](https://github.com/MrRefactoring/jira.js), about 490 stars) | v6.4.0 published 2026-10-27; 18 releases in 2026; about 870k downloads/week | Cloud platform v3, Agile, Service Management, Assets; Data Center 10.0+ via `createServerClient`. Auth: email + API token, bearer, **OAuth 2.0 3LO helpers with auto-refresh**; no Connect JWT in 6.x. Covers `/search/jql` (`searchForIssuesUsingJqlEnhancedSearch`) and dynamic-webhook refresh (`/rest/api/3/webhook/refresh`). `jira.js/webhooks` provides typed events, payloads and headers plus `verifyWebhookSignature` (HMAC `X-Hub-Signature`, i.e. admin webhooks). The source shows **no JWT verifier for dynamic OAuth-app webhooks**. **No ADF helpers.** (Checked in the 6.4.0 package source.) |
| TS ADF: [`@atlaskit/adf-utils`](https://www.npmjs.com/package/@atlaskit/adf-utils) (Atlassian, Apache-2.0, actively published), [`@atlaskit/editor-markdown-transformer`](https://www.npmjs.com/package/@atlaskit/editor-markdown-transformer) (Atlassian, MIT) | Official, but frontend-editor packages | ADF builders, validators and traversal. Markdown → ProseMirror, which still has to be serialised to ADF (**unverified**: how cleanly this works in Node). |
| Official Atlassian Node SDK for Jira REST | **None found** outside Forge (`@forge/api` only runs inside Forge apps) (**unverified**) | |

Jira has no first-party SDK in either language. `jira.js` is the de facto TypeScript client and is actively maintained.

---

## 3. Tracker abstraction proposal

### 3.1 Principles
1. **Opaque, stable IDs.** Store `{tracker_kind, workspace_id, issue_id}` (Linear UUID; Jira numeric id plus cloudId). Treat `ENG-123` keys as **display values that can change**, and refresh them from events.
2. **Semantic intents, not raw statuses.** ostra asks to "move to InProgress", and an adapter plus per-team config decides how: set a state in Linear, find and run a transition path in Jira.
3. **One rich-text IR.** ostra produces markdown (agents speak it). Adapters render to Linear markdown or Jira ADF, and parse ticket bodies back to markdown for prompts.
4. **Capabilities, not lowest common denominator.** The core trait is small, and optional features are discoverable capability objects.
5. **Events in, reconciliation always.** Webhooks are hints. A periodic reconcile query per intake rule catches missed or expired webhooks.
6. **Loop safety.** Every adapter can tell "this change was made by ostra" (Linear `actor.id == app user id`; Jira `user.accountId == service account`).

### 3.2 Core operations (every tracker)

| Operation | Linear | Jira Cloud |
|---|---|---|
| `connect` / `health` / `whoami` | OAuth `actor=app` token; `viewer { id }` | service account / 3LO; `GET /myself` + `cloudId` |
| `list_scopes` (teams/projects) | `teams` | `GET /project/search` |
| `get_ticket(id)`, body + metadata | `issue(id)` (description md, labels, state, assignee, parent, project, url) | `GET /issue/{id}?fields=…` (ADF → md) |
| `search(rule) -> stream<TicketRef>` | `issues(filter: IssueFilter)` | `/search/jql` with `nextPageToken` |
| `list_comments(id)` | `issue.comments` | `GET /issue/{id}/comment` |
| `post_comment(id, md, reply_to?) -> CommentRef` | `commentCreate` | `POST /comment` (ADF) |
| `update_comment(ref, md)` (a single "live status" comment) | `commentUpdate` | `PUT /comment/{id}` |
| `list_statuses(scope) -> [Status{id, name, category}]` | `workflowStates` by team | statuses + workflow per project/issue type |
| `move_to(id, intent)` | see 3.4 | see 3.4 |
| `add_labels` / `remove_labels` | `addedLabelIds`/`removedLabelIds` | `update.labels [{add}/{remove}]` |
| `upsert_link(id, url, title, subtitle, icon)` | `attachmentCreate` (idempotent by URL) | remote link (upsert by `globalId`) |
| `link_pull_request(id, pr)` | `attachmentLinkGitHubPR` | remote link (+ Dev Info if enabled) |
| `branch_name_hint(id)` | `Issue.branchName` | `KEY-123-slug` (key must be uppercase) |
| `parse_event(headers, raw_body) -> Vec<TrackerEvent>` (verify, dedupe ID) | HMAC + timestamp | HMAC (admin) / JWT (dynamic) |
| `ensure_subscriptions()` | no-op (app webhook) / check enabled | create or refresh webhooks; 30-day refresh job |

Normalised `TrackerEvent`: `TicketCreated`, `TicketUpdated { changed_fields }`, `TicketDeleted`, `CommentAdded`, `StatusChanged`, `AssigneeChanged`, `Revoked`, `PermissionChanged`, plus `Agent(AgentEvent)` from 3.3. Each carries `delivery_id`, `actor`, `occurred_at` and `raw`.

Illustrative shape (a design sketch, not implementation):

```rust
trait Tracker {                       // object-safe, async
    fn kind(&self) -> TrackerKind;
    fn capabilities(&self) -> &Capabilities;
    async fn get_ticket(&self, id: &TicketId) -> Result<Ticket>;
    async fn search(&self, q: &CompiledQuery, page: Option<Cursor>) -> Result<Page<TicketRef>>;
    async fn post_comment(&self, id: &TicketId, body: &RichText, reply_to: Option<&CommentId>) -> Result<CommentId>;
    async fn move_to(&self, id: &TicketId, intent: StatusIntent) -> Result<MoveOutcome>; // Moved | AlreadyThere | NeedsInput{fields} | NoPath
    async fn upsert_link(&self, id: &TicketId, link: &ExternalLink) -> Result<()>;
    fn parse_event(&self, headers: &Headers, raw: &[u8]) -> Result<Vec<TrackerEvent>>;
    // optional capabilities:
    fn agent_sessions(&self) -> Option<&dyn AgentSessions>;
    fn delegation(&self) -> Option<&dyn Delegation>;
    fn dev_info(&self) -> Option<&dyn DevInfo>;
}
```

### 3.3 Optional capabilities

| Capability | Linear | Jira Cloud | Notes |
|---|---|---|---|
| **NativeAgentSessions** (`start_session`, `emit(activity)`, `set_plan`, `set_external_urls`, receive `created`/`prompted`/`stop`) | ✅ Agent Sessions | ⚠️ only through a Forge `rovo:agentConnector` (A2A), not v1 | With it, ostra streams activities. Without it, ostra uses one updatable status comment plus a link. |
| **Delegation** (the ticket names the agent without changing the human owner) | ✅ `delegate` | ⚠️ agents appear in Assignee for Rovo/connector agents. Otherwise use a label or custom field. | Intake "delegated to ostra" = Linear `delegate.id = app`. |
| **Mention trigger** (a comment @-mentioning ostra starts or continues work) | ✅ `app:mentionable` | ⚠️ connector only. Otherwise parse comments for a keyword such as `/ostra`. | Q-12 |
| **Elicitation / approval UI in the tracker** | ✅ `elicitation` + `select` | ❌ (comment + reply parsing) | Q-13 |
| **Stop signal from the tracker** | ✅ `stop` | ❌ (keyword comment) | |
| **App identity** (acts as itself) | ✅ `actor=app` + `createAsUser` | ✅ with a service account; ❌ with 3LO (acts as the user) | |
| **Free status set** vs **transition graph** | free | graph | Drives the `move_to` implementation |
| **Native PR linking by branch/title** | ✅ (Linear GitHub integration) | ✅ (GitHub for Atlassian) | Adapter reports whether it is installed, if detectable (**spike**) |
| **Dev panel push** | ❌ (attachments instead) | ✅ Dev Info API | |
| **Push events: auto-registered** | ✅ app webhook per install | ⚠️ admin-created or 30-day dynamic | |
| **Push events: server-side filtering** | ❌ | ✅ (JQL subset) | |
| **Streaming subscriptions** | ⚠️ GraphQL subs (**unverified**) | ❌ | Could remove the public-URL requirement for the non-agent path |
| **Repo suggestion** | ✅ `issueRepositorySuggestions` | ❌ | Q-09 |
| **Hidden metadata on the ticket** | attachment `metadata` | issue properties | Store the ostra task ID |

### 3.4 Status: intents and mapping

ostra intents (proposal): `Picked` (optional), `InProgress`, `InReview`, `Done`, `Blocked` / `NeedsInput` (optional), `Canceled` (rare).

- **Config is per tracker scope** (Linear team, Jira project + issue type): `intent → target status`. Defaults are inferred from the category: Linear `started` with the lowest position goes to InProgress; Jira category `indeterminate` goes to InProgress.
- **Linear `move_to`:**
  1. Resolve the target state for the team.
  2. No-op if already there or "past" it (don't move a `completed` issue back to `started` unless reopening).
  3. `issueUpdate(stateId)`.
- **Jira `move_to`:**
  1. `GET transitions`, and pick the one whose `to.id` is the target (or whose `to.statusCategory` matches).
  2. If none, BFS over the workflow. The full graph needs `GET /workflows/search`, or ostra keeps hopping while each hop moves closer.
  3. If `hasScreen` with required fields, return `NeedsInput{fields}` and post a comment rather than failing the task.
- **Status ownership** (`status_driver`): when the Linear GitHub integration or Jira automation already moves statuses on PR events, ostra only performs `InProgress` on pickup.

### 3.5 Intake rules across trackers

The rule language is an ostra-level AST (stored as JSON/YAML), with an **escape hatch** for native queries:

```yaml
# illustrative config, not code
rule: "bugs labelled agent in ENG"
scope: { team: ENG }                # Linear team key / Jira project key
match:
  all:
    - label: { any: [agent] }
    - status_category: { in: [todo] }   # unstarted/backlog | new
    - assignee: { is: unassigned }
    - not: { label: { any: [no-agent] } }
  # or: delegated_to_ostra: true        # Linear delegate / Jira agent assignee (capability)
native:                             # optional, overrides match on that tracker
  jira_jql: 'project = ENG AND labels = agent AND statusCategory = "To Do"'
then: { repo: org/api, agent: claude-code, runner_pool: default, on_pick: InProgress }
```

| AST predicate | Linear `IssueFilter` | JQL |
|---|---|---|
| `scope.team/project` | `team: { key: { eq } }` | `project = KEY` |
| `label any/all/none` | `labels: { some/every: { name: { in } } }`, `none` via `not` | `labels in (...)`, `labels not in (...)` |
| `status_category` | `state: { type: { in: [...] } }` | `statusCategory in (...)` |
| `status name` | `state: { name: { eq } }` | `status = "..."` |
| `assignee is X / unassigned` | `assignee: { id: { eq } }` / `assignee: { null: true }` | `assignee = accountId` / `assignee is EMPTY` |
| `delegated_to_ostra` | `delegate: { id: { eq: appUserId } }` | capability-dependent |
| `priority <= n` | `priority: { lte, neq: 0 }` | `priority in (Highest, High)` (names are site-specific) |
| `project / cycle / sprint` | `project`, `cycle` | `"Epic Link"`/`parent`, `sprint in openSprints()` |
| `text contains` | `searchableContent` / `title: { containsIgnoreCase }` | `text ~ "..."` |
| `created/updated within` | `createdAt: { gt: "-P1D" }` | `created >= -1d` |

**Evaluation**
1. **Event path:** on each webhook, fetch the ticket (payloads may be partial or stale), then evaluate the AST **locally** in Rust. Linear webhooks have no filter, and Jira dynamic-webhook JQL is only a subset.
2. **Reconcile path:** every N minutes, compile the AST to `IssueFilter` or JQL and query the tracker. Native queries are only usable in this path, plus a "re-query by ID" check.
3. Picks are **idempotent** on `(rule, ticket_id)` and must also check that no active ostra task exists for the ticket.

### 3.6 Where a naive abstraction breaks

| Area | Linear | Jira | Consequence |
|---|---|---|---|
| Status | Any team state, settable directly. Types fixed (7). | Per-workflow transition graph; IDs differ per workflow; screens and validators; required fields | `move_to(intent)` returns an outcome, not a bool. Per-scope mapping config. |
| Rich text | Markdown in and out; mentions via URLs | ADF JSON; mentions need accountIds; v2/DC uses wiki markup | `RichText` IR plus per-adapter renderers. Never store tracker-native bodies as the source of truth. |
| Identifiers | UUID + `TEAM-n` (changes on team move) | numeric id + `KEY-n` (changes on project move); site `cloudId` | Key everything on stable IDs. Re-resolve keys for branch names. Old branch names may stop auto-linking (**unverified** for both). |
| Users | User UUIDs; app user per workspace; `delegate` separate from `assignee` | accountIds; emails often hidden | Map ostra members to tracker users through OAuth or explicit linking, not email. |
| Webhook registration | One app webhook auto-created per install | Admin webhooks (manual) or dynamic webhooks (30-day refresh, 5/user, owner-match rule) | `ensure_subscriptions()` plus refresh scheduler. Health UI shows the last event received. |
| Webhook auth | HMAC body + timestamp | HMAC `X-Hub-Signature` (admin) **or** JWT bearer (dynamic) | Per-adapter verifier |
| Delivery | 5 s timeout, 3 retries (up to 6 h) | 5 retries at 5–15 min; at-least-once; bulk events delayed up to 15 min | Durable inbox table, dedupe by delivery ID, async processing, reconcile loop |
| Payload completeness | Full entity plus `updatedFrom` | Issue plus `changelog` (updates only) | Re-fetch before acting |
| Search consistency | Immediate | Eventually consistent (`reconcileIssues`) | Don't treat "not in search" as "doesn't match" right after a write |
| Rate limits | Per user or app user (5k/h) + complexity | Points per app per hour (API tokens exempt); per-issue write limits (20/2 s) | Shared token bucket per tracker connection. Coalesce progress updates (edit one comment in place). |
| Identity of writes | `actor=app` (app) or user | 3LO = user; service account = bot | "Who did this" in audit; Q-10 analog |
| Hierarchy | parent/children (any depth), projects, cycles | sub-tasks, epics (hierarchy levels), sprints, components | Keep hierarchy out of the core; expose it as read-only context in prompts |
| Agent UX | Native sessions/activities | Comments (or A2A connector) | `Progress` sink abstraction: `AgentSessionSink` vs `CommentSink` |

---

## 4. Implications for ostra

### 4.1 Linear: plain API client, Linear Agent, or both? (Q-11)

| | Plain API client (`actor=app`, no agent scopes) | Linear Agent (`+app:assignable`, `+app:mentionable`, `AgentSessionEvent`) |
|---|---|---|
| Trigger | Intake rules (labels, states, …) and manual pick in the ostra UI | Plus **delegate** (pick "ostra" in the assignee menu), **@ostra** in comments, follow-up prompts in the session |
| Progress in Linear | Comments (one live status comment, edited in place) + attachment link | Native session panel: thoughts, tool calls, plan, PR link, stop button, elicitations |
| Steering from Linear (Q-12) | Comment parsing (a keyword such as `/ostra`) | First class: `prompted` events; mention follow-ups route to the latest session |
| Reachability | Webhooks need public HTTPS, **or** run polling or subscriptions only (works behind NAT) | **Requires public HTTPS** for `AgentSessionEvent` (manifest forbids private hosts) |
| Latency obligations | None beyond 5 s webhook ack | 5 s ack + **10 s first activity** + at least one activity per 30 min, handled by the *server* even when no runner is free |
| Rate budget | Light | Heavier: tool-call streaming to many sessions shares 5k req/h per app user. Needs coalescing and ephemeral activities. |
| Install | Admin (actor=app) | Admin (actor=app) + agent scopes |
| Risk | Low; stable APIs | Moderate: evolving surface (plans in preview, undocumented `continue`/`stopping`), but Linear clearly invests in it (Vercel Eve, Copilot, etc.) |
| Prompt injection (Q-14) | Ticket text from anyone with workspace access | Same, plus *any member* can directly instruct the agent through mentions and prompts. Needs per-user authorization: only linked ostra members can start runs (use the `auth` signal to link accounts). |

**Recommendation: both, in layers. They share one OAuth app and one installation.**
- **Phase 1 (v1 core):** a plain client installed with `actor=app` via the manifest flow. Intake rules plus manual pick, a live status comment, attachment and PR linking, status moves on pickup. Works for every deployment.
- **Phase 1b (v1, if the deployment has a public URL):** turn on agent mode. Add the agent scopes through re-authorization with `update_scopes_on_existing_token=true` and enable the `AgentSessionEvent` category.
  - Map ostra **Task ↔ the issue's agent session(s)** and ostra **Turn ↔ prompt/response**.
  - A `stop` signal cancels the run.
  - `elicitation`+`select` becomes the approval path (Q-13).
  - `externalUrls` = [ostra task page, GitHub PR].
- **Server-side "fast lane":** the ostra server (never the runner) acknowledges `created` with a `thought` ("Queued on runner pool X…") within 10 s. It emits ephemeral heartbeats during long runs, and an `elicitation` or `error` if no runner is available.
- **Who may trigger:** by default, only Linear users linked to ostra accounts can start agent runs. Others get an `auth`-signal elicitation ("Link your ostra account").

### 4.2 Setup flows (D-003: per-deployment credentials, easy)

**Linear** (about 3 minutes, admin):
1. ostra admin UI → "Connect Linear" → opens the **manifest URL**, pre-filled with this deployment's name "ostra (<host>)", the callback URL, the webhook URL and the resource types (`Issue`, `Comment`, `IssueLabel`, `Attachment`, `PermissionChange`, `OAuthAuthorization`, plus `AgentSessionEvent` and `AppUserNotification` for agent mode).
2. The admin creates the app and pastes the client ID, client secret and webhook secret into ostra (encrypted at rest).
3. ostra redirects to `authorize?actor=app&scope=read,write[,app:assignable,app:mentionable]` and stores the token pair and app user ID. A refresh job runs every ~12 h, since tokens last 24 h.
- **Fallback:** personal API key for local trials (no agent mode). Polling ≤ 1 req per 30 s per rule is well within 2,500 req/h.

**Jira Cloud** (later, admin):
1. Create a **service account** (or use a dedicated bot user) and grant it project access.
2. Create a **scoped API token**, or OAuth 2LO credentials, and paste it into ostra.
3. Create an **admin webhook** pointing at ostra (UI or REST), with a JQL filter and secret. ostra can create it itself if given Jira-admin credentials once.
4. Optional: "OAuth credentials" (2LO) for Dev Info if GitHub for Atlassian isn't installed.
- **Alternative for "act as me":** a customer-created 3LO app (see the policy grey area) with a dynamic-webhook refresh job.

### 4.3 Architecture consequences
- **Webhook ingress lives on the server**, never the runner. Verify, store in a durable `inbox` table (dedupe by `Linear-Delivery` / `X-Atlassian-Webhook-Identifier`), return 200 immediately, process asynchronously. Linear's 5 s timeout makes synchronous processing risky.
- **The public URL becomes a deployment question** for 05-architecture. Document reverse proxy, Cloudflare Tunnel or Tailscale Funnel. Without one: polling or subscriptions for intake, and no agent mode.
- **Reconciler:** periodic re-query per intake rule, plus a per-active-task status check. It covers missed webhooks, Linear disabling a failing webhook, and expired Jira dynamic webhooks.
- **Progress fan-out:** the runner's event stream (tool calls, messages) goes to the server, then to a tracker `ProgressSink`. Linear agent: coalesced activities (ephemeral `action`s, at most N/min per session). Comment mode: a single comment edited at most every ~30–60 s. Final summary as `response` or a final comment.
- **Ticket context for prompts:** in Linear agent mode, `promptContext` is ready-made (issue, parent, project, labels, threads, **guidance**). Otherwise ostra builds the same thing from the API. Workspace and team **guidance** in Linear is a natural place for repo and agent defaults (Q-09).
- **Rate budget:** one shared limiter per tracker connection, with priority lanes (acks and heartbeats > status > bulk reconcile).
- **Language choice:** the abstraction in section 3 maps one-to-one onto a TypeScript interface. If the core (or just the tracker layer) is TypeScript, use `@linear/sdk` (official; agent and webhook support built in) and `jira.js`. That removes the Rust codegen work (S-14) but still needs a markdown→ADF converter and a JWT verifier for Jira dynamic webhooks.
- **Competition:** Linear's built-in coding agent (cloud sandboxes, BYOK, inside the Linear UI) overlaps ostra's core loop for Linear-only teams. ostra's pitch is self-hosted compute, your own agents and runners, and tracker-agnosticism. Agent mode matters for UX parity.

### 4.4 Inputs to open questions
- **Q-09 (repo mapping):** use `issueRepositorySuggestions` with ostra's known repos, plus Linear guidance and team defaults. Ask through a `select` elicitation when confidence is low.
- **Q-10 (PR author):** Linear's `createAsUser`/`displayIconUrl` lets app-authored comments show "Alice (via ostra)". The same idea applies to bot PRs with a co-author.
- **Q-12 (steering):** Linear agent mode gives tracker-side steering for free. Jira would need comment parsing.
- **Q-13 (approvals):** Linear `elicitation` + `select` can carry "Approve running migration? Yes/No".
- **Q-14 (injection):** every tracker text field and every Linear prompt is untrusted input from any workspace member. Gate triggers by linked accounts, label agent-visible content, and keep runner sandboxing.

---

## 5. Unknowns / things to spike

| # | Question | Why it matters | How to test |
|---|---|---|---|
| S-1 | Can a **client-credentials** token request `app:assignable`/`app:mentionable` and receive `AgentSessionEvent`s? | Simpler, no-redirect setup | Test workspace: enable CC on an app and request agent scopes |
| S-2 | **Linear GraphQL subscriptions:** endpoint, protocol, auth, stability; do `agentSessionCreated`/`issueUpdated` reach `actor=app` tokens? | Could avoid the public-URL requirement for intake (and maybe agent mode) | `graphql-ws-client` against `wss://api.linear.app/graphql` (guess); ask in Linear's #api Slack |
| S-3 | Agent mode without a reachable webhook (e.g. agent category on, poll `agentSessions`)? Does Linear disable the app webhook after failures? | Agent UX behind NAT | Point the app webhook at a dead URL and observe |
| S-4 | Linear GitHub integration with PRs authored by a GitHub App bot: linking, status automation, linkback comment | PR ownership (Q-10) and status driver | Open a bot PR whose branch contains `ENG-1` |
| S-5 | `attachmentLinkGitHubPR` when the integration is installed vs not, and duplicate attachments when both link | Avoid duplicate links | Test workspace with and without the integration |
| S-6 | Throughput: activities per session per minute before 429s at 5k req/h; how ephemeral updates count | Progress-streaming design | Load test against a test workspace |
| S-7 | Undocumented SDL features (`continue` signal, `stopping` status, "workload identity token", `contextualMetadata`) | Avoid relying on unstable features | Watch the docs and changelog; ask Linear |
| S-8 | Does Linear still auto-link an old branch after the issue changes team (identifier change)? Same for Jira key changes. | Long-lived reopenable tasks (D-011) | Move the issue, push to the old branch |
| S-9 | Atlassian's position on self-hosted OSS tools where each customer creates its own 3LO app | Compliance of the Jira auth design | Ask in the Atlassian developer community or support; default to service accounts |
| S-10 | Service-account availability without Atlassian Guard (doc says Guard/Enterprise but also "Free: 5") | Jira setup friction | Try on a free Jira Cloud site |
| S-11 | Can 2LO service-account credentials register **dynamic** webhooks? If not, admin webhooks only. | Jira webhook setup | Call `POST /rest/api/3/webhook` with a 2LO token |
| S-12 | Jira transition-path finding: is the full workflow graph readable with service-account scopes (`/workflows/search`)? | `move_to` across multi-step workflows | Test on company-managed and team-managed projects |
| S-13 | Jira Dev Info via self-hosted 2LO credentials alongside GitHub for Atlassian: conflicts or duplicates? | Dev panel strategy | Push dev info for a repo also connected through GitHub for Atlassian |
| S-14 | `cynic` vs `graphql_client` compile time and ergonomics on Linear's 1.6 MB SDL | Developer experience, build times | Prototype both with ~20 operations |
| S-15 | Forge `rovo:agentConnector` as a per-team deployable "ostra connector" (forge deploy to own developer account, private install) | Jira agent parity later | Hello-world connector pointing at a public ostra URL |
| S-16 | Jira status category keys (`new`/`indeterminate`/`done`) and their stability | Default status mapping | `GET /rest/api/3/statuscategory` on a real site |
