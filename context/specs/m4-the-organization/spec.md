# Milestone 4: The organization

**Status:** spec, 2026-11-19. Tickets in `issues/`, one file each (`docs/agents/issue-tracker.md`). *Changed 2026-11-19: one organization per install in v1. The maintainer answered "sure" to the lead's proposal to move several organizations after v1 (F-134), since one team runs each install, with its clients as projects. F-049 keeps the isolation, with ticket 09 and its fixtures. Ticket 24 and the switcher's half of ticket 33 (now ticket 44) are `wontfix`, and the instance admin's accounts move to ticket 43 (section 1, "Not in").*
**Milestone:** 4 (`context/build-order.md`).
**Features:** F-002, F-003, F-087, F-049, F-073, F-080, F-037, F-108, F-109, F-110, F-111, F-098, F-104, and F-115 grown (its invite, reset and budget mails), and, added 2026-11-19, F-135 (model keys per project), F-136 (repos from several GitHub organizations) and F-137 (reasoning effort, tickets 56 to 63). Its demo signs in as milestone 1's default first admin, and the second member arrives through an invitation, not a seed.
**Decisions it builds on:** ADR 0003 (better-auth, invite-only sign-up, the reset link's sink), 0017 (Postgres only), 0025 (everything is an adapter), 0026 (organizations, projects and the access matrix), 0027 (a task across several repos), 0030 (no credential in the agent's container), 0035 (the event log records every tool call's input, for the audit; Insights aren't live), 0037 (background work), 0040 (the GitHub App and the independent-review check), 0042 (budgets, metering at the key proxy), 0044 (project memory), 0049 (profiles and their instructions channel), 0050 (notifications and email), 0052 (the verified GitHub link). **New for this spec:** ADR 0053 (members, invitations and several organizations), 0054 (the audit log and search), 0055 (budgets, spend and Insights), and amendments to 0027 (several repos in practice), 0040 (the check in practice) and 0044 (memory in practice). **Added 2026-11-19:** ADR 0065 (clients in one organization: keys per project and linked GitHub installations), with amendments to 0033, 0040, 0049 and 0055; and ADR 0066 (reasoning effort: the model's own levels, set over ACP, one level a turn), with amendments to 0018, 0033 and 0049, from `research/opencode-reasoning-effort.md`.
**Spikes it ports from:** 9 (`auth-foundation`: invite-only sign-up, the reset link's sink, the `owner` block, the isolation scenario), 4 (`github-app-and-git-proxy`: the independent-review evaluator and its local review harness) and 10 (`is-opencode-good-enough`: the audit's positive control), section 10. Product code never imports `spikes/`. A builder copies the code into the product's package and adapts it, with a one-line provenance comment (`// Ported from spikes/<spike>/<path>.`).
**Builds on milestones 1, 2 and 3** as they were built (`../m1-first-pr/spec.md`, `../m1-first-pr/demo.md`, `../m2-tickets-in/spec.md`, `../m3-step-in/spec.md`), not only as they were specified. Milestones 2 and 3 are being built while this spec is written. Where their code ends up different from their specs, this spec follows the code, and the ticket that meets the difference says so in its `## Comments`.

Terms follow `context/GLOSSARY.md`. Lifecycles follow `context/domain-model.md`.

---

## 1. What milestone 4 ends with

The maintainer's team works in several projects with their own access. Spend is visible and limited. Projects remember what they learned (`build-order.md`). Since 2026-11-19, one organization also serves several clients: each client's project spends only its client's model key and holds its client's repos (ADR 0065).

In more words: an organization admin invites people with a link, which ostra also mails, and each invitee signs up through it. Roles hold at two levels, and a restricted project is invisible to everyone it doesn't list. No record crosses into another organization, and a test proves it for every kind of record against a second organization its fixtures make. The audit log says who did what, and links to each task's event log, which holds every tool call's input. Members find any task by its ticket, repo, member, state or anything said or run in it. Each task, project and organization shows its spend; a monthly budget warns at 80% and stops new work at 100%; Insights show what the agents shipped and what it cost. Members write memory notes, agents receive an index of them and search the rest, and an agent's proposal reaches the next task once a member approves it. A task changes several repos at once and opens one linked PR per repo, and the `ostra/independent-review` check passes only when someone who didn't drive the task approves.

And, added 2026-11-19 from the maintainer's request (ADR 0065): the team that runs ostra is one organization, and each client is a project in it, or several. An organization admin gives each project its list of model providers, each provider being one client's key, so the `calculator` project uses client A's key, another project client B's, and neither can reach the other's: the server checks it at the dispatch, at the credentials endpoint and at every turn start, with no fallback. An agent profile names its model by name, so one profile works in every client's project on that project's key. A project holds repos from its client's own GitHub organization, through an installation of the organization's App that an admin linked, or through the client's own App connected beside it. v1 has one organization per install (several move after v1, F-134), so this is the whole answer for clients.

And, added 2026-11-19 from the maintainer's question, "it doesn't seem that our models have support for the reasoning effort towards opencode?" (ADR 0066). An agent profile sets how much its model reasons, from exactly the levels the model's catalog entry lists, and the agent gets the model's real context window and output limit instead of fixed ones. The task's driver changes the level on the task page, for the next turn, and each turn records the level it ran at and its reasoning tokens. A level a model doesn't have is clamped to its nearest, never an error.

### What milestones 1 to 3 leave that milestone 4 starts from

Read from the code on `main` on 2026-11-19, and from milestones 2 and 3's specs for what they add, so builders don't rebuild what exists:

- **The organization model is in place, with one member.** `Organization`, `Member`, `Invitation`, `ProjectMember` and `Project.access` (`open`, `restricted`) are in the schema. `packages/domain/src/access.ts` has `requireOrganizationAdmin`, `requireProjectAccess` (another organization's or a hidden project's record is `not-found`) and `visibleProjects`; `packages/api` has `memberProcedure`, `adminProcedure`, `projectProcedure` and `taskProcedure` on them. better-auth's organization plugin is configured with the two roles, a 7-day invitation expiry and the `owner` block (`packages/api/src/auth/create-auth.ts`), but sign-up is refused ("invitations come in a later release"). `organization.members` and `organization.setMemberRole` exist, the latter with the last-admin lock. The active organization is the member's first one (`firstOrganizationOf`). Milestone 3 adds `pnpm dev:seed-member` for development only.
- **The audit log is written, and nobody can read it.** `AuditEntry` rows are written in the transaction of the change, with about twenty actions (`task.created`, `task.stopped`, `task.driver-changed`, `task.credentials-issued`, `approval.answered`, `provider.added`, `pool.created`, `join-token.created`, `member.role-changed`, `organization.renamed`, …). Home reads recent activity from them. There is no viewer, no filter and no export.
- **The event log holds every tool call's input.** `tool.called` carries `input` as JSON, with typed shapes for `read`, `search` and `execute` (`packages/protocol/src/events/tools.ts`), as ADR 0035 requires. Nothing searches it.
- **Spend is per task, per session and per turn.** Milestone 2 prices `usage.recorded` on its four token kinds and sums it on the task and the session; milestone 3 adds it per turn. Nothing adds it up per project or per month. `Model` has input and output prices only, so the cache prices come from milestone 2's spend-cap prices in the task spec.
- **The sidecar already has ostra's MCP server.** `apps/runner/src/sidecar/mcp-tools.ts` serves `set_pull_request_text` over Streamable HTTP on loopback (`host`) or the box network (`docker`), behind a random bearer that grants one task's tools. Memory adds three tools to it.
- **Several repos are mostly wired.** The task spec's `repos` is a list; the git proxy, the MCP tool and `session.ended` work per repo; `agentCwd` starts the agent at the workspace root when there are several. Milestone 2's PR set rule (Q107) and milestone 3's per-repo diff, checks, update branch and fresh branch after a merge are per repo. **But a project has one repo:** project creation takes one, and nothing adds a second (F-086 is `building`).
- **The independent-review check has its parts.** The App asks for `checks: write` (ADR 0040); the GitHub adapter declares `checkRuns: true`; spike 4 wrote the evaluator; milestone 3 adds the verified GitHub link (F-119). Nothing publishes the check.
- **Providers and GitHub are per organization, not per client** (read 2026-11-19 for ADR 0065). A `ModelProvider` belongs to one organization and a `Model` to one provider, so a models.dev model two providers serve is two rows; an `AgentProfile` points at one `Model`; nothing ties a project to a provider, so a task can run on any of the organization's keys (`apps/core/src/dispatch/task-spec.ts` and `packages/domain/src/use-cases/issue-task-credentials.ts` read the provider through the profile). The App's manifest sets `public: false`, so only the App owner's account can install it. A `Repo` keeps its own connection and installation, and core's PR opener, reconcile and credentials use each repo's own, but `packages/api` finds the GitHub connection with one `findFirst` (`src/services/github-connection.ts`, `src/routers/github.ts`), lists every installation the App has, and adds repos from any of them. The task spec authors every repo's commits with the first repo's bot.
- **Notifications and email exist** (milestone 3): the panel, the ticket and email channels, Resend or SMTP, ostra's own templates, each member's choices. Their kinds stop at the needs-you moments.
- **Reasoning effort is advertised and never set** (read 2026-11-19 for ADR 0066, `research/opencode-reasoning-effort.md`).
  - OpenCode 2.3.2 advertises an `effort` option of category `thought_level` on every task, with levels it guesses from the API format. The catalog file the adapter writes has no `release_date`, so OpenCode skips it and treats the model as custom.
  - Nothing in ostra sets the option, so every turn runs at the endpoint's default.
  - Every model gets a 128,000-token window and a 16,000-token output limit (`packages/adapters/adapter-opencode/src/config.ts`), whatever the catalog says.
  - The bundled catalog and its refresh drop `reasoning` and `reasoning_options`, and the key proxy reads no reasoning tokens from Anthropic.

### What is in, and what is not

**In:** invitations by link and mail, sign-up through an invitation, address verification and self-service resets when email is set up, the instance admin's reset link without it, removing a member; roles at two levels with project access; the isolation test for every kind of record, against a second organization made from fixtures, and the instance admin's Accounts page; the audit log with filters and export, and the task's event log view; search in a palette and a page; spend per task, project and organization, model prices with cache prices, monthly budgets with their 80% and 100% notices and the gate; Insights per organization and project; memory notes for organizations and projects, the index and the memory tools for agents, proposals from agents and from "Remember this" on diff comments and `@ostra` comments, the closing-turn switch; several repos per project and per task, with linked PRs; the `ostra/independent-review` check. Added 2026-11-19: provider lists per project with the organization's default, the model by name on profiles, one provider per model per project, the checks at the dispatch, the credentials and every turn start, spend per key; linked installations, an App other accounts may install, a client's own App beside the organization's, a bot per repo. Added 2026-11-19 with F-137: each catalog model's reasoning controls, a custom model's set by an admin, a profile's level, a task's level changed for the next turn, each turn's level and reasoning tokens, the model's real limits in the agent's config, and the `reasoningEffort` capability.

**Not in** (and when it comes):
- several organizations per install: the instance admin creating more, a member in several with the switcher, links across organizations and the instance's Organizations page: F-134, after v1 (2026-11-19, the maintainer's "sure" to the lead's proposal: one team runs each install, with its clients as projects). Tickets 24 and 44 (44 split from 33) are `wontfix`, and the targets `org-switcher` and `instance-settings`' Organizations page are postponed. F-049 keeps the isolation (ticket 09)
- "Remember this" on an AI review finding: F-100, milestone 6. F-111 stays `building`
- runner pools per project and join-token rules beyond milestone 1's: F-091, milestone 5. F-086 stays `building` for its pool list
- budgets per member and per agent profile: F-131, after v1
- automatic rounds (the CI loop, review rounds): F-035, F-101, milestone 6. The budget gate takes their origin from the start, and its test calls it
- SSO, SCIM, custom roles: F-004, after v1
- repo and path scopes for memory, staleness checks, "Promote to repo": F-129, after v1
- vector search: F-129, only if full-text proves too weak (ADR 0044)
- another currency, or a budget month in an organization's time zone (ADR 0055)
- reviewers and the review screen: F-102, milestone 6. The independent-review check reads GitHub reviews, not ostra's reviewer list
- a budget per model provider, two keys for one model in one project, a provider pinned on a profile: not in v1 (ADR 0065)
- a member's own model provider: F-128, after v1
- a reasoning level chosen on the New task page, a thinking budget typed in tokens, and a level changed during a running turn: not in v1 (ADR 0066). Pricing reasoning tokens apart from output is a later addition to F-037's prices

### On this machine

The same adjustment as milestones 1 to 3: the demo runs on the `host` executor, on a personal runner, and a "box" is a worktree. Nothing in milestone 4 needs Docker to finish. The `docker` executor's share (two repos in one box, the memory tools on the box network) is unit-tested against the fake engine and joins F-017's live run on the Linux machine; no row of this milestone waits for it.

---

## 2. The features, and where each one lives

"At M4's end" is the ledger status the demo ticket (41) sets, if and only if every condition in the row's "done when" holds.

| F-ID | What milestone 4 builds | Packages | Tickets | At M4's end |
|---|---|---|---|---|
| F-002 Accounts | Invitations by link, bound by their ID, mailed when email is set up, with the address verified then; sign-up through the link, and joining with an existing account; one use, 7 days, revocable; self-service resets by mail, the instance admin's reset link without email; every reset signs out the other sessions; removing a member (ADR 0053) | `packages/db`, `packages/domain`, `packages/api` (better-auth hooks), `apps/core` (mails), `apps/web` | 04, 05, 06, 19, 22, 23, 32, 40 | done |
| F-003 Roles | The two-level matrix enforced on every procedure and the live stream; organization roles changed by admins; the last admin and the last instance admin kept (ADR 0053) | `packages/domain`, `packages/api`, `apps/web` | 05, 06, 09, 23, 32, 33, 43 | done |
| F-087 Project access | Open or restricted; listed members with project roles; a project admin edits the project; a restricted project's records hidden from everyone it doesn't list, proved for every kind of project record | `packages/domain`, `packages/api`, `apps/web` | 05, 06, 09, 23, 33 | done |
| F-049 Organization isolation | The generated isolation test over every model and every query procedure, against a second organization its fixtures make, with its guard on a model that has no `organizationId` and isn't on the allowlist; the one organization a fresh install starts with stays milestone 1's seed (ADR 0053). *Changed 2026-11-19: creation by the instance admin, the switcher and links across organizations moved to F-134, after v1, with tickets 24 and 44* | `packages/db`, `packages/domain`, `packages/api` | 05, 06, 09 | done |
| F-073 Audit log | Every action of ADR 0054's list recorded, credential issuances included; the admin's viewer with filters and CSV export; a project admin's view of their project; the task's event log view with every tool call's full input | `packages/domain`, `apps/core`, `packages/api`, `apps/web` | 05, 06, 10, 25, 34 | done |
| F-080 Search | `SearchEntry` rows written at ingest and backfilled, Postgres full-text with filters as columns and access in the query; the palette and the search page (ADR 0054) | `packages/db`, `apps/core`, `packages/api`, `apps/web` | 05, 06, 11, 26, 35 | done |
| F-037 Costs and budgets | `SpendDaily` at ingest; spend per task, project and organization; the four-price form; monthly budgets per organization and project; 80% and 100% notices in the panel and by mail; the gate on every turn start; unpriced models held where a budget applies (ADR 0055) | `adapter-sdk`, `packages/db`, `packages/domain`, `apps/core`, `packages/api`, `apps/web` | 01, 04, 05, 06, 12, 13, 27, 36 | done |
| F-108 Insights | `insights.compute` every 5 minutes into `InsightDaily` and `TaskMetric`; the six figures of ADR 0055 per organization and project, over a picked period | `packages/db`, `packages/domain`, `apps/core`, `packages/api`, `apps/web` | 05, 06, 14, 28, 37 | done |
| F-109 Memory notes | Notes for organizations and projects with kinds, versions, sources, "always", full-text search, the secret scan with its model-control tokens, the version check on edit, audit entries; the Memory pages (ADR 0044, amended) | `packages/db`, `packages/domain`, `apps/core`, `packages/api`, `apps/web` | 05, 06, 16, 29, 38 | done |
| F-110 Memory for agents | The index and the "always" notes in the task spec, delivered with the profile's instructions, never in a repo; `memory_search` and `memory_read` on the sidecar's MCP server through core; the `memory` capability, with an index-only agent in the suite; only a read counts as a note's use, and the index is ordered by last read; each agent's own memory off; the notes a session used, on the task page | `packages/protocol`, `adapter-sdk`, `adapter-opencode`, `apps/core`, `apps/runner`, `packages/api`, `apps/web` | 01, 02, 05, 06, 07, 15, 20, 29, 38 | done |
| F-111 Memory proposals | `memory_propose` as a standing instruction; "Remember this" on diff comments and `@ostra` comments; proposals as a count, with related and contradicting notes beside them; approve, merge (with the version check), reject; the closing-turn switch | `packages/protocol`, `packages/domain`, `apps/core`, `apps/runner`, `packages/api`, `apps/web` | 01, 05, 06, 15, 16, 20, 29, 38 | building: "Remember this" on an AI review finding needs F-100 (milestone 6) |
| F-098 Tasks across several repos | Several repos per project, in order, up to 10; every session checks them all out side by side; one branch name; one PR per changed repo, each linking the others, all linked on the ticket; the diff, checks and reopen per repo; the PR set rule (ADR 0027, amended) | `packages/protocol`, `adapter-sdk`, `adapter-github`, `packages/domain`, `apps/core`, `apps/runner`, `packages/api`, `apps/web` | 01, 03, 05, 06, 08, 17, 21, 30, 39 | done |
| F-104 Independent-review check | `ostra/independent-review` on every task PR, evaluated on reviews, new heads, links and the reconcile; only linked non-drivers count; `in_progress` or `action_required` as the live test on `test1` settles (ADR 0040, amended) | `adapter-sdk`, `adapter-github`, `packages/domain`, `apps/core`, `packages/api`, `apps/web` | 03, 05, 06, 08, 18, 30, 39, 40 | done |
| F-115 Email notifications (grown) | The account mails (invitation, verification, reset) and the budget mails, on milestone 3's channel and templates | `adapter-sdk`, `packages/domain`, `apps/core` | 04, 06, 13, 19 | done |
| F-135 Model keys per project | Added 2026-11-19. The organization's default provider list and a project's own; the model by name on profiles; one provider per model per project, with the rule that keeps it; the provider and model row recorded on the session; the checks at the dispatch, the credentials endpoint and every turn start; "no key" with its needs-you for organization admins; spend per key; caps, holds and personal runners per provider; the upgrade's backfill (ADR 0065) | `packages/db`, `packages/domain`, `apps/core`, `packages/api`, `apps/web` | 45, 48, 50, 52, 53 | done |
| F-136 Repos from several GitHub organizations | Added 2026-11-19. Linked installations, the owner's own linked when seen and any other waiting; nothing minted, offered or stored for an unlinked one; the manifest's public choice; a client's own App beside the organization's, with its webhook address; a bot per repo at minor 3 (ADR 0065) | `packages/protocol`, `adapter-sdk`, `adapter-github`, `packages/db`, `packages/domain`, `apps/core`, `packages/api`, `apps/web` | 46, 47, 49, 51, 52, 54, 64 | done |
| F-137 Reasoning effort | Added 2026-11-19. Each catalog model's reasoning controls kept from models.dev; a custom model's set by an admin, and a catalog model's overridable on one provider; a profile's level from exactly its model's levels, with Default; the level set over ACP's `thought_level` option at every session start; the task's driver changing it for the next turn; the clamp, never an error; each turn's level and reasoning tokens; the model's real limits in the agent's config; the `reasoningEffort` capability (ADR 0066) | `packages/protocol`, `adapter-sdk`, `adapter-opencode`, `adapter-model-endpoint`, `packages/db`, `packages/domain`, `apps/core`, `apps/runner`, `packages/api`, `apps/web` | 56 to 63 | done |

**Rows this milestone touches without finishing:** F-086 (projects) gains several repos and stays `building` for its pool list (F-091, milestone 5). F-033 (reopen anywhere) can now be reopened "by another member" for real, and stays `building` for "with another agent" (F-018, after v1 since 2026-11-19); ticket 41 adds that proof to its file. F-036 stays `building` for milestone 6's audiences. Added 2026-11-19: F-021's profile names its model by name (tickets 45, 48, 50, 53); F-088 and F-089 gain the provider lists' checks, F-006 the manifest's public choice and a second App, and F-078 a bot per repo. Each keeps its status, and ticket 41 adds a dated note for what milestone 4 added.

**Built in from the first milestone** (`build-order.md`), checked again by ticket 41:
- Organization-scoped data: every new row carries `organizationId`, every project record `projectId` with the composite key (05). Ticket 09's generated test is the check for every model, old and new.
- The event log and the durable queue: a proposal, a held turn, a budget notice, a review check and an account mail each are saved before they are acted on, and sent from the queue (12, 13, 16, 18, 19).
- No credential in the agent's container: the memory tools reach core through the sidecar with the task's token, and the agent holds only the sidecar's bearer (15, 20). A note never holds a secret (16).
- ACP as the only way to talk to an agent: the index reaches the agent through the adapter's launch, and the tools through MCP (02, 07).
- Strict typing, dark first, responsive, English text in message files: as milestones 1 to 3.

---

## 3. The end-to-end demo

Ticket 41 runs it and records the result under its `## Comments` and in `demo.md` next to this spec. Everything runs against the Linear workspace `ostra-test` (team `OST`) and the GitHub org `ostra-test` (repos `test1` and `test2`). Secrets come from `~/.config/ostra-dev/` with `set -a; . ~/.config/ostra-dev/<file>; set +a`, and are never printed, logged or committed.

**Mail.** The scripted run sends every mail through SMTP to ticket 40's mail sink (`pnpm dev:mail-sink`, milestone 3's fake SMTP server writing each message to `.data/mail/`), so the script can open an invitation and a verification link the way a person would. The manual run uses Resend with the key in `email.env`, to the maintainer's own address and plus addresses.

**Before:** a fresh clone, `pnpm install`, `pnpm dev:reset`, `tunnel.env` loaded, and `pnpm dev`. Milestones 1 to 3's setup is done by their scripts' helpers: a model provider from `model.env` with its four prices, the test App, a project `test1` with that repo and Linear's `OST` attached, a project `test2` with that repo, one personal runner on `host`, milestone 3's profile `Careful` (plan first), and the maintainer's GitHub user linked to Demo (milestone 3's ticket 51). The panel signs in as the **default first admin, `demo@demo.com` / `demo`**; the scripted run sets `OSTRA_ALLOW_DEFAULT_PASSWORD=true` and `OSTRA_INSIGHTS_INTERVAL_MINUTES=1`. No `pnpm dev:seed-member`: people arrive by invitation.

**Before steps 15 to 17** (added 2026-11-19, ADR 0065). The provider of "Before" is named `client-a`. Ticket 55 adds a second model key (`model-b.env`) and a second test GitHub organization, `ostra-test-b` with the repo `testb1` in this text (the names are what ticket 55 records in `github-test.env`), with the test App, made public once, installed on `testb1`. Without them, the scripted run uses two of the e2e stub model endpoints, each with its own token, for `client-a` and `client-b`, and the fake GitHub's second account for `ostra-test-b`, and `demo.md` says which steps ran live.

1. **An invitation.** Demo makes `test2` restricted, listing nobody yet. Organization, "Members", "Invite": the address `sam@…` (the sink's, or the maintainer's plus address), role member, and `test2` with the role member. The panel shows the link once, with "Copy link" and "Send it privately". The invitation mail arrives with the organization's name, who invited, the link and nothing else. Sam opens it in a second browser: "Join Demo on ostra", the address locked, a username `sam` and a password of 12 characters or more. Sam sees "Check your inbox"; the verification mail arrives; its link activates the membership, and Sam lands on Home in `Demo`. "Members" lists Sam, and the invitation as accepted. The audit log has the invitation's creation, its acceptance and the verification.
2. **Roles and project access.** `test2`'s "Access" lists Sam as a project member. Demo creates a project `vault` (repo `test2`, restricted, nobody listed). Sam's sidebar shows `test1` and `test2` and not `vault`; `vault`'s URL shows "not found", and the script's `projects.get` for it as Sam is `NOT_FOUND`. Sam sees no admin page under Organization, and the script's `organization.invite` as Sam is `FORBIDDEN`. Sam starts a prompt task in `test2` ("List the files in the repo and stop"); Sam's save of `test2`'s environment is `FORBIDDEN`. Demo makes Sam a project admin of `test2`, and Sam's next save goes through. Each change is an audit entry.
3. **A second repo.** Demo opens `test1`'s settings, "Repos", "Add repo", and adds `test2`. The project lists both, in order; the environment shows a section per repo.
4. **A task across `test1` and `test2`.** The script creates a ticket in `OST`: "In test1, add `"apiVersion": 2` to `config/settings.json`. In test2, add a line to `CHANGELOG.md` saying test1's API version is now 2." Demo starts it from the Inbox. One session checks both repos out side by side and starts at the workspace's root; its instructions list both repos. One branch name in both. Two PRs open, one per repo, each with a "Related" section naming the other; the ticket links both; the task is in review; the Changes and Checks tabs show each repo on its own.
5. **The independent-review check.** The script turns on branch protection for `main` in `test1` and `test2`, requiring `ostra/independent-review`, with the test token. Both PRs show the check as "Waiting for an independent reviewer". The script's merge of `test1`'s PR with the test token is refused while the check waits (the test records whether `in_progress` blocks it; if not, the adapter reports `action_required`, and the run is repeated). The maintainer's user, linked to Demo, approves `test1`'s PR: Demo drove the task, so the check still waits ("Only drivers approved"). The reviewer user of `GITHUB_TEST_REVIEWER_TOKEN`, linked to Sam (`pnpm dev:link-github sam <login>` in the scripted run, the App's OAuth in the manual one), approves it: the check passes, "Approved by Sam". Demo reopens the task with "Also mention `apiVersion` in test1's README": the new head's check waits again. The reviewer approves again; the script dismisses that review with the test token, and the check waits; the reviewer approves once more, and approves `test2`'s PR. Both checks pass, the script merges both PRs, the task is merged and the ticket moves to done.
6. **Costs and a budget.** The task page shows its spend; `test1`'s page shows the month's spend; Organization, "Spend" shows each project and each model, and the organization's total equals the sum of its tasks' spend this month. Demo sets `test1`'s monthly budget to 110% of what it has spent: at once, Demo's "Needs you" and mail say "`test1` is at 91% of its budget". Demo starts a prompt task in `test1` with `Careful` ("Add a `CONTRIBUTING.md` with three short rules"). Its plan turn ends as "Needs you · plan"; Demo waits about a minute, then approves the plan. While the build turn runs, Demo lowers the budget to 90% of the spend so far. The turn finishes. "`test1` reached its budget" reaches Demo in the panel and by mail. Demo's message "Also add a line about tests" is held, and the thread says "Held: `test1`'s budget for November is reached". A new task in `test1` waits, queued, with the reason; the New task page shows it before Start. A task in `test2` still starts. Demo raises the budget: the held message starts its turn, and the waiting task starts. "Spend" shows the overshoot past 100%.
7. **Memory notes.** Organization, "Memory", "New note": "Dates are written YYYY-MM-DD", kind convention, "always" on. `test1`, "Memory", "New note": "Check JavaScript with node", kind command: "Run `node --check <file>` on every JavaScript file you change." A third note whose body holds the script's fake GitHub token is refused: "This note holds a GitHub token. Memory never holds credentials." Searching `test1`'s Memory for "node" finds the second note.
8. **A proposal, approved.** The script creates a ticket in `OST`: "Rename the `releaseName` key in `config/settings.json` to `release`. Before you finish, propose a memory note titled 'Settings keys' saying that keys in `config/settings.json` are single lowercase words." Demo starts it. The event log shows the agent's `memory_propose` call. `test1`'s Memory shows "1 proposal", from that task, with the related notes beside it. Sam, who can open `test1`, presses "Approve as a new note". The audit log has the decision.
9. **Memory reaches the next task.** Sam starts a prompt task in `test1`: "Add `scripts/print-release.js`, which prints the `release` key of `config/settings.json`, and a line to `CHANGELOG.md` with today's date." The session's instructions hold the index (the three notes) and the "always" note in the task's config folder, and no repo has a memory file (`git status` clean of it in both repos). The agent runs `node --check scripts/print-release.js`, the changelog line's date reads YYYY-MM-DD, and the task page's "Memory" lists the notes the session used and how (index, always, read). On the Changes tab Sam comments on a line ("Print a newline at the end"), and "Remember this" on that comment makes a proposal; Demo merges it into "Check JavaScript with node", which becomes version 2 with the comment as its source.
10. **The audit log.** Demo opens Organization, "Audit log", filters by Sam: the acceptance, the task start, the environment save, the proposal's approval. Filtered by `budget.*`: each budget change. Each task's `task.credentials-issued`. "Export CSV" downloads the filtered view. From the task of step 4, "Event log" lists every tool call with its full input: each command with its folder, each path read, searched or written. The script compares every session's tool calls, from OpenCode's own session export (milestone 2), with the event log: the same calls, each with its input. Sam, as `test2`'s project admin, sees `test2`'s entries in its settings and none of the organization's.
11. **Search.** Demo runs a prompt task in `vault`: "Write `VAULT-ONLY-7731` into `notes.txt`". Sam presses Ctrl+K and types `apiVersion`: the task of step 4 comes first, with a snippet from the agent's message and the command it ran; `repo:test2 status:merged` keeps it; `by:sam` drops it. `VAULT-ONLY-7731` finds nothing for Sam, and the vault task for Demo.
12. **A third member, and the instance admin's accounts.** *Changed 2026-11-19: this step made a second organization, `Second`, and showed it apart from `Demo`. Several organizations moved after v1 (F-134), and ticket 09's test proves the isolation against a fixture organization instead.* Demo invites `rae@…` to `Demo` as a member, with no restricted project; Rae joins as in step 1, and sees `test1` and `test2` and not `vault`. Demo, the instance admin, opens Instance, "Accounts": Demo, Sam and Rae, found by username or address. Demo makes Sam an instance admin, then removes the role again; with Demo the only instance admin left, Demo's own row has no "Remove". The sidebar's organization row reads `Demo`, and nothing in the panel makes another organization.
13. **Insights.** Organization, "Insights", the last 7 days: PRs opened and merged, the merge rate, the median time to a first PR, the time waiting on people (the plan of step 6 among it), tokens and spend, each with "computed N minutes ago"; `test1`'s Insights the same for that project. Sam's organization Insights show `vault`'s share as "Other projects".
14. **Removal and resets.** Demo removes Rae from `Demo`: Rae's open page says Rae is no longer a member of any organization, and the audit log and Rae's past entries show "Rae (removed)". Sam presses "Forgot your password?", gets the reset mail, chooses a new password, and Sam's other browser is signed out. The instance admin switches email off; "Create reset link" for Sam under the instance's "Accounts" shows a link once; it works, and its second use is refused.
15. **A second GitHub organization.** Organization, "GitHub" lists the App with its installation on `ostra-test`, linked, and the one on `ostra-test-b` as "Waiting to be linked", with its account. While it waits, "Add repo" offers nothing from `testb1`; the script's `projects.addRepo` with `testb1` is `PRECONDITION_FAILED` ("This installation isn't linked"); and the script pushes a commit to `testb1` with the second organization's token, whose webhook delivery is stored nowhere. "Add a GitHub organization" shows the install link to send, and the line that GitHub lets only the App's own account install a private App, with the link to the App's settings. Demo links the installation, and the audit log has `installation.linked`. *If ticket 55 made an App that `ostra-test-b` owns,* Demo also connects it under "Connect another App" with its ID and private key; the panel shows that App's own webhook address and a secret once, which the maintainer sets in the App's settings; its installation on `testb1`, its owner's own, is linked when seen, and step 16's PR in `testb1` is authored by that App's bot.
16. **Two clients, two keys.** Organization, "Models" lists `client-a` on the default list, with every project that follows it. Demo adds `client-b` from `model-b.env` and ticks no list, so no project can use it. Demo creates `calculator`, client A's app (repo `test1`; its own list, `client-a`), and `portal`, client B's (repos `testb1` and `test2`; its own list, `client-b`). A profile `Builder` names the model of `model.env` by its name, and is both projects' default. Demo starts a prompt task in each: in `calculator`, "Add `docs/client.md` saying this app belongs to client A"; in `portal`, "In testb1, add `HELLO.md`. In test2, add a line to `CHANGELOG.md` naming testb1." The task pages show "Key · client-a" and "Key · client-b". `portal`'s task opens two PRs, one in each GitHub organization, each authored by its App's bot and listing the other under "Related". Organization, "Spend" by key: `client-a`'s month holds `calculator`'s task and not `portal`'s, and `client-b`'s holds `portal`'s alone. Demo adds `client-b` to `calculator`'s list too: the save's preview says nothing moves, the model stays on `client-a`, and a new task there shows "Key · client-a". Demo takes `client-b` off again. Sam opens `calculator`'s "Models and keys": the providers by name and the model each serves, no token and no edit. The script's `projects.setProviders` as Sam, on `calculator` and on `test2`, where Sam is a project admin, is `FORBIDDEN`.
17. **No key, and no fallback.** With `calculator`'s task of step 16 idle, Demo takes `client-a` off `calculator`'s list: the preview says the model has no key in `calculator`, and the task's idle box is released. Demo's message to it, "Also name client A's contact", is held, and the thread says "No key for <model> in `calculator`. An organization admin picks one in Models and keys." Home's needs-you shows it to Demo and not to Sam. A new task in `calculator` shows the same before Start, and Start is refused. Demo puts `client-a` back: the held message starts its turn in a fresh box, on `client-a`. The audit log has each change to the lists.
18. **Reasoning effort** (added 2026-11-19, ADR 0066). On `calculator`, after step 17, with `client-a` back on its list. Where `client-a` is one of the e2e stub endpoints, the stub records each request's body, and the catalog fixture lists the levels of its model. Where `client-a` is `model.env`'s endpoint, the turns' levels and reasoning tokens show the effect, since no log holds a request's content. `demo.md` says which ran.
    1. Organization, "Agent profiles", `Builder`: under the model, "Effort" offers exactly the levels the catalog lists for that model, `Default` first. Demo picks `High` and saves, and the audit log has the save.
    2. A profile on a model that doesn't reason (the stub's second model) shows no "Effort" at all.
    3. Organization, "Models": the model reads "Reasoning · from the catalog" with its levels. A custom model on the stub provider reads "Reasons: no" until Demo sets it to reason at `Low` and `High`, which is an audit entry.
    4. Demo starts a prompt task in `calculator`: "Add `docs/effort.md` with one line". The task page shows "Effort · High", and the first turn's usage line says `High`, with its reasoning tokens.
    5. While that turn runs, Demo, the driver, picks `Low`. The control says "Low from the next turn", the thread says "Demo set effort to Low, from the next turn", and the running turn finishes at `High`.
    6. Demo's message "Also add a second line" runs at `Low`. With the stub, every request of the first turn carries `high` and every one of the second carries `low`, in its format's own field. A task on a profile at `Default` sends neither.
    7. Sam, who isn't the driver, sees "Effort · Low" with "Take over to change", and the script's `tasks.setEffort` as Sam is `FORBIDDEN`.

**The checks after the run** (ticket 41 scripts what it can, in `e2e/m4-the-organization/`):
- **Nothing leaked.** Invitation IDs, verification and reset tokens, the CLI's and the task's tokens, every GitHub token and the Resend key appear in no log line, no event and no worktree (searched by value, never printed). The fake GitHub token of step 7 is stored nowhere. No note's text is in a repo or a commit.
- **Isolation for every kind of record.** Ticket 09's generated test passes, against the second organization its fixtures make, and the script's sweep of every list procedure as Sam and as Rae returns none of `vault`'s IDs (F-049, F-087).
- **Invitations.** A used link, a revoked link, an expired one (with the clock moved) and an `owner` invitation are refused; with email on, a pasted link without the mailbox never activates a membership; an address with an account joins without a second account (F-002).
- **The last admin.** Demoting or removing the last admin of an organization is refused, and the last instance admin can't give the role up (F-003).
- **The audit.** Every action the run took appears in the log, by its action name; no code path updates or deletes an entry; the canary control of the agent contract suite shows a read outside the workspace in the event log (F-073, ADR 0035).
- **Search access.** Twenty searches built from `vault`'s own text return nothing for Sam, and ticket 09's suite runs search against its fixture organization's text (F-080).
- **The gate.** Every origin of a turn, an automatic round's included, is held at 100% (the gate's test); a model with no price makes a task wait where a budget applies; the overshoot shown equals the spend counted after the line (F-037).
- **Insights.** Each figure equals the reference query over the same tables and period (F-108).
- **Memory.** The index-only fake agent gets the index and no tools; a task's 21st proposal is refused; each secret shape and each model-control token is refused and its negative control saved; a session that only saw a note in the index leaves its last use alone; a stale edit and a stale merge are refused with `CONFLICT`; a minor-2 runner gets the notes in its instructions (F-109 to F-111).
- **Several repos.** A task that changes only `test2` opens one PR; removing a repo an open task uses is refused with the task named; each PR's "Related" section is right after a replayed webhook (F-098).
- **The check.** The evaluator's cases of spike 4, the webhook flips, an unlinked approver, a bot and a driver each leave it waiting (F-104).
- **Keys stay in their project.** Ticket 48's isolation test passes, with its break-it. Every `usage.recorded` of `calculator`'s sessions names `client-a`, and every one of `portal`'s names `client-b`; every `task.credentials-issued` names its session's provider; with the stub endpoints, `client-b`'s endpoint saw `client-b`'s token alone, and only from `portal`'s sessions (F-135).
- **No fallback.** With `client-a`'s stub answering a rate limit and `calculator`'s list holding both keys, `calculator`'s next task waits on `client-a`'s hold and never starts on `client-b` (F-135, F-089).
- **The upgrade.** Ticket 45's migration test passes on a milestone 4 database with two profiles naming one model on two providers (F-135).
- **Installations nobody linked.** Before step 15's link, no token was minted for the second organization's installation, no delivery from it was stored, and its repos were offered nowhere; a stranger's installation on the fake GitHub gets the same (F-136).
- **Effort** (F-137). Ticket 56's clamp table passes for every level against every kind of model. Ticket 57's contract cases pass on the pinned OpenCode: the levels advertised, each level in the request body, `Default` sending nothing, and the model's output limit in the request. A task whose profile's model was changed to one without its level ran at the nearest, and its page says so. A minor-2 runner is never offered a task with a level.
- **Clean-up:** the demo's tickets archived in `OST`, its PRs closed, branches and hidden refs deleted, branch protection removed, in `test1`, `test2` and `testb1` only. The test App stays installed on `ostra-test-b` for the next run.

---

## 4. How it fits together in milestone 4

```
 browser ──▶ apps/web: Members, Accept invite, Reset, Project access, Accounts, Audit log,
                │       Event log, Search, Spend and budgets, Insights, Memory, Project repos
                ▼
             packages/api ──▶ Postgres: memberships, invitations, audit, search entries,
                │                       spend, budgets, insights, notes, proposals, uses
                ▼                                 ▲
 apps/core workers: account-mail.send, budget.check, budget.release, insights.compute,
                    search.backfill, pr.link-related, review.evaluate, invitation.expire
                │                                 │
 runner ──WS──▶ gateway        runner: the memory index at launch, several repos
   └─ sidecar: key proxy, git proxy, ostra MCP (PR text, memory_search, memory_read,
               memory_propose) ──HTTPS, task token──▶ /runner/v1/tasks/:id/memory/*
 GitHub ──webhook──▶ core: pull_request_review, pull_request synchronize
 core ──▶ GitHub: check runs (ostra/independent-review), PR bodies ("Related")
 Resend / SMTP ◀── account mails and budget mails (milestone 3's channel)
```

**The flows:**
- **An invitation.** `members.invite` writes the invitation (through better-auth's plugin, with ostra's project grants beside it), an audit entry, and, with email set up, an `account-mail.send` job, in one transaction. The panel shows the link once. The sign-up page reads the invitation by its ID; ostra's `before` hook on `/sign-up/email` lets through an invitee whose invitation is pending and unexpired, and creates the membership and the project grants in the same transaction as the account. With email on, the membership starts `pending_verification` and a verification mail is sent; better-auth's verification callback activates it. An existing account signs in and accepts on the same page.
- **A reset.** With email on, "Forgot your password?" calls better-auth's reset request; its mail callback enqueues an `account-mail.send` with the link, for a verified address only, and answers the same either way. Without email, the instance admin's "Create reset link" uses ADR 0003's sink. Using either revokes the account's other sessions and CLI sessions.
- **Removing a member.** `members.remove` runs ADR 0053's transaction: the membership marked removed, project roles dropped, personal runners revoked, CLI sessions revoked, driving dropped (a `driver.changed` to nobody on each task), drafts deleted, invitations revoked, an audit entry. The live stream ends the member's subscriptions in that organization.
- **Switching organizations** (after v1 since 2026-11-19, F-134; kept for then). `organizations.switch` sets the session's active organization after a membership check, and records it as the account's last one. A link to a record of another organization the member belongs to calls it first and the panel says so.
- **The audit log.** Every use case that changes something writes its entry in its transaction, through the one `recordAudit` port. The viewer reads with the filters as indexed columns; the export streams the same query as CSV. The task's event log view reads `Event` rows in order through the task's access check.
- **Search.** Every writer of a task's title, prompt, ticket, messages and tool calls writes `SearchEntry` rows in the same transaction. `search.query` builds one SQL statement: the organization, the visible projects, the filters, `websearch_to_tsquery` with the last word as a prefix, grouped by task, ranked, with `ts_headline` snippets.
- **Spend and the gate.** The ingest of `usage.recorded` (milestone 2) also upserts `SpendDaily` and, when the month's total for a budget crosses 80% or 100%, enqueues `budget.check` keyed by budget, month and threshold. `budget.check` writes the notice once. Every turn start (a dispatch, a reopen, a steer to an idle session, a diff-comment send, update branch, `@ostra`, "Keep working", a closing turn) calls `budgetGate`. A closed gate saves the message as held (`turn.held` in the thread), or leaves the task queued with its dispatch note. Raising a budget, or the month turning, enqueues `budget.release`, which lets the held turns go in order.
- **Insights.** `insights.compute`, a pg-boss schedule, upserts each task's `TaskMetric` and each day's `InsightDaily` for the days whose source rows changed since its last run, and records when it ran. The page reads only those rows.
- **Memory at a session's start.** The dispatch builds the spec's `memory` section: the project's and the organization's notes, "always" first, then the index in ADR 0044's order, cut at its limits, rendered into one block that names the notes as approved, each with its source, and ends with the standing instruction. The adapter's launch writes the block with the profile's instructions in the task's config folder, and turns its agent's own memory feature off. The runner emits `memory.used` for the notes the block delivered. Core keeps every row, and only a read moves a note's last use (ADR 0044, Q91).
- **The memory tools.** The agent calls `memory_search`, `memory_read` or `memory_propose` on the sidecar's MCP server. The sidecar checks the input against the protocol's schemas and forwards it to `/runner/v1/tasks/:taskId/memory/*` with the task's token. Core checks the token's task, runs the search scoped to the task's organization and project, or scans and stores the proposal (and writes `memory.proposed` in the thread), and answers. The runner emits `memory.used` for each note read.
- **A proposal's decision.** The Memory page lists proposals with the agent's declared relation and the three notes ranking highest against it. "Approve as a new note", "Approve and archive …", "Merge into …" (the member edits the merged text) or "Reject" each run in one transaction with the audit entry. A merge, like an edit, carries the version the member opened, and is refused with `CONFLICT` when the note has moved on (ADR 0044, Q91). An approved note reaches the next session, never a running one.
- **Several repos.** The dispatch puts every repo of the project in the spec, in order, and appends the list of repos, their folders and base branches to the agent's instructions. The runner checks each out side by side. After a turn, each repo that's ahead is pushed; core opens one PR per repo (milestone 1's opener), then enqueues `pr.link-related`, which edits every open PR of the task to list the others, idempotent by task and repo. Milestone 2's tracker writer links each PR on the ticket.
- **The independent-review check.** `pull_request_review`, `pull_request` `synchronize`, a link or unlink, a new trailer and milestone 2's PR reconcile each enqueue `review.evaluate` keyed by the PR and its head. It lists the PR's reviews, maps each reviewer through the verified links to members, takes the task's drivers from its trailers, runs the evaluator, and creates or updates the check run when the result changed.
- **Keys per project** (added 2026-11-19, ADR 0065). A session's start calls `resolveSessionModel`: the project's list (its own or the organization's default), the profile's model name, and the project's choice or the only provider on the list that lists it. It records the provider and model row on the session, or leaves the task queued with `no-provider-for-model` and a needs-you item for the organization's admins. The task spec takes the session's row. `POST /runner/v1/tasks/:taskId/credentials` checks the session's provider against the project's list before it reads the token. Every turn start calls `providerGate` beside `budgetGate`. A list change, in one transaction with its audit entry, records the choices it would otherwise leave with two providers, and enqueues `providers.release-boxes` for the project's idle boxes holding a key it removed.
- **Linked installations** (added 2026-11-19, ADR 0065). The webhook inbox reads the installation of a verified GitHub delivery and keeps the delivery only when that installation is linked to its connection. An `installation` event for the App owner's own account links it, and a `deleted` one marks a linked installation removed. The organization's GitHub page lists the App's installations through the adapter, linked ones first. Every token mint goes through the repo's installation row, and is refused when it isn't linked.
- **Reasoning effort** (added 2026-11-19, ADR 0066).
  - The catalog sync stores each model's reasoning controls. An admin's controls for a custom model, or an override on one provider's listing, sit beside them.
  - A profile's level is one of its model's levels, which its agent adapter computes from the controls.
  - A new task copies the profile's level. The dispatch clamps it to the session's model row, and puts it in the spec with the row's controls and limits.
  - The adapter writes the controls and limits into the agent's config. After every `session/new` and `session/load` the runner sets the level on the `thought_level` option, clamped again to what the agent advertised, and `turn.started` says which level the turn ran at.
  - The driver's change writes `Task.effort`, `effort.changed` and an audit entry, and sends `set-effort`, which the runner holds until the running turn ends.
  - `usage.recorded` carries the reasoning tokens, which ingest sums on the turn and the session.

---

## 5. The contracts

Every contract change in milestone 4 is **additive**: a new optional field, a new union member, a new endpoint, a new table, column or enum value. Nothing is renamed or dropped (`AGENTS.md`). Each lands as one small commit that names the contract and updates every caller in the same commit. Tickets 01 to 06 make them first, each with the fakes its callers test against; everything else builds on them.

### 5.1 `packages/protocol`: minor 3 (ticket 01)

- **The version.** The protocol goes to minor 3, after milestone 3's minor 2. The window stays one minor either way, so a minor-2 runner still works: core appends the memory block to the `agent.instructions` it already knows, gives it no memory tools, and expects no `memory.used`. Several repos need nothing new from the runner, since minor 0's spec has a list. A minor-1 runner is outside the window and refused at `hello`.
- **Events, new members of the union:**
  - `memory.used { noteIds, via: "index" | "always" | "search" | "read" }`: what a session saw. `via: "search"` is a search result the agent then read. Core stores every one, and only `read` and `search` move a note's `lastUsedAt` and `useCount` (ADR 0044, Q91).
  - `memory.proposed { proposalId, title }` (server-only): a proposal the agent made, for the thread.
  - `turn.held { origin, budgetId, scope: "organization" | "project" }` and `turn.released { budgetId }` (server-only): a turn the gate held, and its release.
  - `review.check_updated { repoId, prNumber, headSha, status: "pending" | "passed", approverMemberId | null, reason }` (server-only): the check's result for the thread and the task page.
  - `pr.related_updated { repoId, prNumber, related: [{ repoId, prNumber }] }` (server-only).
- **The task spec, new optional fields** (a minor-2 runner gets the old shape):
  - `memory: { block, indexNoteIds, alwaysNoteIds, omitted, tools: boolean } | null`: `block` is the memory text core rendered (the "always" notes, the index and the standing instruction, within the limits), so the runner, which is Apache-2.0, needs no renderer from `packages/domain`; the ID lists are what the runner reports in `memory.used`; `omitted` counts the notes that didn't fit
  - `agent` gains `closingTurn: boolean`
- **Runner HTTP, new** (the sidecar on behalf of one task, with the task's token, ADR 0034's HTTP):
  - `POST /runner/v1/tasks/:taskId/memory/search { query, limit }` → `{ results: [{ noteId, title, line, kind, scope }] }`
  - `GET /runner/v1/tasks/:taskId/memory/notes/:noteId` → `{ noteId, title, body, kind, scope, version }`
  - `POST /runner/v1/tasks/:taskId/memory/proposals { title, body, kind, scope, relatesTo, relation }` → `{ proposalId }`, or a refusal `{ code: "secret-found", found }`, `{ code: "limit-reached" }`, `{ code: "invalid" }`, whose words the tool returns to the agent
- **The memory note's shape** is a protocol type, Zod first: `MemoryKind` (`convention`, `command`, `gotcha`, `decision`, `preference`, `term`), `MemoryScope` (`organization`, `project`), and the note and proposal inputs as strict objects.
- **Limits** as named working values: a note's title 120 characters and body 4 KiB; the index 100 notes and 8 KiB; the "always" notes 8 KiB; a search's query 500 characters and at most 20 results; 20 proposals a task; a search entry's text 8 KiB.
- The schemas' descriptions say what's never logged: a note's text, a query, a proposal's text.

### 5.2 `packages/adapter-sdk` (tickets 02 to 04)

**`AgentAdapter`** (ticket 02):
- **Capability, new:** `memory: "mcp" | "index-only"`. An agent that reaches ostra's MCP server takes the tools; one that can't gets the index only (ADR 0044).
- **Launch, new input:** `prepareLaunch` takes the rendered memory block (the domain's renderer, ticket 06) and writes it with the profile's instructions where the agent reads them, in the task's config folder.
- **Native memory, off** (ADR 0044, Q91): the base class documents that an adapter turns its agent's own memory feature off at launch, so nothing an agent keeps for itself outlives the task or skips a member's approval. Each adapter states what it turns off, or that its agent has none: OpenCode has none. The Claude Code adapter will set `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, and the contract case that checks the rule comes with it, the first agent that has native memory.
- **The scripted fake agents** grow: one calls `memory_search`, `memory_read` and `memory_propose` when its script says so; a third, index-only fake declares `memory: "index-only"` and no MCP.
- **The agent contract suite** gains: the index and "always" notes reach the agent and no repo (`git status` clean in each); with `mcp`, the three tools are listed and a call round-trips through a fake core; with `index-only`, no tool is offered; two repos checked out side by side with the agent at the root; and, if milestone 1's suite lacks it, ADR 0035's canary control.

**`CodeHostAdapter`** (ticket 03):
- `listReviews(access, number)` → `[{ reviewId, userId, login, isBot, state: "approved" | "changes_requested" | "commented" | "dismissed" | "pending", commitId, submittedAt }]`.
- `publishCheckRun(access, { name, headSha, status: "in_progress" | "completed", conclusion: "success" | "action_required" | null, title, summary, externalId })` → `{ checkRunId }`, and `updateCheckRun(access, checkRunId, sameFields)`. Idempotent by `(headSha, name)`.
- `updatePullRequestBody(access, number, body)`, where milestones 1 to 3 haven't added it.
- `parseWebhook` gains `pull_request_review` (submitted, edited, dismissed) and `pull_request` `synchronize` hints.
- **Capability, new:** `reviews: boolean` (`checkRuns` exists).
- **The fake code host** gains reviews, check runs, a review dismissal, and branch protection that requires a check, refusing a merge while it's pending in one mode (`in_progress` blocks) and allowing it in the other, so both answers of ADR 0040's open question are tested.

**`NotificationAdapter`** (ticket 04): `Notification.kind` gains `invitation`, `email_verification`, `password_reset`, `budget_warning` and `budget_reached`, and `Notification` gains `category: "moment" | "account"`. An account mail goes to one address that may have no member yet, skips the delay and the member's choices, and carries a bearer link, so the contract suite checks its link is in both parts and never in a log line or an error. The panel and tracker channels refuse the account category.

**`ModelProviderAdapter`** (ticket 04): `matchCatalog`'s prices carry all four (fresh input, output, cache read, cache write), each `null` when the source has none, where milestone 2 hasn't added them.

### 5.3 `packages/db`: the milestone 4 migration (ticket 05)

One new migration, after milestone 3's, additive only. Every row carries `organizationId`; every project record carries `projectId` with the composite key to the project.

| Change | What |
|---|---|
| `Member` | + `state` (`active`, `pending_verification`, `removed`; default `active`), `removedAt`, `removedByMemberId`. Queries that list members filter `active` unless they show history |
| `Invitation` | + `projectGrants` (JSON: project ID and role, parsed by the domain's schema), `acceptedAt`, `acceptedUserId`, `revokedAt`, `revokedByMemberId`, `linkShownAt` |
| New `ResetLinkGrant` | An install-level record of a reset link: `userId`, `createdByUserId` (null for a self-service reset), `kind` (`admin_link`, `self_service`), `tokenHash`, `expiresAt`, `usedAt`. On the isolation test's allowlist; audit entries go to each of the account's organizations |
| `User` | + `lastOrganizationId`. *Not in this migration since 2026-11-19: it comes with F-134's switcher, after v1* |
| `Organization` | + `createdByUserId`. *Not in this migration since 2026-11-19: it comes with F-134's Organizations page, after v1* |
| `AuditEntry` | + `actorName` (as it was, for removed members); indexes `(organizationId, action, createdAt)`, `(organizationId, actorId, createdAt)`, `(organizationId, entity, entityId)` |
| New `SearchEntry` | `taskId`, `projectId`, `repoId` (nullable), `eventSeq` (nullable for the title, prompt and ticket), `kind` (`title`, `prompt`, `ticket`, `member_message`, `agent_message`, `tool_input`, `pr`), `authorMemberId`, `text` (at most 8 KiB), `vector` (generated `tsvector`, `simple`, GIN index), `createdAt`. Unique `(taskId, eventSeq, kind)` |
| `Model` | + `cacheReadPricePerMTok`, `cacheWritePricePerMTok`, `priceSource` (`endpoint`, `catalog`, `admin`), `priceChangedAt`, where milestone 2 hasn't added them |
| New `SpendDaily` | `projectId`, `day` (date, UTC), `modelId`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `spentMicroUsd`, `unpricedTokens`. Unique `(projectId, day, modelId)` |
| New `Budget` | `projectId` (null for the organization's), `monthlyMicroUsd`, `updatedByMemberId`, `updatedAt`. Unique `(organizationId, projectId)`, with a partial unique index for the organization's own |
| New `BudgetNotice` | `budgetId`, `month` (`YYYY-MM`), `threshold` (`warn`, `reached`), `sentAt`. Unique `(budgetId, month, threshold)` |
| New `HeldTurn` | A turn the gate held: `taskId`, `origin`, `budgetId`, `pendingMessageSeq` (the saved message, when there is one), `heldAt`, `releasedAt` |
| New `TaskMetric` | One per task: `taskId`, `projectId`, `createdAt`, `firstPrAt`, `prsOpened`, `prsMerged`, `prsClosedUnmerged`, `waitingMs`, `computedAt` |
| New `InsightDaily` | `projectId` (null for the organization's), `day`, `prsOpened`, `prsMerged`, `prsClosedUnmerged`, `waitingMs`, `waitingItems`, `waitingByReason` (JSON), `computedAt`. Unique `(organizationId, projectId, day)` |
| New `InsightRun` | Per organization: `lastRunAt`, `lastSourceChangeAt` |
| New `MemoryNote` | `projectId` (null for an organization note), `scope`, `title`, `body`, `kind`, `always` (default false), `status` (`active`, `archived`), `version`, `sourceKind` (`member`, `task`, `diff_comment`, `pr_comment`, `proposal`), `sourceTaskId`, `sourceRef`, `authorMemberId`, `lastUsedAt` and `useCount` (moved by reads only, Q91), `vector` (generated `tsvector` over title and body, GIN index), `createdAt`, `updatedAt` |
| New `MemoryNoteVersion` | `noteId`, `version`, `title`, `body`, `kind`, `always`, `editedByMemberId`, `proposalId`, `createdAt`. Unique `(noteId, version)` |
| New `MemoryProposal` | `projectId` (null for the organization's), `scope`, `title`, `body`, `kind`, `state` (`proposed`, `approved`, `rejected`, `merged`), `sourceKind` (`agent`, `diff_comment`, `pr_comment`, `closing_turn`), `taskId`, `sessionId`, `proposedByMemberId`, `relatesToNoteId`, `relation` (`contradicts`, `refines`), `decidedByMemberId`, `decidedAt`, `resultNoteId`, `vector` (generated, GIN) |
| New `MemoryUse` | `taskId`, `sessionId`, `noteId`, `via` (`index`, `always`, `search`, `read`), `at`. Unique `(sessionId, noteId, via)` |
| `AgentProfile` | + `closingTurn` (default false) |
| `Repo` | + `position` (the project's order) |
| New `ReviewCheck` | `taskRepoId`, `prNumber`, `headSha`, `checkRunId`, `status` (`pending`, `passed`), `reason`, `approverMemberId`, `updatedAt`. Unique `(taskRepoId, headSha)` |
| Enums | The notification kinds (an enum or a checked column, as milestone 3 built them) + `invitation`, `email_verification`, `password_reset`, `budget_warning`, `budget_reached`. New `MemberState`, `ResetLinkKind`, `SearchEntryKind`, `PriceSource`, `BudgetThreshold`, `MemoryKind`, `MemoryScope`, `MemoryNoteStatus`, `MemorySourceKind`, `ProposalState`, `ProposalSourceKind`, `ProposalRelation`, `MemoryUseVia`, `ReviewCheckStatus`. `NeedsYouReason` keeps its values |

The generated `tsvector` columns and their GIN indexes are raw SQL in the migration, declared to Prisma as `Unsupported("tsvector")`. The migration backfills nothing; `search.backfill` fills `SearchEntry` for existing tasks.

**Two deprecated columns stay: drop them in a later release.** `InstanceSetting.openSignupAccounts` and `InstanceSetting.openSignupOrganizations` are unused since 2026-11-19, when the open sign-up settings were removed (`schema.prisma` marks them). This migration is additive only, so it keeps them. The first migration of the release after the one that stopped reading them drops them (`AGENTS.md`: add first, drop in a later release), and the spec that writes that migration carries this line on until one does.

### 5.4 `packages/domain` (ticket 06)

- **Lifecycles,** new, each with exhaustive tests: the membership (`pending_verification` → `active` → `removed`), the invitation (`pending` → `accepted` | `revoked` | `expired`), the proposal (`domain-model.md`'s, with "approve and archive" as an approve), a budget's month (`under` → `warned` → `reached`, reset on a new month or a raise), and the review check (`pending` ⇄ `passed`, per head).
- **Access, new:** `requireInstanceAdmin`, `canWriteNote(scope, note)` and `canArchiveNote(scope, note)` (ADR 0044, amended), `canReadAudit(scope, projectId | null)`, and the rule that a removed or pending membership makes no scope.
- **The budget gate:** `budgetGate(budgets, spend, origin)` → `open` | `held { budgetId, scope }`, pure, over a closed union of origins (`dispatch`, `reopen`, `message`, `diff-comments`, `update-branch`, `pr-comment`, `keep-working`, `closing-turn`, `automatic-round`); the month and threshold arithmetic; the overshoot.
- **Insights:** pure definitions of ADR 0055's six figures over rows, the reference the job and its test both use.
- **Memory:** the secret scan (the organization's secret values, the fixed credential shapes and the model-control tokens, each with a negative control), the index builder with its order (project first, then by last read, then by last edit) and limits, the renderer of the memory block (approved notes with their sources, and the standing instruction), the version check that an edit and a merge share, the proposal's related-notes query (a store method, ranked by `ts_rank`), and "Remember this" from a diff comment or a PR comment.
- **Several repos:** a project's repo limit, the "in use" rule for removing a repo, the folder name rule, the renderer of the repos list for the agent's instructions, and the renderer of a PR's "Related" section.
- **The independent-review check:** spike 4's evaluator, ported, with the driver set from the task's trailers and the approvers mapped through verified links (ADR 0040, amended).
- **Mail templates:** the account mails (invitation: the organization, who invited, the link, the expiry; verification; reset) and the budget mails (the budget, the share, the month, a link), on milestone 3's renderers: `{ subject, html, text }`, no task content.
- **Use-case signatures:** `inviteMember`, `revokeInvitation`, `acceptInvitation`, `verifyMembership`, `removeMember`, `setProjectAccess`, `setProjectMember`, `createOrganization` and `switchOrganization` (both after v1 since 2026-11-19, F-134), `grantInstanceAdmin`, `createResetLink`, `recordAudit` (one port), `exportAudit`, `writeSearchEntries`, `searchTasks`, `recordSpend`, `setBudget`, `checkBudget`, `releaseHeldTurns`, `setModelPrice`, `computeInsights`, `saveNote`, `archiveNote`, `searchNotes`, `buildMemoryBlock`, `recordMemoryUse`, `proposeNote`, `rememberThis`, `decideProposal`, `addProjectRepo`, `removeProjectRepo`, `linkRelatedPullRequests`, `evaluateIndependentReview`.
- **Jobs, new names** (IDs only in payloads, each with its key rule, ADR 0037): `account-mail.send` (key: purpose and record ID), `invitation.expire` (a sweep), `budget.check` (key: budget, month and threshold), `budget.release` (key: budget and the raise's time), `budget.new-month` (a schedule at 00:05 UTC on the 1st that enqueues a `budget.release` per budget; added by ticket 13), `insights.compute` (an idempotent pass, so a pg-boss schedule), `search.backfill` (key: task; idempotent per entry), `pr.link-related` (key: task and the PR that opened), `review.evaluate` (key: PR and head, `singletonSeconds` 10).
- **Settings, new,** each with a working default and its line in `docs/configuration.md`:

| Setting | Default |
|---|---|
| `OSTRA_INVITATION_DAYS` | `7` |
| `OSTRA_RESET_LINK_HOURS` | `24` |
| `OSTRA_BUDGET_WARN_PERCENT` | `80` |
| `OSTRA_INSIGHTS_INTERVAL_MINUTES` | `5` |
| `OSTRA_MEMORY_INDEX_MAX_NOTES`, `OSTRA_MEMORY_INDEX_MAX_KIB`, `OSTRA_MEMORY_ALWAYS_MAX_KIB` | `100`, `8`, `8` |
| `OSTRA_MEMORY_PROPOSALS_PER_TASK` | `20` |
| `OSTRA_PROJECT_MAX_REPOS` | `10` |
| `OSTRA_SEARCH_ENTRY_MAX_KIB` | `8` |

`OSTRA_OPEN_SIGNUP_ACCOUNTS` and `OSTRA_OPEN_SIGNUP_ORGANIZATIONS` exist from milestone 1 and keep their defaults (off). *Changed 2026-11-19: open sign-up is no longer planned, since it existed for a hosted version (ADR 0026, amended). The two settings stay as built, and milestone 4 builds no switch for them. Changed again 2026-11-19 (the maintainer: "the user can currently just invite team members. Yep."): both settings are removed from the code. A server that still finds one starts, ignores it and logs a warning (`docs/configuration.md`, "Removed settings"); their columns stay until a later release (section 5.3).*

### 5.5 Keys per project and linked installations (tickets 45 to 47)

Added 2026-11-19 with F-135 and F-136 (ADR 0065). A second migration, after ticket 05's, additive only, under the same rules: every row carries `organizationId`, and every project record `projectId` with the composite key.

| Change | What |
|---|---|
| `AgentProfile` | + `modelCatalogId`, `modelCustomName`: the model by name, at most one set (a check constraint). Back-filled from the profile's `Model` (`catalogId`, else `endpointModelId`). `modelId` stays: this release still writes it, as the default list's row for the name, so a rollback works; nothing new reads it, and a later release drops it |
| New `ProviderListEntry` | `projectId` (null for the organization's default list), `providerId` (composite key to the organization's provider), `addedByMemberId`, `createdAt`. Unique `(organizationId, projectId, providerId)`, with a partial unique index for the default's rows. Back-filled: every existing provider on its organization's default list |
| `Project` | + `ownProviders` (default false: the project follows the default list) |
| New `ModelChoice` | `projectId` (null for the organization's default), `modelCatalogId` or `modelCustomName`, `modelId` (the chosen `Model` row, whose provider the domain checks is on the same list), `chosenByMemberId` (null when ostra kept the current one), `reason` (`admin`, `kept`, `upgrade`), `needsConfirm` (default false), `updatedAt`. Unique per list and model name. Back-filled: each model name's default choice from the oldest profile that names it, with `needsConfirm` where profiles named it on different providers |
| `Session` | + `providerId`, `modelId` (composite keys): what its start resolved. Back-filled from the session's profile's model |
| `Connection` | + `ownerLogin`, `ownerAccountId`: the App's owner, from `readApp`, filled on the next read for existing rows |
| New `CodeHostInstallation` | `connectionId` (composite key), `installationId`, `accountId`, `accountLogin`, `accountKind` (`organization`, `user`), `state` (`linked`, `removed`), `linkedByMemberId` (null for the owner's own, or the upgrade's), `linkedAt`, `removedAt`, `removedByMemberId`. Unique `(connectionId, installationId)`. Back-filled: one `linked` row per installation an existing repo uses |
| `Repo` | + a foreign key `(organizationId, connectionId, installationId)` to `CodeHostInstallation`, which the backfill satisfies |
| Enums | `NeedsYouReason` + `no_provider_for_model`; `NeedsYouAudience` + `organization_admins`; new `ModelChoiceReason`, `InstallationState`, `InstallationAccountKind` |

- **The protocol** (ticket 46, in ticket 01's minor 3): `TaskSpec.repos[]` gains an optional `gitIdentity`, the bot of that repo's App. A minor-2 runner gets the top-level `gitIdentity` alone, so the dispatch sends a task whose repos have different bots only to a minor-3 runner (`needs-protocol`, as milestone 3's profile features do). Nothing else in the runner changes: the spec already names one provider and one model.
- **The domain** (tickets 45 and 46):
  - the branded `ModelName`: `{ kind: "catalog", catalogId } | { kind: "custom", endpointModelId }`
  - pure: `resolveProjectModel(list, choices, models, name)` → `{ ok: true, providerId, modelId } | { ok: false, reason: "no-provider" | "not-listed" }`; `planProviderChange(before, after)` → every model that keeps, moves or loses its provider, and the choices to record; `keepChoicesOnRefresh`; `providerGate(session, project)` → `open` | `moved { providerId, modelId }` | `none { modelName }`; `installationUsable(row)`
  - access: `canEditProviderLists` (organization admin), `canSeeProjectProviders` (anyone who can open the project, names only)
  - the dispatch wait codes `no-provider-for-model { modelName }` and `provider-not-allowed`, and the needs-you item for organization admins
  - audit actions: `providers.default-changed`, `project.providers-changed`, `project.model-choice-changed`, `task.credentials-refused`, `installation.linked`, `installation.unlinked`, `installation.removed`, `connection.added`
  - use cases: `setDefaultProviders`, `setProjectProviders`, `previewProviderChange`, `chooseModelProvider`, `confirmUpgradeChoice`, `resolveSessionModel`, `linkOwnInstallation`, `linkInstallation`, `unlinkInstallation`, `removeInstallation`, `connectExistingApp`
  - the job `providers.release-boxes` (key: project and the change's time)
- **`CodeHostAdapter`** (ticket 47): `appManifest` takes `public`, and a public App's homepage is ostra's project page; `removeInstallation(app, installationId)`; `listInstallations` returns each account's ID; `readApp` returns the App's owner; `parseWebhook` gains `installation` (created, deleted, suspend, unsuspend) and `installation_repositories` (added, removed). **Capability, new:** `installableByOtherAccounts: boolean` (GitHub: true). The fake GitHub gains a second account, a stranger's installation and a removal.
- **No new setting.** A fresh install's first provider is on the default list, and a private App links its own installation, so the required settings alone still work.

### 5.6 Reasoning effort (tickets 56 to 58)

Added 2026-11-19 with F-137 (ADR 0066, `research/opencode-reasoning-effort.md`). A third migration, after ticket 45's, additive only, under the same rules.

| Change | What |
|---|---|
| Enum `EffortLevel` | `default`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `on` |
| `Model` | + `catalogReasoning` (the catalog's controls, written by the sync), `adminReasoning` (an admin's, which wins and which a refresh never touches). Both JSON, parsed by the protocol's `reasoningControlsSchema`, nullable |
| `AgentProfile` | + `effort` (default `default`) |
| `Task` | + `effort` (default `default`): copied from the profile at creation, changed by the driver |
| `Turn` | + `effort` and `effortAdjustedFrom` (nullable for earlier turns), `reasoningTokens` (default 0) |
| `Session` | + `reasoningTokens` (default 0) |

- **The protocol** (ticket 56, in ticket 01's minor 3):
  - `effortLevelSchema` and `reasoningControlsSchema` (models.dev's v2 shape: `{ supported: false }`, or `{ supported: true, toggle?, effort?, budget?: { min?, max? } }`)
  - the task spec's `agent` gains `effort`, `reasoning` and `limits: { contextWindow, maxOutputTokens }`
  - the command `set-effort { sessionId, level, changeId }`
  - `turn.started` gains `effort` and `adjustedFrom`, and `usage.recorded` gains `reasoningTokens`
  - the server-only `effort.changed { from, to, memberId }`

  A task whose level isn't `default` goes only to a minor-3 runner (`needs-protocol`). A minor-2 runner gets the spec without the new fields, and keeps its fixed limits.
- **The domain** (ticket 56):
  - pure: `effectiveReasoning(model)` and `clampEffort(requested, offered)`, by ADR 0066's rules
  - access: `canSetTaskEffort` (the driver)
  - use cases: `setModelReasoning`, `setTaskEffort` (under the task's counter lock), and the profile save's level
  - audit actions: `model.reasoning-changed`, `task.effort-changed`
- **`AgentAdapter`** (ticket 57):
  - **Capability, new:** `reasoningEffort: "session-option" | "relaunch" | "none"`. OpenCode declares `session-option`.
  - **Methods:** `effortLevels(input)` and `effortValue(level, input)`, from a model's controls, API format, endpoint ID and limits; and the base class's `setEffort(session, level)`, by the option of category `thought_level`.
  - **Driver:** `newSession` and `loadSession` return the session's `configOptions`. `PrepareLaunchInput.model` gains `reasoning` and `limits`.
  - **Tests:** the scripted fakes cover `session-option` and `none`, and the contract suite runs the research's cases (section 1.7) against the pinned OpenCode on every bump.
- **`ModelProviderAdapter`** (ticket 58): `CatalogEntry` gains `reasoning` and `reasoningPriceDiffers`, from models.dev's `reasoning`, `reasoning_options` and `cost.reasoning`, in the bundled copy and the daily fetch.
- **No new setting.** A model with no known limits keeps today's 128,000 and 16,000, and every level starts at `default`, so a fresh install behaves as before until an admin picks a level.

---

## 6. Packages, licenses and owners

| Package | License | New in M4 | Built by |
|---|---|---|---|
| `packages/protocol` | Apache-2.0 | minor 3 | core (01) |
| `packages/adapter-sdk` | Apache-2.0 | the memory capability and fakes, reviews and check runs, account and budget mail kinds, four prices | adapters (02, 03, 04) |
| `packages/adapters/adapter-opencode` | Apache-2.0 | the memory block at launch, the tools in its MCP list | adapters (07) |
| `packages/adapters/adapter-github` | Apache-2.0 | reviews, check runs, PR bodies, the review webhooks | adapters (08) |
| `apps/runner` | Apache-2.0 | the memory block, `memory.used`, the three memory tools in the sidecar, several repos side by side | runner (20, 21) |
| `packages/db` | Sustainable Use | the M4 migration, the isolation model list | core (05, 09) |
| `packages/domain` | Sustainable Use | lifecycles, access, the gate, Insights, memory, several repos, the evaluator, mails, use cases, jobs, settings | core (06); bodies by core and api |
| `apps/core` | Sustainable Use | the audit writers, search entries, spend, budgets, Insights, memory endpoints, proposals, related PRs, the check, account mails | core (09 to 19) |
| `packages/api` | Sustainable Use | invitations, members, organizations, audit, search, spend, Insights, memory, project repos | api (22 to 30) |
| `apps/web` | Sustainable Use | the M4 screens | web (31 to 39) |
| `e2e/m4-the-organization` (new) | Sustainable Use | the demo, the mail sink and `dev:link-github` | core (40, 41) |

Tickets 45 to 51 (added 2026-11-19) add to `packages/db`, `packages/domain`, `packages/protocol` (a git identity per repo), `adapter-sdk`, `adapter-github`, `apps/core` and `packages/api`, and tickets 52 to 54 to `apps/web` and the targets, as each ticket says.

Tickets 56 to 63 (added 2026-11-19 with F-137) add to `packages/protocol`, `packages/db`, `packages/domain`, `adapter-sdk`, `adapter-opencode`, `adapter-model-endpoint`, `apps/core`, `apps/runner`, `packages/api`, `apps/web` and the targets, as each ticket says. The runner and the adapters import only `packages/protocol` and `adapter-sdk` for it.

The license line holds (ADR 0045, ADR 0048): no Apache-2.0 package depends on a Sustainable Use one. The sidecar's memory tools reach core over HTTP and import only `packages/protocol`. `pnpm check:licenses` runs on every commit.

---

## 7. The builders and their tickets

Five builders: **core**, **runner**, **web**, **api** and **adapters**. Core and adapters make the contracts first (01 to 06), each with the fakes its callers need. Tickets 42 and 55 are the maintainer's.

| # | Ticket | Builder | Blocked by |
|---|---|---|---|
| 01 | Protocol: minor 3 | core | none |
| 02 | Adapter SDK: memory for agents | adapters | 01 |
| 03 | Adapter SDK: reviews, check runs and PR bodies | adapters | none |
| 04 | Adapter SDK: account and budget mails, and four prices | adapters | none |
| 05 | DB: the milestone 4 migration | core | none |
| 06 | Domain: lifecycles, access, the gate, Insights, memory, several repos, the evaluator, mails | core | 01, 05 |
| 07 | OpenCode adapter: the memory block and the memory tools | adapters | 02 |
| 08 | GitHub adapter: reviews, check runs, PR bodies and the review webhooks | adapters | 03 |
| 09 | Core: isolation for every kind of record | core | 05, 06 |
| 10 | Core: the audit log for every action | core | 06 |
| 11 | Core: search entries and their backfill | core | 06 |
| 12 | Core: spend rollups and the budget gate | core | 06 |
| 13 | Core: budget notices and their release | core | 04, 12 |
| 14 | Core: the Insights job | core | 06, 12 |
| 15 | Core: memory in the task spec, and the memory endpoints | core | 01, 06 |
| 16 | Core: proposals and "Remember this" | core | 06, 15 |
| 17 | Core: several repos, and the related PRs | core | 06, 08 |
| 18 | Core: the independent-review check | core | 06, 08 |
| 19 | Core: account mails | core | 04, 06 |
| 20 | Runner: the memory block and the memory tools | runner | 01, 07 |
| 21 | Runner: several repos side by side | runner | 01 |
| 22 | API: invitations, sign-up, verification and resets | api | 06, 19 |
| 23 | API: members, roles and project access | api | 06, 10 |
| 24 | API: organizations and the instance admin. *`wontfix` since 2026-11-19 (F-134, after v1); its instance-admin half is ticket 43* | api | 06, 23, 43 |
| 25 | API: the audit log and the task's event log | api | 10 |
| 26 | API: search | api | 11 |
| 27 | API: spend, budgets and prices | api | 12, 13 |
| 28 | API: Insights | api | 14 |
| 29 | API: memory notes, proposals and the task's memory | api | 15, 16 |
| 30 | API: project repos and the review check | api | 17, 18 |
| 31 | Milestone 4 screen targets | web | none |
| 32 | Web: members, invitations, accepting and resets | web | 22, 23, 31 |
| 33 | Web: project access and the instance's accounts. *Trimmed 2026-11-19: the switcher and the Organizations page are ticket 44* | web | 23, 31, 43 |
| 34 | Web: the audit log and the task's event log | web | 25, 31 |
| 35 | Web: search | web | 26, 31 |
| 36 | Web: spend and budgets | web | 27, 31 |
| 37 | Web: Insights | web | 28, 31 |
| 38 | Web: Memory, proposals and the task's memory | web | 29, 31 |
| 39 | Web: project repos, the task with several repos, and the check | web | 30, 31 |
| 40 | Dev tools: the mail sink and the dev GitHub link | core | 05 |
| 41 | The end-to-end demo and the ledger | core (lead) | 09, 13, 14, 18, 19, 20, 21, 32 to 40, 48, 49, 53, 54, 59, 60, 63 |
| 42 | The maintainer's steps outside the code | maintainer | none for the decisions; 41 for the review of the run |
| 43 | API: the instance admin's accounts (split from 24 on 2026-11-19) | api | 06, 23 |
| 44 | Web: the organization switcher and the instance's Organizations page (split from 33 on 2026-11-19). *`wontfix`: F-134, after v1* | web | 24, 31, 33 |
| 45 | Contracts: keys per project (DB and domain) | core | 05, 06 |
| 46 | Contracts: linked installations, several Apps and a bot per repo | core | 01, 05, 06, 45 |
| 47 | GitHub adapter: a public App, installation events and removing an installation | adapters | 03 |
| 48 | Core: keys enforced at the dispatch, the credentials and every turn start | core | 12, 45 |
| 49 | Core: linked installations, their webhooks and each repo's bot | core | 46, 47 |
| 50 | API: provider lists, model choices and the model by name | api | 27, 48 |
| 51 | API: GitHub organizations, installations and several Apps | api | 30, 49 |
| 52 | Screen targets: keys per project and GitHub organizations | web | none |
| 53 | Web: Models, a project's Models and keys, the profile's model and "no key" | web | 36, 50, 52 |
| 54 | Web: GitHub organizations and installations | web | 39, 51, 52 |
| 55 | The maintainer's steps for keys per project and GitHub organizations | maintainer | none for the decisions; 41 for the review of the run |
| 56 | Contracts: reasoning effort (protocol, DB and domain) | core | 01, 05, 06, 45 |
| 57 | Agent SDK and OpenCode: the effort capability, the levels and the real limits | adapters | 02, 07, 56 |
| 58 | Model catalog: each model's reasoning controls | adapters | 04, 56 |
| 59 | Core: effort and limits at dispatch, and a change for the next turn | core | 48, 56, 57, 58 |
| 60 | Runner: the effort set over ACP, at every session start and before the next turn | runner | 20, 21, 56, 57 |
| 61 | API: effort on profiles, models and tasks | api | 50, 59 |
| 62 | Screen targets: reasoning effort | web | none |
| 63 | Web: the effort on the profile, the task page and the Models page | web | 53, 61, 62 |

**Who starts when.** core takes 01 and 05 at once, then 06; adapters take 03 and 04 at once, 02 after 01. runner takes 21 after 01 and 20 after 07. api starts on 23 once 06 and 10 are in. web takes 31 at once; its screen tickets wait for the targets' approval (section 12). Milestones 2 and 3's tickets come first wherever both touch a file: a milestone 4 ticket that meets an earlier milestone's ticket still open on the same package waits for it, and says so in its `## Comments`. Tickets 45 to 55 came with F-135 and F-136 on 2026-11-19: core takes 45 after 06, and 46 after 01 and 45; adapters take 47 after 03; web takes 52 at once. Tickets 56 to 63 came with F-137 the same day: core takes 56 after 01, 05, 06 and 45; adapters take 57 after 02 and 07, and 58 after 04; web takes 62 at once. They wait for nothing else in the milestone, so F-137 can be built as soon as those contracts are in.

---

## 8. Test seams

Agreed here so builders don't each invent one.

- **Postgres:** milestone 1's helper, a database per test file. Every test that reads data also checks another organization's rows and a restricted project's rows stay invisible.
- **Two organizations and three members:** `seedOrganization(db, { name })` and milestone 3's `seedMember(db, { … })` in `@ostra/domain/testing`, used by every access test, and by ticket 09's generated test.
- **The isolation model list:** `packages/db/src/testing/isolation-models.ts`, one fixture builder per model with `organizationId`, and the allowlist; ticket 09's test reads Prisma's DMMF and fails on a model on neither list.
- **Mail:** milestone 3's fake SMTP server and fake Resend. Ticket 40 wraps the fake SMTP server as `pnpm dev:mail-sink` for the demo, writing each message to `.data/mail/<time>-<to>.eml`, and a helper reads the newest mail to an address and its first link.
- **Agents:** milestone 3's scripted fakes, plus ticket 02's memory-calling fake and the index-only fake. A fake core for the sidecar's memory endpoints in `@ostra/adapter-sdk/testing`, answering by the protocol's schemas.
- **GitHub:** the fake code host gains reviews (with dismissals and bots), check runs and the branch-protection modes of section 5.2. The live cases run against `ostra-test/test1` and `test2`, with branch protection set and removed by the test token.
- **Linear:** milestone 2's fake Linear server; the live cases against `OST`.
- **Time:** invitation and reset expiry, the budget month, the Insights schedule and the warn threshold read the `Clock` port or a setting.
- **Search and memory text:** a fixture set of messages, commands and notes with code identifiers, mixed languages and near-duplicates, used by the search tests and the related-notes tests, so ranking regressions show.
- **Two model keys** (F-135): two of the e2e stub model endpoints, each with its own token, both listing one model under the same catalog ID and one listing a second model the other lacks, each recording which token every call carried, so a test can show a project's calls carried its own key alone. One stub answers a rate limit on request.
- **Two GitHub accounts** (F-136): the fake GitHub's second account, with the App installed by its owner (waiting until linked), a stranger's installation, and a second App the second account owns.
- **Reasoning effort** (F-137): the e2e stub model endpoints record, for each request, the fields that carry an effort and an output limit (`reasoning_effort`, `thinking`, `output_config`, `max_tokens`, `max_completion_tokens`), never the prompt. The catalog fixture gives the two stubs' shared model a list of effort levels and their second model none. Ticket 57's contract cases use the same stub against the pinned OpenCode.

---

## 9. Every ticket's checks and commit

As milestones 1 to 3 (`../m1-first-pr/spec.md`, section 9). In short:
- `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for the touched packages, and `pnpm check:licenses` passes.
- Tickets that touch auth, credentials, the schema, the runner protocol, webhooks or anything that runs agent output (01, 02, 05, 07, 08, 09, 15, 18, 19, 20, 21, 22, 23, 41, 43, and since 2026-11-19 45, 46, 47, 48, 49, 51, 56, 57, 59 and 60) run all the checks for the whole repo.
- Every new setting has a working default and its line in `docs/configuration.md`. A fresh install with only the required settings still works, with mail off.
- **Proof** (`AGENTS.md`, `context/proof/README.md`): a test that proves a condition of a row's "done when" names the row's ID in its title (`it("F-049: a member of one organization never sees another's runners", ...)`), runs in CI, and has a break-it check. The ticket adds its rows to `context/proof/F-nnn.md` (`pnpm proof:new F-nnn` writes the file), and `pnpm check:proof` passes. A condition only a live run shows cites the run's log or screenshot kept in the repo, which ticket 41 records.
- No secret in the commit. Logs carry IDs and fields, never tokens, invitation or reset links, notes, queries, prompts, ticket text, comments or agent output. Member, PR, note and agent text is never interpolated into a shell command or into SQL: search and memory queries go through bound parameters only.
- A `package.json` change goes with its `pnpm-lock.yaml`. Nothing new is added without the maintainer's yes; milestone 4 needs no new dependency (section 10).
- Stage only the ticket's own paths, a gitmoji message of at most 50 characters, no AI attribution, `git pull --rebase origin main`, `git push origin main`, retrying on a rejected push.
- The ticket file gets its `Status:` updated and a line under `## Comments` with the commit's hash.

### 9.1 How each row gets proved

Each condition of a row's "done when" gets a row in its proof file. This is where the proofs are expected to come from; the building tickets write them, and ticket 41 checks every one.

| F-ID | Proved by tests (kind, ticket) | Live evidence (step of section 3, kept by ticket 41) |
|---|---|---|
| F-002 | Integration through better-auth's HTTP: sign-up refused without an invitation, allowed by its ID, refused by a known address alone; one use, expiry, revoke; the `owner` refusal; verification with email on; an existing account joins; the reset link's one use and 24 hours; a reset signs out other sessions; only the instance admin creates one without email; removal's transaction (22, 23, 19) | Steps 1, 12, 14: the mails as screenshots with addresses masked, the members list |
| F-003 | The matrix: every procedure called as an admin, a member, and each project role, from a table in the test, each expecting its result; the last-admin and last-instance-admin races (09, 23, 43) | Steps 2 and 12 |
| F-087 | The generated test as a member who can't open a restricted project, over every project record; a project admin's edits allowed and a member's refused (09, 23) | Step 2 |
| F-049 | The generated test over every model and query procedure, against a fixture organization; its guard on a model with no `organizationId` that isn't on the allowlist (09); milestone 1's seed of the first organization (F-001's seed test) | The checks after the run, "Isolation for every kind of record". *Changed 2026-11-19: organization creation, the switcher and step 12's second organization moved to F-134* |
| F-073 | One test per action of ADR 0054's list, asserting its entry in the change's transaction (a rollback leaves none); append-only; filters and export; the event log view's full inputs; the canary control (10, 25, 02) | Step 10, with the session-export comparison's log |
| F-080 | Search by ticket, repo, member, state and text, each with a near miss that must not match; access in the query for every visibility case; the backfill's idempotence (11, 26) | Step 11 |
| F-037 | Spend at ingest into the rollup, equal to the tasks' sums; the four prices and their order; 80% and 100% notices once per month, in the panel and by mail; the gate for every origin; a running turn finishes; the release in order; an unpriced model held (12, 13, 27) | Step 6, with the mails |
| F-108 | Each figure against the reference definitions on a fixture of tasks, PRs and needs-you items; the schedule's idempotence; "computed N minutes ago" (14, 28) | Step 13 |
| F-109 | Notes with kinds, versions, sources and status; full-text search; each secret shape and model-control token refused with a negative control; a stale edit refused; an audit entry per change; access per scope (16, 29) | Step 7 |
| F-110 | The contract cases of ticket 02 on the fakes and on OpenCode; the spec's memory section with its order and limits; the endpoints scoped to the task's organization and project; `memory.used` and the task page's list; only reads move a note's last use; a minor-2 runner's folded instructions (02, 07, 15, 20, 29) | Step 9, with the config folder's listing and `git status` |
| F-111 | A proposal reaches no agent until approved (the next spec doesn't hold it); approve, merge, reject; a stale merge refused; related notes shown; the per-task cap; "Remember this" on a diff comment and a PR comment; the closing turn's switch, off by default (15, 16, 20, 29) | Steps 8 and 9. The AI finding's condition stays `missing` until milestone 6 |
| F-098 | Two repos side by side in one workspace; one branch name; one PR per changed repo; "Related" in each, idempotent; the ticket links each; the diff, checks and reopen per repo; milestone 2's set rule, both orders (17, 21, 30) | Steps 3 and 4, with the PRs' URLs |
| F-104 | The evaluator's cases (spike 4's, ported); the webhook flips both ways; a new head pending; unlinked, bot and driver approvals; both branch-protection modes on the fake (08, 18) | Step 5, with the check runs' URLs and which mode GitHub showed |
| F-115 | The account and budget mails rendered and sent on both providers, links in both parts (04, 13, 19) | Steps 1, 6, 14 |
| F-135 | The resolution's table; the keep rule on a list change and on a refresh; the isolation test at the dispatch and at the credentials endpoint with a forged session row, and its break-it; every turn start's check, and idle boxes released; no move on a hold, a cap or an error; "no key" on New task, on a queued task and in needs-you for organization admins only; spend per key from each provider's own prices; the cap across projects; personal runners; the access matrix; an audit entry per change; another organization's provider refused by the key; the upgrade on a milestone 4 database (45, 48, 50, 53) | Steps 16 and 17, with the usage events per session and the stub endpoints' logs |
| F-136 | The manifest's `public` both ways; the owner's installation linked when seen and another waiting; no mint, no repo offered and no delivery stored for an unlinked installation, each with its break-it; a repo of an unlinked or removed installation stops new tasks; removing uninstalls; a client's App connected with its own webhook address and a generated secret; a bot per repo, and no offer to a minor-2 runner; an audit entry for each (46, 47, 49, 51, 54, 64) | Step 15, and step 16's PRs in two GitHub organizations (live with ticket 55's second organization, otherwise on the fake GitHub, said in `demo.md`) |
| F-137 | The catalog's controls kept and converted (58); the levels each adapter computes equal what OpenCode advertises, each level in the request body, `Default` sending nothing, the model's output limit in the request, and a level surviving `session/load` (57, the contract suite); the clamp table over every level and kind of model (56); the spec's level, controls and limits, `needs-protocol`, the driver-only change and its race, one level a turn, the reopen and the rebuild template (59, 60); reasoning tokens in both formats (57, 60); the access matrix, the custom model's form and the override across a refresh (61); the three screens (63) | Step 18, with the stub endpoint's recorded request fields, or the live endpoint's turns with their levels and reasoning tokens |

---

## 10. What each ticket ports

| From | What | To (ticket) |
|---|---|---|
| `spikes/auth-foundation/src/auth/create-auth.ts` | the invite-only `before` hook on sign-up, recognising the invitee by the invitation's ID | 22 |
| same, `src/auth/link-sink.ts` | the per-request sink that catches better-auth's reset link for the asking admin | 22 |
| same, `src/scenarios/accounts.ts`, `src/scenarios/reset-link.ts` | the invitation and reset scenarios, as integration tests | 22 |
| same, `src/scenarios/isolation.ts`, `src/ostra/organization-scope.ts` | the isolation scenario and the scoped store's shape | 09 |
| same, `src/auth/roles.ts` | the `owner` refusal's cases | 23 |
| `spikes/github-app-and-git-proxy/src/github/independent-review.ts` | the evaluator and its review shape | 06, 18 |
| same, `src/harness/review-local.ts` | the local review harness: reviews, dismissals and the check's flips against a fake | 08, 18 |
| `spikes/is-opencode-good-enough/src/harness/criteria.ts` | the audit's reach check, as the canary control, where milestone 1's suite lacks it | 02 |

**Dependencies.** None new. Search and memory use Postgres full-text search (ADR 0017, ADR 0044, ADR 0054), with no extension. The memory tools use `@modelcontextprotocol/sdk`, already in the runner since milestone 1. The CSV export is written by hand (a quoted field per column). The mail sink is milestone 3's fake SMTP server.

---

## 11. Choices this spec makes

The maintainer delegated every decision of this spec on 2026-11-19. Each choice below is the recommendation applied, recorded in `context/open-questions.md` under its number and, where it's hard to reverse, in an ADR. If the maintainer disagrees with one, it moves back to the open list and the ticket that holds it changes.

1. **Removing a member** (Q191, ADR 0053). ostra's own use case marks the membership removed and keeps it, so history keeps names. Its project roles, personal runners, CLI sessions, driving, drafts and invitations go in the same transaction. The account stays.
2. **Who invites, to what** (Q192, ADR 0053). Organization admins invite, with a role and optional restricted projects. Project admins add existing members to their project and invite nobody new. An address with an account joins by signing in.
3. **Verification and self-service resets** (Q193, ADR 0053). With email set up, the invitee's address is locked to the invitation and verified by a mailed link before the membership is active, and members reset their own password by mail. Without email, the link alone is enough and only the instance admin makes reset links.
4. **The last admin** (Q194, ADR 0053). An organization keeps one admin and an install one instance admin. The instance admin role grants nothing inside an organization the account isn't in.
5. **Several organizations** (Q195, ADR 0053). The active organization is in the session, and the account remembers its last one. Links across organizations switch with a notice. New organizations get a pool and the built-in profile. *After v1 since 2026-11-19 (F-134), on the maintainer's word: v1 ships one organization per install. The choice stands for then.*
6. **Isolation for every record** (Q196, ADR 0053). A test generated from the schema's model list, with a fixture per model and a reviewed allowlist, fails on any model that's on neither. Its second organization comes from fixtures (2026-11-19).
7. **The audit log** (Q197, ADR 0054). People's actions in `AuditEntry`, an agent's in the event log, linked. A credential's use is one entry per issuance. Append-only, kept while the organization exists. Organization admins read it all and export CSV; project admins read their project's.
8. **Search** (Q198, ADR 0054). Postgres full-text, `simple` configuration, over a search table written at ingest: titles, prompts, tickets, messages, tool inputs; not thoughts or output. Filters as columns, access in the query, results as tasks. A palette and a page.
9. **Budgets** (Q199, ADR 0055). Calendar months in UTC, dollars. 80% and 100% notices once per budget and month. At 100% no new task and no new turn starts, held in order and released on a raise; running turns finish. One gate for every origin. Unpriced models wait where a budget applies.
10. **Insights** (Q200, ADR 0055). Six figures with fixed definitions, computed every 5 minutes into daily rows and per-task metrics. A hidden project's share is "Other projects".
11. **Memory's secret scan and who writes** (Q201, ADR 0044 amended). The organization's own secret values and a fixed list of credential shapes, and since Q91 a list of model-control tokens; a hit refuses, naming the kind. Members write and approve in what they can open; archiving another's note needs an admin of its scope.
12. **The index and the tools** (Q202, Q203, ADR 0044 amended). 100 notes and 8 KiB, plus 8 KiB of "always" notes, project first, then by last read (Q91). Three tools on the sidecar's MCP server, forwarded to core with the task's token. 20 proposals a task.
13. **Q91 is settled** (ADR 0044, "Q91: what the prior art changed"). The prior-art research (`research/project-memory.md`) landed on 2026-11-19, after this spec was first written, and confirms the design. Milestone 4 builds the search ADR 0044 names, with five changes: only a read counts as a note's use, so the index is ordered by last read (tickets 06, 15); the secret scan refuses model-control tokens (06, 15, 16); edits and merges check the version (16, 29, 38); each agent's own memory stays off (02, 07); and the block names its notes as approved, each with its source (06, 07).
14. **Contradictions** (Q204, ADR 0044 amended). The agent declares a relation, and ostra shows the three highest-ranking notes beside every proposal. The member decides; ostra calls no model.
15. **"Remember this" in milestone 4** (Q205, ADR 0044 amended). On diff comments and accepted `@ostra` comments. AI review findings in milestone 6.
16. **Several repos** (Q206, ADR 0027 amended). Up to 10 per project, all checked out, the agent at the root with the repos listed, "Related" sections in every PR, a repo added joins the next session, a repo in use can't be removed.
17. **The independent-review check** (Q207, ADR 0040 amended). Only approvals from GitHub users linked to an active non-driver member count. Evaluated on reviews, new heads, links, trailers and the reconcile. On every task PR. `in_progress` until the live test shows it doesn't block, then `action_required`.
18. **A dev-only GitHub link** (Q208, ADR 0053). `pnpm dev:link-github`, refused outside development and test, for the scripted run's reviewer user.
19. **The protocol window** (Q209). Minor 3. A minor-2 runner gets the memory notes folded into its instructions and no tools, and every other milestone 4 feature works on it unchanged.

Added 2026-11-19 with F-135 and F-136, from the maintainer's request, on the same delegation (ADR 0065). Ticket 55 asks the maintainer to review them.

20. **Keys per project** (Q270, Q273, Q275, ADR 0065). Each project follows the organization's default provider list or has its own, which only an organization admin edits; the default may be empty, and the first provider joins it. Each model is served by exactly one provider on a project's list, and only an admin's save moves it. The server checks it at the dispatch, at the credentials endpoint and at every turn start; a running turn finishes, idle boxes holding a removed key are released, and nothing falls back to another key.
21. **The model by name, and no pin** (Q271, Q272, ADR 0065, ADR 0049 amended). A profile names its model by its models.dev catalog ID or a custom model's endpoint ID, so one profile works in every client's project. It pins no provider: the project's list is the one place that decides a task's key.
22. **No key, who sees what, spend and the upgrade** (Q274, Q276, Q277, Q278, ADR 0065, ADR 0055 amended). No key for the model: the task can't start, says so, and a queued one shows in needs-you for organization admins. Spend per key, per project and per organization; budgets stay per organization and per project; caps, holds and the personal-runner switch stay per provider. Project admins and members see a project's providers by name, never a token. The upgrade puts every provider on the default list and keeps every task on the provider it used, except where two profiles named one model on two providers, which is marked for an admin.
23. **Repos from several GitHub organizations** (Q279 to Q283, ADR 0065, ADR 0040 amended). Both ways: the client installs the organization's App, made public only when the manifest form says so, or the client's own App is connected beside it. ostra works only through linked installations: the App owner's own is linked when seen, any other waits for an admin, and nothing is minted, offered or stored for it until then. Each repo's commits are its own App's bot's, at protocol minor 3.
24. **The live runs** (Q284). Ticket 55's second test GitHub organization and second model key; until they exist, the fake GitHub's second account and two stub endpoints, said in `demo.md`.

Added 2026-11-19 with F-137, from the maintainer's question and two of their answers (a change on a running task is wanted, and a level a model lacks is hidden or clamped, never an error). The lead settled the rest by the research's recommendation, and ticket 62's approval is the maintainer's review of them (ADR 0066).

25. **The levels** (Q285, ADR 0066). A model's levels are what its catalog entry lists, as far as its agent can send them, with `Default` always first and sending nothing. One closed vocabulary, models.dev's own plus `default` and `on`. A model that doesn't reason shows no control.
26. **Custom models and overrides** (Q286). An organization admin says whether a custom model reasons and at which levels. The same form overrides a catalog model's controls on one provider, kept across a refresh.
27. **Delivery** (Q287). Over ACP, on the `thought_level` option, after every `session/new` and `session/load`. The config carries the model's own controls, and never a `#variant`, which ACP would misreport.
28. **A change on a running task** (Q288, the maintainer's yes). By the driver, from the next turn: a turn runs at one level and records it.
29. **The clamp** (Q289, the maintainer's rule). To the nearest level the model has, the higher of two equally near, shown on the task page. The runner clamps again to what the agent advertised.
30. **The limits** (Q290). The model row's own window and output limit. 128,000 and 16,000 only when neither is known.
31. **Reasoning tokens** (Q291). Counted inside output, as today, and shown per turn. Priced as output in v1, with the Models page marking a model whose catalog lists a different reasoning price.
32. **Where** (Q292). Milestone 4: it rides minor 3 and the model by name, and its tickets wait only for the contracts.

---

## 12. Screens that need a design target

`build-order.md`: a milestone's screens are designed first, image first. The maintainer requires the `ui-taste` skill and Higgsfield targets, approved before building, against `context/brand/brief.md` and `context/brand/app-design.md`. **This spec names them; ticket 31 makes them,** in the form milestones 1 to 3's approved targets have (`context/brand/app-targets/m1/README.md`: a picture, a build spec and a prompt per screen). Until they're approved (recorded in ticket 31's `## Comments`), tickets 32 to 39 don't start their UI; their routers and tests can go ahead.

**New targets**, for what's new in milestone 4:

| # | Target | Screen | Feature | Starts from |
|---|---|---|---|---|
| 1 | `members` | Organization, "Members": active members with role, projects and last active; pending invitations with "Copy link" and "Revoke"; removed members folded under "Removed"; "Invite"; the row menu (change role, remove) | F-002, F-003 | `app-targets/m1/runners` |
| 2 | `member-invite` | The invite sheet: address, organization role, restricted projects with a role each; then the link shown once with "Copy link", "Send it privately", and "Mailed to …" or "Mail is off" | F-002, F-087 | `app-targets/m1/project-new` |
| 3 | `accept-invite` | The page an invitation link opens: "Join Demo on ostra", who invited, the address locked, username and password; "Sign in to accept" for an existing account; "Check your inbox"; the expired, revoked and used states | F-002 | `app-targets/m1/sign-in` |
| 4 | `reset-password` | "Forgot your password?" (the address, and the same answer either way), and the page a reset link opens: a new password, and the expired and used states | F-002 | `app-targets/m1/change-password` |
| 5 | `project-access` | A project's settings, "Access": open or restricted, the listed members with project roles, "Add member", and the line that organization admins always see it | F-087, F-003 | `app-targets/m2/project-boards` |
| 6 | `org-switcher` | The sidebar's organization switcher, open: the member's organizations, the active one marked, "New organization" for the instance admin; the create sheet; the "Switched to Second" notice. *Postponed 2026-11-19 with F-134, after v1 (ticket 44); the files stay* | F-134 (was F-049) | `app-targets/m1/home` |
| 7 | `instance-settings` | The instance admin's pages: Organizations (each with its members and projects counts, "New organization"), Accounts (search an account, "Create reset link", instance admins). *Changed 2026-11-19: open sign-up's two switches are out (ADR 0026, amended). Changed again 2026-11-19: the Organizations page waits for F-134, after v1 (ticket 44); Accounts is built (tickets 33 and 43)* | F-002, F-003 (F-134 for Organizations) | `app-targets/m2/storage-settings` |
| 8 | `audit-log` | Organization, "Audit log": the table (time, actor, action, entity, project), filters for actor, action, project and period, an entry's detail with its data and a link to the task's event log, "Export CSV" | F-073 | `app-targets/m1/runners` |
| 9 | `task-event-log` | The task page's "Event log" view: every event in order, a tool call with its kind, full input (command and folder, paths, URL), status and error, an approval with its command, filters by kind, and the line on what a record can't show | F-073 | `app-targets/m3/task-checks` |
| 10 | `search-palette` | The Ctrl+K palette over any page: the query with filter tokens (`repo:`, `status:`, `by:`), the top tasks with snippets and what matched, keyboard hints, "See all results" | F-080 | `app-targets/m1/home` |
| 11 | `search` | The search page: the query, filters as controls (project, repo, ticket, member, state, period), results as tasks with snippets, and the empty state | F-080 | `app-targets/m2/inbox` |
| 12 | `spend-budgets` | Organization, "Spend": this month against the budget, per project with each budget's bar, per model, the overshoot, the unpriced-model warning, "Set budget"; a model's four-price form | F-037 | `app-targets/m1/models` |
| 13 | `insights` | Insights for an organization or a project: the period picker, the six figures with their trend over the period, PRs opened and merged by day, waiting by reason, tokens and spend by project and model, "computed N minutes ago" | F-108 | `app-targets/m1/home` |
| 14 | `memory` | A project's or the organization's Memory page: notes with search and kind filters, scope tabs, "always" marks, last used, "N proposals", "New note" | F-109, F-111 | `app-targets/m2/inbox` |
| 15 | `memory-note` | A note's editor and history: title, body, kind, scope, "always", its source, its versions with who and when, the secret-scan refusal | F-109 | `app-targets/m3/agent-profile` |
| 16 | `memory-proposals` | The proposals list and one proposal: its source task, the agent's declared relation, the related notes beside it, "Approve as a new note", "Approve and archive …", "Merge into …" with the merged text editable, "Reject" | F-111 | `app-targets/m3/needs-you` |
| 17 | `project-repos` | A project's settings, "Repos": the repos in order with drag to reorder, "Add repo", a repo in use with the tasks that block its removal, the limit | F-098 | `app-targets/m2/repo-checks` |
| 18 | `email-account` | The account mails at a mail client's width, in light and dark: the invitation, with the verification, reset and budget mails' variants in the build spec, and the text part | F-002, F-037, F-115 | `app-targets/m3/email-needs-you` |

**Added 2026-11-19 with F-135 and F-136** (ADR 0065). Ticket 31's eighteen are approved; **ticket 52 makes these five** the same way, and tickets 53 and 54 build their UI after the approval:

| # | Target | Screen | Feature | Starts from |
|---|---|---|---|---|
| 19 | `models-keys` | Organization, "Models": each provider as a key (its name, the base URL's host, its format, the models it lists, the month's spend, its cap and personal-runner switch) with the projects that use it, through the default list or their own; the organization's default list with "Edit"; "Add provider", with no list ticked; the upgrade's choices to confirm | F-135, F-088, F-037 | `app-targets/m1/models` |
| 20 | `project-models-keys` | A project's settings, "Models and keys": "Follow the organization's default" or "Use this project's own list", the providers on it, each model the project's profiles use with the provider that serves it and "Change", the save's preview of what moves or is left with no key, and the read-only view a project admin or member sees, with no token anywhere | F-135, F-087 | `app-targets/m4/project-access` |
| 21 | `agent-profile-model` | The agent profile editor's model, chosen by name: a search over model names with each one's logo, the providers that list it, and the projects where no key serves it; a custom model by its endpoint ID | F-135, F-021 | `app-targets/m3/agent-profile` |
| 22 | `no-key-for-model` | "No key for this model in this project": New task with the reason before Start and Start disabled, a queued task's page with its reason and who can fix it, a held message's line in the thread, and the needs-you row an organization admin sees on Home | F-135 | `app-targets/m1/task-new`, `app-targets/m2/task-limits` |
| 23 | `github-organizations` | Organization, "GitHub": each connected App with its owner and webhook state, and its installations, linked, "Waiting to be linked" with the account and "Link" or "Remove", or removed; "Add a GitHub organization" with the install link to send, why a private App can't be installed elsewhere and the link to GitHub's setting; "Connect another App" with its ID and key, then the webhook address and the secret shown once | F-136, F-006 | `app-targets/m1/github` |

**Added 2026-11-19 with F-137** (ADR 0066). **Ticket 62 makes these three** the same way, and ticket 63 builds their UI after the approval:

| # | Target | Screen | Feature | Starts from |
|---|---|---|---|---|
| 24 | `agent-profile-effort` | The agent profile editor's "Agent and model" with "Effort" under the model: the model's levels, `Default` first, each with a one-line hint; no control and a quiet line for a model that doesn't reason; a stored level the model lacks, with the level it will run at; a custom model whose reasoning nobody set, with a link to Models | F-137, F-021 | `app-targets/m3/agent-profile`, target 21 `agent-profile-model` |
| 25 | `task-effort` | The task page: "Effort · High" in the properties panel, the model's levels for the driver, "Low from the next turn" while a turn runs, read-only with "Take over to change" for everyone else; the thread's "Demo set effort to Low, from the next turn"; each turn's level and reasoning tokens in its usage line; "Ran at Max: this model has no Extra high" | F-137, F-024, F-084 | `app-targets/m1/task` |
| 26 | `model-reasoning` | Organization, "Models", a model's reasoning: its levels "from the catalog" or "set by an admin", with "Edit" and "Use the catalog's"; a custom model's "Reasons: yes or no" and the levels its endpoint takes, beside its limits; the mark on a model whose catalog prices reasoning apart, and the line that v1 prices it as output | F-137, F-088 | target 19 `models-keys`, `app-targets/m1/models` |

**Screens that only grow**, built against their existing targets with the changes listed in the ticket that builds them:
- `app-targets/m1/task`: the "Memory" list in the properties panel (notes used and how, proposals made); two PRs in the header for a task with several repos, each with its independent-review state; the held-turn marker in the thread ("Held: `test1`'s budget for November is reached"); the "Event log" tab next to Activity, Changes and Checks.
- `app-targets/m3/task-changes` and `app-targets/m3/task-checks`: a section per repo for a task with several repos; "Remember this" on a diff comment; the `ostra/independent-review` line per PR.
- `app-targets/m1/task-new`, `app-targets/m2/inbox`: the budget's reason before Start, when it's reached or the model has no price.
- `app-targets/m2/task-limits`: a task queued by the budget, with its reason and who can raise it.
- `app-targets/m1/home` and `app-targets/m3/needs-you`: the budget notices among the needs-you rows.
- `app-targets/m1/project` and `app-targets/m1/project-new`: the month's spend on the project; several repos at creation.
- `app-targets/m1/environment`: a section per repo when the project has several.
- `app-targets/m3/agent-profile`: the "Ask what the next task should know" switch.
- `app-targets/m3/account`: the account's organizations. *After v1 since 2026-11-19, with F-134 (ticket 44): with one organization per install there's nothing to list.*
- `app-targets/m1/models`: a model's price and its source, with "Edit price". With F-137, a model's row also shows whether it reasons and its levels (target 26).
- The sidebar (`app-targets/m1/README.md`'s shell): the organization's name at its top, as milestone 1 built it (the switcher's menu waits for F-134 since 2026-11-19); Members, Spend, Insights, Memory and Audit log under Organization; Memory and Insights under each project; search (Ctrl+K) in the top bar; the instance's Accounts page for the instance admin.
- Added 2026-11-19 (tickets 53 and 54): `app-targets/m1/github-not-connected` gains the setup form's question, whether repos outside the App owner's account will use the App, with why private is the default; `app-targets/m1/project-new` the provider list at creation and repos from every linked installation, grouped by GitHub account; `app-targets/m4/project-repos` repos grouped by GitHub account, and a repo whose installation was unlinked, with its reason; `app-targets/m4/spend-budgets` spend by key; `app-targets/m1/task` "Key · <provider>" beside the model; `app-targets/m3/needs-you` the "no key" row for organization admins.
