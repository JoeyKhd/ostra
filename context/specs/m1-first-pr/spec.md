# Milestone 1: First PR, from a prompt

**Status:** spec, 2026-11-18. Tickets in `issues/`, one file each (`docs/agents/issue-tracker.md`).
**Milestone:** 1 (`context/build-order.md`).
**Features:** F-001, F-076, F-002, F-086, F-088, F-089, F-090, F-006, F-013, F-017, F-016, F-050, F-112, F-019, F-097, F-023, F-025, F-030, F-078, F-065. It also builds the first slice of F-014 (the personal runner), because that's how this machine runs the demo (below).
**Decisions it builds on:** ADR 0025 to ADR 0048, chiefly 0026 (organizations and projects), 0029 (pools, executors, boxes), 0030 (no credential in the agent's container), 0032 (OpenCode over ostra's ACP driver), 0033 (model providers), 0034 (the runner protocol), 0035 (the event log), 0036 (the task page), 0037 (pg-boss), 0038 (environments), 0040 (the App opens every PR), 0045 (layout and licenses) and 0046 (the CLI and images).
**Spikes it ports from:** 1, 3, 4, 6, 7, 8 and 9 (section 10). Product code never imports `spikes/`. A builder copies the code into the product's package and adapts it, with a one-line provenance comment (`// Ported from spikes/<spike>/<path>.`).

Terms follow `context/GLOSSARY.md`. Lifecycles follow `context/domain-model.md`.

---

## 1. What milestone 1 ends with

An admin installs ostra on one machine and adds a model provider and the GitHub App. They create a project and type a prompt. They watch OpenCode work, live, and get a PR that the App opened.

### The adjustment for this machine: the `host` executor

The machine that builds milestone 1 runs Windows 11 and has **no Docker**. So:

- **The demo runs on the `host` executor,** on a **personal runner**: `ostra runner` on the same machine, signed in with a device code. The task runs in a worktree, and the runner process does the sidecar's work (ADR 0029). The agent's process holds no credential: it gets the fake key and the proxy URLs, nothing else. The key proxy and the git proxy run in the runner's process, on loopback.
- **The `docker` executor (F-017) is written in full,** with unit tests, along with the three images and the compose file (F-001). Its live test waits for a Linux machine with Docker (`build-order.md`, "Outside the code"). Until it runs, F-001 and F-017 stay `building`, and so does every row whose "done when" talks about the agent's container.
- **A personal runner on `host` is "personal, not isolated"** (F-014). The member controls the machine, so they can read the key in the runner's memory (ADR 0030, "A personal runner"). The demo shows that the agent's process doesn't get it. It doesn't claim more.
- **The pool runner in the compose file** uses the `docker` executor. It's part of F-001 and waits with it.

The spec says "on this machine" wherever the adjustment changes what can be shown.

### What is in, and what is not

**In:** one organization, one admin, one model provider, the organization's GitHub App, one project with one repo and its environment (no services), one personal runner on `host`, prompt tasks of kind `code`, one turn per session, live activity for any number of viewers, Stop, one PR per changed repo, no empty PRs.

**Not in** (and when it comes):
- invites, reset links, more members, roles beyond the first admin: F-002's rest and F-003, milestone 4
- trackers, tickets, the Inbox and webhooks: F-005, F-010 and F-043, milestone 2
- a second turn, steering, approvals answered in the panel, take over: F-024, F-026, milestone 3. The protocol and the event union carry them from now on (section 5), and the panel renders their events read-only
- reopening, the idle timer, session archives, blobs: F-032, F-033, F-096, F-114, milestone 2
- snapshots, services, checks, the diff: F-051, F-094, F-054, F-027, milestone 3
- pools and join tokens, the fleet view, `kubernetes`, the HTTP fallback: F-091, F-092, F-093 and F-013's fallback, milestone 5
- budgets and spend caps: F-037, F-068. The key proxy counts every call from milestone 1, so the numbers exist when budgets arrive

---

## 2. The features, and where each one lives

"At M1's end" is the ledger status the demo ticket (39) sets, on this machine. A row is `done` only when every condition in its "done when" holds (`features.md`). Most rows that mention the box stay `building` until the Linux run.

| F-ID | What milestone 1 builds | Packages | Tickets | At M1's end |
|---|---|---|---|---|
| F-001 One-command install | `pnpm dev` from a fresh clone on this machine (embedded Postgres, migrations, web and core). The first account needs the setup token the server prints in its log at first start, and creates the first organization with it (Q117). The compose file and the server, runner and base images are written and built from source, but not run here | root scripts, `packages/db`, `packages/api` (setup token), `deploy/` (images, compose file), `apps/core`, `apps/web` | 05, 22, 29, 30 | building: `docker compose up` waits for Linux |
| F-076 Setup in the panel (first version) | The first-run checklist in its order: admin, model provider, GitHub App, project, runner online, first prompt. Linear shows as "milestone 2" and is skipped. The 30-minute measure is milestone 7's | `apps/web`, `packages/api` | 30, 37 | building |
| F-002 Accounts (the first admin) | Sign-up of the first account only, by username and email with a password, through better-auth. It becomes the instance admin and the admin of the first organization. Sign-up is closed after that | `packages/api` (auth), `packages/db`, `apps/web` | 06, 30, 35, 37 | building: invites and resets are milestone 4 |
| F-086 Projects (one repo) | An admin creates a project with one repo linked through the App and its one environment. Its default code agent profile is the organization's built-in OpenCode profile. Boards, several repos and pool lists come later | `packages/db`, `packages/domain`, `packages/api`, `apps/web` | 06, 07, 32, 37 | building |
| F-088 Model providers | Add a provider (base URL, token, format), Test connection with format detection, the model list from the endpoint, matched to the models.dev catalog (bundled copy, daily fetch, one setting turns it off, logos served by ostra), sessions-at-once cap, "allow on personal runners" | `packages/adapters/adapter-model-endpoint`, `packages/api`, `apps/core` (jobs), `apps/web` | 12, 28, 31, 37 | done |
| F-089 Key proxy | The per-task fake key, both API formats, stream pass-through, token counts for every call, rate-limit report, estimate when usage is missing. On this machine the proxy runs in the runner process | `apps/runner` (sidecar module), `packages/adapter-sdk` (usage parsing) | 12, 17, 21 | building: the "agent's container" clause waits for F-017's live test |
| F-090 Git proxy | Clone, fetch and push through the proxy with a token for one repo, refusing every ref but the task's branch and hidden ref, LFS handled as spike 4 settled. On this machine it runs in the runner process | `apps/runner` (sidecar module), `packages/adapters/adapter-github` (token minting) | 13, 18, 26 | building: same as F-089 |
| F-006 Connect GitHub | The manifest flow that creates the organization's App from the panel, and "connect an existing App" for the test App 5821041. Permissions include `checks: write` and `actions: read` | `packages/adapters/adapter-github`, `packages/api`, `apps/web` | 13, 31, 37, 40 | done, once ticket 40 runs the manifest flow in a browser |
| F-013 Runner (WebSocket) | `ostra runner`: device-code sign-in for a personal runner, a key pair, short-lived access tokens, the WebSocket carrier, reconnect, the disk spool, commands applied once, the version window. The compose file's pool runner joins with one bootstrap join token that core writes at first start. Managing join tokens (F-091) and the HTTP fallback are milestone 5 | `apps/runner`, `apps/core`, `packages/protocol` | 01, 15, 16, 24 | building |
| F-017 A box per task (`docker`) | The `docker` executor in full: agent container, sidecar container, private network, egress rules, release. Unit tests against a fake Engine API. Live test gated on Docker | `packages/adapters/adapter-executor-docker`, `apps/runner` (sidecar mode) | 22 | planned: the row's own note keeps it `planned` until its live test passes on Linux |
| F-016 Workspace per task | On `host`: a worktree root per task with every repo of the project checked out side by side, one branch name in each, nothing shared between tasks | `packages/adapters/adapter-executor-host`, `apps/runner` | 19, 21 | building: the clause "inside its box" waits for F-017 |
| F-050 Environment | One environment per project: a setup script, variables, secrets and files, each belonging to one repo, shown in the panel with the setup log. The base image applies on `docker` only. Services are F-094 (milestone 3) | `packages/db`, `packages/domain`, `packages/api`, `apps/web`, executors | 06, 19, 22, 32, 37 | building |
| F-112 Environment detection | A draft from each repo's lockfiles, tool versions, `.env.example`, `devcontainer.json` and compose files, without an agent or a model, reviewed before it's saved | `packages/domain` (pure detector), `packages/adapters/adapter-github` (file reads), `packages/api` | 13, 32 | done |
| F-019 OpenCode | The `AgentAdapter` for OpenCode over ostra's ACP driver: pinned version and checksum, per-task config, an allowlisted environment, `elicitation.form`, steering detected from `initialize`, plans from `todowrite`. The agent contract suite passes for OpenCode and for the scripted fake agent | `packages/adapter-sdk` (driver, suite), `packages/adapters/adapter-opencode` | 09, 10, 11 | building: the base image pin waits for F-017's live test |
| F-097 Prompt tasks | A member starts a task in a project by typing a prompt. No ticket is created. "Create ticket" needs a tracker (milestone 2) | `packages/api`, `packages/domain`, `apps/web` | 33, 38 | building: "Create ticket" is milestone 2 |
| F-023 Live activity | The task page shows messages, thoughts, tool calls and file changes as they happen, and the full history afterwards, to every viewer | `packages/task-view`, `packages/api` (stream), `apps/core` (ingest), `apps/web` | 25, 33, 36, 38 | done |
| F-025 Stop | A member stops the task's agent. The branch and the hidden ref, holding unfinished work, stay on GitHub | `apps/runner`, `apps/core`, `packages/api`, `apps/web` | 21, 27, 33, 38 | done |
| F-030 Open the PR | When the session ends with changes, the App opens one PR per changed repo. Title from the prompt, body written by the agent through an ostra MCP tool, with links to the task | `apps/core`, `packages/adapters/adapter-github`, `apps/runner` (MCP tool) | 13, 20, 27 | done |
| F-078 Repo conventions | The PR fills in the repo's PR template when it has one. Commits are authored by the App's bot identity, with a `Co-authored-by` trailer for the member who prompted | `apps/runner` (commits), `packages/adapters/adapter-github` (template, bot identity), `apps/core` | 13, 19, 27 | done |
| F-065 No empty PRs | A session that ends with no changes opens no PR, and the task goes to "needs you" with the agent's summary | `apps/core`, `packages/domain` | 07, 27 | done |
| F-014 Personal runner (first slice) | Device-code sign-in, the `host` executor, "personal, not isolated" in the panel, the member picks it when starting a task, and "allow on personal runners" per provider, off by default. On Windows the agent's whole process tree ends on stop and crash, and the panel says that detached processes aren't contained, until milestone 2's ticket 42 adds the job object (ADR 0029; Q126, settled 2026-11-19) | `apps/runner`, `apps/core`, `packages/api`, `apps/web` | 15, 19, 26, 31, 38 | building: the row is milestone 5's |

**Built in from the first milestone** (`build-order.md`), and checked by the demo ticket:
- Organization-scoped data, with the project on every project record (06).
- The task kind and the task repo record in the schema (06, 07).
- The event log and the durable queue (23, 25). Nothing is acted on before it's saved.
- No credential in the agent's container: on `docker` by construction (22), and on `host` the agent's process gets only the fake key and proxy URLs (21).
- ACP as the only way to talk to an agent (09).
- Strict typing end to end: every check green, no suppressions beyond the documented form.
- Dark first, responsive, English text in message files: F-082, F-075, F-083 (35).

---

## 3. The end-to-end demo, on this machine

Ticket 39 runs it and records the result in its `## Comments`. Everything runs against the test org `ostra-test`, repo `test1`. Secrets are loaded from `~/.config/ostra-dev/` with `set -a; . ~/.config/ostra-dev/<file>; set +a`, typed or pasted into the panel's forms, and never printed, logged or committed.

**Before:** a fresh clone, `pnpm install`, no `DATABASE_URL` (so the embedded Postgres is used) and an empty dev data folder (`pnpm dev:reset`).

1. **Install.** `pnpm dev` starts the embedded Postgres in `.ostra-dev/`, runs the migrations, and starts `apps/web` on `http://localhost:3000` and `apps/core` on `http://localhost:8787`. Nothing else is configured. The terminal shows both addresses.
2. **The first admin.** The panel has no account, so it opens on "Create the first admin": the setup token from the server's log, a username, an email, a password and the organization's name. Without the right token nothing is created (F-001, Q117). The account becomes the instance admin and the admin of the first organization, which ostra creates with it. The token stops working, and a second sign-up, from another browser, is refused. The checklist appears, with step 1 ticked.
3. **A model provider.** Step 2, "Add a model provider": the base URL and token from `model.env`. "Test connection" lists the endpoint's models and detects its format. (Spike 1 found that this endpoint speaks Anthropic's Messages API; the form shows what it detects, and the admin can correct it.) Each model is matched against the models.dev catalog or shown as a custom model. The admin picks `OSTRA_DEV_MODEL_ID` as the model of the built-in OpenCode profile, and turns on **Allow on personal runners**, which is off by default and needed here because the only runner is personal.
4. **The GitHub App.** Step 3, "Connect GitHub": "Use an existing App", with the App ID (5821041), its private key (the PEM at the path in `github.env`) and its webhook secret. ostra reads the App, shows its slug and its permissions (`checks: write` and `actions: read` among them) and lists its installations: `ostra-test`. The other path, "Create a new App", is the manifest flow (ticket 40).
5. **The project.** Step 4, "Create a project": a name, and the repo `ostra-test/test1` from the installation's list. ostra drafts the environment from the repo's files (F-112) and shows the draft: the setup script, the variables from `.env.example`, and anything it found but can't run on `host` (services), marked as such. The admin edits it and saves.
6. **The runner.** Step 5, "Connect a runner": the panel shows the command, `pnpm ostra runner --server http://localhost:8787` (from source; `ostra runner` once it's published, ADR 0046). The runner prints a code and the panel's `/device` address. The admin approves the code in the panel. The runner trades the device session for its own key pair, and the session is revoked. The panel shows the runner online: personal, `host`, "not isolated", capacity 1, its version.
7. **The prompt.** Step 6, "Start the first task": in the project, the admin types a prompt such as "Add a short CONTRIBUTING.md that explains how to run the tests". "Run on" shows the admin's personal runner. The task appears as queued, then preparing (the worktree, the clone through the git proxy, the setup log), then running.
8. **Watching.** The task page shows OpenCode's messages, thoughts, tool calls (`read`, `edit`, `execute`) and file changes as they happen, with partial text. A second tab, signed in as the same member, shows the same thread. A reload mid-turn brings back the history and the partial text.
9. **The PR.** The turn ends. The runner commits what's left with a `Co-authored-by` trailer for the admin, and pushes the task's branch through the git proxy. The session ends "with changes". Core opens a PR on `ostra-test/test1` through the App. The task moves to "in review", and the page links the PR.
10. **On GitHub:** the PR was opened by the App's bot (`<slug>[bot]`). Its commits are authored by the bot, and the admin shows as co-author. The title comes from the prompt. The body was written by the agent through the MCP tool, follows `test1`'s PR template if it has one, and links the task.

**The checks after the run** (ticket 39 scripts what it can, in `e2e/m1-first-pr/`):
- **No credential reached the agent.** The environment the runner built for OpenCode holds only the allowlist, the fake key and the proxy URLs. The real model token and the GitHub token appear nowhere in the worktree, the task's OpenCode directories, the event log or any log line (searched by value, without printing it).
- **The git proxy holds.** From the task's worktree, `git push origin HEAD:main` and a push to another repo are refused by the proxy, with its reason, before anything reaches GitHub.
- **No empty PR (F-065).** A second task whose prompt asks only for an explanation ends without changes, opens no PR, and lands in "needs you" with the agent's summary.
- **Stop (F-025).** A third task is stopped mid-turn. It shows as stopped, and GitHub has its branch and its hidden ref `refs/ostra/wip/<taskId>`.
- **Tokens counted (F-089).** The key proxy's counts for the turn are stored with the session, and match what the endpoint reported.
- **Clean-up:** the demo's PRs are closed and its branches and hidden refs deleted, in `test1` only.

**What waits for the Linux machine**, written into ticket 39's comments, with the rows left `building` (F-017 stays `planned`, as its ledger note says): `docker compose up` (F-001), a task in a box on the `docker` executor (F-017), the agent's container holding no credential (F-089, F-090), OpenCode pinned in the base image (F-019), and the executor contract case for a detached helper on `docker` and on Linux `host` (ADR 0029).

---

## 4. How it fits together in milestone 1

```
 browser ──HTTP/SSE──▶ apps/web :3000 (Next.js, better-auth, tRPC via packages/api)
                           │ writes rows, commands, jobs; tails events (LISTEN)
                           ▼
                       Postgres (embedded in dev; DATABASE_URL overrides)
                           ▲
                           │ ingest, outbox, presence, pg-boss workers
 runner ──WS /runner/v1──▶ apps/core :8787 (runner gateway, credentials, jobs, PR opening)
   │  (personal, host executor; the sidecar's work in-process)
   ├─ key proxy (loopback) ──▶ the model provider
   ├─ git proxy (loopback) ──▶ github.com, with a one-repo App token
   ├─ ostra MCP tools (loopback)
   └─ ACP driver ──stdio──▶ OpenCode (worktree, fake key, allowlisted env)
```

**The flows:**
- **Sign-in.** better-auth runs in `apps/web` (`/api/auth/*`). Its configuration lives in `packages/api`, so `apps/core` can check a device session with the same code.
- **A personal runner joins.** `ostra runner --server <core>` reads `/runner/v1/info`, which names the panel's address. The runner runs the device flow against the panel, then posts its new Ed25519 public key to `/runner/v1/register` with the device session as a bearer token. Core creates the runner (personal, owned by the member, in the session's active organization) and revokes the session. From then on the runner posts a signed assertion to `/runner/v1/token`, gets a 10-minute access token, and opens the WebSocket with it (ADR 0034, and spike 9's recommendation 4).
- **A task starts.** The panel's `task.create` writes the task, its first session and a change notice, and enqueues a dispatch job, in one transaction. Core's dispatch job leases the task to the chosen runner, raising the lease epoch, and writes a `dispatch` command to the outbox with a `NOTIFY`. The gateway delivers it. The runner accepts it, fetches the task's spec and then its credentials (after the server checks the epoch), prepares the worktree and starts the agent.
- **Events.** The runner numbers each event per session, spools it to disk and sends it in batches. Core saves a batch in one transaction, idempotent on `(sessionId, sessionSeq)`, numbers it per task, checks the lease epoch under a share lock on the task row, enqueues reactions, acks after the commit, and sends one wake-up `NOTIFY` per batch window. Partial text goes to the `UNLOGGED` live-text table and is never an event.
- **Viewers.** Each web process runs one tailer. A tRPC subscription over SSE per tab yields committed events with `tracked(seq)`, live frames untracked, and change notices. A named `ping` goes out every 15 s, and the client reconnects from the last committed `seq` after 20 s without a frame (ADR 0035). A reload resumes from `Last-Event-ID`. History pages by turn, the newest 20 turns first (ADR 0036).
- **Commands from the panel** (Stop) are outbox rows written in the panel's transaction. The panel never calls core.
- **The end of a session.** After the turn, the runner commits, pushes the branch, records per repo whether the branch is ahead of its base, and sends `session.ended`. Core's reaction opens a PR per changed repo through the `CodeHostAdapter`, idempotent per task repo, or opens a needs-you item when nothing changed.

**One session is one turn in milestone 1.** A second turn needs the composer of F-024 (milestone 3) and the idle timer of F-096 (milestone 2). The protocol carries `steer` and `interrupt` from now on, so nothing changes shape later.

**"In review" starts at "waiting for a reviewer"** in milestone 1. The CI and AI review rounds that come before it (F-035, F-100) arrive in milestone 6. The transition function allows that path when both are off. Detecting a merge is ticket sync, F-031, milestone 2, so a milestone-1 task stays in review.

---

## 5. The contracts

The five builders work in parallel on four shared packages. **One agent builds these first, as tickets 01 to 08.** After that, a change to a contract is its own small commit with a `♻️` or `✨` message that names the contract. It updates every caller in the same commit, or it's additive.

Each contract is Zod first: the schema is written once and the type is `z.infer`. Formats ostra owns are strict objects. Vendor formats are loose. IDs are the branded schemas in `packages/protocol/src/ids.ts`, which already exist. IDs are UUIDv7 strings generated by the database.

### 5.1 `packages/protocol` (Apache-2.0; depends only on `zod`)

**The runner protocol** (ticket 01), ported from `spikes/runner-transport/src/protocol/messages.ts` and widened to the product's commands:
- **Versions.** Major 1 in the URL (`/runner/v1/*`). Minor 0 for milestone 1, negotiated in `hello` and `welcome`, with the window of one minor older or newer (ADR 0034, F-061), and codecs for the current and previous shape.
- **The peer.** `hello.peer` is a union: `{ kind: "runner", runnerId }` or `{ kind: "sidecar", taskId, boxId, leaseEpoch }`. On `host` only the runner peer exists. A `docker` box's sidecar uses the second.
- **Up, from peer to server:** `hello` (the one loose message), `events` (a batch of `{ sessionId, sessionSeq, leaseEpoch, event }`), `command-ack` (`accepted`, `rejected`, `done` or `outcome-unknown`, with the highest contiguous seq), `status` (executor, capacity, labels, version, free slots) and `live-text` (untracked frames).
- **Down, from server to peer:** `welcome`, `ack` (`upTo`, or `resendFrom` when a batch doesn't start at the cursor), `credit`, `command`, `goaway`, `error`, `evict`. Close codes: `4403` revoked, `4409` replaced, and the rest from the spike.
- **Commands,** discriminated on `kind`, each with `seq`, `id` and `notAfter` (server time): `dispatch { taskId, sessionId, boxId, leaseEpoch }`, `steer { sessionId, clientMessageId, text, delivery: "queue" | "interrupt" }`, `interrupt { sessionId }`, `stop { taskId, sessionId, leaseEpoch, reason }`, `approval-answer { approvalId, decision }`, `drain`, `update-hint { version }`. Commands carry references, never secrets.
- **The HTTP endpoints** beside the WebSocket, request and response schemas only: `GET /runner/v1/info` (server version, minor window, the panel's URL, the device-flow client ID), `POST /runner/v1/register` (public key, name, executor, capacity, labels, OS, and either a device session as a bearer or the default pool's bootstrap join token; returns the runner ID), `POST /runner/v1/token` (a signed assertion; returns an access token and its expiry), `GET /runner/v1/tasks/:taskId/spec`, `POST /runner/v1/tasks/:taskId/credentials` (both take the lease epoch).
- **Limits and timers** as named working values: the 1 MiB frame cap, the window of 256 frames or 4 MiB, whichever comes first (the runner counts both, ADR 0034), ping 20 s, dead connection 45 s, the 10 s handshake timeout, task grace 10 min, self-fence 9.5 min, offer timeout 2 min.
- **Late events are refused.** A batch whose epoch the grace has ended gets an error, never a quarantine (Q111). The schema docs say so, so the runner and the gateway agree.

**Agent events, live text and config** (ticket 02):
- **The event union,** discriminated on `kind`, ported from `spikes/live-stream-and-task-view/src/shared/events.ts` (29 kinds: `user.message`, `turn.*`, `agent.message`, `agent.thought`, `agent.content`, `tool.*`, `approval.*`, `question.*`, `plan.updated`, `compaction.updated`, `session.config_changed`, `driver.changed`, `runner.connected`, `runner.lost`, `session.restored`, `session.crashed`, `pr.opened`, `agent.unknown`). Milestone 1 adds `environment.setup_started`, `environment.setup_output`, `environment.setup_finished`, `git.pushed { repoId, branch, headSha, ref }`, `pr.text_set { repoId, title, body }`, `session.ended { outcome: "with-changes" | "without-changes", repos: [{ repoId, ahead }] }`, `usage.recorded { providerId, modelId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, estimated }` (the key proxy's count, which is what spend comes from) and `session.usage { contextUsed, contextSize }` (the agent's own figure, once per turn, shown only as the context meter: ADR 0036, Q124). Tool events carry ACP's `kind` (`read`, `edit`, `execute` and the rest), so the panel renders by kind (ADR 0036). The read side keeps an `unsupported` row for a kind it doesn't know, never a silent drop.
- **Live text:** the frame schema for partial text, by segment, at most every 250 ms.
- **The task spec,** what a dispatch hands the runner: task, project and organization IDs, kind, title, prompt, branch name, lease epoch; the repos, each with its ID, `owner/name`, clone URL, default branch, checkout folder and the code host's LFS action hosts; the agent (adapter name, model ID, API format, extra instructions, the repo's PR template when there is one); the environment's setup script and its non-secret variables and files per repo; the git identity (the App's bot name and email) and the co-authors (name and email); and the limits (the turn's maximum minutes).
- **The task credentials,** returned only after the lease check: the model endpoint (base URL, format, auth scheme `bearer` or `x-api-key`, token); per repo, a git token and its expiry; the environment's secrets per repo; the token the runner uses for this task's MCP calls. The schema's description says the payload is never logged.
- **The runner's config:** server URL, data folder, transport (`websocket` in milestone 1), executor, capacity, labels and name, from flags and `OSTRA_*` variables, strict.

### 5.2 `packages/adapter-sdk` (Apache-2.0; depends on `protocol` and `zod`; ticket 09 adds `@agentclientprotocol/sdk`)

**The eight base classes** (ticket 03), one abstract class per kind (ADR 0025), each with a typed `capabilities` object, a `name`, a `health()` check and the abstract operations below. Adapters extend one class, one level deep.

| Base class | Abstract operations (milestone 1 implements the bold ones) | Capabilities |
|---|---|---|
| `TrackerAdapter` | getTicket, listTickets, updateStatus, comment, linkPullRequest (declared; Linear implements them in milestone 2) | `agentSessions`, `subIssues`, `statusGraph` |
| `CodeHostAdapter` | **appManifest, convertManifestCode, readApp, listInstallations, listRepos, mintRepoToken (one repo, named permissions), readFiles, getDefaultBranch, getPullRequestTemplate, getBotIdentity, findPullRequest, openPullRequest**, verifyWebhook | `checkRuns`, `prTemplates`, `lfsActionHosts` |
| `AgentAdapter` | **prepareLaunch (binary, args, allowlisted env, config files), mapUpdate (agent-specific ACP quirks)**; the base class composes the ACP driver: **startSession, prompt, cancel, close**, steer, loadSession | `steerMidTurn`, `sessionLoad`, `nativePlan`, `rejectAndContinue`, `elicitationForm`, `modelBaseUrlAndPlaceholderKey` |
| `ExecutorAdapter` | **create, prepare (checkout, setup), startAgent (returns the agent's stdio and a process handle: spike 3's `AgentHost` seam), commitAndPush, stop, release, state** | `isolation` (`container` or `none`), `services`, `boxSizes`, `snapshots` |
| `ModelProviderAdapter` | **testConnection (detects the format), listModels, matchCatalog** | `apiFormats`, `modelList`, `usageInStream` |
| `NotificationAdapter` | send (declared; milestone 3) | `channels` |
| `SecretStoreAdapter` | **put, get, delete** | `rotation` |
| `BlobStoreAdapter` | put, get, delete, resumable upload (declared; milestone 2) | `resumableUpload` |

Plus a **registry** (adapters register by kind and name) and the **capability types** the panel and the scheduler read.

**The shared plumbing and the contract-test helpers** (ticket 04):
- Store interfaces, which the server implements with Postgres and a test implements in memory: `RateBudgetStore`, `IdempotencyStore`, `SecretRowStore`.
- Retry with backoff and full jitter, rate budgets per credential, idempotency keys, Zod parsing of vendor data (loose), a structured logger that takes IDs and fields only, with a redaction guard for strings that look like tokens.
- `@ostra/adapter-sdk/testing`: one `defineXContractSuite(...)` per kind for Vitest, which an adapter's test file calls with a factory and its fakes. The suites hold the cases every adapter of that kind must pass. Milestone 1 fills the code host, agent, executor, model provider and secret store suites. The tracker, notification and blob suites exist with their first cases.

### 5.3 `packages/db` (Sustainable Use; Prisma 7.10.1, `@prisma/adapter-pg`, `pg`; `embedded-postgres` as a dev dependency)

**The dev database** (ticket 05): `pnpm db:dev` starts `embedded-postgres` (18.6.0-beta.19, the spikes' pin) in `.ostra-dev/pg` (gitignored) unless `DATABASE_URL` is set. `prisma.config.ts`, a client factory on `@prisma/adapter-pg`, migrate and generate scripts, and a test helper that gives each test file its own database.

**The schema** (ticket 06): every M1 entity from `domain-model.md`, including the nouns milestone 1 doesn't use yet, because adding a noun later is a rewrite (`build-order.md`, the v1 cut, rule 1). Every row carries `organizationId`. Every record inside a project also carries `projectId`, with a composite foreign key `(projectId, organizationId)` to the project (spike 9, recommendation 3).

| Group | Models |
|---|---|
| better-auth (from its generator, with ostra's edits as spike 9 made them) | `User` (username required, unique), `Session`, `Account`, `Verification`, `Organization`, `Member` (role `admin` or `member`), `Invitation`, `DeviceCode` |
| Install | `InstanceSetting` (open sign-up for accounts and for organizations, both off), `AuditEntry`, `ChangeNotice` (organization, project, entity, ID, seq) |
| Organization | `Connection` (kind `github` or `linear`, the App's ID, slug and bot identity, secret refs), `ModelProvider` (base URL, format, auth scheme, token's secret ref, sessions-at-once cap, allow on personal runners), `Model` (endpoint ID, catalog match or custom fields), `RunnerPool` (one default pool per organization), `JoinToken`, `Runner` (kind `pool` or `personal`, owner member, public key, executor, capacity, labels, version, state, command counter), `RunnerPresence`, `AgentProfile` (the built-in OpenCode profile and its model), `Secret` (encrypted rows for the built-in secret store) |
| Project | `Project` (name, slug, access `open` or `restricted`, default agent profile per task kind), `ProjectMember`, `ProjectPool`, `Repo` (connection, the code host's repo ID, `owner/name`, default branch), `Board`, `Environment` (one per project: base image, setup script, draft or saved), `EnvironmentEntry` (repo, kind `variable`, `secret` or `file`, name or path, value or secret ref, available during setup), `Service`, `Check`, `Snapshot`, `Automation` |
| Task | `Task` (kind, source `prompt` or `ticket`, title, prompt, branch name, state and sub-state columns that map to the domain's union, driver, creator, chosen runner, event counter, lease epoch), `TaskRepo` (repo, branch, head SHA, PR number and URL, state), `TaskCoAuthor`, `Lease` (epoch, runner, box, granted, ended), `Box` (executor, state), `Session` (agent profile, origin, state, the agent's own session ID, token counts), `Turn`, `Event` (`taskId`, `seq` unique per task; `sessionId`, `sessionSeq` unique per session; kind; payload `jsonb`), `Command` (runner, seq per runner, kind, body, `notAfter`, result), `Approval`, `NeedsYouItem` (audience, state), `WebhookDelivery` |
| Raw SQL in the migration | the `UNLOGGED` live-text table, one row per open segment (ADR 0035) |

Prisma's types are the source. `packages/db` exports the client, the transaction type and row mappers that parse IDs into their branded types, so nothing is typed again by hand.

### 5.4 `packages/domain` (Sustainable Use; depends on `protocol` and `db`)

**The lifecycles** (ticket 07), each a discriminated union with a pure, exhaustive transition function and its tests:
- **Task,** per kind. Every kind shares `awaiting_approval`, `queued`, `preparing`, `running`, `needs_you` and `stopped`. Code adds `in_review` (with the sub-states `ci_running`, `fixing_ci`, `ai_review`, `fixing_findings`, `waiting_for_reviewer`) and `merged`. Refine and review add `done`. Milestone 1 uses the code kind; the other two are types and tests only.
- **Session:** `starting`, `running`, `waiting`, `idle`, `ended` (with or without changes), `stopped`, `crashed`; and its origin (`new`, `resumed`, `restored`, `rebuilt`).
- **Box,** which a `host` worktree follows too: `creating`, `preparing`, `ready`, `idle`, `stopped`, `released`, `failed`.
- **Runner:** `joining`, `online`, `offline`, `draining`, `revoked`.
- **Approval, needs-you item, task repo** (no branch, branch pushed, PR open, merged, closed unmerged), **snapshot**, **lease** (active, ended, with its epoch).

**The use cases and settings** (ticket 08):
- **Ports:** `JobQueue` (enqueue inside a transaction; `packages/jobs` implements it), `CommandOutbox`, `ChangeNotices`, `Clock`, and the adapter instances the server holds (code host, model provider, secret store).
- **Use-case signatures,** each taking a transaction or the ports and returning a result union for expected failures: `createFirstAdmin`, `addModelProvider`, `connectGitHubApp`, `createProject`, `saveEnvironment`, `registerPersonalRunner`, `createPromptTask`, `dispatchTask`, `acceptOffer`, `issueTaskCredentials`, `ingestEvents`, `recordSessionEnd`, `openPullRequests`, `stopTask`. Ticket 08 writes the signatures and the job catalogue (names and Zod payloads). The builders write the bodies, in `packages/domain`, in the tickets section 7 names.
- **Access checks** for organizations and projects (ADR 0026), used by every tRPC procedure and by the stream.
- **Server settings:** one strict Zod schema over the environment, with a working default for every setting, and `docs/configuration.md`, the configuration reference, with one line per setting. Every later ticket that adds a setting adds its line there (the self-hosting rule in `AGENTS.md`).

---

## 6. Packages, licenses and owners

| Package | License | Depends on (workspace) | Built by |
|---|---|---|---|
| `packages/protocol` | Apache-2.0 | none | contracts |
| `packages/adapter-sdk` | Apache-2.0 | protocol | contracts (03, 04), adapters (09, 10, 12's stubs and usage) |
| `packages/adapters/adapter-github` | Apache-2.0 | protocol, adapter-sdk | adapters |
| `packages/adapters/adapter-opencode` (new) | Apache-2.0 | protocol, adapter-sdk | adapters |
| `packages/adapters/adapter-model-endpoint` (new) | Apache-2.0 | protocol, adapter-sdk | adapters |
| `packages/adapters/adapter-secret-store-builtin` (new) | Apache-2.0 | protocol, adapter-sdk | adapters |
| `packages/adapters/adapter-executor-host` (new) | Apache-2.0 | protocol, adapter-sdk | runner |
| `packages/adapters/adapter-executor-docker` (new) | Apache-2.0 | protocol, adapter-sdk | runner |
| `packages/adapters/adapter-linear` | Apache-2.0 | (milestone 2) | none in milestone 1 |
| `apps/runner` | Apache-2.0 | protocol, adapter-sdk, adapters | runner |
| `packages/db` | Sustainable Use | protocol | contracts |
| `packages/domain` | Sustainable Use | protocol, db | contracts (07, 08); bodies of use cases by core and api |
| `packages/jobs` | Sustainable Use | db, domain | core |
| `packages/api` | Sustainable Use | protocol, db, domain, jobs, adapters | api |
| `packages/task-view` | Sustainable Use | protocol | web |
| `apps/core` | Sustainable Use | everything server-side | core |
| `apps/web` | Sustainable Use | api, task-view, protocol | web |

**The license line** (ADR 0045, ADR 0048): no Apache-2.0 package depends on a Sustainable Use one, directly or through another. `pnpm check:licenses` checks it on every commit. A new package declares its license in `package.json` and, if Apache-2.0, carries the `LICENSE` file as the existing Apache packages do.

---

## 7. The builders and their tickets

**contracts** (one agent, first): 01 to 08. Everything else waits on some of these. Each ticket names exactly which.

| # | Ticket | Builder | Blocked by |
|---|---|---|---|
| 01 | Protocol: the runner protocol | contracts | none |
| 02 | Protocol: agent events, live text, task spec and config | contracts | none |
| 03 | Adapter SDK: the eight base classes and capabilities | contracts | 01, 02 |
| 04 | Adapter SDK: shared plumbing and contract-test helpers | contracts | 03 |
| 05 | DB: dev Postgres, Prisma 7 and the test helper | contracts | none |
| 06 | DB: the milestone 1 schema and first migration | contracts | 05 |
| 07 | Domain: the lifecycle unions and transitions | contracts | 02, 06 |
| 08 | Domain: use-case signatures, jobs catalogue, settings | contracts | 07 |
| 09 | ACP driver and the ACP-to-event mapping | adapters | 03 |
| 10 | Scripted fake ACP agent and the agent contract suite | adapters | 04, 09 |
| 11 | The OpenCode adapter | adapters | 10, 12 |
| 12 | The model endpoint adapter, the catalog and stub models | adapters | 04 |
| 13 | The GitHub code host adapter | adapters | 04 |
| 14 | The built-in secret store adapter | adapters | 04 |
| 15 | The `ostra` CLI and personal-runner sign-in | runner | 01 |
| 16 | The runner's connection, spool and commands | runner | 01, 02 |
| 17 | The key proxy | runner | 02, 12 |
| 18 | The git proxy | runner | 02 |
| 19 | The `host` executor | runner | 04, 18 |
| 20 | ostra's MCP tools in the sidecar | runner | 02 |
| 21 | The task host: the sidecar's work, end to end | runner | 11, 15, 16, 17, 19, 20 |
| 22 | The `docker` executor, the three images and the compose file | runner | 21 |
| 23 | The jobs package on pg-boss | core | 08 |
| 24 | The runner gateway | core | 01, 08 |
| 25 | Event ingest, fencing and the task grace | core | 23, 24 |
| 26 | Dispatch, leases and task credentials | core | 13, 14, 25 |
| 27 | Session end: PRs, no empty PRs, stop and crash | core | 13, 26 |
| 28 | The model catalog and model-list jobs | core | 12, 23 |
| 29 | `pnpm dev`: one command for the whole dev stack | core | 05 |
| 30 | Auth, the first admin and organization scope | api | 08 |
| 31 | Routers: model providers and the GitHub connection | api | 12, 13, 14, 30 |
| 32 | Routers: projects, environments and detection | api | 13, 30 |
| 33 | Routers: tasks and the live stream | api | 23, 30 |
| 34 | Milestone 1 screen targets | web | none |
| 35 | The panel shell | web | 30 |
| 36 | The task-view fold | web | 02 |
| 37 | The first-run checklist and setup screens | web | 31, 32, 35 |
| 38 | The task page and the project's task list | web | 33, 35, 36 |
| 39 | The end-to-end demo and the ledger | core (lead) | 22, 27, 28, 29, 37, 38 |
| 40 | Run the manifest flow once in a browser | maintainer | 31, 37 |
| 41 | Core takes a box's sidecar as a peer, with a token for its one task | core, runner | none |
| 42 | Core accepts a pool's join tokens, and holds a runner for approval | core, api | none |
| 43 | The `host` executor finds Git for Windows' bash | runner | none |

**Tickets 41 to 43 are follow-ups,** added on 2026-11-19 from the questions the milestone raised (`context/open-questions.md`, Settled: Q129, Q130 and Q136's item 9). Each closes something milestone 1 shipped half of: F-017's box has no peer on core's side, the Runners page makes join tokens core refuses, and `ostra runner` started from PowerShell finds no `bash`. Two of them touch rows this spec's list doesn't hold, F-015 (41) and F-091 (42), so each ticket names its own features. The milestone's other follow-ups are tickets 41 to 46 of milestone 2 (`../m2-tickets-in/spec.md`, section 7).

**Who starts when.** The contracts agent works 01 → 02 → 05 → 06 → 03 → 04 → 07 → 08, committing each. Builders start as soon as their first ticket unblocks: web on 34 at once and 36 after 02, runner on 15 and 16 after 02, core on 29 after 05, adapters on 09 after 03, api on 30 after 08.

---

## 8. Test seams

Each seam is agreed here so builders don't each invent one.

- **Postgres:** the test helper of ticket 05, an embedded instance with a database per test file. Every test that reads data also checks that another organization's rows, and a restricted project's rows, stay invisible (ADR 0026, spike 9's `isolation.ts` as the template).
- **Model endpoints:** stub servers in both API formats, ported from spike 1's `stub-models`, exported from `@ostra/adapter-sdk/testing` (ticket 12). The key proxy, the model endpoint adapter and the agent suite use them. The live case reads `model.env` and is skipped when it's not loaded.
- **Agents:** the scripted fake ACP agent (ticket 10). It declares the capabilities OpenCode lacks, so parity stays testable. The OpenCode adapter runs the same suite against the stubs and, gated on `model.env`, against the real endpoint.
- **GitHub:** a fake code host for the contract suite (ticket 13), including spike 4's rule that a request without a `User-Agent` is refused, and an upstream git stub for the git proxy (ticket 18). The live cases run against `ostra-test/test1` when `github.env` and `github-test.env` are loaded, and clean up their branches.
- **Runner and server:** the runner's connection tests run against a fake gateway built from the protocol's schemas (ticket 16), and the gateway's tests against a fake peer (ticket 24), so neither waits for the other.
- **Docker:** a fake Engine API for the `docker` executor's unit tests (ticket 22). Its live suite is skipped unless `docker` answers.
- **The browser:** the fold's tests run on recorded event streams (ticket 36), including spike 1's captures with tool calls. The demo uses a real browser.

---

## 9. Every ticket's checks and commit

A ticket is done when its own "done when" holds and these hold in the same commit:
- `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for the packages it touches (`pnpm --filter <pkg> ...`), and `pnpm check:licenses` passes.
- Tickets that touch auth, credentials, the schema, the runner protocol or anything that runs agent output (01, 02, 05, 06, 09, 10, 15 to 22, 24 to 27, 30 to 33, 39) run all the checks for the whole repo (`AGENTS.md`, the table of checks).
- Every new setting has a working default and its line in `docs/configuration.md`.
- No secret, no `.env` file, no embedded Postgres data, no other agent's `spikes/` in the commit. Logs carry IDs and fields, never tokens, prompts or agent output. Untrusted text is never interpolated into a shell command: child processes get argument arrays.
- Commit only the ticket's own paths: `git add <paths>`, then `git commit -m "<gitmoji> <summary of at most 50 chars>"`, `git pull --rebase origin main`, `git push origin main`. Retry after a few seconds on `index.lock` or a rejected push. No AI attribution.
- The ticket file gets `Status:` updated and a line under `## Comments` with the commit's hash.

---

## 10. What each ticket ports

| From | What | To (ticket) |
|---|---|---|
| `spikes/runner-transport/src/protocol/` | messages, negotiation, close codes, timers | 01 |
| `spikes/runner-transport/src/runner/` | peer, spool, state | 16 |
| `spikes/runner-transport/src/server/` | replica (presence, outbox, `NOTIFY` plus sweep), schema | 24, 25 |
| `spikes/live-stream-and-task-view/src/shared/` | events, fold, tools | 02, 36 |
| `spikes/live-stream-and-task-view/src/producer/acp-map.ts` | ACP to ostra events | 09 |
| `spikes/live-stream-and-task-view/src/server/` | appender, tailer, wake, SSE | 25, 33 |
| `spikes/live-stream-and-task-view/src/web/` | convert, the page | 38 |
| `spikes/how-should-the-runner-drive-opencode/src/lib/` | ACP driver, process tree, deciders | 09 |
| same | OpenCode launch, per-task dirs, config | 11 |
| same | key proxy, usage, stub models | 12, 17 |
| `spikes/what-is-inside-a-box/src/` (another agent's spike, in progress) | the `AgentHost` seam, sidecar, bridge, snapshot Dockerfile | 19, 22, once it's committed. Until then, build from spike 1 and ADR 0029 |
| `spikes/github-app-and-git-proxy/src/` | git proxy, pkt-line, policy, LFS hosts | 18 |
| same, `github/` | App auth, manifest, PR flow, bot identity | 13 |
| `spikes/auth-foundation/src/` | better-auth setup, roles, organization scope, isolation test | 06, 30 |
| `spikes/durable-queue-choice/src/` | jobs, job definitions, `enqueueInTx` | 23 |

**Dependencies,** pinned exactly (pnpm 11 refuses versions under a day old). The ones the spikes already ran: `zod` 4.6.7, `prisma`, `@prisma/client` and `@prisma/adapter-pg` 7.10.1, `pg` 8.23.1, `better-auth` 1.7.25, `pg-boss` 12.38.2, `ws` 8.23.0 with `@types/ws` 8.18.2, `@agentclientprotocol/sdk` 2.7.0, `@opencode/cli` 2.3.2, `@octokit/auth-app` 8.3.1, `@octokit/rest` 22.0.1, `ai` 7.0.173 (types only), `@assistant-ui/react` 0.15.36, `@assistant-ui/react-markdown` 0.14.26, `react` 19.3.1, and `embedded-postgres` 18.6.0-beta.19 as a dev dependency. `embedded-postgres` is approved as a dev dependency only (ADR 0007). New in milestone 1, from ADR 0007 and answers section 4.6: Next.js 16, Tailwind 4, shadcn/ui, tRPC 11, TanStack Query 5, `@modelcontextprotocol/sdk`, `lucide-react`, and `dockerode` (answers 4.6; its license is checked before it's pinned). `ai` and `@assistant-ui/react` are pinned to the newest pair at least a day old when they're installed (ADR 0036). Still to confirm when this was written, so not added: `@tanstack/react-virtual` (Q112; paging by turn covers milestone 1) and a Windows job-object helper (Q126). Both are settled since (ADR 0007): the first was confirmed on 2026-11-19, and the second is `koffi`, chosen on 2026-11-19 and added by milestone 2's ticket 42. Nothing else without asking the maintainer.

---

## 11. Choices this spec makes, and where each stands

Each is the smallest choice that unblocks milestone 1. If the maintainer disagrees, it moves to `context/open-questions.md` and the ticket that holds it changes. **Status, 2026-11-19:** nine are built as written or changed, and one moved to Q126. **Confirmed on 2026-11-19, on the maintainer's delegation (Q136, `context/history/answers-2026-11-19.md`):** items 1 to 4, 6 to 8 and 10 stand, item 9 changes on Windows, items 1 and 10 gain a guard, and item 5 is settled as Q126. Each item ends with its status.

1. **The secrets key.** The built-in secret store encrypts with `OSTRA_SECRETS_KEY`. When it's unset, the server generates a key on first start and keeps it in its data folder, and `docs/configuration.md` says to back it up. A fresh install then needs no setting (ticket 14). *Status: Built as written and confirmed (Q136); `docs/configuration.md` has the setting and the backup warning. A guard follows: the server checks at start that its key can read the database's secrets, and the key that signs runners' tokens gets a setting (milestone 2's ticket 45).*
2. **Ports.** Web on 3000 and core on 8787 in development (`tunnel.env` already points at 8787). The runner talks to core, and `/runner/v1/info` names the panel's address for the device flow. *Status: Built as written and confirmed (Q136), in `docs/configuration.md`.*
3. **"Use an existing App"** beside the manifest flow. F-006 asks for the one-flow creation, which ticket 40 checks. The demo connects the test App that spike 4 already created. *Status: Built as written and confirmed (Q136): it stays for good, for an organization whose owners create Apps themselves. The demo connects the test App. The manifest flow's live run is ticket 40, so F-006 is not `done`.*
4. **The co-author's identity before F-119.** The trailer uses the member's ostra name and email. GitHub credits them when that email is one of their verified addresses. The verified link (F-119, milestone 3) replaces this. *Status: Built as written and confirmed until F-119 (Q136); the demo's commit carries `Co-authored-by` for the admin. Until a member links GitHub (F-119), their ostra email goes into commit messages, which F-119's row now says; with a link the trailer carries the account's no-reply address (ADR 0052).*
5. **Process containment on Windows `host`.** No job-object helper is added in milestone 1, because it needs a native addon or a helper program and the maintainer's yes (ADR 0029, ADR 0007, Q126). The `host` executor ends the agent's whole process tree on stop and crash, and the panel says that detached processes aren't contained. Ticket 19 leaves a seam for the job object. *Status: **Moved to Q126, and settled there on 2026-11-19:** the runner makes a job object itself, through `koffi` (ADR 0029; milestone 2's ticket 42). Until that ticket is in, `host` ends the process tree and the panel says so.*
6. **OpenCode's permissions in milestone 1.** With no approval rules until F-026, the per-task config lets the agent edit and run commands inside its worktree, and denies paths outside it (`external_directory`). The deny bounds OpenCode's file tools and not its shell, which reaches whatever the member's account does. So on `host` the agent's reach does not end at its task's workspace, and the panel's "not isolated" label says so (ADR 0029, ADR 0031, spike 10). Only a box contains the agent. The event log records every tool call's input, so a run can be audited (ADR 0035). *Status: Built as written and confirmed until F-026 (Q136), in the adapter's per-task config. Of the two gaps the demo found, Q133 is settled (milestone 2's ticket 44) and Q134 is still open.*
7. **Variables and secrets on `host`.** Each repo's variables and secrets are written to that repo's checkout, as the environment says (a `.env` file by default, or the file path given), and its setup script runs with the ones marked "available during setup" in its environment. Nothing is shared across repos. *Status: Built and confirmed (Q136). The sentence was corrected on 2026-11-19 to what the executor does: it first said the setup script got all of them.*
8. **One session is one turn,** and a task in review stays there until milestone 2's ticket sync (section 4). *Status: Built as written and confirmed for milestone 1 (Q136); milestone 2's sessions span turns. Q132 is settled as built: the task stays `queued` while an offer is out.*
9. **The setup shell on Windows.** The `host` executor runs a setup script with `bash` from `PATH` (Git Bash on Windows), set by `OSTRA_RUNNER_SHELL`. *Status: Built as written, and **changed on 2026-11-19 (Q136):** on Windows, `bash` means Git for Windows' own bash, found from the `git` the runner uses, and never the WSL launcher; a full path in `OSTRA_RUNNER_SHELL` is used as given (ticket 43). On the machine this milestone was built on, `bash` isn't on `PATH` in PowerShell.*
10. **Branch names.** `ostra/<last 8 hex digits of the task ID>-<slug of the title>`, the same in every repo of the task. (Changed by ticket 39 from the first 8 characters: a UUIDv7 starts with its timestamp, so tasks made within about a minute shared them, and the same prompt twice got the same branch.) *Status: **Changed** from the first 8 characters to the last 8 hex digits (see the item), and confirmed (Q136). A guard follows: a unique index on a project's branch names (milestone 2's ticket 46).*
