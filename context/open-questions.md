# Open questions

**Who answers:** 👤 = the maintainer's call · 🔬 = research informs it, then we decide together · 🔧 = a build task with a known fix: no decision is needed, and the row leaves when the fix is committed.

A settled question leaves this file. Its answer lives on in the ADR (`decisions/`) or ledger row (`features.md`) that settles it. IDs are permanent. The early questions are written with a dash (Q-01 to Q-28), and the later rounds without one (Q1 to Q164). They are two separate ranges: Q-20 and Q20 are different questions.

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
| Q117 A fresh install belongs to whoever reaches it first (spike 9) | F-001, ADR 0026: a setup token printed in the server log at first start is needed to create the first account, and the first organization is created with it |
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

#### Chat answers with no question number

| Answer | Settled in |
|---|---|
| Models are listed from the provider's own endpoint, then matched against models.dev. Unmatched IDs are custom models | ADR 0033, F-088 |
| Local secrets live outside the repo, in `~/.config/ostra-dev/` | `docs/development.md` |

## Open

**Q91 🔬 Prior art for project memory** (F-109 to F-111, ADR 0044). Research before building: how Devin Knowledge, Cursor Memories, GitHub Copilot Memory, Windsurf Memories and Claude Code's memory files capture, approve, retrieve and expire memory. The findings go in `research/project-memory.md`, which doesn't exist yet. Memory's v1 cut (Q92) stands until it lands. If the research changes how notes are found, only the search changes.

**Q107 👤 A code task whose PRs end mixed** (`domain-model.md`, ADR 0027). Some of a task's PRs merge and its last open PR closes unmerged. Is the task merged or stopped? *Recommendation:* merged when at least one PR merged and none is still open. The repo whose PR closed shows as "closed unmerged" on the task, and reopening can open a new PR for it.

**Q108 👤 Can a drained runner come back?** (`domain-model.md`, ADR 0029). The runner lifecycle goes draining → revoked, but an upgrade usually drains a runner and restarts it. *Recommendation:* allow draining → offline for a planned restart, keeping the runner's identity. Only an admin's revoke is final.

**Q109 👤 Which CLA, and how contributors sign it** (ADR 0048). Due before the first outside contribution is accepted. The CLA must let the maintainer offer the hosted version and commercial licenses with contributed code in them. Until it is chosen, the project takes no outside code. *Recommendation:* one standard CLA for individuals and another for companies, signed once per contributor through a check on the pull request. A lawyer reviews it with the license (Q110).

**Q110 👤 Who is the licensor?** (ADR 0048). For now the licensor and copyright holder is "JoeyKhd (https://github.com/JoeyKhd), the maintainer of ostra". Does that line stay, or does it become a legal name or a company? The license, the CLA and the commercial licenses all name the licensor. *Recommendation:* keep the line through milestones 1 to 6. Settle it with the legal review of the license and the CLA before the milestone 7 launch (`build-order.md`, "Outside the code").

**Q126 👤 Containing a task's processes on the `host` executor** (ADR 0029, `research/spike-how-should-the-runner-drive-opencode.md`, item 6). The decision is made: a Windows job object, a Linux cgroup. Two things aren't. How does a Node runner create a Windows job object (a native addon or a small helper program, either of which is a new dependency)? And what does macOS use, which has neither? Until it is settled, milestone 1's `host` executor on Windows ends the agent's process tree and says so in the panel, and `host` on macOS reaps a process group and walks the tree, recorded as the third allowed difference in ADR 0029. *Recommendation:* a small helper program for Windows, so the runner needs no native addon on a laptop, and for macOS test a process group plus a sweep for orphans against a detached helper, and record the result.

**Q127 👤 Dependencies waiting for a yes** (ADR 0007, "pending the maintainer"). `@tanstack/react-virtual` for the task page's long lists (Q112), `dockerode`, `@kubernetes/client-node`, `nodemailer`, and whatever Q126 picks. Each is added only when the feature that needs it is built, and only after the maintainer confirms it and its license. *Recommendation:* yes to all four named ones, since each has no standard-library or already-listed alternative.

**Q164 👤 `AGENTS.md` says an agent's reach ends at its task's workspace** (spike 10, finding 8, `research/spike-is-opencode-good-enough.md`). That is a goal only a box meets. On `host`, OpenCode's `external_directory` deny bounds its file tools and not its shell, which reaches whatever the member's account does (ADR 0029, ADR 0031). Milestone 1's spec now says so, and `AGENTS.md`'s Boundaries line is the maintainer's to change. *Recommendation:* reword it to "An agent's reach ends at its task's workspace on `docker` and `kubernetes`, enforced by the box. The `host` executor is labelled not isolated, and its agent can reach what the account can." The same file's Phase line still reads "milestone 0, spikes"; it can say that milestone 0 is done and milestone 1 is in progress.

### Raised by milestone 1 (2026-11-19)

Found while building and demonstrating milestone 1 (`specs/m1-first-pr/`: the tickets' closing notes, `demo.md`). Each names the ledger row it blocks, and that row's note names the question back.

**Q129 👤 A token scoped to its task for the box's sidecar** (F-017, F-089, ADR 0034). In a box, the sidecar talks to core with the runner's own access token, so a compromised sidecar (the process that holds the real provider key and git token) could speak for the whole runner. *Recommendation:* at dispatch, core issues a token bound to the task, the lease epoch and the runner, valid for the lease's length, and allowed to do only what the sidecar needs: store that task's events, fetch that task's credentials, and report its git pushes. The sidecar uses it in place of the runner's token. It is a runner protocol change, so it needs an ADR amendment before it is built. Nothing is exposed on the `host` executor, where the sidecar is the runner's own process.

**Q130 👤 Join tokens made in the panel are refused by core** (F-091, ticket 24, ticket 31). `pools.createJoinToken` stores a token with the same hash as the bootstrap one, but core's register accepts only the `bootstrap` kind, so a token an admin creates registers no runner. The ticket put the rest of F-091 in milestone 5. *Recommendation:* make core accept any unexpired, unrevoked token of a pool now, with its expiry and its "one runner name each" rule, because the panel already offers the button and a button that creates a token nothing accepts is a bug. Approval of each new runner and the audit entry stay in milestone 5.

**Q131 👤 No way to revoke a runner in the panel** (F-013, F-091, ADR 0029, `domain-model.md`; related to Q108). A runner is revoked only from `draining`, and the panel has no `runners.revoke`. A leaked runner key can't wait for its tasks to finish. *Recommendation:* an admin can revoke a runner in any state but `revoked`, and draining stays the polite path. Revoking a connected runner sends `evict` and closes with 4403 at once, and its tasks follow F-045's lost-runner path. The runner lifecycle's `revoke` input then accepts `joining`, `online`, `offline` and `draining`, and `domain-model.md` and ADR 0029 change with it.

**Q132 👤 A queued task while its offer is out** (`domain-model.md`, F-014, ticket 26). Ticket 26 says a dispatch moves the task to `preparing`. Core keeps it `queued` while the runner's offer is open, and moves it to `preparing` when the runner accepts, which is what the domain lifecycle and `acceptOffer` say. A runner that never answers then returns the task to the queue with nothing to undo. *Recommendation:* keep what is built. Change the ticket's wording, and let the task page show "offered to <runner>" from the task's dispatch note, so a task that waits on an offer doesn't look like one with no place to run.

**Q133 👤 Where the agent starts, and a file written outside every repo** (F-016, F-025, ticket 21). The workspace holds the repos side by side, and the agent used to start at its root. An agent told "create docs/numbers.md" wrote it at the root, outside `test1/`, and the task ended without changes and lost the file without a word. With one repo the agent now starts inside it (`agent-cwd.ts`, on the working tree). With several it still starts at the root, where the task spec's instructions name each repo's folder. *Recommendation:* keep that rule, and at the end of a turn have the runner look for files created in the workspace root outside any repo. When there are some, the task goes to "needs you" and names them, so the work is never lost silently.

**Q134 🔬 OpenCode writes tool outputs to the machine's temp folder** (F-019, F-079, ticket 19, `demo.md`). OpenCode keeps large tool outputs in `%TEMP%\opencode\tool-outputs\<taskId>\…`, although the launch sets `TEMP` and `TMP` to the task's folder, so on `host` they outlive the task and sit outside its workspace, where an agent's reach should end (`AGENTS.md`). Find out whether OpenCode has a setting for that folder (its data and state folders, or an environment variable it reads) and test it. *Recommendation:* until then, the runner deletes `…\opencode\tool-outputs\<taskId>` when the task's workspace is released, and records the path in the executor's cleanup list. Whether the same happens on Linux and macOS is part of the finding, for `research/`.

**Q136 👤 Spec section 11's ten choices** (`specs/m1-first-pr/spec.md`, section 11, F-001, F-006, F-014, F-026). The section was headed "for the maintainer to confirm", and milestone 1 is built on all ten. Each one now carries its status in the spec. Built as written and documented: 1 (the secrets key, in `configuration.md`), 2 (ports 3000 and 8787), 3 ("use an existing App" beside the manifest flow, whose live run is ticket 40 and keeps F-006 from `done`), 4 (the co-author trailer from the member's ostra name and email, until F-119), 6 (OpenCode's per-task permissions, until F-026), 7 (variables and secrets in each repo's checkout on `host`), 8 (one session is one turn, until milestone 2's ticket sync), 9 (the setup shell `OSTRA_RUNNER_SHELL`, default `bash`). Changed: 10, branch names use the *last* 8 hex digits of the task ID, because the first 8 of a UUIDv7 are a timestamp and three demo tasks collided (`87c0eef`). Moved: 5, to Q126. *Recommendation:* confirm 1 to 4 and 6 to 10 as they stand. The row leaves when the maintainer says so, or at the milestone 1 review.
