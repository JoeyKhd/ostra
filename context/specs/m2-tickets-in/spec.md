# Milestone 2: Tickets in, nothing lost

**Status:** spec, 2026-11-19. Tickets in `issues/`, one file each (`docs/agents/issue-tracker.md`).
**Milestone:** 2 (`context/build-order.md`).
**Features:** F-005, F-007, F-010, F-064, F-031, F-042, F-043, F-044, F-045, F-046, F-047, F-048, F-068, F-079, F-114, F-096, F-032, F-033, F-055, F-060. It also finishes F-097's "Create ticket", which waited for a tracker. Its demo signs in as milestone 1's default first admin (section 11, item 1).
**Decisions it builds on:** ADR 0006 (long-lived tasks), 0011 (the six guarantees), 0013 (trackers are adapters; Linear's two modes), 0034 (the runner protocol, the fence), 0035 (the event log), 0037 (pg-boss, as amended after spike 8: timers, sweeps and the forwarding queue's heartbeat), 0039 (idle boxes, hidden refs, session archives, as amended after spike 2: Q128, Q150), 0042 (four token kinds, each priced: Q163), 0043 (blobs), 0047 (Jira's shape, which the tracker interface must fit).
**Spikes it ports from:** 2 (`can-a-session-move-to-a-fresh-box`), 5 (`linear-agent-mode`), 6 (`runner-transport`) and 8 (`durable-queue-choice`), section 10. Product code never imports `spikes/`. A builder copies the code into the product's package and adapts it, with a one-line provenance comment (`// Ported from spikes/<spike>/<path>.`).
**Builds on milestone 1** as it was built (`../m1-first-pr/spec.md`, `../m1-first-pr/demo.md`), not only as it was specified. Where the code differs from the M1 spec, this spec follows the code.

Terms follow `context/GLOSSARY.md`. Lifecycles follow `context/domain-model.md`.

---

## 1. What milestone 2 ends with

A member picks a ticket from the project's Inbox. It becomes a task, and the task's PR is linked on the ticket, which moves through its statuses as the work does. The failure suite passes: kill the runner, drop webhooks, restart the server mid-task, and nothing is lost or duplicated. A day later the task reopens on a fresh box with its context.

### What milestone 1 left that milestone 2 starts from

Read from the code on `main` on 2026-11-19, so builders don't rebuild what exists:

- **`@ostra/adapter-linear` exists** with the plain-API basics over `fetch`: `health`, `getTicket`, `listTickets`, `updateStatus`, `comment`, `linkPullRequest` (through `attachmentLinkGitHubPR`). It takes a personal API key or an OAuth token. It has no OAuth flow, no webhook handling, no statuses, no ticket context, and its contract suite is milestone 1's first cases only.
- **`@ostra/adapter-blob-postgres` exists** with its rows behind a `BlobRows` port and an in-memory implementation. No Postgres table backs it, nothing on the server uses it, and the blob contract suite has its first cases only.
- **The schema has `Board`, `Connection` (kind `linear`), `WebhookDelivery`, `Snapshot`, `NeedsYouItem` and the task's `ticketKey`,** unused. There is no ticket cache, no idempotency or rate-budget table, and no blob table. The plumbing's `IdempotencyStore` and `RateBudgetStore` have only in-memory implementations.
- **The runner pushes the hidden ref on stop and on crash only,** and a session is one turn: after the turn the runner commits, pushes, sends `session.ended`, and releases the workspace. Core opens PRs on `session.ended`.
- **The protocol is at minor 0.** It carries `steer`, `interrupt`, `stop` (reasons `requested`, `grace-expired`, `spend-cap`, `runaway`), and the events `session.restored` (kind only) and `session.crashed`.
- **The task lifecycle already has `reopen`,** and the enums already hold the needs-you reasons `stalled`, `spend_cap`, `crashed` and `ticket_closed`, and the stop reasons `runaway` and `spend_cap`.
- **Known gaps from M1's demo** that this milestone owns: a batch the server can't store is resent forever (ticket 17); OpenCode's tool outputs land in the machine's temp folder on `host` (Q134's interim answer, in ticket 23's release). The agent already starts inside the repo when a task has one (Q133), and ticket 44 reports files left outside every repo.
- **`packages/jobs` has four gaps** that ADR 0037 lists after spike 8: no heartbeat on pg-boss's forwarding queue and no boot check, no `singletonSeconds` on its schedules, no `group` for throttled jobs, no test of the panel's start against an empty schema. F-044's five minutes rest on the first (ticket 01).
- **The default first admin** (`demo@demo.com` / `demo` unless `OSTRA_ADMIN_*` says otherwise, with the forced password change and `OSTRA_ALLOW_DEFAULT_PASSWORD`) is milestone 1's, decided by the maintainer on 2026-11-19 and designed in `context/brand/app-targets/m1/change-password.md`. Milestone 2 uses it and builds nothing more for it.

### What is in, and what is not

**In:** one Linear connection per organization through its own Linear app, webhooks when Linear can reach the install and polling when it can't; boards on projects with a status mapping; the project's Inbox; tasks from tickets with their context; ticket sync; PR states from GitHub; a session that lives across turns; the idle timer; the hidden ref and the session archive after every turn; reopening on the same box, on a fresh box from the archive, or from the rebuild template; runaway protection; cleanup; the built-in blob store, and the S3-compatible one; the two repo checks; the failure suite.

**Not in** (and when it comes):
- Linear agent mode, stop and follow-up from Linear: F-012, milestone 6. The connection's scopes and webhook types leave room for it (section 11, item 3)
- starting several tickets at once: F-107, milestone 6. The Inbox starts one at a time, so F-010 stays `building`
- intake rules and schedules: F-011, F-106, milestone 6
- the ticket closed while its task runs, and the fresh branch after a merge: F-066, milestone 3
- steering, approvals in the panel, take over: F-024, F-026, milestone 3. The composer in milestone 2 only reopens a task or sends the next turn to an idle session
- invites, so "another member" reopens: F-002, milestone 4. The demo reopens as the same member
- another agent through the rebuild template: F-018, after v1 (it was milestone 7 until 2026-11-19). The contract suite proves it with the scripted fake agent
- `kubernetes` and its deleted pods: F-093, milestone 5
- budgets per organization and project: F-037, milestone 4. Milestone 2's spend cap is per task, with a server-wide default
- Jira itself: F-008, after v1. Only the Jira fake runs in the tracker contract suite (ADR 0047, Q104)

### On this machine

The same adjustment as milestone 1 (`../m1-first-pr/spec.md`, section 1): the demo runs on the `host` executor, on a personal runner. On `host` a "box" is a worktree, its "stop" ends the agent's process tree, and "a fresh box" is a new worktree on the same or another runner. Every row whose "done when" needs a `docker` box (a stopped box kept until its host needs the space, the sidecar dropping out) stays `building` until the Linux run, as F-017 does.

---

## 2. The features, and where each one lives

"At M2's end" is the ledger status the demo ticket (39) sets, if and only if every condition in the row's "done when" holds.

| F-ID | What milestone 2 builds | Packages | Tickets | At M2's end |
|---|---|---|---|---|
| F-005 Connect Linear | The organization's own Linear app from a pre-filled manifest link (Create, paste three values, Authorize with `actor=app` and PKCE). Tokens in the secret store, refreshed before they expire. Webhooks routed by connection when core has a public address; polling otherwise. Its status, its mode and the last event received, in the panel | `adapter-linear`, `apps/core` (webhook inbox, token refresh), `packages/api`, `apps/web` | 03, 07, 08, 13, 14, 27, 33 | done |
| F-007 Boards | A project admin attaches Linear teams to a project as boards. Each board has a status mapping with defaults from Linear's status types. One active code task per ticket per project | `packages/db`, `packages/domain`, `packages/api`, `apps/web` | 05, 06, 28, 34 | done |
| F-010 Ticket inbox | Each project's Inbox lists the open tickets of its boards from the ticket cache, filterable, and starts a task from one in one action, with kind and agent profile from the project's defaults | `packages/api`, `apps/web`, `apps/core` (the cache) | 14, 29, 35 | building: several at once is F-107, milestone 6 |
| F-064 Ticket context | The task's first prompt is the ticket rendered through a template an admin can edit: title, description, comments, labels, images, parent and linked tickets, and the profile's instructions. Images are copied into the workspace | `adapter-linear`, `packages/domain` (the renderer), `apps/core`, `apps/runner`, `packages/api`, `apps/web` | 03, 06, 07, 18, 26, 31, 37 | done |
| F-031 Ticket sync | Started on the task's start, "in review" at its first PR, "done" on merge only when Linear's GitHub integration isn't installed. One progress comment edited in place. Every PR linked, plus a link to the task. The board can change the mapping | `apps/core` (the tracker writer), `adapter-linear`, `packages/api`, `apps/web` | 07, 15, 16, 28, 34 | done |
| F-042 Private installs | With no public address, every board is polled every 60 s *(working value)*, and every ticket change still arrives | `apps/core` | 14 | done |
| F-043 Nothing is lost | A server killed at any moment and started again loses no ticket event, task change or agent event, and every running task carries on. A batch the server can't store is refused once, visibly, instead of resent forever | `apps/core`, `apps/runner`, `packages/jobs` | 01, 13, 17, 21, 38 | done |
| F-044 Drift gets fixed | With webhooks off, ticket changes arrive within 60 s and PR merges and closes within 5 min *(working values)*, on the forwarding queue's heartbeat (ADR 0037). *Note 2026-11-22 (Q344): this narrowed F-044; the maintainer's answer widened the reconcile to PR comments, reviews and a reopened PR too, after this milestone (ADR 0011 amended).* | `apps/core`, `packages/jobs` | 01, 14, 16, 38 | done |
| F-045 Runners can drop out | Milestone 1's grace and fence, plus: a task stopped by the grace is ready to reopen on a fresh box, and does | `apps/core`, `apps/runner` | 18, 24, 38 | building: the sidecar case waits for `docker` on Linux |
| F-046 No duplicates | Every tracker and code-host write goes through a Postgres-backed idempotency store and the tracker writer's own outbox, and each handler looks its effect up by a marker it can recompute before it creates it. Replaying any webhook, or retrying any call, makes no second PR, comment, link or status change. Each contract test keeps a control without the lookup, which must duplicate (ADR 0037) | `apps/core`, `packages/db`, `packages/adapter-sdk` | 05, 13, 15, 16, 38 | done |
| F-047 Agent crashes don't kill tasks | A killed agent or a lost box marks the session crashed, keeps the branches, the hidden ref and the last archive, and one action reopens the task, on a fresh box when the old one is gone. The member's unanswered message is replayed | `apps/core`, `apps/runner` | 17, 18, 24, 38 | done |
| F-048 Failure tests | `e2e/m2-failure-suite/`: against the test workspaces it kills runners, cuts the network, drops webhooks, replays them and restarts the server mid-task, with spike 8's three kill points on a fake GitHub that counts idempotency keys, and every check passes | `e2e/` | 38 | building: the row's schedule hunt needs F-106's scheduler tick, milestone 6 |
| F-068 Runaway protection | A session stops after 2 h (one delayed job per session) or after 10 min with no agent event (a sweep once a minute), both on the server (ADR 0037); a task stops at its spend cap, 25 USD by default, enforced by the key proxy on the four token kinds. Then the task needs you | `apps/core` (timers, sweep), `apps/runner` (key proxy), `packages/domain` | 02, 19, 25 | done |
| F-079 Cleanup and retention | The box is released when the task's last PR merges or closes, or after 14 idle days. The hidden ref is deleted then. Histories, archives and blobs stay while the task exists unless an admin sets a retention period | `apps/core`, `apps/runner`, `adapter-github`, `packages/api`, `apps/web` | 09, 20, 23, 31, 37 | building: the `docker` box that goes when its host needs the space waits for Linux |
| F-114 Blob storage | The built-in store on its own Postgres tables, the runner's upload and download through core, the full blob contract suite. The S3-compatible adapter on `@aws-sdk/client-s3` (approved 2026-11-19) | `adapter-blob-postgres`, `adapter-blob-s3` (new), `apps/core`, `packages/db` | 04, 05, 11, 12 | done |
| F-096 Idle, stop and release | After every turn: commit and push, the hidden ref, the session archive uploaded. After 15 idle minutes the box stops. A turn that waits on a person follows the same timer | `apps/runner`, `apps/core`, `adapter-opencode` | 10, 17, 22, 23 | building: the kept `docker` box waits for Linux. "Starts no CI" was checked by hand against `test1`'s push workflow on 2026-11-19 (ticket 40), and ticket 39 checks it again |
| F-032 Reopen | Any member reopens any task with a message and keeps working on the same branches; new commits update the same PRs | `packages/api`, `apps/core`, `apps/web` | 18, 30, 36 | done |
| F-033 Reopen anywhere | The three steps of ADR 0039, on any runner: the same box while it's kept, a fresh box from the archive and the hidden ref (the normal path), the rebuild template | `apps/core`, `apps/runner`, `adapter-opencode`, `packages/domain` | 06, 10, 18, 24 | building: "by another member" needs invites (milestone 4), "with another agent" needs F-018 (after v1 since 2026-11-19) |
| F-055 Signed-commit repos | A repo whose default branch requires signed commits is reported to the admin as unsupported, and no task starts on it | `adapter-github`, `packages/api`, `apps/web` | 04, 09, 31, 37 | done |
| F-060 Default-branch warning | A repo whose default branch isn't protected shows a warning, with the reason, on the project and when a task starts | `adapter-github`, `packages/api`, `apps/web` | 04, 09, 31, 37 | done |
| F-097 Prompt tasks ("Create ticket") | "Create ticket" on a prompt task creates a ticket on one of the project's boards and links the task to it | `packages/api`, `apps/core`, `apps/web` | 29, 36 | done |

**Built in from the first milestone** (`build-order.md`), checked again by ticket 39:
- Organization-scoped data: every new row carries `organizationId`, and every project record carries `projectId` with the composite foreign key (05).
- The event log and the durable queue: a webhook is saved before it's answered, and acted on only from the queue (13).
- No credential in the agent's container: the Linear token never reaches the runner. Ticket images are fetched by core and handed over as blobs (12, 26).
- ACP as the only way to talk to an agent: session load, export and import go through the agent adapter (10).
- Strict typing, dark first, responsive, English text in message files: as milestone 1.

---

## 3. The end-to-end demo

Ticket 39 runs it and records the result under its `## Comments` and in `demo.md` next to this spec. Everything runs against the Linear workspace `ostra-test` (team `OST`) and the GitHub org `ostra-test` (repos `test1` and `test2`). Secrets come from `~/.config/ostra-dev/` with `set -a; . ~/.config/ostra-dev/<file>; set +a`, and are never printed, logged or committed.

**Before:** a fresh clone, `pnpm install`, `pnpm dev:reset`, `tunnel.env` loaded so core has a public address (`OSTRA_DEV_PUBLIC_URL`), and `pnpm dev`. Milestone 1's setup is done by the M1 script's helpers: a model provider, the test App, a project with `test1`, a personal runner online. The panel signs in as the **default first admin, `demo@demo.com` with the password `demo`**, unless `OSTRA_ADMIN_*` names another (milestone 1's, section 11, item 1). The scripted run sets `OSTRA_ALLOW_DEFAULT_PASSWORD=true`, so no forced password change interrupts it; the manual run goes through the change once.

**Until the maintainer authorizes the Linear app** (decided 2026-11-19, ticket 40). Linear's consent-free grant, client credentials, is off on the `ostra-test` app, and only a person can switch it on (`context/research/linear-app-token-without-consent.md`). So the overnight runs don't wait on step 1's click:
- **The seed.** `e2e/m2-tickets-in/seed-linear.ts` (ticket 39) creates the organization's Linear connection straight from `LINEAR_API_KEY`: `credentialKind: api_key`, state `active`, the workspace from `viewer` and `organization`, and `appUserId` null. The key goes into the secret store, and nowhere else. This is a development path only: no panel action creates an `api_key` connection, and the panel labels it `Personal API key (development)`.
- **Webhooks.** When `OSTRA_DEV_PUBLIC_URL` is set, the seed registers a workspace webhook through `webhookCreate`: team `OST`, resource types `Issue`, `Comment`, `IssueLabel` and `Attachment`, URL `/webhooks/linear/<connectionId>`, and a secret it generates and keeps only in the secret store. It deletes the webhook when the run ends. Without a public URL, the connection polls.
- **What works with it:** steps 2 to 7 and 9, the checks after the run, and the failure suite. Comments, status moves and attachments come from the maintainer's user, not an app user. With `appUserId` null there's no own-echo filter. The ticket cache is upserted either way, and every write is still found by its marker before it's made (F-046), so nothing loops.
- **What waits for the consent click:** step 1 itself, the app user, and step 8's expired and refreshed token. The manual run in the morning does step 1 by hand: "Connect Linear", Create, the three values, Authorize. It saves `LINEAR_REFRESH_TOKEN` in `linear.env`, and runs steps 8 and 9 on that connection. Ticket 39 records the two runs separately.

1. **Connect Linear.** Organization settings, "Connect Linear". ostra shows the manifest link, pre-filled with this install's callback and its per-connection webhook URL. The maintainer clicks Create in Linear (once, by hand: ticket 40), pastes the client ID, the client secret and the webhook signing secret into ostra, and presses Authorize. Linear asks for the workspace's consent and comes back. The connection shows `ostra-test`, the app's own user, "webhooks: receiving", and the last event received.
2. **Attach the board.** In the project, "Boards", "Attach a board": team `OST`. The status mapping fills itself from Linear's status types (open: triage, backlog, unstarted; started: the first `started` state; in review: the `started` state named like "review", or the started state; done: the first `completed` state). ostra says whether Linear's GitHub integration is installed, and so whether it will move tickets to done itself.
3. **A ticket arrives.** The script creates a ticket in `OST` through the API (a test tool, with the maintainer's key from `linear.env`): a title, a description with one image, a label and one comment. It shows in the project's Inbox within 5 s, through the webhook.
4. **Start it.** In the Inbox, "Start task" on the ticket: kind `code` and the OpenCode profile come from the project's defaults. The task appears as queued. On Linear, within seconds: the ticket moves to the mapped "started" status, gets one comment from the app's user ("ostra is working on this", with a link to the task) and a link attachment to the task.
5. **Context.** The task page shows the ticket's key, status and link. The first prompt is the rendered template: the title, the description, the comment, the label, the profile's instructions. The image is in the workspace under `.ostra/ticket/`, and the prompt names its path. The branch is `ostra/ost-<n>-<last 8 hex of the task ID>-<slug>`.
6. **The PR.** The turn ends with changes. After the turn the runner pushes the branch, writes the hidden ref and uploads the session archive. Core opens the PR: its title starts `OST-<n>:`, its body holds `Closes OST-<n>` and the agent's text. On Linear the PR is linked on the ticket, the ticket moves to the mapped "in review", and the progress comment is edited in place, not added again.
7. **Idle.** No one sends anything. After the idle timer (15 min; the script sets `OSTRA_BOX_IDLE_MINUTES=2`) the agent's process stops, the session ends, and the task stays in review. The hidden ref and the archive are on GitHub and in the blob store.
8. **A day later.** At least 24 hours after step 6, so the Linear access token from step 1 has expired and been refreshed: the old worktree is gone (the script releases it, as cleanup would), and a second personal runner, from another data folder, is the only one online. The member reopens the task with a message: "Also add today's date at the top. And what did you change in your first turn, and why?" The task goes queued, preparing (a fresh worktree, the branch fetched, the hidden ref restored, the archive imported), running. The thread shows "restored from the session archive". The agent answers about its first turn correctly, and its new commit updates the same PR. The ticket gets no second comment: the progress comment is edited.
9. **Merge.** The script merges the PR on GitHub with the test token. Core learns it from the App's webhook (or the reconcile, within 5 min). The task is merged, the box is released, the hidden ref is deleted. The ticket moves to done: by Linear's GitHub integration when it's installed, by ostra when it isn't.

**The checks after the run** (ticket 39 scripts what it can, in `e2e/m2-tickets-in/`):
- **No duplicates (F-046).** On the ticket: one progress comment, one attachment per PR, one task link, and exactly one status change per mapped step, read from the ticket's history. On GitHub: one PR.
- **Nothing reached the agent that shouldn't.** The Linear token appears nowhere in the worktree, the agent's directories, the event log or a log line (searched by value, never printed). Ticket text in the prompt is passed as data, never into a shell.
- **Private install (F-042).** With the webhook route blocked (`OSTRA_DEV_BLOCK_WEBHOOKS=linear`), a ticket edited in Linear reaches the Inbox within 60 s.
- **The rebuild template (F-033, step 3).** A second task's archive blob is deleted before its reopen. It reopens "rebuilt from the template" and answers at least 4 of spike 2's 5 questions.
- **The repo checks (F-055, F-060).** `test2` is added to a second project: with its default branch unprotected the panel warns, and with the signed-commit rule on (ticket 40) the panel says the repo isn't supported and refuses to start a task on it. The script switches the ruleset `ostra-demo-signed-commits` on and off with `GITHUB_TEST_ADMIN_TOKEN` (ticket 40). It runs only once `test1` and `test2` are public, or the org is on a paid plan, and the token is saved. Until then, ticket 39 records the check as waiting on ticket 40.
- **Runaway protection (F-068)** runs in the failure suite on the scripted fake agent, where the timers can be short.
- **"Create ticket" (F-097).** A prompt task gets a ticket in `OST`, linked both ways.
- **Clean-up:** the demo's tickets are archived in `OST`, its PRs closed, its branches and hidden refs deleted, in `test1` and `test2` only.

**The failure suite** (ticket 38, `e2e/m2-failure-suite/`, F-048) runs against the same stack. Each case checks, after it, that every event the server received is stored exactly once, that no PR, comment, link or status change is doubled, and that the task ends where it should:

| Case | How | Must hold |
|---|---|---|
| Kill the runner mid-turn | `kill -9` (on Windows `taskkill /T /F`), restart it from its data folder | It carries on from its spool; the task finishes; no event stored twice |
| Cut the network, 30 s and 5 min | the loopback cut proxy from spike 6, between runner and core, in both modes (`hold`, `reset`) | The task carries on; a reopen message sent during the cut arrives |
| Cut for longer than the grace | 11 min (`--long` only) | The task stops cleanly (`runner_lost`), stale writes are refused, and the task reopens on a fresh box with its context |
| Restart the server mid-turn | `kill -9` core and web, start them again | The runner reconnects; the task carries on; queued jobs run once |
| Drop webhooks | block both webhook routes for the case | Ticket changes arrive within 60 s, a PR merge within 5 min |
| Replay webhooks | resend every delivery the inbox recorded, Linear's and GitHub's | Nothing new happens on Linear or GitHub |
| Retry after a write committed | the fakes answer 500 after applying a write, then the real services through a fault-injecting proxy | No second comment, link, status change or PR |
| Kill the agent mid-turn | kill OpenCode's process tree | The session is crashed, the branch and the hidden ref stay, "Reopen" carries on |
| Lose the box | delete the worktree while the runner is stopped | The task reopens on a fresh worktree from the last archive, and the unanswered message is replayed |
| A batch the server can't store | the fake agent emits an event the server refuses | It's refused once, with a needs-you item, and the runner stops resending it |
| Stall, maximum duration, spend cap | the scripted fake agent, with the timers at seconds and the cap at cents | Each stops the session cleanly, and the task needs you with the right reason |
| Kill a replica mid-job | spike 8's three kill points (before the side effect, after it and before completion, after completion) on a fake GitHub that counts idempotency keys, for `task.open-pull-requests` and `ticket.sync` | One side effect per key; the job runs on the survivor |
| Revoke a runner mid-turn (ticket 41) | an admin's `runners.revoke` on a second personal runner while its turn runs | Its socket closes with `4403` and its task stops as `runner_lost` at once; its late events are refused, also when it's started again; the reopen goes to the other runner and restores the session with its context |

**What waits for the Linux machine,** written into ticket 39's comments: the same cases on `docker` (a sidecar dropping out, a stopped box kept and resumed in place, released when its host needs the space), and `kill -9` with POSIX semantics.

---

## 4. How it fits together in milestone 2

```
 Linear ──webhook──▶ apps/core /webhooks/linear/:connectionId ─┐ verify, claim, 200
 GitHub ──webhook──▶ apps/core /webhooks/github/:connectionId ─┤ (WebhookDelivery, then a job)
                                                               ▼
 browser ──▶ apps/web (Inbox, boards, reopen)            Postgres: tickets, boards, tasks,
                │ writes rows and jobs                   events, ticket writes, blobs,
                ▼                                        idempotency keys
             Postgres ◀──── apps/core workers: webhook.process, tracker.poll-board,
                │           ticket.sync, github.reconcile-prs, task.dispatch (reopen),
                │           box.release, cleanup and retention sweeps
                ▼
 runner ──WS──▶ apps/core gateway      runner ──HTTPS──▶ /runner/v1/tasks/:id/blobs (archives, ticket files)
   └─ after every turn: commit, push, hidden ref, archive export → upload → session.saved
   └─ idle timer → stop → session.ended;  reopen → restore from archive and hidden ref, or the template
```

**The flows:**
- **A webhook.** Core verifies the signature (Linear's HMAC and its 60 s timestamp window; GitHub's `X-Hub-Signature-256`), claims the delivery with one insert keyed by the connection and the delivery ID (and, for Linear, the signature too), enqueues `webhook.process` in the same transaction, and answers 200. The insert has a deadline of 2 s *(working value)*; past it, core answers 503 so the sender retries. Nothing else sits before the 200 (ADR 0013). Each delivery's transit time is recorded, and a skew over 10 s logs a warning.
- **A ticket change.** `webhook.process` reads the delivery as a hint: it fetches the ticket through the adapter and upserts the ticket cache row by the board and Linear's stable ID, never by the key, which changes when a ticket moves team. A change made by the connection's own app user is recorded and not acted on (no echo). With polling, `tracker.poll-board` asks for tickets updated since the board's cursor minus 2 min of overlap, ordered by `updatedAt`, and moves the cursor forward after each page commits.
- **A ticket becomes a task.** The Inbox's "Start task" creates the task (source `ticket`, the ticket's ID and key, the branch name with the key) under the partial unique index that allows one active code task per ticket per project, and enqueues `ticket.fetch-context`. That job reads the full context through the adapter, copies the images into the blob store, renders the prompt with the project's template, stores the prompt on the task, and enqueues `task.dispatch`. A ticket's text is untrusted: it's data in the prompt, inside marked blocks, and never reaches a shell.
- **Ticket sync.** Each state change that F-031 maps writes a `TicketWrite` row in the same transaction (status, comment, comment edit, PR link, task link), and `ticket.sync` applies it through the adapter with an idempotency key fixed by the task and the step. The progress comment's ID is kept on the task, so every later update edits it.
- **After every turn.** The runner commits what's left and pushes the task's branch, writes each repo's working tree to `refs/ostra/wip/<taskId>` with a forced push through the git proxy, exports the session archive, gzips it, uploads it through core in chunks, and sends `session.saved` with the heads, the hidden ref's commit, whether each repo is ahead, and the archive's blob ID. Core's reaction opens or updates PRs (idempotent per task repo) or, when nothing changed and no PR is open, raises the needs-you item of F-065. The session goes idle and the box stays warm.
- **The idle timer.** After `OSTRA_BOX_IDLE_MINUTES` with no turn, the runner stops the agent and sends `session.ended`. A turn that waits on a person is cancelled first, its needs-you item stays open, and answering it reopens the task (ADR 0039).
- **Reopen.** `tasks.reopen` writes a member message and a new session, raises nothing yet, and enqueues `task.dispatch`. The dispatch chooses the step: the same box when its runner still has it (`resumed`), else a fresh box with the archive and the hidden ref (`restored`), else the rebuild template (`rebuilt`). It writes that choice into the task spec's `restore` section. The lease epoch rises with the dispatch, so an old box that wakes up can't write.
- **A PR's state.** The App's `pull_request` webhooks, and a reconcile every 5 min over task repos with an open PR, move the task repo to merged or closed unmerged and the task to merged or stopped (`prs_closed`), as the domain's transitions say. The last PR closing releases the box (`box.release` sends the runner a `release` command) and deletes the hidden ref.

**One session now spans many turns.** It's idle between them while the box is warm, and ends when the box stops. A second turn on a warm box is `tasks.send` (milestone 1's procedure) or a reopen; the composer that steers mid-turn stays milestone 3's.

---

## 5. The contracts

Every contract change in milestone 2 is **additive**: a new optional field, a new union member, a new endpoint, a new table, column or enum value. Nothing is renamed or dropped (`AGENTS.md`: add first; drop or rename in a later release). Each lands as one small commit that names the contract and updates every caller in the same commit. Tickets 02 to 06 make them first; everything else builds on them.

### 5.1 `packages/protocol`: minor 1 (ticket 02)

- **The version.** The protocol goes to minor 1. A runner at minor 0 still works within the window (ADR 0034, F-061): core serves it milestone 1's task spec and sends it no `release` command, and that runner keeps one-turn sessions with no archive. A runner at minor 1 talking to a minor-0 server behaves as minor 0. The codecs for the current and previous shape cover both.
- **Events, new members of the union:**
  - `session.saved { turnOrdinal, repos: [{ repoId, headSha | null, ahead, hiddenRefSha | null }], archive: { blobId, size, sha256 } | null }`: what left the box after a turn. `archive` is `null` when the export or the upload failed, which never fails the turn.
  - `session.limit_reached { limit: "max-duration" | "stall" | "spend-cap", observed }`: a runaway limit stopped the session (F-068). The runner sends it for the spend cap, which its key proxy enforces; core records it as its own event for the maximum duration and the stall, which it times (ADR 0037). `observed` is minutes, micro-USD or tokens, a number, never content.
  - `ticket.files_ready { files: [{ path, blobId }] }`: the ticket's images are in the workspace (ticket 26).
- **Events, new optional fields:** `session.restored` gains `origin: "resumed" | "restored" | "rebuilt"`, `replayedUpdates` (how many `session/load` updates were marked as replay, never stored as new events) and `hiddenRef: "applied" | "none" | "conflict"`. `user.message` gains an optional `replayed: true` for the member message a lost box never answered. *Added 2026-11-19 for the reopen and limits targets (ticket 40's decisions):* `session.restored` also gains `previousBox: "kept" | "released" | "lost"`, so the thread can say a lost box is why the task came back on a fresh one. `user.message` gains `reopen: true` on the message a reopen wrote, for the thread's reopen tag. `session.crashed` gains `cause: "agent_exited" | "box_lost"`. All three are optional, and a missing one renders as milestone 1's line.
- **The command `release { taskId, boxId }`:** remove the box and its workspace. Sent only to minor ≥ 1. The outbox validates it like every body.
- **The task spec, new optional fields** (a minor-0 runner gets the old shape):
  - `ticket: { key, title, url } | null`
  - `contextFiles: [{ blobId, path, contentType, size }]`: ticket images to write under `.ostra/ticket/` before the agent starts
  - `restore: { origin: "new" | "resumed" | "restored" | "rebuilt", archive: { blobId, size, sha256 } | null, hiddenRefs: [{ repoId, sha, baseSha }], pendingMessages: [{ clientMessageId, text }] }`. For `rebuilt`, the template's text is the spec's `prompt`
  - `limits` gains `idleMinutes` and `spendCap: { capMicroUsd, spentMicroUsd, prices: { inputPerMTok, outputPerMTok, cacheReadPerMTok, cacheWritePerMTok } } | { capTokens, spentTokens }` (the four token kinds, each priced: Q163; the token form when the model has no known price: section 11, item 8). The maximum duration and the stall are core's timers, so the runner isn't told them
- **HTTP, the bulk path** (ADR 0043: plain HTTPS beside the socket, chunked, resumable, with a digest), each taking the lease epoch and answering 409 on a stale one:
  - `POST /runner/v1/tasks/:taskId/blobs` `{ purpose: "session-archive", sha256, size, contentType, leaseEpoch }` → `{ uploadId, receivedBytes }` (a resume answers the bytes already held)
  - `PUT /runner/v1/tasks/:taskId/blobs/:uploadId?offset=` with one chunk of at most 1 MiB *(working value)* → `{ receivedBytes }`
  - `POST /runner/v1/tasks/:taskId/blobs/:uploadId/finish` → `{ blobId, size, sha256 }`
  - `GET /runner/v1/tasks/:taskId/blobs/:blobId?leaseEpoch=` → the bytes, only for a blob of that task
- **Limits and timers** as named working values: idle 15 min, upload chunk 1 MiB, the archive's cap 64 MiB (the blob cap; over it, the next reopen uses the template).

### 5.2 `packages/adapter-sdk` (tickets 03 and 04)

**`TrackerAdapter`, new operations** (ticket 03), each implemented by Linear (07, 08), by the Jira fake, and by `test-adapters/tiny-adapters.ts` in the same commit:

| Operation | What it does | Why the Jira fake shapes it |
|---|---|---|
| `listBoards()` | The teams (Linear) or projects (Jira) the credential can see | Jira boards are projects |
| `listStatuses(board)` | Each status with its `category`: `open`, `started`, `done`, `cancelled` | Jira's categories, Linear's types, mapped to one set |
| `getTicketContext(board, ref)` | Title, description as markdown, comments, labels, attachments and inline images (URL, name, type), parent, linked tickets | Jira's ADF is converted to markdown in its adapter |
| `ticketRef` on `Ticket` | A stable `externalId` beside the key, which can change | Jira and Linear keys both change on a move |
| `moveTicket(board, ref, target: "started" \| "in-review" \| "done", mapping)` | Moves through the board's mapping; Jira through a transition, Linear by setting the state | Jira can't write a status directly |
| `updateComment(board, ref, commentId, markdown)` | Edits ostra's own comment | Jira coalesces progress into one edited comment (ADR 0047) |
| `linkTask(board, ref, { url, title, subtitle })` | ostra's link to the task, idempotent by URL | |
| `createTicket(board, { title, description })` | For "Create ticket" (F-097) | |
| `detectCodeHostIntegration(board)` | Whether the tracker's own GitHub integration links PRs and moves statuses | Jira's development panel, later |
| `verifyWebhook(input)` and `parseWebhook(input)` | Signature check, then a loose parse into a hint: delivery ID, the ticket's external ID, the board, whether ostra's own user made it | Jira's `X-Hub-Signature`, Linear's `Linear-Signature` |
| `listTickets` gains `order: "updatedAt"` and an inclusive `updatedSince` | Polling | |

`getTicket` and `updateStatus` stay, and `comment` and `linkPullRequest` keep their shapes. **Capabilities, new fields:** `webhooks` (the tracker can push events), `commentEdit`, `attachments` (it can take file copies, ADR 0043; Linear yes, used from milestone 6), `transitions` (moves go through a graph; Jira fake yes, Linear no). `statusGraph` stays.

**The tracker contract suite** (ticket 03) grows from its first cases to the full set: paging, `updatedSince`, a key that changes, status moves through the mapping, an edited comment, idempotent links, webhook verification refusing a bad signature and a stale timestamp, own-echo detection, rate-limit answers (429 with `Retry-After`) turned into `rate-limited` errors. It runs against Linear's adapter on a fake Linear server (ported from spike 5's) and against the **Jira fake**, a test-only `TrackerAdapter` over an in-memory Jira with a status graph, ADF text and keys that change (Q104).

**`CodeHostAdapter`** (ticket 04): `readBranchRules(access, branch)` → `{ protected: boolean | "unknown", requiresSignedCommits: boolean | "unknown", reasons }` (F-055, F-060), `getPullRequest(access, number)` → state, merged, head SHA (the reconcile), `parseWebhook(input)` for `pull_request` events, `deleteRef(access, ref)` (cleanup). Capability `branchRules`.

**`AgentAdapter`** (ticket 04): the capability `sessionArchive`, and two launch helpers the base class calls, `exportSession(input)` and `importSession(input)` (the binary and arguments, run beside the live agent), with `importSession` taking the box's workspace directory. The ACP driver marks the updates that `session/load` replays, so the runner never stores them as new events (ADR 0035).

**`ExecutorAdapter`** (ticket 04): `saveWorkInProgress(input)` (the hidden ref after any turn, forced), `restoreWorkInProgress(input)` (onto the saved commit, then the branch's new commits merged in: section 11, item 7), and `release` gains a `reason`. `commitAndPush` keeps its shape.

**`BlobStoreAdapter`** (ticket 04): the contract suite grows to the full set: put and get, chunked upload and resume after a drop, a digest mismatch refused, the size cap, another organization's key answering `not-found`, delete. The operations don't change.

**Plumbing:** the server's Postgres implementations of `IdempotencyStore` and `RateBudgetStore` (ticket 15) behind the existing interfaces.

### 5.3 `packages/db`: the milestone 2 migration (ticket 05)

One new migration, additive only. Every row carries `organizationId`; every project record carries `projectId` with the composite key to the project.

| Change | What |
|---|---|
| New `Ticket` | The cached copy, per board: `boardId`, `connectionId`, `externalId` (stable), `key` (as of the last read), `title`, `description`, `statusId`, `statusName`, `statusCategory`, `priority`, `labels` (JSON), `parentExternalId`, `url`, `open`, `trackerUpdatedAt`, `removedAt`. Unique `(boardId, externalId)` |
| New `TicketWrite` | The tracker writer's outbox: `taskId`, `ticketId`, kind (`move`, `comment`, `comment_update`, `link_pr`, `link_task`, `create`), `idempotencyKey` (unique), state (`pending`, `done`, `failed`), `attempts`, `externalId`, `error` (words and IDs) |
| New `IdempotencyRecord`, `RateBudget` | Back the plumbing's stores |
| New `Blob`, `BlobChunk`, `BlobUpload` | The built-in store, in its own tables (ADR 0043), with `store` (`postgres` or `s3`) and the owning task when there is one |
| New `OAuthState` | Linear's `state` and PKCE verifier (as a secret ref), bound to the admin's session, 10 min |
| `Connection` | + `state` (`pending`, `active`, `failed`, `revoked`), `webhookMode` (`webhooks`, `polling`), `externalWorkspaceId`, `appUserId`, `accessTokenSecretRef`, `refreshTokenSecretRef`, `accessTokenExpiresAt`, `lastEventAt` |
| `Board` | + `pollCursor`, `lastPolledAt`, `integrationDetected`; `statusMap` keeps its column, parsed by the domain's schema |
| `Task` | + `ticketId`, `boardId`, `progressCommentId`, `spentMicroUsd`; partial unique index: one task per `(projectId, ticketId)` where kind is `code` and the state isn't `stopped`, `merged` or `done` |
| `TaskRepo` | + `hiddenRefSha`, `hiddenRefBaseSha`, `mergedAt`, `closedAt` |
| `Session` | + `archiveBlobId`, `archiveTurnOrdinal`, `spentMicroUsd`, `limitReached` |
| `Box` | + `idleSince`, `stoppedAt`, `releaseReason` |
| `Project` | + `ticketTemplate` (null: the built-in template) |
| `InstanceSetting` | + `retentionDays` (null: keep while the task exists) |
| `WebhookDelivery` | + `payload` (the verified body; never logged), `signatureHash`, `transitMs`, `error`; unique `(connectionId, signatureHash)` where set |
| Enums | `CommandKind` + `release`; `NeedsYouReason` + `restore_conflict`, `unstorable_event`; new `ConnectionState`, `WebhookMode`, `TicketWriteKind`, `TicketWriteState`, `BlobStoreKind` |
| *Added 2026-11-19 (ticket 40's decisions on the targets)* | |
| `Connection`, more | + `credentialKind` (new enum `ConnectionCredential`: `app_oauth`, `app_client_credentials`, `api_key`; null on GitHub rows), `externalWorkspaceKey`, `externalWorkspaceName`, `appUserName`, `activatedAt`, `createdByMemberId` (the admin who started a pending row) |
| `WebhookDelivery`, more | + `ticketKey` (set by `webhook.process` once it has read the ticket; for the connection's "last event" line) |
| `Board`, more | + `key` (the team's key as of the last read, such as `OST`) |
| `Repo` | + `private`, `branchRules` (JSON, parsed by the domain's schema: `protected` and `signedCommits`, each `{ result: true \| false \| "unknown", reason? }`), `branchRulesCheckedAt` (the 10-minute cache of ticket 31) |
| New `OrganizationSetting` | One row per organization (`organizationId` is the key and the foreign key): `linearSkippedAt`, `linearSkippedByMemberId`, `updatedAt`. Home's checklist reads it (ticket 27) |
| `InstanceSetting`, more | + `retentionSetAt`: null means no admin has saved retention, so `OSTRA_RETENTION_DAYS` applies; set means the saved `retentionDays` wins, and null there means "keep" |

### 5.4 `packages/domain` (ticket 06)

- **Lifecycles,** new inputs, each with its exhaustive tests: task `work_saved { withChanges, prOpen }` (the first PR moves it to in review; no changes and no PR raises needs you), `limit_reached { limit }` (→ needs you: `stalled`, `spend_cap`, or `stalled` for the maximum duration); a restore conflict is **not** a task input: the task keeps running from the branch's head, and the conflict is a `restore_conflict` needs-you item for the driver on that running task (decided 2026-11-19, ticket 40; ADR 0039's "the task doesn't stall on it"); `reopen` allowed from `in_review` and `needs_you` as well as `stopped`, `merged` and `done`, as the domain model's diagrams say. Session: `idle → ended` on the box stopping. Box: `ready ⇄ idle → stopped → released`, with the release reason.
- **The board's status mapping:** a strict Zod schema (`open`, `started`, `inReview`, `done` status IDs, `doneBy: "integration" | "ostra"`, and `magicWord: "Closes" | "Refs"`, default `Closes`: section 11, item 5) and a pure function that drafts it from `listStatuses` and the integration check.
- **The ticket prompt:** a pure renderer of a small template language (named placeholders and sections, no code, no loops beyond lists), the built-in template, and the rule that every piece of ticket text sits inside a marked block. **The rebuild template**, pure too, exactly as ADR 0039 now words it (Q128): the ticket and the PRs' text, every member message and every agent message oldest first, an interrupted turn's text in its own labelled section, each branch's log with its file statistics, a line saying whether unfinished work was restored, no tool output, and a cap of 100,000 characters *(working value)* that cuts the oldest messages first and says how many.
- **Use-case signatures:** `connectLinear`, `authorizeLinear`, `attachBoard`, `saveBoardMapping`, `ingestTicketHint`, `startTicketTask`, `createTicketForTask`, `recordWorkSaved`, `reopenTask`, `chooseReopenStep`, `recordPullRequestState`, `releaseBox`, `recordLimitReached`, `sweepCleanup`, `sweepRetention`.
- **Jobs, new names** (IDs only in payloads, each with its key rule, on exclusive queues: ADR 0037): `webhook.process`, `tracker.poll-board` and `github.reconcile-prs` (idempotent passes, so pg-boss schedules are allowed for them), `linear.refresh-token`, `ticket.fetch-context`, `ticket.sync`, `session.max-duration` (one delayed job per session, `session:<SessionId>:max-duration`, cancelled when the session ends), `session.stall-sweep` (one keyed job a minute over running sessions' last event times), `box.release`, `box.release-after-idle` (one delayed job per box, 14 days), `retention.sweep`, `blob.gc`.
- **Settings, new,** each with a working default and its line in `docs/configuration.md`:

| Setting | Default |
|---|---|
| `OSTRA_BOX_IDLE_MINUTES` | `15` |
| `OSTRA_SESSION_MAX_MINUTES`, `OSTRA_SESSION_STALL_MINUTES` | `120`, `10` |
| `OSTRA_TASK_SPEND_CAP_USD`, `OSTRA_TASK_TOKEN_CAP` | `25`, `10000000` |
| `OSTRA_TRACKER_POLL_SECONDS`, `OSTRA_RECONCILE_MINUTES` | `60`, `5` |
| `OSTRA_WEBHOOK_INSERT_DEADLINE_MS` | `2000` |
| `OSTRA_BOX_RELEASE_IDLE_DAYS` | `14` |
| `OSTRA_RETENTION_DAYS` | unset: keep while the task exists |
| `OSTRA_BLOB_STORE`, `OSTRA_BLOB_MAX_MIB` | `postgres`, `64` |
| `OSTRA_S3_ENDPOINT`, `OSTRA_S3_BUCKET`, `OSTRA_S3_REGION`, `OSTRA_S3_ACCESS_KEY_ID`, `OSTRA_S3_SECRET_ACCESS_KEY` | unset; only read when `OSTRA_BLOB_STORE=s3` (ticket 11) |

---

## 6. Packages, licenses and owners

| Package | License | New in M2 | Built by |
|---|---|---|---|
| `packages/protocol` | Apache-2.0 | minor 1 | core (02) |
| `packages/adapter-sdk` | Apache-2.0 | tracker ops, the Jira fake, code host, agent, executor additions, full suites | adapters (03, 04) |
| `packages/adapters/adapter-linear` | Apache-2.0 | the plain API in full, the app | adapters (07, 08) |
| `packages/adapters/adapter-github` | Apache-2.0 | branch rules, PR state, webhooks, refs | adapters (09) |
| `packages/adapters/adapter-opencode` | Apache-2.0 | export, import, replay | adapters (10) |
| `packages/adapters/adapter-blob-postgres` | Apache-2.0 | unchanged; core backs its rows | core (12) |
| `packages/adapters/adapter-blob-s3` (new) | Apache-2.0 | the S3-compatible store, if approved | adapters (11) |
| `packages/adapters/adapter-executor-host`, `-docker` | Apache-2.0 | work in progress saved after every turn, restore, release | runner (22, 23, 24) |
| `apps/runner` | Apache-2.0 | after every turn, idle, restore, limits, context files | runner (22 to 26) |
| `packages/db` | Sustainable Use | the M2 migration | core (05) |
| `packages/jobs` | Sustainable Use | the forwarding queue's heartbeat, the boot check, the schedule and group options | core (01) |
| `packages/domain` | Sustainable Use | inputs, mapping, renderers, use cases, jobs, settings | core (06); bodies by core and api |
| `apps/core` | Sustainable Use | webhook inbox, tracker ingest and writer, PR states, blobs, reopen, limits, cleanup | core (12 to 21) |
| `packages/api` | Sustainable Use | Linear, boards, Inbox, reopen, settings | api (27 to 31) |
| `apps/web` | Sustainable Use | the M2 screens | web (32 to 37) |
| `e2e/m2-tickets-in`, `e2e/m2-failure-suite` (new) | Sustainable Use | the demo and the failure suite | core (38, 39) |

The license line holds (ADR 0045, ADR 0048): no Apache-2.0 package depends on a Sustainable Use one. `adapter-blob-postgres` keeps its `BlobRows` port and never imports `packages/db`. `pnpm check:licenses` runs on every commit.

---

## 7. The builders and their tickets

Five builders: **core**, **runner**, **web**, **api** and **adapters**. Core and adapters make the contracts first (02 to 06). Ticket 40 is the maintainer's.

| # | Ticket | Builder | Blocked by |
|---|---|---|---|
| 01 | `packages/jobs`: the heartbeat, the boot check and the queue options | core | none |
| 02 | Protocol: minor 1 | core | none |
| 03 | Adapter SDK: the tracker interface, the Jira fake and the tracker suite | adapters | none |
| 04 | Adapter SDK: code host, agent, executor and blob additions | adapters | 02 |
| 05 | DB: the milestone 2 migration | core | none |
| 06 | Domain: inputs, mapping, renderers, use cases, jobs and settings | core | 02, 05 |
| 07 | Linear adapter: tickets, statuses, context and writes | adapters | 03 |
| 08 | Linear adapter: the app, OAuth and webhooks | adapters | 03 |
| 09 | GitHub adapter: branch rules, PR states, webhooks and refs | adapters | 04 |
| 10 | OpenCode adapter: session export, import and replay | adapters | 04 |
| 11 | The S3-compatible blob store adapter | adapters | 04, 40 (the library's approval) |
| 12 | Core: the blob service and the runner's bulk path | core | 02, 05 |
| 13 | Core: the webhook inbox | core | 05, 06 |
| 14 | Core: ticket ingest and polling | core | 01, 07, 08, 13 |
| 15 | Core: the tracker writer, idempotency and rate budgets | core | 06, 07 |
| 16 | Core: PR states and the GitHub reconcile | core | 09, 13 |
| 17 | Core: sessions across turns, saved work and idle | core | 06, 12 |
| 18 | Core: reopen, the restore spec and the templates | core | 06, 12, 14, 17 |
| 19 | Core: runaway timers, the stall sweep and spend | core | 01, 06, 17 |
| 20 | Core: cleanup and retention | core | 16, 17 |
| 21 | Core: nothing lost across a server restart | core | 01, 13, 17 |
| 22 | Runner: after every turn | runner | 02, 04, 10, 12 |
| 23 | Runner: the idle timer, stop and release | runner | 22 |
| 24 | Runner: restore on the same box or a fresh one | runner | 10, 22 |
| 25 | Runner: the spend cap at the key proxy | runner | 02 |
| 26 | Runner: ticket files in the workspace | runner | 02, 12 |
| 27 | API: the Linear connection | api | 06, 08 |
| 28 | API: boards and their mapping | api | 06, 07 |
| 29 | API: the Inbox, tasks from tickets, "Create ticket" | api | 14, 15, 28 |
| 30 | API: reopen and the task's ticket | api | 18 |
| 31 | API: repo checks, the ticket template, storage and retention | api | 06, 09 |
| 32 | Milestone 2 screen targets | web | none |
| 33 | Web: connect Linear, and the checklist's Linear step | web | 27, 32 |
| 34 | Web: boards and the status mapping | web | 28, 32 |
| 35 | Web: the Inbox | web | 29, 32 |
| 36 | Web: the task page for tickets, reopening and limits | web | 30, 32 |
| 37 | Web: repo checks, the ticket template, storage and retention | web | 31, 32 |
| 38 | The failure suite | core (lead) | 01, 14, 16, 18, 19, 21, 23, 24, 25 |
| 39 | The end-to-end demo and the ledger | core (lead) | 20, 33, 34, 35, 36, 37, 38 |
| 40 | The maintainer's steps outside the code | maintainer | none |

**Follow-ups from the questions milestone 1 raised** (settled 2026-11-19: `context/open-questions.md`, Settled, and `context/history/answers-2026-11-19.md`). They aren't part of this milestone's demo, each is its own commit, and their features aren't in this spec's list, so each ticket names its own. Tickets 41, 42, 44, 45 and 46 touch credentials, the schema, the runner protocol or what runs agent output, so they run all the checks for the whole repo (section 9). Where one adds to a screen, its UI waits for the target to be amended and approved, and its data and tests go ahead.

| # | Ticket | Builder | Blocked by | Features | Settles |
|---|---|---|---|---|---|
| 41 | Revoke a runner at once, and the runner lifecycle's drain and resume | core, api, web | none | F-013, F-091, F-092, F-045 | Q131, Q108 |
| 42 | A job object on Windows, and a marker sweep where there's no kernel unit | runner | 02 | F-014 | Q126 |
| 43 | Say why a queued task waits | api, web | none | F-014, F-067, F-069 | Q132 |
| 44 | Files left outside every repo raise a needs-you item | runner, core, web | 02, 05, 22 | F-016, F-065 | Q133 |
| 45 | Check the secrets key at start, and a setting for the runner-token key | core | none | F-001, F-118 | Q136, item 1 |
| 46 | A project's branch names are unique in the database | core | 05 | F-016 | Q136, item 10 |

Q107 has no ticket of its own: tickets 06 and 16 carry its rule. Three more follow-ups are milestone 1's own (`../m1-first-pr/spec.md`, section 7, tickets 41 to 43).

**Who starts when.** core takes 02, then 05, then 06, then 01; adapters take 03 at once and 04 after 02. api starts on 28 once 06 and 07 are in. web takes 32 at once; its screen tickets wait for the targets' approval (section 12). runner takes 25 after 02. The rest unblock as the table says.

---

## 8. Test seams

Agreed here so builders don't each invent one.

- **Postgres:** milestone 1's helper, a database per test file. Every test that reads data also checks another organization's rows, and a restricted project's rows, stay invisible.
- **Linear:** a fake Linear server in `@ostra/adapter-sdk/testing`, ported from `spikes/linear-agent-mode/src/fake-linear/`: GraphQL for issues, states, teams, comments, attachments, integrations and `viewer`; the OAuth authorize and token endpoints with PKCE and rotating refresh tokens; signed webhook deliveries with Linear's headers and its retry schedule; 429 with `Retry-After`. The live cases run against `ostra-test`, team `OST`, when `linear.env` is loaded, and archive what they create.
- **Jira:** the Jira fake in the same place (ticket 03). It's never a product adapter.
- **GitHub:** milestone 1's fake code host gains `pull_request` webhooks (signed), merge and close, branch protection and rulesets with `required_signatures`, and ref deletion. The live cases run against `ostra-test/test1` and `test2`.
- **Faults:** a write-applied-then-500 mode in both fakes, and a fault-injecting HTTP proxy for the live services (ticket 38), so "retry after commit" is testable against real Linear and GitHub.
- **The network:** the loopback cut proxy from `spikes/runner-transport/src/harness/net-proxies.ts`, in `hold` and `reset` modes (ticket 38).
- **Agents:** the scripted fake ACP agent gains `session/load` with a replay, an export and an import of its own archive format, a stall, and a long turn. OpenCode runs the same suite against the stub models and, gated on `model.env`, against the real endpoint.
- **Time:** every timer (idle, stall, maximum duration, grace, polling, reconcile, token expiry) reads the `Clock` port or a setting, so tests run them in seconds. Nothing sleeps for real in a unit test.
- **S3:** a fake S3-compatible server in-process for ticket 11's suite. No external service.

---

## 9. Every ticket's checks and commit

As milestone 1 (`../m1-first-pr/spec.md`, section 9). In short:
- `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for the touched packages, and `pnpm check:licenses` passes.
- Tickets that touch auth, credentials, the schema, the runner protocol, webhooks or anything that runs agent output (01, 02, 04, 05, 08, 12, 13, 17, 18, 21 to 27, 38, 39) run all the checks for the whole repo.
- Every new setting has a working default and its line in `docs/configuration.md`. A fresh install with only the required settings still works.
- No secret in the commit. Logs carry IDs and fields, never tokens, prompts, ticket text, comments or agent output. Ticket text is never interpolated into a shell command.
- Stage only the ticket's own paths, a gitmoji message of at most 50 characters, no AI attribution, `git pull --rebase origin main`, `git push origin main`, retrying on a rejected push.
- The ticket file gets its `Status:` updated and a line under `## Comments` with the commit's hash.

---

## 10. What each ticket ports

| From | What | To (ticket) |
|---|---|---|
| `spikes/linear-agent-mode/src/manifest.ts` | the manifest link and the address pre-check | 08 |
| same, `oauth.ts`, `token-store.ts`, `server.ts` (install, the app-user check) | authorize with `actor=app`, the token exchange, the check that a token is the app's own user | 08, 27 |
| same, `webhook-verify.ts`, `webhook-schema.ts`, `server.ts` (verify, claim, 200, then work) | signature and timestamp checks; the inbox's order | 08, 13 |
| same, `retry.ts` | hedged retries on one client-made ID | 15 |
| same, `fake-linear/` | the fake Linear server | 03 |
| `spikes/can-a-session-move-to-a-fresh-box/src/lib/hidden-ref.ts` | save and restore work in progress | 04, 22, 24 |
| same, `session-archive.ts` | export, gzip, import with `--directory` | 10, 22, 24 |
| same, `rebuild-template.ts`, `history.ts` | the template, and the five questions as a test | 06, 18, 39 |
| same, `lib/git.ts` | `GIT_CEILING_DIRECTORIES` on every git call | 22, 24 |
| `spikes/runner-transport/src/harness/` | the cut proxy, the `kill9`, `cuts` and `acks` scenarios | 38 |
| `spikes/durable-queue-choice/src/` | schedules created at runtime | 14, 16, 20 |

**Dependencies.** None new without the maintainer's yes. `@linear/sdk` is **not** added: milestone 1's adapter speaks GraphQL over `fetch`, and the plain API needs nothing more. Its webhook verifier is a constant-time HMAC that ticket 08 writes with `node:crypto`, as spike 5 read it. (Agent mode in milestone 6 may want the SDK; that's its own question.) The S3-compatible adapter uses `@aws-sdk/client-s3` (Apache-2.0), approved by the maintainer on 2026-11-19 (ADR 0043). gzip is `node:zlib`. Ticket 42, a follow-up, adds `koffi` 3.3.8 (MIT) to the `host` executor, for the Windows job object (ADR 0007, Q126).

---

## 11. Choices this spec makes, for the maintainer to confirm

Each is the smallest choice that unblocks milestone 2. If the maintainer disagrees, it moves to `context/open-questions.md` and the ticket that holds it changes. Items 1, 6 and 7 are already decided, and only restated here. **Items 2 to 5 and 8 to 12 were confirmed on 2026-11-19 by the lead, on the maintainer's delegation** (ticket 40's `## Comments`). The notes in italics are what that review added.

1. **The default first admin is milestone 1's** (the maintainer, 2026-11-19: "default setup user is demo@demo.com with password demo, unless specified otherwise in one of the environment variables"). A fresh install seeds `demo@demo.com` / `demo` unless `OSTRA_ADMIN_*` says otherwise, forces a password change at the first sign-in unless `OSTRA_ALLOW_DEFAULT_PASSWORD=true`, and shows the default-password banner while it's in use (`context/brand/app-targets/m1/change-password.md`). Milestone 2's scripts sign in with it; nothing in this spec changes it.
2. **One Linear app per organization, its webhook on core,** at `OSTRA_CORE_PUBLIC_URL/webhooks/linear/<connectionId>`. The connection row is created as `pending` before the manifest link, so the URL can name it. When core's public address fails the pre-check (loopback, private, no dot, `.local` and the rest), the manifest leaves out the webhook, and the connection runs in polling mode from the start.
3. **Scopes:** `read`, `write`, `issues:create`, `comments:create` now. Agent mode's `app:assignable` and `app:mentionable` come with F-012 in milestone 6, by re-authorizing with `update_scopes_on_existing_token=true`, and the manifest already asks for the `AgentSessionEvent` webhook type so the app needn't be recreated. *The manifest asks for the `authorization_code` grant only. A client-credentials token would silently replace the consented installation, and it has no refresh token (`context/research/linear-app-token-without-consent.md`).*
4. **Status ownership.** ostra moves the ticket to "started" and to "in review" itself. It moves it to "done" only when Linear's GitHub integration isn't installed on the workspace (F-031). The board can change any of the four targets and `doneBy`. *`ostra-test` has no GitHub integration (checked 2026-11-19), so the demo's board drafts `doneBy: "ostra"`.*
5. **The ticket in branch, title and body.** Branch `ostra/<key, lower case>-<last 8 hex of the task ID>-<slug>`, PR title `<KEY>: <ticket title>`, and `Closes <KEY>` in the body. Linear's integration links on any of them. A board setting can turn the magic word into `Refs`.
6. **The rebuild template's wording** is settled (ADR 0039, Q128): every agent message oldest first, an interrupted turn's text in its own section, no tool output, capped at 100,000 characters *(working value)*. Spike 2 scored it 5 of 5 in all four runs.
7. **A branch that moved since the hidden ref was saved, and a lost box,** are settled (ADR 0039, Q150): restore the work onto the commit it was saved on, then merge the branch's new commits; on a conflict, leave the ref alone, restore nothing, and raise a needs-you item for the driver (milestone 2 names its reason `restore_conflict`). A lost box restores its last finished turn's ref and archive, and the runner replays the member's unanswered message from the event log as the new session's first prompt.
8. **A spend cap for a model with no known price.** The task's cap falls back to tokens: 10 million per task *(working value)*, and the panel says the cap is counted in tokens because the model has no price.
9. **Ticket images.** Core fetches each image with the connection's token, at most 20 per ticket and 10 MiB each *(working values)*, and stores them as blobs of the task. The runner writes them under `.ostra/ticket/`, which the workspace's git excludes.
10. **The Inbox's default filter** is the mapped open statuses (Linear's triage, backlog and unstarted types), newest change first. Started tickets show too when the filter says so, with any task they already have.
11. **Retention.** Unset by default: histories, archives and blobs stay as long as their task exists (F-079). *A retention period saved in the panel wins over `OSTRA_RETENTION_DAYS`, and "keep" counts as a saved choice. The env value applies only until an admin saves one (`InstanceSetting.retentionSetAt`).*
12. **One active code task per ticket per project.** Starting a second while one is active is refused with a link to it. A stopped or merged task doesn't count; reopening one is refused while another active task holds the ticket. *In milestone 2 a merged task isn't reopened at all. Its PRs are merged, and the fresh branch a reopen needs is F-066, in milestone 3. `tasks.reopen` refuses it with that reason, and a new task can start from the ticket (ticket 18).*

---

## 12. Screens that need a design target

`build-order.md`: a milestone's screens are designed first, image first. The maintainer requires the `ui-taste` skill and Higgsfield targets, approved before building, against `context/brand/brief.md` and `context/brand/app-design.md`. **This spec names them; ticket 32 makes them,** in the form milestone 1's approved targets have (`context/brand/app-targets/m1/README.md`: a picture, a build spec and a prompt per screen). Until the maintainer approves them (recorded in ticket 32's `## Comments`), tickets 33 to 37 don't start their UI; their routers and tests can go ahead. The default-password banner and the forced password change are milestone 1's targets, not these.

| # | Screen | Feature | Starts from |
|---|---|---|---|
| 1 | Connect Linear: the manifest link, the three values, Authorize, and the connected state (workspace, app user, mode, last event, token health) | F-005, F-042 | `app-targets/m1/github` |
| 2 | Home's first-run checklist with the Linear step live, no longer "milestone 2" | F-076, F-005 | `app-targets/m1/home` |
| 3 | The project's boards: attach a team, the status mapping editor, "Linear's GitHub integration: installed" | F-007, F-031 | `app-targets/m1/project`, `app-concepts/07-project-dashboard.png` |
| 4 | The project's Inbox: ticket rows (key, title, status, labels, priority, an existing task), filters, "Start task" with kind and profile | F-010 | `app-concepts/03-inbox.png`, `app-targets/m1/task-new` |
| 5 | The task page for a ticket task: the ticket header, its context, the sync state on Linear, the PRs per repo | F-064, F-031 | `app-targets/m1/task` |
| 6 | Reopening: the composer on a stopped, idle or in-review task; the thread's markers for "resumed", "restored from the archive", "rebuilt from the template", replayed messages, and a restore conflict | F-032, F-033 | `app-targets/m1/task` |
| 7 | Limits and crashes on the task page: stalled, maximum duration, spend cap reached, crashed, each with its needs-you action | F-068, F-047 | `app-targets/m1/task` |
| 8 | Repo checks on the project: "default branch not protected" and "requires signed commits: not supported" | F-060, F-055 | `app-targets/m1/project-new`, `app-targets/m1/environment` |
| 9 | The ticket template editor, with a preview on a real ticket | F-064 | `app-targets/m1/environment` |
| 10 | Organization settings for storage and retention: the blob store in use, its size, the retention period | F-114, F-079 | `app-targets/m1/models` |
| 11 | Screens 4 and 5 at phone width | F-075 | `app-concepts/05-phone.png` |
