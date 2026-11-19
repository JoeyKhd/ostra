# Open questions

**Who answers:** 👤 = the maintainer's call · 🔬 = research informs it, then we decide together · 🔧 = a build task with a known fix: no decision is needed, and the row leaves when the fix is committed.

A settled question leaves this file. Its answer lives on in the ADR (`decisions/`) or ledger row (`features.md`) that settles it. IDs are permanent. The early questions are written with a dash (Q-01 to Q-28), and the later rounds without one (Q1 to Q209). They are two separate ranges: Q-20 and Q20 are different questions.

## Settled

| Question | Settled in |
|---|---|
| Q-01 name | "ostra" |
| Q-02 | ADR 0009, superseded by ADR 0048 |
| Q-03 | ADR 0010, superseded by ADR 0026 |
| Q-04, Q-18 | ADR 0008 |
| Q-05 | ADR 0012, superseded by ADR 0029 |
| Q-06 | ADR 0014, superseded by ADR 0030 |
| Q-07, Q-08 | ADR 0006 |
| Q-09 | F-007 |
| Q-10 | ADR 0019, superseded by ADR 0040 |
| Q-11, Q-19 | ADR 0013 |
| Q-12 | F-053 and ADR 0013 now; F-034 later |
| Q-13 | F-026 |
| Q-14 | ADR 0020, superseded by ADR 0031 |
| Q-15 | ADR 0017 |
| Q-16 | F-041 in v1; F-029 later. F-041 has since moved to after v1 (Q74) |
| Q-17 | F-054 |
| Q-21 | F-055 in v1; F-056 later |
| Q-22 | ADR 0018 |
| Q-23 | ADR 0016 |
| Q-24 | F-021 |
| Q-25 | ADR 0004: Claude Code only in v1, then the researched tiers. Superseded by ADR 0032: OpenCode first, with Claude Code on keys as the second agent in milestone 7 |
| Q-26 | F-050 to F-052 |
| Q-27 | F-058 in v1 |
| Q-28 | ADR 0018: Claude Code through ACP. Amended by ADR 0032: OpenCode through ACP first |
| Q60–Q63, the panel's look (asked in chat 2026-11-18) | `brand/app-design.md`: neutral graphite chrome with brand accents, denser type, few boxes, concepts in real HTML; direction B picked |
| Q164 agent reach on `host` | `AGENTS.md` Boundaries (2026-11-19): enforced by the box on `docker` and `kubernetes`; `host` is labelled not isolated (ADR 0029, ADR 0031) |
| Q127 dependencies waiting for a yes | ADR 0007 (2026-11-19): `@tanstack/react-virtual`, `dockerode` and `@kubernetes/client-node` confirmed; email through Resend (`resend`) first, with SMTP (`nodemailer`) as the second option; ADR 0043: `@aws-sdk/client-s3`. Q126's Windows helper gets its own yes when it's chosen |

### Delegated on 2026-11-18

The maintainer delegated every remaining question on 2026-11-18. The answers, with each one's reasoning, confidence and revisit condition, are in `context/history/answers-2026-11-18.md`, under the question's number in its section 3. ADRs 0026 to 0047 record the decisions that were hard to reverse.

Two adjustments the maintainer made afterwards apply to every row below:
- Claude Code on keys is v1, in milestone 7, as the second agent (F-018). OpenCode is the default and the only agent from milestone 1.
- Signed runner binaries (F-085) come after v1.

"Later" in a row means after v1.

#### Q-20 and round 7: making it a big tool

| Question | Settled in |
|---|---|
| Q-20 Jira's sign-in model | ADR 0047: a service account the organization owns with a scoped API token, plus one admin webhook. ostra never asks a customer to create its own OAuth app. F-008, Jira, is the first tracker after v1 (Q104) |
| Q1 what "huge" means | ADR 0026 and the v1 cut in `build-order.md`: the whole platform shape in v1 (organizations, projects, environments, pools, any model, three task kinds, budgets, the audit log), with the least depth that works in each part |
| Q2 environments at scale | F-112 in v1: detection per project, with ADR 0038. F-126 later: organization templates and bulk onboarding |
| Q3 setup step 5 | Superseded by projects. F-076's checklist: admin account, model provider, GitHub App, first project, runner check, first task from a prompt, then Linear |
| Q4 starting many tickets at once | F-107, through the same gates as a single start. F-010 |
| Q5 runners page | F-092, the fleet view |
| Q6 insights | F-108, in v1, computed by a scheduled job |
| Q7 tickets spanning several repos | Superseded by Q29: ADR 0027, F-098 |
| Q8 elastic runners | Superseded by round 14: elasticity is the `kubernetes` executor, on the cluster's own autoscaler (ADR 0029, F-093). Hosted sandboxes may become community executors later (F-127) |
| Q9 runner pools | ADR 0029, F-091 |
| Q10 schedules on intake rules | F-106 |
| Q11 spike 1 | ADR 0032: spike 1 tests only ostra's own ACP driver. Rivet Sandbox Agent is out |
| Q12 CI failures and review comments | ADR 0041: failing CI (F-035, at most 2 rounds) and "changes requested" reviews (F-105) reopen a code task in v1. Other comments still need `@ostra` (F-053). The rest of F-034 stays later |
| Q13 reviewer agent as a profile option | Superseded by Q64 and Q71: review is a task kind (ADR 0028, F-100) |
| Q14 variants ×2/×3 | F-124, soon after v1 |
| Q15 YAML workflows | F-125, later |
| Q16 secrets per repo | F-050: each secret, variable and file in a project's environment belongs to one repo. ADR 0038 |
| Q17 keys the agent can see | ADR 0030: no model key and no GitHub token in the agent's container. F-089, F-090 |
| Q18 scale target | F-117 and ADR 0016: 1,000 tasks at once per install as a tested floor, on any number of stateless replicas. The load test is a launch gate |
| Q19 subscriptions versus scale | Superseded by Q47: keys everywhere (ADR 0030). F-130 later: providers that sign each request |
| Q20 rate limits | ADR 0025: each adapter's base class keeps a rate budget per credential, with its stores injected (ADR 0045). ADR 0037: a call that would overspend becomes a job delayed until the reset. F-089 and ADR 0042 for models: the key proxy reports rate limits, and the scheduler holds dispatches |
| Q21 copying modules | ADR 0015, amended: small ports of logic with attribution, each listed in ADR 0015's Borrowed code section and in `NOTICE`. The product stays ostra's own |
| Q22 run the Tier 1 research | Done: `research/durable-execution.md`, `elastic-sandboxes.md`, `live-sync.md`, `integrations-platform.md`, `credential-proxy.md` and `runner-transport.md`. Their findings are in ADRs 0025, 0029, 0030, 0034, 0035 and 0037 |
| Q23 text deltas and "saved before acted on" | ADR 0035. ADR 0011, amended: partial text is shown, never saved, and nothing acts on it |
| Q24 the durable queue | ADR 0037: pg-boss behind one package, `packages/jobs`, with DBOS as the fallback. ADR 0017, amended. Spike 8 tested it and pg-boss stays (ADR 0037, Q156 to Q158) |
| Q25 integrations | ADR 0025: the official SDKs, each wrapped in an adapter. No integrations platform |
| Q26 keeping keys from the agent | ADR 0030: the sidecar's key proxy and git proxy. F-089, F-090. F-052 later: network allowlists |
| Q27 separate OS user | ADR 0030: the boundary is the sidecar container on `docker` and `kubernetes`. ADR 0029: a separate OS user remains only for `host` pools |

#### Round 8: ostra as a platform with projects

| Question | Settled in |
|---|---|
| Q28 the playback | ADR 0026, F-086: organization, with model providers, runner pools, agent profiles and budgets, above projects |
| Q29 what a project contains | ADR 0027, F-098: several repos, one task, one PR per changed repo |
| Q30 above projects | ADR 0026, F-049: an organization, which replaces "team" |
| Q31 tasks without a ticket | F-097: prompt tasks. ostra creates a ticket only when a project setting or an action asks for it |
| Q32 runners | ADR 0029, F-067, F-069: pools at the organization, each project picks the pools it may use |
| Q33 the environment as the project's computer | ADR 0038, F-050 |
| Q34 models | ADR 0033, F-088: a provider is an API base URL and a token, models are listed from the endpoint itself, and models.dev supplies names, limits, prices and logos. ADR 0021, amended: it names the catalog fetch. F-130 later |
| Q35 enterprise depth in v1 | ADR 0026: two roles at each level, restricted projects, and the audit log (F-003, F-087, F-073). F-004 later: SSO and custom roles |
| Q36 elastic runners | Answered in chat: no hosted sandbox vendor. Runners are self-hosted anywhere and join with a key (ADR 0029, F-093). F-127 later: community executors |
| Q37 tasks that outlive a sandbox | Superseded by Q99: ADR 0039 |

#### Round 9: the runner

| Question | Settled in |
|---|---|
| Q38 one box per task | ADR 0029, F-017: a box is the agent's container, the sidecar and the environment's services |
| Q39 the project's snapshot | ADR 0038, F-051: one snapshot per project, never a secret |
| Q40 services for tests | ADR 0038, F-094. The `host` executor starts no services, a declared difference (ADR 0029) |
| Q41 who commits | ADR 0030 and ADR 0040: the box commits and pushes through the git proxy, and the agent never holds a credential. F-030, F-090 |
| Q42 after a turn | ADR 0039, F-096: 15 minutes warm, then the box stops |
| Q43 box sizes | ADR 0029, F-095 |
| Q44 laptop runners | ADR 0029, F-014: the personal runner, on the `host` executor. A pool may also use `host` when an admin opts in |

#### Round 10: the agent

| Question | Settled in |
|---|---|
| Q45 default agent | ADR 0032, F-019: OpenCode is the default and the only agent from milestone 1. Spike 10 passed (Q159). Claude Code on keys (F-018) is the second agent, in milestone 7. Codex stays later (F-038) |
| Q46 Omnara bake-off | Replaced by an acceptance run of OpenCode alone: spike 10 in `build-order.md` (ADR 0032). It passed (Q159) |
| Q47 keys everywhere | ADR 0030, F-014: no subscription login anywhere, and a provider is usable on personal runners only when an admin allows it. F-128 later: a member's own provider |
| Q48 pool join tokens | ADR 0029, F-091, F-118: a join token per pool, shown once, hashed, expiring |
| Q49 onboarding a new project | F-113, in milestone 6, built on F-112. The onboarding task is a code task from a built-in template. ADR 0038 |
| Q50 the live agent UI | ADR 0036: the AI SDK's message types, rendered with assistant-ui. ADR 0007, amended |
| Q51 keep Rivet Sandbox Agent | ADR 0032: no. The runner drives agents with the official ACP SDK. ADR 0024 is superseded and ADR 0018 amended |
| Q52 steering with OpenCode | ADR 0032, F-024: steering mid-turn is a declared agent capability. Send steers where the agent declares it and queues otherwise, and "Interrupt and send" is a separate action. Spike 1 found that OpenCode declares it (Q114) |
| Q53 reopening on another runner | ADR 0039, F-033: the agent's session archive and the hidden ref, then a fixed rebuild template. ADR 0006, amended. Spike 2 tested it (Q128, Q150) |

#### Asked in chat, Q54 to Q59

| Question | Settled in |
|---|---|
| Q54 the sign-in name | F-002, F-115: a unique username and an email, either one plus a password, invite and reset links. ADR 0003, amended. Spike 9 confirmed the username plugin on better-auth 1.7.25, so the email-only fallback is dropped |
| Q55 who authors PRs | ADR 0040: the GitHub App opens every PR, with co-author trailers and the `ostra/independent-review` check. F-104, F-119, F-030, F-078 |
| Q56 test accounts | The same as Q106 |
| Q57–Q59 the rejected UI direction | Superseded by the graphite direction (Q60–Q63). Nothing to decide |

#### Round 11: the whole team, before and after the code

| Question | Settled in |
|---|---|
| Q64 kinds of task | ADR 0028, F-099: a task is refine, code or review, in the schema from milestone 1 |
| Q65 what to call the work before the code | ADR 0028: refine. "Plan first" (F-063) stays a step inside a code task |
| Q66 what a refine task may do | ADR 0028, F-099: it reads, answers and prototypes in its box, and never pushes or opens a PR |
| Q67 how refine ends | ADR 0028, F-099: a typed draft, then "Update ticket" and "Mark ready", both by a member |
| Q68 seeing the running app | F-121, after v1 and first in line |
| Q69 mockups | F-122, later. Members upload their own images in v1 |
| Q70 who uses ostra | ADR 0026, F-021: non-coders are ordinary members, and a profile can be limited to some members |
| Q71 AI review | ADR 0028, F-100: a review task with its own profile, posting a comment-type review |
| Q72 fixing what the AI review finds | ADR 0041, F-101: at most 2 rounds, then a person decides |
| Q73 human review in ostra | F-102, F-072, F-119: the review screen and the reviewer role. Approving and merging stay on GitHub |
| Q74 changing the code by hand | F-103: `ostra checkout`. F-041, `attach`, moves to later. F-028 |
| Q75 reviewing PRs that people wrote | F-123, after v1 |
| Q76 where screenshots and files live | ADR 0043, F-114: a blob store adapter, with Postgres as its default (ADR 0025, ADR 0017). Whether GitHub can take uploaded images in PR comments is still to verify, and ostra links to files without uploading them |
| Q77 what ships in v1 | The v1 cut in `build-order.md`. In v1: F-099 to F-103, F-105 and F-113. After v1: F-121 to F-123 |

#### Round 12: the repo's layout

| Question | Settled in |
|---|---|
| Q78 the layout | ADR 0045: `packages/jobs` and `packages/task-view` are added, and the adapter SDK takes its stores as interfaces |
| Q79 enforcing the license line | ADR 0045, ADR 0048: every package declares its license, and CI fails on an Apache-2.0 package that depends on one under the Sustainable Use License |
| Q80 one CLI | ADR 0046: one Apache-2.0 `ostra` CLI. A free npm name is a maintainer check, in the "Outside the code" table of `build-order.md` |
| Q81 publishing to npm | ADR 0045: Changesets and one version line, publishing from the v1 launch |
| Q82 the server image | ADR 0046, F-039: one server image with `web`, `core` and `all`, beside the runner image and the base image |

#### Round 13: project memory

Answered "yes" on 2026-11-18, and Q91's research is the one question that stays open (below).

| Question | Settled in |
|---|---|
| Q83 scopes | ADR 0044, F-109: organization and project notes in v1. F-129 later: repo and path scopes |
| Q84 what a note is | ADR 0044, F-109: one fact per note, versioned in Postgres |
| Q85 how agents receive it | ADR 0044, F-110: an index at session start, and search through ostra's MCP server in the sidecar |
| Q86 who writes | ADR 0044, F-111: members write, and agents only propose. A member approves a proposal before any agent sees it |
| Q87 where proposals come from | ADR 0044, F-111: agents propose while they work, and "Remember this" on review comments and findings. The closing question is a profile option, off by default |
| Q88 keeping it true | ADR 0044, F-109: the secret scan is v1. F-129 later: staleness checks |
| Q89 memory, repo files and the environment | ADR 0044: `AGENTS.md` stays the repo's own. F-129 later: "Promote to repo" |
| Q90 where it shows | ADR 0044, F-109, F-073: a Memory page per project and per organization, and the audit log |
| Q92 what ships in v1 | ADR 0044: F-109 to F-111 in v1. F-129 later: staleness checks, "Promote to repo", vector search, personal notes |

#### Round 14: runners without a sandbox vendor

Answered "yes" on 2026-11-18.

| Question | Settled in |
|---|---|
| Q93 executors | ADR 0029: `docker` first (F-017), then `host` (F-014, F-015), then `kubernetes` (F-093), all in v1 |
| Q94 how a runner joins | ADR 0029, F-091, F-013, F-014: a device code for a personal runner, a join token for a pool runner |
| Q95 the snapshot as an image | ADR 0038, F-051, F-120: a registry is required for a `kubernetes` pool and optional otherwise |
| Q96 services without a sandbox vendor | ADR 0038, F-094: sidecar containers on `docker` and in the pod on `kubernetes` |
| Q97 the Docker socket | ADR 0029, ADR 0031: the `docker` executor runs on dedicated hosts, and the docs recommend rootless Docker or gVisor |
| Q98 hosted sandboxes later | ADR 0025, amended: `ExecutorAdapter` replaces `RunnerProviderAdapter`. F-127 later: community executors |
| Q99 Q37, revisited | ADR 0039, F-096: after every turn the unfinished work goes to a hidden ref and the session archive is uploaded. After 15 idle minutes the box stops: kept on `docker` until its host needs the space, deleted on `kubernetes` |

#### Round 15: what needed the maintainer

| Question | Settled in |
|---|---|
| Q100 defaults for the rest | Replaced by `context/history/answers-2026-11-18.md`: every question there has its own answer |
| Q101 the first users | The maintainer's own team uses ostra first, and v1 is done when that team runs its daily work through ostra. From milestone 3, ostra's own tickets run through ostra (`build-order.md`) |
| Q102 organizations per install | ADR 0026, F-049: many organizations in the data model from the first migration |
| Q103 Rivet | ADR 0032: dropped |
| Q104 Jira | F-008, ADR 0047: the first tracker after v1. From milestone 2, the tracker contract suite also runs against a Jira fake |
| Q105 spend limits | ADR 0042, F-037, F-068: a monthly budget per organization and per project, counted at the key proxy, and a spend cap per task |
| Q106 test accounts for the spikes | `docs/development.md`: the maintainer sets up a Linear workspace. The spikes read one neutral file, `~/.config/ostra-dev/model.env` (a base URL, a token and a model ID), and a GitHub org is a sandbox for test repos and the test GitHub App. The three things only the maintainer can provide are tracked under "Outside the code" in `build-order.md` |

#### Settled from the spikes' findings (2026-11-18)

The maintainer delegated these calls. Each spike's finding (`research/spike-*.md`, section 4, "What this changes in the plan") proposed a decision or asked a question. Where it recommended one, the recommendation was applied, and the row says what was decided. The numbers are new. Spikes 6 and 7 each proposed their own "Q111", and spike 6's kept the number.

| Question | Settled in |
|---|---|
| Q111 Events produced under a valid lease but delivered after the grace (spike 6): refused, or kept in a quarantine table? | ADR 0034, F-045: refused. Every event received before the grace is stored exactly once, and later ones are refused. A quarantine would keep a transcript nothing reads. The work is on the branch and the hidden ref. The build-order wording of spike 6 is changed to match |
| Q112 On which device, and for which view, must 5,000 events render in 1.5 s? (spike 7) | ADR 0036, `build-order.md` spike 7: the default view on a mid laptop, measured unthrottled in a production build, with list virtualization for long tasks. The library for virtualization needs a yes (Q127) |
| Q113 What to do about the partial-text cost, and its fallback (spike 7) | ADR 0035: first a cheaper table (upsert at most once a second, deltas, nothing written for a task nobody watches). The fallback of riding the notification is a redesign, because a notification must be under 8,000 bytes: bounded pieces of at most 6,000 bytes, with each replica holding open segments in memory. Untested. Measured on Linux |
| Q114 OpenCode's gaps (spike 1): steering, plans, deny, and whether the default agent is reopened | ADR 0032, ADR 0018, F-019, F-024, F-026, F-063: OpenCode declares `steerMidTurn` over ACP and Send steers; the plan is mapped from `todowrite`; a deny ends the turn and the runner re-prompts; the default agent is not reopened, because every other check passed, the HTTP API rescued the reject, and the plan has an answer on ostra's side |
| Q115 A personal runner's credential (spike 9) | ADR 0029, ADR 0034, F-013, F-103: the runner trades the device session for its own runner key at once, and the server revokes the session. `ostra login` is a separate member session |
| Q116 Who may create a reset link (spike 9) | F-002: the instance admin only, because an account belongs to every organization its owner joined |
| Q117 A fresh install belongs to whoever reaches it first (spike 9) | F-001, ADR 0026: a setup token printed in the server log at first start was needed to create the first account. **Superseded 2026-11-19** (ADR 0026, "The first admin"): the server seeds the first account itself, `demo@demo.com` / `demo` unless `OSTRA_ADMIN_*` says otherwise, and the default password must be changed at the first sign-in. There is no setup token |
| Q118 An invite link is a bearer secret, and a mailbox is never verified (spike 9) | F-002: the invitation is bound to an address and the link's ID is the secret, used once, valid 7 days. With a mail server, the address must match and be verified. The docs say to send the link privately |
| Q119 Does the default LFS host list keep `*.githubusercontent.com`? (spike 4) | ADR 0030, F-090: no. Exactly the three names the run saw. A GitHub Enterprise Server install lists its own |
| Q120 How ostra treats the LFS storage a cleaned-up task leaves behind (spike 4) | ADR 0039, F-079: cleanup deletes refs, never LFS objects, and the docs say that the code host's storage keeps them and counts them against its quota |
| Q121 Who counts as the driver when several members prompted a task (spike 4) | ADR 0040, F-104: every member credited with a trailer on the task |
| Q122 Does v1 ask for `workflows: write`? (spike 4) | ADR 0040, F-006: no. A push that touches `.github/workflows/` fails on GitHub and the task says why. A later release can ask |
| Q123 Is a refused push answered before its body is read, and what is the cap on the drained body? (spike 4) | ADR 0030, F-090: answered after the body is read, so git reads the answer. The cap is 1 GiB *(working value)*. Answering early was not tried |
| Q124 May the mapper hide usage, mode and tool-progress updates? (spike 7) | ADR 0036: no. Mode and config become `session.config_changed`, in-progress tool updates with content become `tool.progress`, and `usage_update` gets a `session.usage` kind that feeds only the context meter. Spend comes from the key proxy |
| Q125 Linear: who sends a stop, and the heartbeat's values (spike 5) | ADR 0013, F-012: a stop always comes from a signed-in user, never from an API key. The heartbeat is every 20 minutes of silence, reset by any post, with retries for at most 5 minutes, ephemeral by default and a plain thought if Linear doesn't count it |

#### Settled from the second batch of findings (2026-11-19)

The maintainer delegated these calls too, and each recommendation of the findings of spikes 2, 3, 8 and 10 was applied. Spikes 2 and 10 each proposed a "Q128", and spike 2's keeps the number. Spike 8 left its questions unnumbered. The others start at Q150, because Q129 to Q136 were taken in parallel by questions that milestone 1 raised.

| Question | Settled in |
|---|---|
| Q128 What does the rebuild template carry: the last finished reply, or every agent message? (spike 2) | ADR 0039, ADR 0006, F-033: every agent message, oldest first, plus a section for an interrupted turn, with a cap on its size *(working value)*. It scored 5 of 5 in all four runs, against 4 of 5 for the last finished reply and 3 of 5 for the last turn with any text. It holds no tool output, and the one question it misses is about a tool's output |
| Q150 A moved branch, a lost box, ignored files and a forced ref (spike 2) | ADR 0039, F-033, F-047, F-096: the saved work is restored onto the commit it was saved on and the branch's new commits are merged, and a conflict leaves the ref alone and raises a "needs you" item. A lost box leaves the last finished turn's ref and archive, and the runner replays the member's unanswered message from the event log. Ignored files stay behind. The hidden ref is a forced push, the git proxy accepts a non-delete, non-fast-forward update of it, and F-096's test checks it on GitHub |
| Q151 Kubernetes egress is per pod, so the agent container has direct internet access (spike 3) | ADR 0029, ADR 0031, F-116: accepted for v1 and recorded as the fourth allowed difference between executors, said plainly in the panel. F-052 stays later and can come forward for `kubernetes`. A pod whose agent has its own network namespace has not been found |
| Q152 The git proxy's URL: a per-box secret, or none? (spike 3) | ADR 0030: no credential in the URL, and a random path segment per box as a second wall, with the network as the first |
| Q153 Where a snapshot's checkouts live, and when the scan runs (spike 3) | ADR 0038, F-051: no mount hides the checkouts, the scan runs on the built image before it is pushed, and the build namespace gets its own egress policy. A box started from a snapshot seeing its repos is part of F-051's "done when" |
| Q154 The `docker` executor and Docker's default address pools, which hold about 31 networks (spike 3) | ADR 0029, F-017: ostra owns the subnets of its boxes. The runner carves each box's networks out of a pool it manages |
| Q155 The minimum Kubernetes version (spike 3) | ADR 0029, ADR 0038, F-093, F-094: 1.29, for native sidecar containers. The bridge also gets deadlines (ADR 0029, F-017) |
| Q156 What an automation does for an occurrence that came due while the install was down, and how schedules tick (spike 8) | ADR 0037, F-106: schedules that start work are rows in ostra's tables, ticked by one job a minute, with a unique row and a fixed job key per occurrence. A missed occurrence fires once, for the latest, when it is under 6 hours late *(working value)*, and older ones are skipped. pg-boss's own cron stays only for idempotent passes, behind the heartbeat on its forwarding queue and a singleton slot |
| Q157 Does the `web` role wait for the core's migration, or retry its start? (spike 8) | ADR 0037: it retries with backoff and reports itself as starting |
| Q158 Does the server check the database's time zone, or set it on every connection? (spike 8) | ADR 0037: both. It sets `TimeZone=UTC` on every connection and checks `SHOW timezone` at boot, and the configuration reference says the database runs in UTC |
| Q159 Is spike 10's bar reworded, is a realistic gate added, and does a person rate a sample? (spike 10) | `build-order.md` spike 10, ADR 0032: the bar is reworded to what was measured (the ten spike tickets, on a toy repo, rated blind by two AI reviewers), and "realistic tickets" becomes a gate after milestone 1's end-to-end demo: one ticket of each kind through the real flow on a repo in `ostra-test`, rated blind by two AI reviewers and at least one person. A person rating a sample of the 30 is optional and nothing waits on it. OpenCode stays the default agent |
| Q160 What answers an agent's question in an automatic round? (spike 10) | ADR 0041, F-101: a fixed neutral reply, recorded in the activity. Never a decline, which ends the turn |
| Q161 What the event log records, and what contains the agent (spike 10) | ADR 0035, ADR 0031, F-073: every tool call's input is saved in full, a refusal keeps its error text, an approval keeps its command, and the "never content" rule is for log lines, not the log. Only a box contains the agent, and a record is not a box. The contract suites carry a canary file outside the workspace |
| Q162 Spike-only dependencies: `yaml` (spike 3) and `@dbos-inc/dbos-sdk` (spike 8) | ADR 0007: approved for the spikes, and never for the product |
| Q163 Which token kinds does the proxy count and price? (spike 10) | ADR 0042, ADR 0033, F-084, F-089: four, fresh input, output, cache reads and cache writes, each priced on its own. Whether models.dev and endpoints carry cache prices is unchecked, and the admin's price form has the two fields if they don't |

#### Settled from the questions milestone 1 raised (2026-11-19)

Settled under the maintainer's delegation of 2026-11-18. Each answer's reasoning, the alternative it was weighed against, its confidence and what would reopen it are in `context/history/answers-2026-11-19.md`. A row that says **changed** departs from the recommendation this file gave. Q109 and Q110 are legal and identity questions and weren't settled: they stay open below, with sharper recommendations. The code each answer needs is in the tickets the row names.

| Question | Settled in |
|---|---|
| Q107 A code task whose PRs end mixed | ADR 0027, `domain-model.md` ("How it ends"), F-098, F-066; milestone 2's tickets 06 and 16. The task follows the set of its PRs, whatever the order of their events: merged when none is open and at least one merged, stopped when none is open and none merged. The repo whose PR closed shows "closed unmerged", and after a reopen the task's next push to it opens a new PR. A PR reopened on GitHub puts the task back in review. This is the recommendation, made independent of order |
| Q108 Can a drained runner come back? | ADR 0029 ("Drain, resume and revoke"), ADR 0034, `domain-model.md`, F-092. **Changed.** Yes, by an admin's Resume, and not by reconnecting: a drain is a hold that a disconnect or a restart doesn't lift, where the recommended draining → offline would let a dropped connection cancel it. A runner that shuts down by itself for an upgrade isn't draining. Only revoke is final. Drain and Resume are built with the fleet view, and milestone 2's ticket 41 makes the lifecycle match |
| Q126 Containing a task's processes on the `host` executor | ADR 0029 ("Process containment on `host`"), ADR 0007, F-014, `research/host-process-containment.md`; milestone 2's ticket 42. **Changed.** Windows: a job object per task that the runner makes and holds through `koffi`, a new dependency, and not a helper program. In a run on Windows 11 it ended a detached helper that the tree kill missed. macOS: the process group, the tree and a sweep for a marker in the environment, unverified until it runs on a Mac. Linux: its cgroup, and the same sweep when it has none. The third allowed difference is reworded: weaker containment wherever the machine gives no kernel unit, which the runner reports and the panel shows |
| Q129 A token scoped to its task for the box's sidecar | ADR 0034 ("The task token"), ADR 0030, `domain-model.md`, `GLOSSARY.md`, F-015, F-017, F-089; milestone 1's ticket 41. The recommendation, with its open ends decided. The task token lasts exactly as long as its lease, with no clock and no renewal. The runner asks for it when it makes the box and hands it over in a file only the sidecar mounts. On `docker` and `kubernetes` a task's credentials go to that token only, and `host` is unchanged. The ticket also makes core accept a sidecar's connection, which it refuses today |
| Q130 Join tokens made in the panel are refused by core | ADR 0029, `domain-model.md`, F-091; milestone 1's ticket 42. The recommendation, with approval **brought forward.** Core accepts any token of the pool that hasn't expired or been revoked, and the join's audit entry names it. The pool's "require approval" switch is enforced in the same change: such a runner stays `joining`, with no task, until an admin approves or rejects it. Accepting tokens without that check would have made the switch do nothing |
| Q131 No way to revoke a runner in the panel | ADR 0029 ("Drain, resume and revoke"), ADR 0034, `domain-model.md`, F-013, F-045, F-091; milestone 2's ticket 41. The recommendation, with two **changes.** A revoke is possible from any state but `revoked`, by an admin, or by a member for their own personal runner. It disconnects the runner at once, and its leases end in the same transaction, with no grace: the recommended lost-runner path would have kept them open for ten minutes for a runner that can't come back |
| Q132 A queued task while its offer is out | ADR 0034, `domain-model.md` (queued), F-014; milestone 1's ticket 26, reworded, and milestone 2's ticket 43. Kept as built: queued until the runner accepts. **Changed** in how it shows: the task page says why a queued task waits from data, the open lease for an offer and a reason code when no runner fits, worded in the panel's message files, and not from core's sentence in the dispatch note (F-083) |
| Q133 Where the agent starts, and a file written outside every repo | `domain-model.md` (Workspace, "When a task needs you"), F-016, F-065; milestone 2's ticket 44. The recommendation, with the task's state made precise. The start rule stays. After every turn the runner lists what sits outside every repo, and a needs-you item for the driver names the files. A repo that changed still gets its PR, and a turn that changed none needs you for this reason. ostra never moves the files |
| Q136 Spec section 11's ten choices | `specs/m1-first-pr/spec.md`, section 11 (each item's status); F-001, F-006, F-016, F-050, F-118, F-119. Items 1 to 4, 6 to 8 and 10 are confirmed, and item 5 is Q126. **Item 9 changed:** on Windows, `bash` means Git for Windows' own bash, because `bash` isn't on `PATH` in PowerShell on the machine milestone 1 was built on (milestone 1's ticket 43). Two guards are added: the server checks at start that its secrets key can read the database, and the key that signs runners' tokens gets a setting (item 1, milestone 2's ticket 45); and a unique index on a project's branch names (item 10, milestone 2's ticket 46) |

#### Chat answers with no question number

| Answer | Settled in |
|---|---|
| Models are listed from the provider's own endpoint, then matched against models.dev. Unmatched IDs are custom models | ADR 0033, F-088 |
| Local secrets live outside the repo, in `~/.config/ostra-dev/` | `docs/development.md` |

#### Settled for milestone 3's spec (2026-11-19)

Writing `specs/m3-step-in/spec.md` met these questions. The maintainer delegated every decision that night ("continue working on everything throughout the night, would be nice to wake up to the finished product"), so each was settled by its recommendation, and the spec's section 11 restates them. Ticket 51 of that spec asks the maintainer to review them; any the maintainer disagrees with moves back to the open list.

| Question | Settled in |
|---|---|
| Q165 How do milestone 3's demo and tests get a second member before invites (F-002, milestone 4)? | `specs/m3-step-in/spec.md`, section 11, item 1: `pnpm dev:seed-member`, a development-only seed through the first admin's account code, refused outside `development` and `test` and left out of production builds. A test tool, like milestone 2's ticket-creating script |
| Q166 What is an approval rule, and how is it enforced? | ADR 0049, F-026: a tool (`edit`, `execute`, `fetch`, `mcp`) and a match (path glob, command prefixes, outside an allowlist, anything), always "ask". Four editable presets. Mapped to the agent's own "ask" settings and checked by the runner too. A guard with a person in it, not a wall: the box contains the agent (ADR 0031) |
| Q167 What does "Approve for this task" approve? | ADR 0049: a task rule of the request's tool and its subject narrowed to a pattern (the exact path, a command's program and first argument, a URL's host, an MCP tool's name), shown on the card before it's pressed |
| Q168 Who answers an agent's question? | ADR 0049: the driver, as with a message; a watcher takes over to answer. Approvals stay any project member's (F-026) |
| Q169 How does plan first work with an agent that has no plan mode? | ADR 0049, F-063: the first turn only, in a read-only mode the adapter makes (an ACP session mode, or a relaunch with read-only permissions and `session/load`); the plan is the agent's plan entries and last message; "Approve plan", "Edit and approve", "Ask for changes", the driver's |
| Q170 How do a profile's MCP servers get their secrets without one entering the box? | ADR 0049, ADR 0030: HTTP servers through the sidecar's MCP proxy, which adds the headers; stdio servers only as commands in the image, with no secret. Skills are a `SKILL.md` and up to 20 files, written in the task's config folder |
| Q171 What if a repo's own agent config loosens the profile? | ADR 0049, F-021: the profile's permissions and MCP list win, proven by a contract case; an agent that can't guarantee it gets the repo's agent config hidden for the task |
| Q172 Which channels and audiences does milestone 3 notify, before reviewers exist? | ADR 0050, F-036: the panel, the ticket (a comment with mentions, coalesced in a 10-minute window) and email; "a PR ready for review" goes to the driver until F-102 |
| Q173 How is email set up, when is a mail sent, and what may it carry? | ADR 0050, F-115: per install by the instance admin, Resend first or SMTP; after a 2-minute delay unless read or closed; the task's title and key, the moment, one line and a link, never task content; no answer buttons |
| Q174 Email templates: a library, or ostra's own? | ADR 0050: ostra's own pure renderers, HTML with inline styles and a text part. No new dependency |
| Q175 Where does the diff come from, and is it highlighted? | ADR 0051, F-027: the code host's compare of the pushed branch, cached by head, "as of the last turn"; ostra's own unified view, with no syntax highlighting until a highlighter is approved |
| Q176 How are diff comments anchored, and who sends them? | ADR 0051, F-072: drafts per member, anchored by repo, path, side, line and head, outdated rather than moved; sending follows the composer's rule |
| Q177 What credential does `ostra login` make, and how does `ostra checkout` fetch? | ADR 0051, F-103: a CLI session of its own by device code, 30 days, listed and revocable, able only to read a task's branches; `ostra checkout` uses the member's own git access and no token from ostra |
| Q178 When do checks run now that a session spans turns, and what does a failure do? | ADR 0052, F-054: after every turn with changes, before the push; a failure makes the PR a draft and offers "Ask the agent to fix"; passing again marks ostra's draft ready |
| Q179 Update branch: merge or rebase? | ADR 0052, F-070: merge, so nothing is forced |
| Q180 After a merge, what is the fresh branch called, and what happens to the old PR? | ADR 0052, F-066: the old name with `-2`, `-3`; every PR is kept on the task repo |
| Q181 What does "the task pauses" mean when its ticket closes while it runs? | ADR 0052, F-066: the turn is interrupted (the work is saved), and the driver chooses "Stop the task" or "Keep working" |
| Q182 `@ostra` while a session runs, and from someone not linked | ADR 0052, F-053: it waits for the turn's end; anyone not linked or without access is dropped with no reply |
| Q183 Where does the verified GitHub link live, and how is co-author credit given? | ADR 0052, F-119: on the account, unique per install; the token revoked before the callback returns; trailers use the no-reply address |
| Q184 Snapshots on `docker` before the registry, and the `host` stand-in | ADR 0038 (amended), F-051: the building runner keeps the image; other runners fall back to the full setup; on `host`, repo mirrors and a dependency cache per project |
| Q185 A task with services when only `host` runners are online | ADR 0038 (amended), F-094: offered only to runners whose executor declares `services`; it waits with the reason |

#### Settled while preparing milestone 3's build (2026-11-19)

Met while reading the approved milestone 3 targets' open points and the spec against the code, on the same delegation. Each is in the spec's section 11 (items 21 to 25) and in the `## Decided 2026-11-19` section of the tickets that build it. Ticket 51 asks the maintainer to review them with Q165 to Q185.

| Question | Settled in |
|---|---|
| Q186 How are F-115's mails proved with no Resend key yet? | Spec section 11, item 21; tickets 12, 13, 21, 50: Resend on a fake of its API; SMTP with the real adapter against an in-process `node:net` SMTP server with `STARTTLS` and `AUTH`, no new dependency; the live Resend send and the SMTP relay case wait for the key (ticket 51) |
| Q187 Does `@ostra` work on an App without a webhook? | Spec section 11, item 22; ticket 25: no, nothing polls PR comments, and the docs say so |
| Q188 Where and when does a check run in a task with several repos? | Spec section 11, item 23; tickets 23, 32, 47: a repo's check on turns that changed that repo, in its folder; a check with no repo once, at the workspace root; a PR reads every check that applies to it |
| Q189 What happens to a project's default when its profile is archived? | Spec section 11, item 24; tickets 07, 34, 42: the default moves to the built-in profile, which is always open to everyone; tasks keep the profile they started with; no restore in milestone 3 |
| Q190 Where do the approval-rule matcher and the prompts the runner sends live? | Spec sections 5.1, 5.4 and 11, item 25; tickets 01, 02, 07, 30, 31: in `@ostra/protocol`, since the runner and the adapters are Apache-2.0 and can't import `packages/domain` (ADR 0045, ADR 0048) |

#### Settled for milestone 4's spec (2026-11-19)

Writing `specs/m4-the-organization/spec.md` met these questions. The maintainer delegated the night's decisions, so each was settled by its recommendation, and the spec's section 11 restates them. Ticket 42 of that spec asks the maintainer to review them; any the maintainer disagrees with moves back to the open list.

| Question | Settled in |
|---|---|
| Q191 What does removing a member do? | ADR 0053, F-002: ostra's own use case marks the membership removed and keeps it for history; project roles, personal runners, CLI sessions, driving, draft comments and pending invitations go in the same transaction; the account stays |
| Q192 Who may invite, and to what? | ADR 0053, F-002, F-087: organization admins, with a role and optional restricted projects; project admins add existing members only; an address with an account joins by signing in |
| Q193 How is an invitee's address verified, and can members reset their own password? | ADR 0053, F-002: with email set up, the address is locked to the invitation and verified by a mailed link before the membership is active, and "Forgot your password?" mails a verified address; without email, the link alone, and only the instance admin's reset links |
| Q194 Can an organization or an install lose its last admin? | ADR 0053, F-003: no; the last admin and the last instance admin are kept under a lock. The instance admin role grants nothing inside an organization the account isn't in |
| Q195 How does a member move between organizations, and what do links do? | ADR 0053, F-049: the active organization in the session, the last one remembered; a link into another of the member's organizations switches with a notice; new organizations get a pool and the built-in profile |
| Q196 How is "a test for every kind of record" kept true as tables are added? | ADR 0053, F-049, F-087: a test generated from the schema's model list, with a fixture per model and a reviewed allowlist, that fails on a model on neither list |
| Q197 What does the audit log record, and who reads it? | ADR 0054, F-073: people's and the system's actions in `AuditEntry`, the agent's in the event log, linked; a credential's use is one entry per issuance; append-only, kept while the organization exists; organization admins read all and export CSV, project admins their project's |
| Q198 How does search work, and over what? | ADR 0054, F-080: Postgres full-text (`simple`), a search table written at ingest over titles, prompts, tickets, messages and tool inputs, never thoughts or output; filters as columns, access in the query; a palette and a page |
| Q199 What exactly does a budget stop, and when? | ADR 0055, F-037: calendar months in UTC; notices at 80% and 100% once per budget and month; at 100% no new task or turn starts, held in order and released on a raise; running turns finish; one gate for every origin; unpriced models wait where a budget applies |
| Q200 What do the Insights figures mean? | ADR 0055, F-108: six fixed definitions, computed every 5 minutes into daily rows and per-task metrics; a hidden project's share shows as "Other projects" |
| Q201 What does memory's secret scan look for, and who may write and approve notes? | ADR 0044 (amended), F-109, F-111: the organization's own secret values and a fixed list of credential shapes; members write and approve in what they can open, and archiving another's note needs an admin of its scope |
| Q202 How large are the index and the "always" notes, and in what order? | ADR 0044 (amended), F-110: 100 notes and 8 KiB, plus 8 KiB of "always" notes, project before organization, then by last use, with the rest left to search |
| Q203 What are the memory tools, and how do they reach ostra without a credential in the box? | ADR 0044 (amended), F-110, F-111: `memory_search`, `memory_read` and `memory_propose` on the sidecar's ostra MCP server, forwarded to core with the task's token; 20 proposals a task |
| Q204 How is a contradicting proposal found without a model call? | ADR 0044 (amended), F-111: the agent declares a relation, and ostra shows the three highest-ranking notes beside every proposal; the member decides |
| Q205 Where is "Remember this" before the AI review exists? | ADR 0044 (amended), F-111: on diff comments and accepted `@ostra` comments; AI findings in milestone 6, so F-111 stays `building` |
| Q206 How many repos may a project have, and what changes when one is added or removed? | ADR 0027 (amended), F-098: up to 10; all checked out side by side, the agent at the root with the repos listed; "Related" sections in every PR; a repo added joins the next session; a repo in use can't be removed |
| Q207 Whose approval counts for the independent-review check, and when is it evaluated? | ADR 0040 (amended), F-104: GitHub users linked to an active non-driver member; on reviews, new heads, links, trailers and the reconcile; `in_progress` until the live test shows it doesn't block, then `action_required` |
| Q208 How does the scripted demo link a GitHub user it can't sign in as? | ADR 0053: `pnpm dev:link-github`, refused outside development and test and left out of production builds, like `pnpm dev:seed-member` |
| Q209 What does a runner on protocol minor 2 get in milestone 4? | `specs/m4-the-organization/spec.md`, section 5.1: the memory block appended to its instructions and no tools; everything else works unchanged |

## Open

**Q91 🔬 Prior art for project memory** (F-109 to F-111, ADR 0044). Research before building: how Devin Knowledge, Cursor Memories, GitHub Copilot Memory, Windsurf Memories and Claude Code's memory files capture, approve, retrieve and expire memory. The findings are in `research/project-memory.md` (2026-11-19). They confirm ADR 0044 and recommend one change to the index's order (only a read counts as a note's use) and four smaller refinements: model-control tokens in the secret scan, a version check on edits and merges, each agent's own memory kept off, and the block framed as approved notes. Q91 closes when the maintainer accepts or rejects them. Memory's v1 cut (Q92) stands either way.

**Q109 👤 Which CLA, and how contributors sign it** (ADR 0048). Due before a contribution from anyone but the licensor is accepted. That includes the maintainer's own team and any contractor, not only strangers: without an agreement, or a contract that assigns the work, their code can't go into the hosted version or a commercial license either. Until it is chosen, the project takes no outside code. It names the licensor, so Q110 comes first. *Recommendation (sharpened 2026-11-19, `history/answers-2026-11-19.md`, section 3; not settled, and a lawyer's call):*
- **A license grant, not a copyright assignment.** The contributor keeps their copyright and gives the licensor a lasting copyright and patent license, with the right to license the contribution on any terms. That is all the hosted version and commercial licenses need. n8n, whose license ostra uses, asks for it in one sentence.
- **Granted to the licensor "and its successors and assigns",** so Q110's answer can change later without every contributor signing again.
- **One agreement for the whole repo,** the Apache-2.0 packages included, so code can move between packages. An individual form, and a company form in which a company signs once and names who contributes for it.
- **Signed once per contributor through a check on the pull request,** with the signatures in a repo the licensor owns. The GitHub Action most projects used for this was archived in March 2026, so the tool is chosen when it's needed.
- A lawyer reviews the text together with the license and Q110.

**Q110 👤 Who is the licensor?** (ADR 0048). For now the licensor and copyright holder is "JoeyKhd (https://github.com/JoeyKhd), the maintainer of ostra", which is a GitHub handle. The license, the CLA and the commercial licenses all name the licensor, and each needs a legal person behind the name. Does the line become a legal name, or a company? **It comes before Q109,** which names the licensor, **and before the first of four events:** the first contribution from anyone else (from milestone 3, ostra's own tickets run through ostra, driven by the maintainer's team: Q101), the first commercial license, the first terms for the hosted version, and the first release a company's lawyers will read. That can be earlier than the milestone 7 launch this question first named. *Recommendation (sharpened 2026-11-19, `history/answers-2026-11-19.md`, section 3; not settled, and a lawyer's call):* name a legal person now, and keep the handle beside the name. If a company is planned for the hosted version, form it before the CLA exists: a person now and a company later needs a written assignment of everything written until then, which is one document while one person holds the copyright, and many once others have contributed. The same legal person should hold the name "ostra", since the license leaves the licensor's trademarks to trademark law. When it is decided, `LICENSE`, `NOTICE` and ADR 0048 change in one commit.

### Raised by milestone 1 (2026-11-19)

Found while building and demonstrating milestone 1 (`specs/m1-first-pr/`: the tickets' closing notes, `demo.md`). Each names the ledger row it blocks, and that row's note names the question back. Q129 to Q133 and Q136 were settled on 2026-11-19 (above). Q134 is research and stays.

**Q134 🔬 OpenCode writes tool outputs to the machine's temp folder** (F-019, F-079, ticket 19, `demo.md`). OpenCode keeps large tool outputs in `%TEMP%\opencode\tool-outputs\<taskId>\…`, although the launch sets `TEMP` and `TMP` to the task's folder, so on `host` they outlive the task and sit outside its workspace, where an agent's reach should end (`AGENTS.md`). Find out whether OpenCode has a setting for that folder (its data and state folders, or an environment variable it reads) and test it. *Recommendation:* until then, the runner deletes `…\opencode\tool-outputs\<taskId>` when the task's workspace is released, and records the path in the executor's cleanup list. Whether the same happens on Linux and macOS is part of the finding, for `research/`.
