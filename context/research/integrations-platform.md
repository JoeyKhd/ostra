# Research: an integrations platform, or official SDKs?

**Status:** Research v1 · **Checked:** 2026-11-18 (every source below was read on this date unless noted) · **Informs:** Q20 (rate limits), Q-20 (Jira sign-in), Q21 (copying modules), F-005, F-006, F-008, F-012, F-042, F-044, F-046 · **Builds on:** `research/trackers.md`, `research/platform-auth-github.md` (not repeated here)

Facts come from primary sources: licence files, source code, the npm registry and official docs. Third-party claims are labelled as such. Anything I could not confirm is marked **unverified**. The recommendations are marked as recommendations, not decisions. Adding any dependency still needs the maintainer's yes (AGENTS.md).

---

## Summary

- **No integrations platform fits ostra's rules.** Every hosted product, and every closed "Enterprise self-host" image, breaks ADR 0001. That covers Composio, Merge, Unified.to, Apideck, Pipedream Connect and Paragon. Using one means either a central vendor account, or every team buying its own. And every one of them that takes your own OAuth app sends the redirect to *the vendor's* host.
- **Nango is the only serious candidate, and it falls short.**
  - **The licence.** It's **Elastic License 2.0**, which is source-available and not open source. That includes the Node client (`@nangohq/node`).
  - **The free self-hosted edition** covers only **auth and the proxy**. The parts ostra needs most are Enterprise or Cloud only: syncs, webhooks, triggers and functions ([feature table](https://nango.dev/docs/guides/platform/self-hosting/self-hosting)).
  - **What free Nango would add:** a second Postgres, Redis, a second dashboard and a second encryption key. In return ostra gets OAuth flows and token refresh, which ostra can write in a few hundred lines.
  - **No Linear agent sessions.** Nango has no support for them.
  - **ELv2 and ostra's licences.** ELv2 can't be combined with the AGPL server or the Apache-2.0 adapter SDK. Its "no hosted service" clause also clouds ostra's paid hosted version.
- **None of the platforms supports Linear agent sessions.** Polling-backed "webhooks" can't meet Linear's 5 s / 10 s rules (ADR 0013).
- **None of them hands out per-task, repo-scoped GitHub App tokens either.** ostra needs those for its runners (`platform-auth-github.md` §2.4).
- **The official SDKs cover nearly everything, all under permissive licences:**
  - **`@linear/sdk`** (official, MIT):
    - typed agent sessions and activities
    - a webhook client that checks the signature and the timestamp
    - a typed rate-limit error
  - **Octokit** (MIT):
    - App auth with installation tokens scoped by repo and permission (`@octokit/auth-app`)
    - typed webhook verification (`@octokit/webhooks`)
    - `apps.createFromManifest` for the manifest flow
    - the throttling and retry plugins
  - **`jira.js`** (MIT, community, one maintainer) for Jira Cloud v3.
- **What ostra builds itself, whichever route it takes:**
  - the credential store
  - single-flight token refresh across processes, in Postgres
  - the durable webhook inbox
  - reconciliation (F-044)
  - idempotent writes (F-046)
  - a shared rate limiter (Q20)
  - the manifest-flow pages

  No candidate removes any of these, including Nango's free edition.
- **Cyrus** (Apache-2.0): a few pieces are worth porting with attribution under Q21:
  - its mapping of agent events to Linear activities
  - its Claude tool-call formatter
  - its webhook fixtures

  The rest is too coupled to reuse:
  - one 280 KB god class
  - hosted-proxy defaults
  - JSON-file state
  - a tracker interface shaped around Linear
- **There's no maintained GitHub App manifest-flow library.** It comes to about 100 lines on top of Octokit, with Probot's `setup.ts` as the reference.

**Recommendation:** official SDKs for all three integrations, behind ostra's own adapter interfaces. No integrations platform. Reconsider Nango only if ostra ever needs many more OAuth trackers than its maintainers can keep up with, and then only as an optional, separate container, after a legal read of ELv2.

---

## Comparison

### Fit with ostra's rules

| Candidate | Licence | Self-host | Your own OAuth app per install | Cost to a self-hosting team | Keeps ADR 0001? |
|---|---|---|---|---|---|
| **Nango, free self-hosted** | ELv2 (source-available) | Docker Compose: server, Postgres, Redis | Yes, the redirect goes to the install's own Nango URL | $0 | Yes, but auth and proxy only. ELv2 can't be combined with AGPL code |
| **Nango, Enterprise / Cloud** | ELv2 + commercial | Helm on Kubernetes, licence fee | Yes | Annual licence + usage | **No** |
| **Composio** | MIT SDKs, closed platform | Enterprise only | Yes (custom auth configs), but the redirect goes to Composio | Free tier, then $29/mo + usage | **No** |
| **Merge Ticketing** | Closed | Paid add-on (**unverified** terms) | One per Merge account, Merge's redirect | Free for 3 accounts, then $650/mo | **No** |
| **Unified.to** | Closed | Enterprise only | Yes, Unified's redirect | $750+/mo | **No** |
| **Apideck** | Closed | None found | Yes, Apideck Vault | €599+/mo | **No** |
| **Panora / Revert** (OSS unified APIs) | AGPL-3.0 | Yes | Yes | $0 | Yes, but both are **abandoned** (below) |
| **Pipedream Connect** | Source-available, no commercial use; closed runtime | No | Yes, Pipedream's redirect | $99–150/mo + usage | **No** |
| **Paragon** | Closed | Enterprise, licence checked against Paragon's cloud | Yes | Sales only | **No** |
| **`@linear/sdk`, `jira.js`, Octokit** | MIT | It's a library | Yes, ostra owns the flow | $0 | **Yes** |
| **Probot** | ISC | It's a framework | Yes | $0 | Yes, but it doesn't fit ostra's shape (below) |

### Capabilities

| Candidate | Linear | Linear agent sessions | Jira Cloud | GitHub App | Webhooks | Sync | TypeScript types | Maturity | Lock-in |
|---|---|---|---|---|---|---|---|---|---|
| **Nango, free** | OAuth + proxy | No | 3LO, API token, service account (token or 2LO) | APP mode mints installation tokens; per-task scoping not documented | **No** (Enterprise only) | **No** | Node client typed; ELv2 | Seed $7.5M (2026-04); `@nangohq/node` about 890k downloads/week | Medium: credentials sit in Nango's tables, under Nango's key |
| **Nango, Enterprise** | + pre-built syncs and actions | Raw webhook forwarding only | + HMAC admin webhooks; no JWT check for dynamic ones | + HMAC-checked webhooks | Yes, verified and routed | Yes, functions | Yes | as above | High |
| **Composio** | Tools + triggers | No | Tools + triggers | **Unverified** | Realtime or polling triggers | Polling triggers | Yes | Series A $25M (2025) | High |
| **Merge** | Common models | No | Common models | — | Fire after a sync | Stored copy; Linear tickets every 3 h on the top plan | Yes | Large vendor | High |
| **Unified.to** | Task, Project, Comment | No | + Change | **Unverified** | Native forwarded, or "virtual" polling (≥ 1 min) | Pass-through | Yes | Vendor | High |
| **Apideck** | Tickets, Comments, Tags | No | Same | — | Some native | Pass-through | Yes | Vendor | High |
| **Pipedream** | Apps + sources | No | Apps + sources | **Unverified** | Instant or polling sources | — | Yes | Workday-owned | High |
| **Paragon** | ActionKit, Managed Sync | No | Same | User OAuth only | Triggers | Every minute | Yes | Vendor | High |
| **`@linear/sdk`** | Full GraphQL | **Yes** (official) | — | — | `LinearWebhookClient`: HMAC + 60 s timestamp | ostra's own | Generated from the SDL | Official, weekly releases | Low (Linear is the dependency anyway) |
| **`jira.js`** | — | — | v3, Agile, `/search/jql`, 3LO refresh | — | HMAC helper for admin webhooks; no JWT verifier | ostra's own | Hand-written + Zod | One maintainer, about 871k downloads/week | Low |
| **Octokit** | — | — | — | Full: scoped tokens, manifest conversion, user tokens | `@octokit/webhooks`: HMAC + typed events | ostra's own | Generated from GitHub's OpenAPI | GitHub-maintained | Low |

---

## 1. Nango

**What it is.** It's an integration platform: an auth broker (OAuth flows, credential storage and token refresh), an authenticated **proxy** (with retries), plus "functions" (syncs, actions and webhook handlers written in TypeScript) that run in Nango's runtime. It's TypeScript throughout.

**Licence**
- The repository is **Elastic License 2.0** ([LICENSE](https://github.com/NangoHQ/nango/blob/master/LICENSE)). ELv2 permits use, modification and redistribution. It forbids "provid[ing] the software to third parties as a hosted or managed service", and it forbids working around licence-key functionality.
- **The client SDKs are ELv2 too.** `@nangohq/node` 0.72.6 (2026-11-16) and `@nangohq/frontend` 0.72.6 both say `Elastic-2.0`, and the CLI says "SEE LICENSE IN LICENSE FILE" ([npm @nangohq/node](https://registry.npmjs.org/@nangohq/node), [npm @nangohq/frontend](https://registry.npmjs.org/@nangohq/frontend)).
- **What this means for ostra** (my reading, not legal advice; **unverified**):
  1. Importing an ELv2 client into the **AGPL** server makes a combined work. AGPL §10 forbids adding further restrictions, and ELv2's no-hosting clause is one. Talking to Nango only over HTTP, as a separate container, avoids that.
  2. The **Apache-2.0 adapter SDK** (ADR 0009) couldn't depend on Nango without passing ELv2 on to third-party adapter authors.
  3. ostra's **paid hosted version** (ADR 0001) would run Nango for its customers. Whether that counts as "a hosted or managed service" offering Nango's features (its Connect UI, say) needs a lawyer.

**Free self-hosting versus Enterprise** ([self-hosting](https://nango.dev/docs/guides/platform/self-hosting/self-hosting), [free self-hosting](https://nango.dev/docs/guides/platform/free-self-hosting))

| Feature | Free self-hosted | Enterprise (BYOC / self-managed) or Cloud |
|---|---|---|
| API auth, proxy | Yes | Yes |
| Syncs, tool calls, triggers, **webhooks**, pre-built syncs, MCP server | **No** | Yes |
| Observability | Auth + proxy only | Full |
| RBAC, MFA, audit trail, custom branding | No | Yes |

- Nango describes the free edition as "intended for hobby projects and evaluation" (same page).
- Enterprise self-hosting runs on Kubernetes through Helm. It's priced as "a fixed annual license fee plus usage-based fees". The stack has five Node services (server, orchestrator, jobs, runner, persist) plus Postgres, **Redis** ("token refresh locks, rate limits"), Elasticsearch and object storage ([docs mirror on Mintlify](https://nangohq-nango.mintlify.app/platform/self-hosting); a third-party summary gives 1 CPU and 2 GB per service, and Postgres 2 CPU, 8 GB and 128 GB: [exploreai](https://www.exploreai.directory/open-source-alternatives/nango), **unverified**).
- The free edition's [docker-compose.yaml](https://github.com/NangoHQ/nango/blob/master/docker-compose.yaml) runs:
  - `nango-db` (Postgres 16)
  - `nango-server` (image `nangohq/nango-server:hosted`, pinned to `platform: linux/amd64`, so ARM hosts would run it emulated; whether ARM images exist is **unverified**)
  - `nango-redis`
  - optionally Elasticsearch

  Whether the server needs Redis in free mode is **unverified**: the compose file passes it no Redis variable.
- **Operational notes from the free-hosting docs:**
  - The encryption key can't be changed once it's set.
  - The proxy's URL override can reach hosts that weren't meant to be exposed, such as cloud metadata services or localhost (SSRF).
  - The docs mirror says the dashboard is open to anyone who can reach it until basic auth is set ([mirror](https://www.mintlify.com/nangohq/nango/platform/self-hosting)).
- **Against ostra's rules:**
  - It adds a second Postgres or database, plus Redis. ADR 0017 is Postgres only.
  - It adds a second admin UI and a second secret that operators must never lose.
  - It adds its own required settings (instance URL, encryption key, dashboard credentials, database URLs), which strains the "fresh install with only the required settings" rule.

**Linear, Jira and GitHub in Nango** ([providers.yaml](https://github.com/NangoHQ/nango/blob/master/packages/providers/providers.yaml), read 2026-11-18)

| Provider key | Auth mode | Notes |
|---|---|---|
| `linear` | OAuth2 | `prompt: consent`. The proxy retries on `400`, `5xx`, `401` and `429`. Webhook routing goes to connections by `organizationId`. No `actor=app` by default. Connect sessions accept per-integration `authorization_params` ([API](https://nango.dev/docs/reference/backend/http-api/connect/sessions/create)), so `actor=app` should be possible (**unverified**). |
| `jira`, `jira-basic`, `atlassian-service-account-api-token`, `atlassian-service-account-oauth2` (`OAUTH2_CC`), `jira-data-center*` | 3LO, Basic, service account | Covers the auth that `trackers.md` §2.2 recommends. But a service-account API token never needs refreshing, and 2LO is one token request an hour, so Nango adds little here. |
| `github-app` (`APP`), `github-app-oauth` | App JWT → installation token, plus user OAuth | The token URL is `…/app/installations/{id}/access_tokens`. Nango's guide describes tokens "scoped to the org/repo permissions granted at install time" ([guide](https://nango.dev/docs/api-integrations/github-app-oauth/how-to-register-your-own-github-app-api-oauth-app)). I found no option for **per-task repo or permission scoping**, which ostra's runners need (**unverified**). No manifest flow: the GitHub App is registered in Nango by hand. |

- **Webhook verification** in Nango's server (Enterprise and Cloud only):
  - Linear: HMAC over the raw body, **with no timestamp or replay check** ([linear-webhook-routing.ts](https://github.com/NangoHQ/nango/blob/master/packages/server/lib/webhook/linear-webhook-routing.ts)).
  - Jira: `X-Hub-Signature` HMAC when a secret is set. Otherwise it still routes the event and marks it unverified, and it has no JWT path for dynamic webhooks ([jira-webhook-routing.ts](https://github.com/NangoHQ/nango/blob/master/packages/server/lib/webhook/jira-webhook-routing.ts)).
  - GitHub: constant-time HMAC check ([github-app-webhook-routing.ts](https://github.com/NangoHQ/nango/blob/master/packages/server/lib/webhook/github-app-webhook-routing.ts)).
- **Pre-built Linear functions:** syncs for issues, teams, workflow states, users, labels, projects and cycles, and actions such as `update-issue` ([Linear page](https://nango.dev/docs/api-integrations/linear)). These are functions, so they're **not in the free edition**. None of them covers agent sessions.
- **Proxy retries and F-046.** A proxy that retries a `400` or a timed-out mutation can repeat a write. ostra would still need its own idempotency layer.

**Maturity**
- Founded in 2023, YC. It raised a $7.5M seed led by Gradient on 2026-04-01 ([blog](https://nango.dev/blog/nango-raises-7-5m-led-by-gradient)), and the site shows about 13.2k GitHub stars.
- `@nangohq/node` had 61 releases in 2026, and about 890k downloads in the week 2026-11-10..16 ([npm downloads](https://api.npmjs.org/downloads/point/last-week/@nangohq/node)).
- Cloud pricing: free for 10 connections, then pay-as-you-go from $50/mo (third-party: [appstackbuilder](https://appstackbuilder.com/tools/nango), **unverified**).

**Verdict:** a good product aimed at SaaS vendors with many integrations. For ostra, the free edition saves only the OAuth dance and token refresh. In exchange it adds about three services, an ELv2 dependency, and no help with the hard parts: agent sessions, webhooks, sync, idempotency and scoped GitHub tokens. **Reject for v1.**

## 2. Composio

- **What it is.** A tool-calling and auth layer for AI agents: 1,000+ toolkits with per-user OAuth and triggers. It isn't a tracker sync engine.
- **Licence and hosting:**
  - The SDK, CLI and toolkits repo is MIT ([LICENSE](https://raw.githubusercontent.com/ComposioHQ/composio/master/LICENSE)), and `@composio/core` 0.30.0 (2026-11-17) is ISC.
  - The platform is closed: credential store, execution and catalogue.
  - Self-hosting is an Enterprise arrangement with Helm (summary of Composio's docs at [aipotluck](https://www.aipotluck.org/org/composio); a competitor says the charts pull closed, licence-bound images: [Nango blog](https://nango.dev/blog/best-self-hosted-api-integration-platforms-for-ai-agents), **unverified first-hand**).
- **Your own OAuth app:** yes, through "custom auth configs", which can be created per customer in code ([custom auth configs](https://docs.composio.dev/docs/auth-configuration/custom-auth-configs), [programmatic](https://docs.composio.dev/docs/auth-configuration/programmatic-auth-configs)). The redirect goes to Composio's callback, and the tokens live in Composio's cloud. GitHub App installation tokens: **unverified**.
- **Triggers:** one signed webhook per project. Each trigger is either realtime or polling with a `pollingInterval` ([triggers](https://docs.composio.dev/docs/triggers)). Linear triggers exist, and Jira's were added recently ([blog](https://composio.dev/blog/build-reactive-integrations-with-webhook-triggers)).
- **Pricing:** Hobby is free (100K calls and 50K trigger events a month). Pro is $29/mo plus usage ([pricing](https://composio.dev/pricing)).
- **Maturity:** a $25M Series A, July 2025 ([Yahoo Finance](https://finance.yahoo.com/news/composio-raises-29m-solve-ais-130000885.html)).
- **Verdict:** wrong layer, cloud-bound, and it breaks ADR 0001. **Reject.** If agents ever need extra tools, the agent side has MCP, such as Linear's own server (`trackers.md` §1.1).

## 3. Unified ticketing APIs

All of these normalise tickets across trackers. **None supports Linear agent sessions, Linear delegation or Jira transitions as first-class objects.** None is self-hostable without a paid Enterprise contract, and each stores or proxies credentials in its own cloud.

**Merge.dev Ticketing**
- **Hosting:** closed SaaS. The pricing page lists "Self-hosted option: available for purchase" ([pricing](https://www.merge.dev/pricing/unified); terms **unverified**).
- **Coverage:**
  - Linear and Jira, including Data Center and JSM, as common models: Ticket, Comment, Attachment, Collection, Tag, Team, User ([Linear](https://www.merge.dev/integrations/linear), [Jira](https://www.merge.dev/integrations/jira)).
  - The ticket status is a coarse enum ([Ticket object](https://docs.merge.dev/merge-unified/ticketing/common-models/tickets/the-ticket-object)).
  - Workflow states and transitions are reachable only through Remote Data or passthrough, and Remote Data needs Professional or higher ([remote data](https://docs.merge.dev/merge-unified/supplemental-data/remote-data)).
- **Sync** is a stored, polled copy. On the top plan, Linear tickets sync **every 3 h**, comments every 1–5 min, and lower plans daily ([Linear sync](https://docs.merge.dev/merge-unified/ticketing/integrations/linear)).
- **Webhooks:** Merge's own webhooks fire after a sync completes ([help](https://help.merge.dev/articles/4883145267-troubleshooting-webhooks)). Webhooks from the tracker into Merge need Professional or higher ([third-party webhooks](https://docs.merge.dev/basics/webhooks/third-party-webhooks)).
- **Your own Linear app:** one per Merge account, using Merge's redirect URI ([partner credentials](https://help.merge.dev/articles/10573779-linear-how-do-i-set-up-my-partner-credentials)).
- **Pricing:** free for 3 linked accounts, then $650/mo for up to 10 ([pricing](https://www.merge.dev/pricing)).
- **Verdict:** hours-stale data in paid SaaS. **Reject.**

**Unified.to**
- **Model:** real-time pass-through, with no stored copy. Its Task Management model is Project, Task and Comment, plus Change for Jira ([Linear](https://unified.to/integrations/linear), [Jira](https://unified.to/integrations/atlassianjira), [task API](https://unified.to/task)).
- **Webhooks:** native ones are forwarded. "Virtual" ones poll, at best every 1 min on paid plans ([blog](https://unified.to/blog/best_unified_api_for_task_and_project_management_integrations_in_2026)).
- **Hosting:** US, EU or AU cloud. On-prem only on Enterprise.
- **Pricing:** from $750/mo ([pricing](https://unified.to/pricing)).
- **Verdict:** the best-designed unified API here, but a paid cloud proxy. **Reject.**

**Apideck Issue Tracking**
- **Coverage:** 24 connectors, including Jira, Jira DC, Linear, GitHub and GitLab ([coverage](https://developers.apideck.com/apis/issue-tracking/coverage)). The resources are Collections, Users, Tickets, Comments and Tags. There's no status or transition resource ([product](https://www.apideck.com/issue-tracking-api)).
- **Hosting:** credentials live in Apideck Vault, hosted in the EU by default ([Vault](https://www.apideck.com/products/vault)). No self-hosting found (**unverified**).
- **Pricing:** from €599/mo ([pricing](https://www.apideck.com/pricing)).
- **Verdict:** **reject.**

**Others covering Linear and Jira, one line each:**
- **Truto:** priced per connector per year; on-prem "typically starts in the low six figures" ([Truto blog](https://truto.one/blog/best-unified-api-for-startups-with-limited-budget-2026-guide), the vendor's own claim).
- **Knit:** pass-through, price unpublished ([Knit](https://getknit.dev/integration/linear)).
- **Synqly:** security-focused ([Synqly](https://www.synqly.com/integration-partners/linear)).

All three: **reject.**

**Open-source unified APIs (checked by cloning, 2026-11-18)**
- **Panora** ([panoratech/Panora](https://github.com/panoratech/Panora)): AGPL-3.0. It has ticketing connectors for Jira, Linear, GitHub, GitLab, Zendesk and others. The last code commit was 2024-12-25, and only README edits followed, up to 2025-10-13. **Abandoned.**
- **Revert** ([revertinc/revert](https://github.com/revertinc/revert)): AGPL-3.0, with ticketing for Jira, Linear, ClickUp, Trello and GitHub. Its README says "Revert has joined Ampersand", and the last commit was 2025-10-13. **Abandoned.**
- Both prove the category can be open source, but neither is safe to build on. Their normalised ticket models are also shallower than ostra's tracker interface (`trackers.md` §3).

## 4. Pipedream Connect

- **Ownership:** Workday signed to acquire Pipedream on 2025-11-19 ([Workday](https://newsroom.workday.com/2025-11-19-Workday-Signs-Definitive-Agreement-to-Acquire-Pipedream)). That the deal closed is **unverified** from a primary source.
- **Licence:** the components repo is under the "Pipedream Source Available License v1.0", which bars commercial use, including any SaaS that "competes with… any other Pipedream products" ([LICENSE](https://raw.githubusercontent.com/PipedreamHQ/pipedream/master/LICENSE)). The runtime is managed only ([pricing](https://pipedream.com/pricing)).
- **Your own OAuth clients:** supported per project, each with its own Pipedream `redirect_uri` ([OAuth clients](https://pipedream.com/docs/connect/managed-auth/oauth-clients)).
- **Triggers:** per-user "event sources". Some are instant, others poll, such as `intervalSeconds: 900` on a GitHub source ([example](https://pipedream.com/apps/github/triggers/new-organization)).
- **Pricing:** $99–150/mo plus credits and per-user fees.
- **Verdict:** cloud only, with a restrictive licence. **Reject.**

## 5. Paragon

- **Self-hosting:** "only available on our Enterprise plan" ([on-prem](https://docs.useparagon.com/on-premise/hosting-paragon-on-premise)). It needs Kubernetes, Postgres, Redis, S3 and SMTP, and the licence is **checked against Paragon's cloud at boot and periodically** ([requirements](https://docs.useparagon.com/on-premise/system-requirements)).
- **Products:** ActionKit, Managed Sync ("every minute") and Workflows, with ticketing sync for Linear and Jira ([managed sync](https://www.useparagon.com/product/managed-sync/ticketing), [pricing](https://www.useparagon.com/pricing)). The GitHub integration takes a GitHub App's client ID and secret, but only for **user** OAuth ([GitHub](https://docs.useparagon.com/resources/integrations/github)).
- **Pricing:** sales only.
- **Verdict:** heavier to run than ostra itself, closed, and tied to a licence server. **Reject.**

## 6. The official-SDK route

### 6.1 `@linear/sdk` (Linear's own, MIT)

| Fact | Value | Source |
|---|---|---|
| Version | 102.0.0, 2026-11-11. 46 releases in 2026. ESM only (`type: module`), Node `^20.19 \|\| >=22.12` | [npm](https://registry.npmjs.org/@linear/sdk) |
| Usage | About 4.35M downloads/week (2026-11-10..16). Five maintainers on npm, all Linear staff | [downloads](https://api.npmjs.org/downloads/point/last-week/@linear/sdk), npm |
| Entry points | `.`, `./webhooks`, `./oauth` (DPoP signer) | package `exports` |
| Size | 8.5 MB unpacked. The type declarations are 3.7 MB + 1.6 MB | [unpkg listing](https://unpkg.com/@linear/sdk@102.0.0/?meta) |
| Agent platform | `createAgentActivity`, `agentSessionCreateOnIssue`, `agentSessionCreateOnComment`, `agentSessionUpdate`, `issueRepositorySuggestions`, `attachmentLinkGitHubPR` are all present | `dist/index.mjs` |
| Webhooks | `LinearWebhookClient.verify`: constant-time HMAC, then **always** checks the signed body's `webhookTimestamp` against a 60 s window. The separate `timestamp` argument is "Deprecated and ignored". Typed payloads include `AgentSessionEventWebhookPayload`, `OAuthAppWebhookPayload` and `AppUserTeamAccessChangedWebhookPayload` | [webhooks chunk](https://unpkg.com/@linear/sdk@102.0.0/dist/webhooks-DyX3tY_A.mjs), [d.ts](https://unpkg.com/@linear/sdk@102.0.0/dist/webhooks/index.d.mts) |
| Rate limits | It throws `RatelimitedLinearError` with `retryAfter`, the request and complexity limits, the remaining counts and the reset times, all parsed from the `X-RateLimit-*` headers. **It doesn't retry or throttle**: that's ostra's job | `dist/index.mjs` |
| Tokens | `new LinearClient({ accessToken })` takes a static token. There's no refresh hook, so OAuth (manifest, PKCE, rotating refresh) is ostra's | `dist/index.mjs` |

- **A gotcha: relation getters run a query each.** For example, `issue.assignee` runs `new UserQuery(...).fetch(id)`. Naive model traversal is N+1, and it burns the 5,000 req/h and complexity budget shared with agent-session streaming.
- **Recommendation:** use the SDK's exported typed documents, or ostra's own documents, through `client.client.request`, for anything on a hot path, and keep the model API for one-off calls.
- **Spike S-1:** whether this 5 MB of types typechecks under ostra's strict flags with `skipLibCheck: false`, and how much it costs `tsc`.

### 6.2 `jira.js` (community, MIT)

- **Version and usage:** 6.4.0, 2026-10-27, ESM, Node ≥ 22. One runtime dependency, `zod ^4.6.5`. 18 releases in 2026, about 871k downloads a week ([npm](https://registry.npmjs.org/jira.js), [downloads](https://api.npmjs.org/downloads/point/last-week/jira.js)).
- **Bus factor: one.** `mrrefactoring` is the only npm maintainer.
- **Coverage** is already in `trackers.md` §2.8:
  - v3, Agile and `/search/jql`
  - 3LO with auto-refresh
  - the dynamic-webhook refresh endpoint
  - an HMAC verifier for **admin** webhooks
  - **no JWT verifier for dynamic webhooks**
  - **no ADF helpers**
- **Fallback if it stalls:** generate a client from Atlassian's published OpenAPI spec (`trackers.md` §2.1). The adapter interface keeps that swap local.
- **ADF:** `@atlaskit/editor-markdown-transformer` 6.3.2 (MIT, markdown-it + ProseMirror) and `@atlaskit/adf-utils` 20.9.83 (Apache-2.0) are official, but `adf-utils` shipped **249 releases in 2026**. That's heavy churn for a server dependency. Weigh it against a small markdown → ADF serialiser written by ostra (spike S-6).

### 6.3 Octokit (GitHub's own, MIT)

| Package | Version (date) | What ostra uses it for |
|---|---|---|
| `@octokit/app` | 16.1.4 (2026-08-02) | App + webhooks + OAuth app in one object. Optional: ostra can compose the parts itself |
| `@octokit/auth-app` | 8.3.1 (2026-09-01), about 9.9M downloads/week | App JWT, and installation tokens narrowed with **`repositoryIds` / `repositoryNames` + `permissions`**. That's exactly the per-task `contents: write`, one-repo token. Caches up to 15,000 tokens in memory (toad-cache), or in a custom cache through `cache.{get,set}` ([README](https://github.com/octokit/auth-app.js#readme)). User-to-server token create, refresh and reset |
| `@octokit/webhooks` | 14.2.0 (2025-12-03) | `verify` / `verifyAndReceive` (HMAC-SHA256) and event types from `@octokit/openapi-webhooks-types` |
| `@octokit/plugin-rest-endpoint-methods` | 18.0.0 (2026-08-01) | Typed REST methods, including **`apps.createFromManifest`** = `POST /app-manifests/{code}/conversions` ([endpoints](https://unpkg.com/@octokit/plugin-rest-endpoint-methods@18.0.0/dist-src/generated/endpoints.js)) |
| `@octokit/plugin-throttling` | 11.0.5 (2026-08-01) | GitHub's best practices for primary and secondary limits, through `onRateLimit` / `onSecondaryRateLimit`. **Throttling across processes needs Redis** through Bottleneck ([README](https://github.com/octokit/plugin-throttling.js#readme)), and ADR 0017 rules Redis out |
| `@octokit/plugin-retry` | 8.1.1 (2026-08-01) | Retries server errors. Leave it off for non-idempotent writes unless they're guarded (F-046) |
| `octokit` (umbrella), `@octokit/rest` | 5.0.5, 22.0.1 (both 2025-10-31) | Not needed. Pick the plugins one by one |

Sources: the npm registry entries and [api.npmjs.org](https://api.npmjs.org/downloads/point/last-week/@octokit/auth-app). Every package is ESM.

- **Two consequences for ostra's shape:**
  - The core service runs as several copies (Q18), and Next.js is a second process (ADR 0016).
  - So token caches and limiters must either live in Postgres (through `auth-app`'s `cache` hook, encrypted) or sit behind the core service's queue. Per-process memory isn't enough.

### 6.4 Probot (ISC)

- **Version and maintenance:** 14.3.7, 2026-11-03. 8 releases in 2026, about 108k downloads a week, maintained ([npm](https://registry.npmjs.org/probot)).
- **Why it doesn't fit:**
  - It's a **framework**. It owns the HTTP server, logging (pino), config loading and one app per process.
  - ostra's App credentials arrive at runtime from the manifest flow, and webhooks land in ostra's durable inbox, not in handler callbacks.
  - Its manifest code writes credentials to `.env` and isn't exported (§8).
- **Verdict:** use the Octokit pieces it's built on, not Probot.

## 7. Cyrus's Linear agent code

[cyrusagents/cyrus](https://github.com/cyrusagents/cyrus), commit `2376d38` ("release v0.2.79", 2026-11-16), read from a shallow clone. Paths are relative to `packages/`.

**Licence and layout**
- The root [LICENSE](https://github.com/cyrusagents/cyrus/blob/main/LICENSE) is **Apache-2.0**, and so is the README.
- But the `package.json` files of `cyrus-ai`, `cyrus-cloudflare-tunnel-client` and `cyrus-config-updater` say **MIT**, and the rest have no licence field. There's no NOTICE file and no proprietary folder.
- **For ostra:** treat ported code as Apache-2.0. Keep the licence text, mark the changed files, and add a line to ostra's NOTICE. Apache-2.0 code can go into the AGPLv3 server and into the Apache-2.0 adapter SDK.
- The packages are published on npm as `cyrus-*` 0.2.79, among them `cyrus-edge-worker` (about 2.3k downloads/week) and `cyrus-linear-event-transport` ([npm](https://registry.npmjs.org/cyrus-edge-worker)).

**What it does, and what's worth taking**

| Area | Cyrus | Reuse for ostra |
|---|---|---|
| Webhook intake: `linear-event-transport/src/LinearEventTransport.ts` (8 KB, Fastify) | Uses `@linear/sdk`'s `LinearWebhookClient.verify` plus an optional IP allowlist. It's **pinned to `@linear/sdk` 64.0.0** (2025-11-15), calls `verify` without the timestamp, so no replay check runs there, and falls back to `JSON.stringify(body)` when the raw body is missing. It emits in-process with no durable inbox | **Don't copy.** Current `@linear/sdk` (102) always checks the timestamp. ostra writes the inbox itself (ADR 0011) |
| Default delivery mode | **Proxy mode** unless `LINEAR_DIRECT_WEBHOOKS=true`. Webhooks arrive through `cyrus-proxy.ceedar.workers.dev` and are checked with a non-constant-time bearer comparison. OAuth also defaults to that proxy ([constants.ts](https://github.com/cyrusagents/cyrus/blob/main/packages/core/src/constants.ts), [SELF_HOSTING.md](https://github.com/cyrusagents/cyrus/blob/main/docs/SELF_HOSTING.md)). `edge-worker/src/DeviceHeartbeat.ts` POSTs to `app.atcyrus.com` every 10 min when team credentials are set | **Avoid.** It conflicts with ADR 0001 and ADR 0021 |
| `core/src/security/WebhookIpValidator.ts` (7 KB) | Linear's IPs (as of 2026-09-15) and the published list URL `linear.app/.well-known/appspecific/app.linear.ips.json` | **Borrow the URL**, and fetch the list rather than hard-coding it |
| Activity sink: `edge-worker/src/sinks/LinearActivitySink.ts` (4 KB) + `IActivitySink.ts` | A thin wrapper over `createAgentActivity` / `createAgentSessionOnIssue`, with the `auth`, `select`, `stop` and `continue` signals | Idea only. ostra's `ProgressSink` (`trackers.md` §4.3) is the same shape |
| Event → activity mapping: `edge-worker/src/AgentSessionManager.ts` (59 KB, about lines 944–1313) | Ordinary tool calls become **ephemeral** `action`s. Todo and sub-task tools become non-ephemeral `thought`s or `action`s. The final result becomes a `response`, a failure an `error`. Also elicitation, and rate-limit notices as thoughts | **Port the rules, not the file.** They're well tested in production. Re-express them over ostra's ACP-shaped events (ADR 0018) |
| `claude-runner/src/formatter.ts` (19 KB, `ClaudeMessageFormatter`) | Formats Claude Code tool calls and results into Linear `action` / `parameter` / `result` text | **Port with attribution** (Q21). It needs adapting from Claude SDK messages to ACP `tool_call` updates (spike S-7) |
| `linear-event-transport/src/LinearMessageTranslator.ts` (17.5 KB) + 18 KB of tests | Webhook → internal message translation | **Reuse the test fixtures** as webhook samples |
| Timing rules | 5 s: reply 200 before processing. 10 s: `ActivityPoster.postInstantAcknowledgment` posts a fixed `thought`, awaited after repo routing (`EdgeWorker.ts` about line 5088). **No 30-minute anti-stale heartbeat found** (**unverified** that none exists). Stop: the first `stop` interrupts the turn, and a second within 10 s aborts (about line 5299). Mention and delegation are told apart by matching comment text (about line 5076) | Take the ideas: instant ack *before* routing, and the double-stop rule. Add the 30-minute heartbeat. Use the payload fields, not text matching |
| Token refresh: `LinearIssueTrackerService.ts` (28 KB) | Refreshes on a 401 and retries once. Single-flight through **static in-memory maps** | Idea only. ostra needs a Postgres lock, since Linear rotates refresh tokens and the core service runs as several copies (Q18) |
| Rate limits | No 429 or `RATELIMITED` handling found | Nothing to take |
| State | A JSON file, `~/.cyrus/state/edge-worker-state.json` | Not applicable (ADR 0017) |
| Tracker interface: `core/src/issue-tracker/types.ts` (`IIssueTrackerService`, 26 KB) | Re-exports `@linear/sdk` enums | **Don't use.** It's shaped around Linear, which would break adapter parity |

**Quality signals**
- **Settings:**
  - `tsconfig.base.json` has `strict`, `noUncheckedIndexedAccess`, `noImplicitReturns` and `noFallthroughCasesInSwitch`.
  - It doesn't have `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noPropertyAccessFromIndexSignature` or `noImplicitOverride`.
  - Biome runs with `noExplicitAny` and `noNonNullAssertion` turned off.
- **Code:**
  - `EdgeWorker.ts` is 280 KB and 8.3k lines.
  - There are 188 Vitest files.
  - Releases are frequent (v0.2.78 on 2026-11-12, v0.2.79 on 2026-11-16).
- **So:** ported code has to be retyped to ostra's rules anyway, which favours porting logic over vendoring files.

## 8. GitHub App manifest-flow helpers

- **No dedicated, maintained npm package** turned up in three npm searches ("github app manifest" and variants, 2026-11-18).
- **Probot** `src/manifest-creation.ts` (5 KB) + `src/apps/setup.ts` (8 KB):
  - builds the manifest from `app.yml`
  - checks `state` against a random setup token
  - calls the conversion endpoint
  - **writes the secrets to `.env`**
  - defaults the webhook URL to a smee.io channel

  It isn't exported (the package `exports` map has only `"."`). It's the best **reference** for the flow ([manifest-creation.ts](https://github.com/probot/probot/blob/master/src/manifest-creation.ts)).
- **Backstage** `@backstage/cli-module-github` (Apache-2.0): `GithubCreateAppServer.ts` (4.8 KB) runs a local Express server with an auto-submitting form, but with **no `state` check** that I could find. It's a CLI, not a library ([source](https://github.com/backstage/backstage/blob/master/packages/cli-module-github/src/commands/create-github-app/GithubCreateAppServer.ts)).
- **Octokit:** `@octokit/app` and `@octokit/oauth-app` have no manifest helper. The conversion is `octokit.rest.apps.createFromManifest({ code })` (§6.3).
- **Cyrus:** its manifest flow is only prose instructions in `skills/cyrus-setup-github/SKILL.md`. Its `GitHubAppTokenProvider.ts` (3 KB) mints installation tokens with `node:crypto`, without Octokit.
- **The same plain-form approach** is described by RunsOn ([blog](https://runs-on.com/blog/self-serve-github-app-registration-with-manifests)) and Atlantis (`platform-auth-github.md` §2.2).
- **What ostra writes**, about 100 lines:
  1. a page that POSTs the manifest JSON plus a random, single-use `state` saved in Postgres
  2. a callback that checks `state` and the one-hour window
  3. `createFromManifest`
  4. storage of `pem`, `client_secret` and `webhook_secret`, encrypted at rest
  5. a redirect to `https://github.com/apps/<slug>/installations/new`

  The setup page stays locked once it has run (`platform-auth-github.md` §2.2).

---

## Recommendation

This is a recommendation, not a decision. Every dependency named here still needs the maintainer's yes. ADR 0008 already counts `@linear/sdk` and Octokit among its reasons for TypeScript.

**Linear (v1): `@linear/sdk`, behind ostra's tracker interface**
- Use the SDK for:
  - the GraphQL API
  - agent sessions and activities
  - webhook parsing (`LinearWebhookClient.parseData` on the raw body, which checks the timestamp)
- Pin an exact version and upgrade on purpose. The SDK ships weekly, and Cyrus shows how far a pin can drift: 64 against 102.
- On hot paths, write ostra's own GraphQL documents and send them through `client.client.request`, to avoid N+1 relation fetches.
- **ostra builds:**
  - the manifest-URL setup and the OAuth code + PKCE flow, with `actor=app` (`trackers.md` §4.2)
  - rotating refresh, single-flight through a Postgres lock
  - a limiter driven by `RatelimitedLinearError` and the `X-RateLimit-*` / `X-Complexity` headers
  - activity coalescing
  - the server-side fast lane (ack within 10 s, heartbeat every < 30 min)
- **Port from Cyrus with attribution** (one Q21 ADR):
  - the event → activity mapping rules
  - the tool-call formatter, adapted to ACP
  - the webhook fixtures

**GitHub (v1): Octokit modules, no Probot**
- Use these modules:
  - `@octokit/core` + `@octokit/auth-app` + `@octokit/webhooks` + `@octokit/plugin-rest-endpoint-methods` + `@octokit/plugin-paginate-rest`
  - `@octokit/plugin-throttling` for its secondary-limit logic, within one process
  - `@octokit/plugin-retry` for reads only
- Per-task tokens come from `auth({ type: "installation", installationId, repositoryIds: [repo], permissions: { contents: "write" } })`, with the cache hook backed by Postgres, or minting confined to the core service.
- **ostra builds:**
  - the manifest flow (§8)
  - the durable webhook inbox with `X-GitHub-Delivery` dedupe and redelivery catch-up (`platform-auth-github.md` §2.2)
  - single-owner refresh of members' user tokens, which are single-use (ADR 0019; who owns it, better-auth or ostra, is `platform-auth-github.md` S5)
  - PR and comment idempotency (below)

**Jira (next release): `jira.js` + an ostra-owned ADF layer**
- Use `jira.js` for REST v3, `/search/jql` and admin-webhook HMAC.
- **ostra builds:**
  - a JWT verifier for dynamic webhooks, if those are used at all; service accounts plus admin webhooks are the default (Q-20, `trackers.md` §2.2)
  - the 30-day refresh job for dynamic webhooks
  - transition-path finding
  - markdown ↔ ADF
- The adapter boundary keeps a later swap to an OpenAPI-generated client cheap if `jira.js` stalls (its bus factor is one).
- **No platform changes Atlassian's policy question** (Q-20). Nango's Jira 3LO connection still needs a 3LO app that each customer creates.

**Later trackers (GitLab, Asana, …):** the same pattern, each tracker's official or most-used SDK behind the interface. Revisit Nango only if the tracker count outgrows what the maintainers can keep up with, and then only as an **optional, separate container**, with the ELv2 questions in §1 answered first.

### What ostra builds itself, whichever route it takes

1. **The credential store:** Postgres, encrypted at rest, team-scoped (ADR 0010).
2. **Token refresh:** single-flight per credential through a Postgres advisory or row lock. It covers Linear's rotating refresh (a 30-min retry window), GitHub's single-use user refresh, and Atlassian's rotating 3LO refresh (a 10-min reuse window).
3. **The webhook inbox:**
   - raw-body capture and per-adapter verification (Linear HMAC + timestamp, GitHub HMAC, Jira HMAC or JWT)
   - a durable insert, then the 200 response
   - dedupe by delivery ID
4. **Reconciliation (F-044):** a high-water mark per connection with an overlap window:
   - Linear: `updatedAt` filter + `orderBy: updatedAt`
   - Jira: `updated >=` JQL, which is eventually consistent
   - GitHub: PRs sorted by `updated`, plus webhook redelivery
5. **Idempotent writes (F-046):** an outbound operation log keyed by operation ID, plus check-before-write where the API has no idempotency key:
   - Linear: `attachmentCreate` is idempotent by URL
   - Jira: remote links upsert by `globalId`
   - GitHub: look up PRs by `head` before creating one, and put a hidden `<!-- ostra:op=… -->` marker in comments
6. **Rate limiting (Q20):** a limiter per provider and credential, shared by every core-service copy. Either the queue library's per-key limits, chosen under ADR 0017, or a token-bucket table. It's fed by each provider's headers, and tasks wait instead of failing.
7. **The setup flows:** the Linear manifest URL (F-005) and the GitHub manifest form (F-006).
8. **Capability declarations** per adapter (adapter parity, ADR 0013).

---

## Unknowns / spike

| # | Question | Why it matters | How to test |
|---|---|---|---|
| S-1 | Does `@linear/sdk` (5 MB of `.d.mts`) typecheck cleanly under ostra's flags with `skipLibCheck: false`? What does it cost `tsc` and the editor? | Strict typing end to end (ADR 0008) | Scratch package with ostra's tsconfig; time `tsc --noEmit` with and without the SDK |
| S-2 | Postgres single-flight refresh across several core-service copies and Next.js. Who owns GitHub user-token refresh, better-auth or ostra? | Single-use and rotating refresh tokens break on a race | Parallel refresh test against the test workspaces; read better-auth's `getAccessToken` (`platform-auth-github.md` S5) |
| S-3 | A shared rate limiter: the queue library's per-key limits, or a token-bucket table? How do 429s from Linear's complexity budget surface? | Q20, and agent-session streaming budget (`trackers.md` S-6) | Load test one Linear workspace and one GitHub installation |
| S-4 | `@octokit/auth-app` with a Postgres-backed `cache.{get,set}`: how many tokens get minted per task, and is there a mint limit? | Per-task scoped tokens on remote runners | Prototype minting for 50 parallel tasks |
| S-5 | `jira.js` 6.4 under ostra's strict flags, sharing one Zod 4 with ostra | Strict typing; dependency hygiene | Scratch package |
| S-6 | markdown ↔ ADF: the Atlaskit packages (weight, churn, Node use) against a small ostra serialiser | Jira comments and descriptions | Round-trip agent markdown samples |
| S-7 | Do Cyrus's activity-mapping rules and `ClaudeMessageFormatter` carry over to ACP `tool_call` / `tool_call_update` events? | Q21 port scope; ADR 0018 | Map one recorded ACP session onto Linear activities in the test workspace |
| S-8 | GitHub idempotency without keys: marker-based comment dedupe and `head`-based PR lookup under webhook replay and retried writes | F-046 | Failure tests (F-048): replay, kill mid-write, retry |
| S-9 | *Only if Nango is revisited:* `actor=app` through `authorization_params`; whether free mode needs Redis; ARM images; a legal read of ELv2 against AGPL and the hosted version | Keeping the door open for a long tail of trackers | Run the free compose against the test Linear workspace; ask counsel |
| S-10 | Cyrus: is there really no 30-minute anti-stale heartbeat? Does Linear mark a session `stale` during a long, silent tool call? | Timing rules (ADR 0013) | Run a 35-minute silent turn in the test workspace |
