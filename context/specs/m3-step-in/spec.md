# Milestone 3: Step in and come back

**Status:** spec, 2026-11-19. Tickets in `issues/`, one file each (`docs/agents/issue-tracker.md`).
**Milestone:** 3 (`context/build-order.md`).
**Features:** F-021, F-024, F-026, F-063, F-062, F-036, F-115, F-027, F-072, F-028, F-103, F-070, F-054, F-051, F-094, F-053, F-119, F-066, F-084. Its demo signs in as milestone 1's default first admin, with a second member seeded for development only (section 11, item 1).
**Decisions it builds on:** ADR 0026 (organizations and roles), 0029 (executors and their allowed differences), 0030 (no credential in the agent's container), 0031 (the safety minimum: explicit permissions and approvals), 0032 (OpenCode: steering, the plan from `todowrite`, a deny re-prompts), 0036 (the task page: one driver, the approval card, the race), 0038 (environments, snapshots, services), 0039 (idle boxes, reopening), 0040 (the GitHub App, the verified link), 0041 (only `@ostra` and linked members reach the agent from GitHub), 0042 (spend at the key proxy), 0046 (one CLI). **New for this spec:** ADR 0049 (agent profiles, approval rules and plan first), 0050 (notifications and email), 0051 (the diff, its comments, and taking a task local), 0052 (checks, update branch and work after a merge), and an amendment to 0038 (snapshots without a registry, the `host` dependency cache, services with only `host` runners).
**Spikes it ports from:** 1 (`how-should-the-runner-drive-opencode`: the steer probe, the permission and question cases), 3 (`what-is-inside-a-box`: the snapshot's Dockerfile and the image scan), 4 (`github-app-and-git-proxy`: the PR flow and its comments) and 7 (`live-stream-and-task-view`: the approval race and the watcher checks), section 10. Product code never imports `spikes/`. A builder copies the code into the product's package and adapts it, with a one-line provenance comment (`// Ported from spikes/<spike>/<path>.`).
**Builds on milestones 1 and 2** as they were built (`../m1-first-pr/spec.md`, `../m1-first-pr/demo.md`, `../m2-tickets-in/spec.md`), not only as they were specified. Milestone 2 is being built while this spec is written. Where its code ends up different from its spec, this spec follows the code, and the ticket that meets the difference says so in its `## Comments`.

Terms follow `context/GLOSSARY.md`. Lifecycles follow `context/domain-model.md`.

---

## 1. What milestone 3 ends with

A member steers, approves, answers and comments on the diff. Boxes start from a snapshot with their services. **ostra's own tickets run through ostra from here on.**

In more words: an organization admin defines agent profiles, and a project picks one per task kind. A profile with plan first makes the agent propose a plan, which the driver approves or edits. A profile's approval rules hold back what needs a person, and any member of the project answers, from the task page, from Home's "needs you", or after a mail or a Linear notification brought them there. The driver steers mid-turn, interrupts and sends, and anyone takes over. Each task shows its diff per repo, and comments on its lines go to the agent as one prompt. Checks run before every PR. A member takes a task's branches to their own machine with `ostra checkout`, and the agent carries on from their commits. A PR comment that starts with `@ostra` from a linked member reopens the task. A merged task reopens on a fresh branch.

### What milestones 1 and 2 left that milestone 3 starts from

Read from the code on `main` on 2026-11-19, and from milestone 2's spec for what it adds, so builders don't rebuild what exists:

- **Steering is mostly built.** The protocol has `steer { delivery: "queue" | "interrupt" }` and `interrupt`. The runner's task run steers mid-turn when the agent declares `steerMidTurn` and the session's `initialize` advertised it, and queues otherwise (`apps/runner/src/task-host/task-run.ts`). `tasks.send`, `tasks.interrupt` and `tasks.takeOver` exist in `packages/api/src/routers/tasks.ts`, with the driver check inside the task's lock and `driver.changed` events. The composer has Send and "Interrupt and send", and the thread shows `queued` and `after an interrupt`. **What's missing:** the race test ADR 0036 names, the watcher's read-only composer and its "Sam is driving · Take over" bar, a no-steer agent's queued messages shown to everyone, the steer on a real model (ADR 0032), and a second member to take over.
- **Approvals are half built.** The event union has `approval.requested`, `.answered`, `.auto_answered` and `.closed`; the command `approval-answer` exists; `approvals.answer` does the compare-and-set, writes the event, the audit entry and the command, and closes the needs-you item. The domain has the approval lifecycle. **But nothing ever asks:** OpenCode's permissions are "allow everything but `external_directory`" (`adapter-opencode/src/config.ts`), the runner auto-answers every request "once" under the rule `NO_RULES_YET`, both runner paths reject `approval-answer` (`task-host.ts`, `box-dispatcher.ts`), and the panel shows the approval read-only (`apps/web/src/task/renderers.tsx`).
- **Questions are read-only.** `question.asked`, `.answered` and `.closed` exist, the runner holds the question until the turn's abort, and nothing answers it. There is no `question-answer` command.
- **The plan view exists.** OpenCode's `todowrite` is mapped to `plan.updated` (`adapter-opencode/src/todo-plan.ts`), and the thread renders `data-plan`. **Plan first doesn't:** no profile field, no read-only turn, no needs-you item of reason `plan`.
- **Agent profiles are a row.** `AgentProfile` has a name, an adapter, a model and instructions, and every organization has a built-in OpenCode profile (`domain/src/use-cases/agent-profiles.ts`). `Project` has `defaultRefineProfileId`, `defaultCodeProfileId` and `defaultReviewProfileId`, and the task spec carries the profile's ID, model and instructions. No panel page, no skills, no MCP servers, no rules, no member limit.
- **Needs you exists as rows.** `NeedsYouItem` has a reason (thirteen of them, `plan` and `ticket_closed` included), an audience (`driver`, `reviewer`, `project_members`) and a state. There is no needs-you page and no notification of any kind. `NotificationAdapter` is declared in `adapter-sdk` with one `send`, and no adapter extends it.
- **Home exists.** `home.overview` (`packages/api/src/routers/home.ts`, rebuilt to milestone 1's Home target on 2026-11-19) covers every project the member can open: the first five tasks that need them, read from each task's needs-you reason and latest events, the projects' counts, recent activity from the audit log, spend at the catalog's price, and runners. **What's missing:** needs-you rows from the items themselves with their audiences, inline answers, the full list, and the board view.
- **The schema already has `Check`, `Service` and `Snapshot`,** unused, and the `SnapshotState` enum. Milestone 2's runner commits and pushes after every turn, writes the hidden ref and the archive, and core opens or updates PRs on `session.saved`.
- **Usage is counted.** The key proxy emits `usage.recorded` in four token kinds, and the session sums them. Milestone 2 adds `spentMicroUsd` to the task and the session. The panel shows none of it.
- **The CLI says "not yet".** `ostra login` and `ostra checkout` print that they come with F-103 (`apps/runner/src/cli/cli.ts`). The device-code sign-in exists for personal runners (`DeviceCode`, the `device` page), and a runner trades its device session for a runner key.
- **There is one member.** Invites are milestone 4 (F-002), so every milestone 3 feature that needs a second person needs a seeded one (section 11, item 1).

### What is in, and what is not

**In:** agent profiles with instructions, skills, MCP servers, approval rules, plan first and a member limit, picked per task kind by a project and at a task's start; approvals answered by any project member, with rules "for this task" and a deny that re-prompts; questions answered by the driver; plan first; steering, interrupt and send, and take over, with the race closed; Home across the organization with "needs you" first and a board view; the "Needs you" page as the panel's notification list; notifications on the ticket and by email through Resend or SMTP, with each member's choices; the diff per repo, with line comments sent as one prompt; `ostra login` and `ostra checkout`; update branch; checks before every PR, with drafts for failures; snapshots on `docker` and the dependency cache on `host`; services on `docker`; `@ostra` on a PR from a linked member; the verified GitHub link; a fresh branch after a merge, and a ticket closed while its task runs; usage per task and per turn.

**Not in** (and when it comes):
- invites and reset links, and their mails: F-002, milestone 4. F-115's email channel is built here; the invite and reset mails ride it then
- budget warnings by mail: F-037, milestone 4
- reviewers, refine drafts, and their audiences: F-102, F-099, milestone 6. Until then "a PR ready for review" goes to the driver, so F-036 stays `building`
- the CI loop, AI review and "changes requested": F-035, F-100, F-105, milestone 6. Failing checks make a draft and offer "Ask the agent to fix"; nothing loops by itself
- roles at two levels and restricted projects: F-003, F-087, milestone 4. "Any member who can open the project" is every member of the organization until then
- a registry for snapshots: F-120, milestone 5. A `docker` runner builds and keeps its project's snapshot itself (ADR 0038, amended)
- snapshots and services on `kubernetes`: F-093, milestone 5
- Slack: F-057, after v1. The notification interface leaves room for it
- a terminal in the browser and attach: F-029, F-041, after v1
- syntax highlighting in the diff: a dependency for later (ADR 0051)
- another agent: F-018, after v1 (it was milestone 7 until 2026-11-19). Every agent-facing feature here goes through the agent interface, and the scripted fake agents prove the paths OpenCode doesn't take (a no-steer agent, native plans, reject and continue)

### On this machine

The same adjustment as milestones 1 and 2 (`../m2-tickets-in/spec.md`, section 1): the demo runs on the `host` executor, on a personal runner. A "box" is a worktree. Two rows of this milestone are mostly `docker` work:
- **F-051 snapshots.** On `host` there's no image: a per-project dependency cache and a local mirror of each repo take its place (ADR 0038). The demo shows the warm cache. Building, scanning and starting from an image is written in full with unit tests, and its live test waits for the Linux machine, as F-017's does. F-051 stays `building`.
- **F-094 services.** `host` starts none, as ADR 0029 declares. The demo shows a task whose environment has a service staying queued, with the reason, while only a `host` runner is online. Services on `docker` are written in full with unit tests and wait for Linux. F-094 stays `building`.

---

## 2. The features, and where each one lives

"At M3's end" is the ledger status the demo ticket (50) sets, if and only if every condition in the row's "done when" holds.

| F-ID | What milestone 3 builds | Packages | Tickets | At M3's end |
|---|---|---|---|---|
| F-021 Agent profiles | The organization's profiles page: agent, model, instructions, skills, MCP servers, approval rules, plan first, and who may use it. A project's default per task kind. The profile picker at a task's start, limited to the profiles a member may use. Every task applies its profile; on permissions and MCP servers the profile wins over the repo's own agent config, and its instructions and skills sit beside the repo's (ADR 0049) | `packages/db`, `packages/domain`, `adapter-sdk`, `adapter-opencode`, `apps/core`, `apps/runner` (sidecar MCP proxy), `packages/api`, `apps/web` | 02, 06, 07, 08, 16, 29, 34, 42 | done |
| F-024 Steer | Milestone 1's Send, "Interrupt and send" and take over, finished: the driver race test, the watcher's read-only composer and bar, queued messages shown to everyone for an agent without mid-turn steering, the steer on the real model in `model.env`, and the steer probe in the agent contract suite | `apps/runner`, `adapter-sdk` (fake agents), `adapter-opencode`, `packages/api`, `apps/web` | 02, 08, 19, 31, 35, 43 | done |
| F-026 Approvals | Profile rules mapped to the agent's own permission settings, a request that matches one waiting for a person; "once", "for this task" (a task rule with a tool and a pattern, ADR 0049) and "deny" with an optional reason; the deny's re-prompt; the session's other approvals closed as cancelled; the 15-minute wait; the card in the panel, on Home, on the ticket in Linear and by mail | `adapter-sdk`, `adapter-opencode`, `apps/runner`, `apps/core`, `packages/api`, `apps/web` | 01, 02, 06, 07, 08, 17, 30, 35, 43 | done |
| F-063 Plan first | A profile switch. The task's first turn runs in plan mode: the agent may read and not write, and its plan (an ACP plan, OpenCode's mapped todo list, and the turn's last message) becomes a needs-you item of reason `plan`. The driver approves, edits and approves, or asks for changes (ADR 0049) | `adapter-sdk`, `adapter-opencode`, `apps/runner`, `apps/core`, `packages/api`, `apps/web` | 01, 02, 08, 18, 31, 35, 43 | done |
| F-062 Home | Milestone 1's `home.overview` grows: "needs you" first from the needs-you items (every reason, amber, with inline answers), then what's running, then what's recent, across every project the member can open. A board grouped by state is the second view | `packages/api`, `apps/web` | 36, 44 | done |
| F-036 Notifications | Each needs-you moment reaches its audience on three channels, each a `NotificationAdapter`: the panel (the "Needs you" page, with unread state), the ticket (a comment through the board's tracker adapter, mentioning the audience's tracker users), and email (F-115). Each member chooses per moment and channel (ADR 0050) | `adapter-sdk`, `adapter-notify-panel` (new), `adapter-notify-tracker` (new), `adapter-linear`, `apps/core`, `packages/api`, `apps/web` | 04, 06, 07, 10, 11, 20, 36, 37, 44, 45 | building: the reviewers' and refine owners' audiences need F-102 and F-099 (milestone 6) |
| F-115 Email notifications | The email channel through Resend first, or SMTP as the second option, set by the instance admin in the panel or by settings. Each member chooses which moments mail them. Without email the panel says mail is off. ostra's own templates, HTML and text, with no new dependency (ADR 0050) | `adapter-email-resend` (new), `adapter-email-smtp` (new), `packages/domain` (templates), `apps/core`, `packages/api`, `apps/web` | 04, 12, 13, 21, 37, 45 | building: invites and reset links (F-002) and budget warnings (F-037) are milestone 4 |
| F-027 Diff | The task page's Changes tab: each changed repo's branch against its base, from the code host's compare, cached by head, rendered by ostra's own unified-diff view (ADR 0051) | `adapter-sdk`, `adapter-github`, `apps/core`, `packages/api`, `apps/web` | 03, 09, 22, 38, 46 | done |
| F-072 Diff comments | Line comments on the diff, saved as drafts per member, sent together as one prompt; each anchored by repo, path, side, line and head, and marked outdated when the line moves | `packages/db`, `packages/domain`, `apps/core`, `packages/api`, `apps/web` | 06, 07, 22, 38, 46 | done |
| F-028 Take it local | The task page's "Take it local": `ostra checkout <key>`, and the plain git commands per repo | `packages/api`, `apps/web` | 39, 47 | done |
| F-103 `ostra checkout` | `ostra login` by device code as a member's CLI session, listed and revocable; `ostra checkout <task>` fetches each branch into the member's clones with their own git access and checks it out. A reopen starts from the branches as they are | `apps/runner` (CLI), `packages/api`, `apps/core`, `apps/web` | 01, 33, 39, 47 | done |
| F-070 Update branch | Core knows how far each task repo is behind its base. One action asks the agent, as a new turn, to merge the base into each repo that needs it and fix the conflicts (ADR 0052) | `adapter-github`, `apps/core`, `packages/api`, `apps/web` | 09, 24, 39, 46 | done |
| F-054 Checks before the PR | An environment's check commands run after every turn with changes, before the push. Results in the panel and the PR body; a failing check makes the PR a draft, and passing again makes it ready (ADR 0052) | `adapter-sdk`, `adapter-executor-host`, `adapter-executor-docker`, `apps/runner`, `apps/core`, `adapter-github`, `packages/api`, `apps/web` | 01, 03, 05, 15, 23, 32, 39, 47, 48 | done |
| F-051 Environment snapshots | On `docker`: the snapshot built by a runner from a generated Dockerfile, scanned for setup secrets, kept by that runner, rebuilt on its triggers, and used by new boxes. On `host`: the dependency cache and the repo mirrors (ADR 0038, amended) | `adapter-sdk`, `adapter-executor-docker`, `adapter-executor-host`, `apps/core`, `apps/runner`, `packages/api`, `apps/web` | 05, 14, 15, 26, 40, 48 | building: the `docker` build and box wait for Linux |
| F-094 Services | The environment's services, edited in the panel, started on `docker` as containers on the box's network with their health shown; a task that needs one is never offered to a `host` runner, and waits with the reason (ADR 0038, amended) | `adapter-sdk`, `adapter-executor-docker`, `apps/core`, `packages/api`, `apps/web` | 05, 14, 27, 40, 48 | building: the `docker` half waits for Linux |
| F-053 `@ostra` on the PR | An `@ostra <prompt>` comment on a task's PR, or on a line of it, from a member with a verified link who can open the project, reopens the task with that prompt; anyone else is ignored (ADR 0052) | `adapter-github`, `apps/core` | 03, 09, 25 | done |
| F-119 Verified GitHub link | A member links their GitHub account through the App's OAuth; ostra keeps the login and ID, revokes the token at once, and the member can unlink. Co-author trailers use the link's no-reply address (ADR 0052) | `adapter-github`, `packages/db`, `packages/api`, `apps/web` | 03, 06, 09, 39, 47 | done |
| F-066 After the merge | Reopening a task whose PR merged starts a fresh branch from the base in that repo and a new PR, on the same ticket, with the history kept. A ticket closed or cancelled while its task runs pauses the task (the turn is interrupted) and asks whether to stop (ADR 0052) | `packages/db`, `packages/domain`, `apps/core`, `packages/api`, `apps/web` | 06, 07, 24, 39, 46 | done |
| F-084 Usage | Each task shows its tokens in four kinds, its spend and its agent time, per task and per turn, from the key proxy's counts; an estimate is marked | `apps/core`, `packages/api`, `apps/web` | 28, 39, 43 | done |

**Built in from the first milestone** (`build-order.md`), checked again by ticket 50:
- Organization-scoped data: every new row carries `organizationId`, every project record `projectId` with the composite key (06). Every query a notification, a Home list or a diff makes is scoped, and its tests read another organization's rows to prove it.
- The event log and the durable queue: an approval, a plan decision, a diff comment sent, a check's result and a notification each are saved before they are acted on, and sent from the queue (17, 18, 20, 22, 23).
- No credential in the agent's container: an MCP server's secret stays in the sidecar, which adds it on the way out (29); the CLI never receives a GitHub token (33); checks get the environment's variables and never a model key or a GitHub token (32).
- ACP as the only way to talk to an agent: permissions, plan mode, questions and steering go through the agent adapter (02, 08).
- Strict typing, dark first, responsive, English text in message files: as milestones 1 and 2.

---

## 3. The end-to-end demo

Ticket 50 runs it and records the result under its `## Comments` and in `demo.md` next to this spec. Everything runs against the Linear workspace `ostra-test` (team `OST`) and the GitHub org `ostra-test` (repos `test1` and `test2`). Secrets come from `~/.config/ostra-dev/` with `set -a; . ~/.config/ostra-dev/<file>; set +a`, and are never printed, logged or committed. Mail goes through Resend with the key in `email.env` (ticket 51), to Resend's test recipient in the scripted run and to the maintainer's own address in the manual one.

**Before:** a fresh clone, `pnpm install`, `pnpm dev:reset`, `tunnel.env` loaded, and `pnpm dev`. Milestones 1 and 2's setup is done by their scripts' helpers: a model provider, the test App, a project `test1` with that repo, a second project `test2`, Linear connected with `OST` attached to `test1`, one personal runner on `host`. The panel signs in as the **default first admin, `demo@demo.com` / `demo`**, unless `OSTRA_ADMIN_*` names another; the scripted run sets `OSTRA_ALLOW_DEFAULT_PASSWORD=true`. **`pnpm dev:seed-member sam`** (development only: section 11, item 1) adds a second member, Sam, with a password the script prints once. The scripted run gives both members addresses at Resend's test recipient; the manual run uses the maintainer's own address and a plus address.

1. **A profile.** Organization, "Agent profiles", "New profile": name `Careful`, agent OpenCode, the model from `model.env`, instructions "Add a line to CHANGELOG.md for every change you make", one skill `changelog` (a `SKILL.md` saying how a changelog line reads), one MCP server `release-names` (the script's fake MCP server on loopback, whose bearer token is a secret in the secret store), the approval rule "Edit files matching `config/**`", plan first on, and "Who may use it": Demo and Sam. In `test1`'s settings, `Careful` becomes the default profile for code tasks.
2. **A ticket, started with the profile.** The script creates a ticket in `OST`: "Set `releaseName` in `config/settings.json` to the name the `release-names` tool gives you." In the Inbox, "Start task": the profile picker shows `Careful` (the default) and `OpenCode`. Demo starts it and is the driver.
3. **Plan first.** The first turn runs in plan mode. The plan appears in the thread and as "Needs you · plan". Within seconds: the sidebar's "Needs you" count rises; Home shows the item first, in amber; a comment on the `OST` ticket says ostra is waiting for a plan approval and mentions Demo's Linear user when one matches Demo's address; and after the mail delay (`OSTRA_EMAIL_DELAY_SECONDS=0` in the scripted run) a mail reaches Demo's address, with the task's title, "A plan to approve" and a link, and nothing else of the task's content. No file in the worktree changed during the plan turn. Demo edits the plan, adding "Also put today's date in the changelog line", and presses "Approve plan". The agent starts work from the edited plan.
4. **An approval, answered by another member.** The agent edits `config/settings.json`, and the rule asks. "Needs you · approval" names the file. Sam, signed in another browser, sees it on Home and presses "Approve for this task" on the card, which shows the rule it adds ("Edit `config/settings.json` in this task"). The receipt reads "Approved for this task by Sam", the audit log has the entry, the ticket's comment is edited to say who answered, and Demo's unread notification shows it answered. The agent's next edit of that file is answered by the task rule, and the thread says so. The script also has Demo and Sam answer one approval at the same moment: one wins, and the other gets "Someone answered this first".
5. **Steer, interrupt and send, take over.** While the agent works, Demo sends "Also mention the ticket's key in the changelog line" with Send: it reaches the agent mid-turn, and the thread shows it delivered without a cancel. Then Demo sends "Stop. Use the date format YYYY-MM-DD." with "Interrupt and send": the turn is cancelled, and the message starts the next one. Then Sam presses "Take over". The thread says "Sam took over". Demo's composer turns read-only, with "Sam is driving · Take over". The script's send as Demo is refused with `FORBIDDEN`.
6. **Checks before the PR.** `test1`'s environment names two checks: `whitespace` (`git diff --check origin/main...HEAD`) and `settings-json` (a one-line Node command that parses `config/settings.json`). After the turn the runner commits, runs both, and pushes. The PR opens ready for review, with a "Checks" section naming both as passed. The task page's Checks tab shows each with its time and output.
7. **The diff, with comments.** The Changes tab shows `test1`'s branch against `main`. Sam comments on two lines ("Keep the keys sorted", "Say which tool gave the name") and presses "Send 2 comments to the agent". One member message with both comments, each with its file and line, starts the next turn. The agent's commit updates the same PR. The comments show as sent, and the one whose line changed shows as outdated.
8. **Update branch.** The script pushes a commit to `test1`'s `main` with the test token, touching another file. Within the reconcile's 5 minutes, or at once through the push webhook, the task says "`test1`: 1 commit behind `main`". Sam presses "Update branch". A turn merges `main` into the task's branch and pushes. The PR is up to date.
9. **Take it local.** The task's "Take it local" shows `ostra checkout OST-<n>` and the plain git commands. The script runs `ostra login`, which prints a code; Sam approves it on the device page; `ostra checkout OST-<n>` in a folder holding a clone of `test1` fetches the task's branch and checks it out, at the PR's head. The script makes a commit there and pushes it with the test token, as Sam's own git access. Sam reopens the task with "Read my last commit and say what it did". The agent starts from the branch with the hand-made commit and answers. Sam's CLI session shows in "Account", "CLI sessions", and after "Revoke" the next `ostra checkout` is refused.
10. **`@ostra` on the PR.** The maintainer's GitHub user is linked to Demo (ticket 51 links it once by hand through the App's OAuth). The script, as that user, comments "`@ostra` add a trailing newline to `config/settings.json`" on the PR. The App reacts with 👀, the task reopens with that prompt, and the thread says it came from a PR comment by Demo. A second comment from the reviewer user of `GITHUB_TEST_REVIEWER_TOKEN`, who is linked to no member, changes nothing.
11. **Merge, then a fresh branch.** The script merges the PR. The task is merged and the ticket moves to done (milestone 2). Sam reopens: "Add a second line to the changelog for the follow-up." The task gets a fresh branch from `main`'s new head, named with `-2` after the first one's slug, and a new PR linked on the same ticket. The thread keeps the whole history, and the task page lists both PRs.
12. **A ticket cancelled while its task runs.** While that turn runs, the script cancels the ticket in Linear. Within seconds the turn is interrupted and the task is "Needs you · ticket closed", with "Stop the task" and "Keep working". Sam presses "Stop the task". The task stops; the PR stays open, for the team to close.
13. **Usage.** The task's properties show fresh input, output, cache-read and cache-write tokens, the spend and the agent time, and each turn in the thread shows its own. The totals equal the sum of the task's `usage.recorded` events, and an estimated figure shows "≈".
14. **Home and Needs you.** Sam's Home lists the open needs-you items of both projects first, then what runs, then what's recent; its board view groups `test1`'s and `test2`'s tasks by state. Sam's "Needs you" page lists every notification that reached Sam, unread ones first, and answered ones under "Done".
15. **SMTP.** The instance admin switches email to SMTP (Resend's SMTP relay, with the same key, from `email.env`) and presses "Send a test mail"; then one more needs-you moment mails through SMTP. Both mails are accepted, and in the scripted run Resend's API reports both delivered to its test recipient.
16. **Snapshots and services on `host`.** `test2`'s environment lists a service, `db` (`postgres:17`, port 5432, a health check). A prompt task in `test2` stays queued, and its page says it needs a runner that can start services and only a `host` runner is online. A second task in `test1` reports "dependency cache: warm" and a shorter setup than the first.

**The checks after the run** (ticket 50 scripts what it can, in `e2e/m3-step-in/`):
- **Nothing reached the agent that shouldn't.** The MCP server's token, the Resend key, the SMTP password and every GitHub token appear nowhere in the worktree, the agent's folders, the event log or a log line (searched by value, never printed). The plan turn changed no file. A PR comment's text and a diff comment's text reach the agent only as data in marked blocks, never in a shell.
- **The profile won.** A repo `opencode.json` that the script commits to a branch of `test1`, allowing everything and adding an MCP server, changed neither the effective permissions nor the MCP list of a task on that branch (F-021).
- **Deny.** On the scripted fake agent, and once on OpenCode: "Deny" with a reason ends the turn, the runner re-prompts with the reason, the agent carries on, and the session's other open approvals close as cancelled (F-026).
- **Expiry.** On the fake agent with the timer at seconds: an unanswered approval expires, the turn is cancelled, the item stays open, and answering it reopens the task with the decision (F-026, ADR 0039).
- **A no-steer agent.** On the scripted agent without `steerMidTurn`: Send queues, the thread shows "queued" to both members, and the message is delivered when the turn ends (F-024).
- **The race.** A take-over and a send at the same moment, 50 times: each send either committed before the take-over or was refused (F-024, ADR 0036).
- **A failing check.** A check `exit 1` added to `test1`'s environment: the next PR opens as a draft, the PR body says which check failed, "Ask the agent to fix" sends its output's tail as a prompt, and when the checks pass the PR is marked ready (F-054).
- **No duplicates.** One ticket comment per needs-you moment within the coalescing window, edited and not added again; one mail per member and moment; one 👀 per accepted `@ostra` comment; one PR per repo and branch (F-036, F-046's rule).
- **Mail off.** With email unset, every step but the mails works, and the panel says mail is off (F-115).
- **Notification choices.** With "Plans" off for email in Demo's settings, a plan mails nobody and still shows in the panel and on the ticket (F-036).
- **Clean-up:** the demo's tickets archived in `OST`, its PRs closed, branches and hidden refs deleted, in `test1` and `test2` only; the fake MCP server stopped.

**What waits for the Linux machine,** written into ticket 50's comments: a snapshot built from the generated Dockerfile, the scan with its negative control, a box started from the snapshot that sees its repos, a nightly rebuild after a default branch moved, and `db` started, healthy and reachable by name from the agent's container.

---

## 4. How it fits together in milestone 3

```
 browser ──▶ apps/web: Agent profiles, Home, Needs you, task page (approve, plan, steer,
                │       Changes, Checks, Take it local), Account, Email settings
                ▼
             packages/api ──▶ Postgres: profiles, task rules, approvals, diff comments,
                │                       notifications, preferences, CLI sessions, check runs
                ▼                                 ▲
 apps/core workers: notify.fanout, notify.deliver, diff.fetch, task.update-branch,
                    github.comment (@ostra), snapshot.schedule, task.reconcile-behind
                │                                 │
   commands (approval-answer, question-answer, plan-answer, steer, ...) ▼
 runner ──WS──▶ gateway        runner: profile launch, permissions, plan mode, checks
   └─ sidecar: key proxy, git proxy, MCP proxy (adds an MCP server's secret)
 GitHub ──webhook──▶ core: issue_comment, pull_request_review_comment, push
 Linear ◀── adapter-notify-tracker (a comment, mentions)    Resend / SMTP ◀── adapter-email-*
 `ostra login` / `ostra checkout` ──HTTPS──▶ /api/cli/v1/* (a member's CLI session)
```

**The flows:**
- **A task starts with its profile.** The task records the profile it started with. The dispatch writes the profile into the task spec's agent section: instructions, skills (as blobs), MCP servers (an HTTP server as a path on the sidecar's MCP proxy; a stdio server as a command in the image, with no secret), the approval rules, the task rules, and plan first. The agent adapter turns the rules into the agent's own permission settings, where a rule's effect is "ask", and writes its config so the repo's own agent config can't widen it (ADR 0049).
- **An approval.** The agent asks over ACP. The runner checks the task rules first: a match is answered "once" at once and recorded as `approval.auto_answered`. Otherwise it emits `approval.requested` with the rule that asked, and waits. Core stores the approval and a needs-you item (audience: the driver, or the project's members when there's no driver), moves the task to needs you, and enqueues `notify.fanout`. A member's answer goes through `approvals.answer` as today; "for this task" also writes a `TaskApprovalRule` and sends it in the command, and "deny" carries the optional reason. The runner answers the agent "once" or "reject", and after a reject re-prompts with the reason or the fixed line (ADR 0032). At 15 minutes with no answer the runner cancels the turn and reports `approval.closed { reason: "expired" }`; the item stays open, and an answer reopens the task with the decision in the reopen's pending messages (milestone 2's path).
- **A question.** As an approval, except that only the driver answers (section 11, item 4), through `questions.answer` and the `question-answer` command.
- **Plan first.** The first turn's spec says `mode: "plan"`. The runner starts the agent in the adapter's plan mode (read and search allowed, write and shell denied), with a fixed preamble asking for a plan and no changes. At the turn's end the runner emits `plan.proposed` with the plan's entries and the turn's last agent message. Core raises the `plan` item. The driver's "Approve plan", with the text as shown or edited, or "Ask for changes" with a message, is a `plan-answer` command. On approve the runner switches the session to the build mode (the adapter's `setMode`, or a relaunch with `session/load`) and prompts with the approved plan as data. On "ask for changes" it prompts again in plan mode.
- **A notification.** Every needs-you item, when it's created and when it's answered or dismissed, enqueues `notify.fanout` keyed by the item and the change. Fan-out resolves the audience to members, reads each member's choices, and writes one `Notification` row per member and one `NotificationDelivery` per channel the member wants, each with an idempotency key of the item, the member and the channel. `notify.deliver` sends each through its adapter: the panel's is the row itself (unread), the tracker's is a comment on the task's ticket (one per moment, coalesced in a 10-minute window by editing the last one, ADR 0050), and email waits `OSTRA_EMAIL_DELAY_SECONDS` and is skipped when the member has read it in the panel or the item is no longer open. A failed delivery retries with backoff and shows on the notification, never blocking the others.
- **The diff.** `tasks.diff` reads the task repo's base and head. Core asks the code host's `compare` and caches the result by `(repo, base sha, head sha)`. The diff is the pushed branch, so it's "as of the last turn"; during a turn the thread's edit rows show work not yet pushed. Over the size limits the file shows "Too large to show here", with a link to the code host.
- **Diff comments.** A member's comment is a draft (`DiffComment`, state `draft`), anchored by task repo, path, side, line and the head it was written on. "Send N comments to the agent" moves the member's drafts to `sent` in one transaction and writes one member message (`intent: "diff-comments"`) that renders the comments with their files, lines and quoted code, as data. The message follows the composer's rule: the driver sends to a running or idle session; with no session going it reopens the task as `tasks.reopen` does. When a later head changes a commented line, the comment shows as outdated.
- **Checks.** After a turn with changes, the runner commits, runs the environment's checks in the workspace in order (each with its own timeout), emits `check.started` and `check.finished` per check, uploads the full output as a blob, and then pushes and sends `session.saved` with the results. Core's PR opener writes the checks section into the PR body and opens a draft when one failed, or converts an open PR to draft; when every check passes on a later turn, it marks a PR ostra made a draft ready.
- **Behind and update branch.** The App's `push` webhooks on a base branch, and milestone 2's reconcile, recompute each open task repo's `behind` from the compare. "Update branch" writes a member message (`intent: "update-branch"`) naming each repo that's behind and its base, and sends it like any message: a steer queued for after the turn, or a reopen.
- **`@ostra`.** The App's `issue_comment` and `pull_request_review_comment` webhooks go through milestone 2's inbox. The handler finds the task by the PR, the member by the commenter's verified GitHub ID, and checks the member can open the project. Then it reacts 👀 (idempotent by comment ID) and writes a member message (`intent: "pr-comment"`, with the comment's URL and, for a line comment, its file and line). With a session going, the message waits for the turn's end; otherwise it reopens the task. Anyone else's comment is recorded by IDs and dropped.
- **After a merge.** A reopen of a task with a merged task repo gives that repo a new branch from the base's current head (`<old branch>-2`, then `-3`), keeps the merged PR in `TaskPullRequest`, and opens a new PR on the first push, linked on the same ticket. A task repo whose PR is still open carries on on its branch.
- **A ticket closed while running.** Milestone 2's ticket ingest sees the ticket move to a `done` or `cancelled` category while the task runs, outside ostra's own writes. Core interrupts the turn, raises `ticket_closed`, and notifies. "Stop the task" stops it (reason `requested`); "Keep working" dismisses the item and sends "Carry on where you stopped." as the next turn.
- **`ostra login` and `ostra checkout`.** `ostra login --server <url>` runs a device-code grant for a CLI session: the member approves the code on the device page, and the CLI stores the session's token in the member's config folder (mode 0600). `ostra checkout <key | task ID | task URL>` asks `/api/cli/v1/tasks/:ref/branches`, then, for each repo, finds a local clone whose remote matches (the current folder, its children to depth 2, or `--dir`), clones it with the member's own git when there's none, fetches the branch, refuses on a dirty tree, and checks the branch out tracking the remote. ostra hands out branch names and clone URLs, never a token.
- **Snapshots** (`docker`). Core enqueues `snapshot.schedule` when the environment changes, when a `push` to a default branch touches a lockfile, and nightly when a default branch moved. A `docker` runner of the project's pools takes the build (a `snapshot-build` command), builds from the generated Dockerfile with setup secrets mounted for the build only, scans the image for each setup secret's value, keeps it locally, and reports `snapshot.built` or `snapshot.failed`. A box on that runner starts from the ready snapshot; one on a runner without it builds or falls back to a full setup. On `host` the executor keeps a per-project mirror of each repo and a dependency cache folder, and the task spec's `snapshot` section says so.
- **Services.** The task spec carries the environment's services. The `docker` executor starts them on the box's network, waits for their health, and reports `service.healthy` or `service.failed`. The scheduler offers a task whose environment has services only to runners whose executor declares `services`, so a `host` runner never gets one, and the task's dispatch note says why it waits.

---

## 5. The contracts

Every contract change in milestone 3 is **additive**: a new optional field, a new union member, a new endpoint, a new table, column or enum value. Nothing is renamed or dropped (`AGENTS.md`). Each lands as one small commit that names the contract and updates every caller in the same commit. Tickets 01 to 07 make them first; everything else builds on them.

### 5.1 `packages/protocol`: minor 2 (ticket 01)

- **The version.** The protocol goes to minor 2. The window stays one minor either way (`version.ts`), so a minor-1 runner still works: core serves it milestone 2's task spec without the new sections, sends it none of the new commands, gives its tasks no plan mode, no checks and no profile rules (a task whose profile needs them isn't offered to it, and its dispatch note says why), and answers its approvals "once" as milestone 1 did, recorded with the rule `peer-too-old`. A minor-0 runner is outside the window and refused at `hello`, with the message milestone 1's version check prints.
- **Events, new members of the union:**
  - `plan.proposed { turnId, entries: PlanEntry[], message }`: the plan turn's result. `message` is the turn's last agent message, capped like `agent.message`.
  - `plan.answered { decision: "approve" | "revise", text, memberId }` (server-only): the driver's answer. `text` is the plan as approved, or the driver's request.
  - `check.started { checkId, repoId | null, name }` and `check.finished { checkId, status: "passed" | "failed" | "timed-out" | "error", exitCode | null, durationMs, outputTail, outputBlobId | null }`: a check's run. `outputTail` is at most 16 KiB.
  - `snapshot.built { snapshotId, imageDigest, durationMs }` and `snapshot.failed { snapshotId, reason: "setup-failed" | "secret-found" | "build-failed", detail }`: reported on the task that triggered the build, or as a runner event when none did.
  - `service.healthy { name, afterMs }` and `service.failed { name, reason }`.
  - `diff.comments_sent { commentIds, count }` (server-only): which drafts a member message carried.
  - `ticket.closed { status, category: "done" | "cancelled" }` (server-only): the ticket moved while the task ran.
  - `pr.comment_received { url, login, path | null, line | null }` (server-only): an accepted `@ostra` comment.
- **Events, new optional fields:** `approval.requested` gains `rule: { ruleId, name, source: "profile" | "task" } | null` and `subject: { kind: "path" | "command" | "url" | "tool", value }`, the thing the rule matched, for the card and the "for this task" pattern. `approval.answered` gains `reason` (a deny's, at most 2,000 characters) and `taskRule: { tool, pattern } | null`. `user.message` gains `intent: "message" | "diff-comments" | "update-branch" | "plan-revision" | "pr-comment" | "fix-checks" | "keep-working"`. `session.saved` gains `checks: [{ checkId, status }]`. `turn.started` gains `mode: "plan" | "build"`.
- **Commands, new:**
  - `question-answer { sessionId, questionId, answers }`
  - `plan-answer { sessionId, decision: "approve" | "revise", text }`
  - `snapshot-build { snapshotId, projectId, environment }`, where `environment` is the build's inputs (base image, repos, setup script, the names of setup secrets; their values come from the credentials endpoint after the lease check, as every secret does)
- **Commands, new optional fields:** `approval-answer` gains `reason` and `taskRule`. `steer` gains `intent`.
- **The task spec, new optional fields** (a minor-1 runner gets the old shape):
  - `agent` gains `skills: [{ name, blobId, files: [{ path, blobId }] }]`, `mcpServers: [{ name, transport: "http", proxyPath } | { name, transport: "stdio", command, args, env }]` (an HTTP server's URL and headers stay in the sidecar's credentials; a stdio server's `env` holds no secret), `approvalRules: ApprovalRule[]`, `taskRules: TaskRule[]` and `planFirst: boolean`
  - `firstTurnMode: "plan" | "build"` (plan only for a task's first session with plan first)
  - `checks: [{ checkId, name, command, repoId | null, timeoutSeconds }]`
  - `services: [{ name, image, port | null, variables, healthCheck | null }]`
  - `snapshot: { kind: "image", snapshotId, imageRef, digest } | { kind: "host-cache", cacheKey } | null`
- **The approval rule and the task rule** are protocol types, Zod first: `ApprovalRule { ruleId, name, tool: "edit" | "execute" | "fetch" | "mcp", match: { kind: "path-glob", glob } | { kind: "command-prefix", prefixes } | { kind: "command-outside", allowlist } | { kind: "any" } }` and `TaskRule { tool, pattern }`, where a pattern is an exact path or a command prefix (ADR 0049). They describe what needs a person; the adapter maps them to the agent's own settings.
- **Added 2026-11-19 for the targets' decisions** (ticket 01's `## Decided 2026-11-19`; Q190), all optional or new, so nothing above changes shape:
  - Each `agent.mcpServers` entry gains `readOnly: boolean` (false when absent).
  - `ApprovalRule.match` gains `{ kind: "mcp-not-read-only" }`, for the tool `mcp` only. The schema refuses a match that doesn't fit its tool (`path-glob` with `edit`; `command-prefix` and `command-outside` with `execute`; `any` with every tool).
  - `ApprovalRule` gains `preset: "dependency" | "migration" | "allowlist" | "network"`, the preset it came from.
  - `TaskRule` is `{ ruleId, tool, pattern }`, where `ruleId` is the `TaskApprovalRule`'s ID. It's in `approval.answered.taskRule`, `approval-answer.taskRule` and `agent.taskRules`, and `approval.auto_answered.ruleId` names it.
  - `plan.answered` gains `entries: PlanEntry[]` and `message` on an approve: the plan as approved, structured.
  - **The matcher, the pattern rule and the runner's prompts live in this package** (`src/agent/rules.ts`, `src/agent/prompts.ts`): the runner and the adapters are Apache-2.0 and can't import `packages/domain` (ADR 0045, ADR 0048). The domain re-exports them (section 5.4).
- **The credentials response** gains `mcpServers: [{ name, url, headers }]` for the sidecar's MCP proxy. Never logged.
- **Added 2026-11-19: a refused token says why** (ADR 0034, "Auth"; a runner exited as revoked when its clock and core's disagreed). The token endpoint's error body gains `reason: "clock-skew" | "unknown-key" | "revoked" | "replayed"` and, with `clock-skew`, `serverTime`, both optional. The runner sends its minor in `x-ostra-minor` on the token request, and a request without it, from a minor-1 runner, gets the body without them.
- **HTTP for the CLI** (`/api/cli/v1/`, on the web app, a member's CLI session in `Authorization`): `POST /device` and `POST /device/token` (the device-code grant), `GET /tasks/:ref/branches` → `{ taskId, key | null, repos: [{ fullName, cloneUrl, branch, baseBranch, headSha | null }] }`, `DELETE /session`. Each refuses a revoked or expired session with 401 and a message the CLI prints.
- **Limits** as named working values: a check's timeout 10 min and the checks' total 30 min, a check's output tail 16 KiB and its blob 4 MiB, the approval wait 15 min (milestone 1's), a plan message 64 KiB, a diff comment 4,000 characters and at most 50 per send.

### 5.2 `packages/adapter-sdk` (tickets 02 to 05)

**`AgentAdapter`** (ticket 02):
- **Capabilities, new:** `permissionRules: "native" | "runner-only"` (the agent's own settings can say "ask" for a path or a command, or only the runner's check stands), `planMode: "session-mode" | "relaunch" | "none"` (how the adapter makes a read-only turn), `skills: boolean`, `mcp: { http: boolean, stdio: boolean }`, `projectConfigOverride: boolean` (the profile's config wins over the repo's).
- **Launch, new inputs:** `prepareLaunch` takes the profile's rules, the task rules, the skills, the MCP servers and the mode, and its result's files hold them. `setMode(session, "plan" | "build")` switches a live session where `planMode` is `session-mode`; with `relaunch` the base class stops the agent and starts it again with `session/load`.
- **The scripted fake agents** grow: one with native plans, reject-and-continue and session modes; one without mid-turn steering; both able to ask for a permission on a path or a command, ask a question, and write a file during a plan turn (which the suite expects refused).
- **The agent contract suite** gains: a rule that asks, a task rule that answers, a deny with a reason that re-prompts, the other approvals closing as cancelled, an expired approval, a question answered, a plan turn that changes no file, a switch to build mode, a steer mid-turn and a queued one, skills and MCP servers reaching the agent, the profile's config winning over a repo's, and the steer probe of spike 1 for every real agent bump.

**`CodeHostAdapter`** (ticket 03):
- `compare(access, base, head)` → `{ aheadBy, behindBy, mergeBase, files: [{ path, previousPath, status, additions, deletions, patch | null, truncated }] }` with the code host's own limits reported, never hidden.
- `setPullRequestDraft(access, number, draft)`.
- `parseWebhook` gains `issue_comment`, `pull_request_review_comment` and `push` hints.
- `addReaction(access, commentRef, "eyes")`, idempotent by comment.
- `userAuthorizeUrl(app, state, redirectUri)` and `exchangeUserCode(app, code, redirectUri)` → `{ userId, login }`, which revokes the token before it returns (F-119).
- **Capabilities, new:** `compare`, `draftPullRequests`, `prComments`, `userLink`.

**`TrackerAdapter`** (ticket 04): `findUsersByEmail(board, emails)` → `[{ email, userId, mention }]`, where `mention` is the markdown that notifies that user, and capability `mentions`. The Jira fake implements it with account IDs.

**`NotificationAdapter`** (ticket 04): the declared class grows. `Notification` gains `kind` (the moment: `approval`, `question`, `plan`, `pr_ready`, `no_changes`, `stalled`, `spend_cap`, `crashed`, `setup_failed`, `ticket_closed`, `test`), `recipients: [{ memberId, email | null, trackerMention | null }]`, `subject` (the task's or the test's) and `rendered: { subject, html, text } | null` (email only). `send` keeps its shape and returns the provider's message ID. A new optional `update(notification, providerMessageId)` edits a sent one where the channel can (capability `edits`: the tracker's yes, email no). **The notification contract suite** is new: idempotent per key, a refused recipient reported without failing the others, rate limits as `rate-limited`, and, for email, a message whose HTML and text both carry the link.

**`ExecutorAdapter`** (ticket 05):
- `runChecks(input)` → each check's result, run in the agent's environment, with its timeout and output cap, never with a model key or a GitHub token in its environment.
- `buildSnapshot(input)` and `hasSnapshot(snapshotId)` (`docker`); `prepareCache(input)` (`host`: the repo mirrors and the dependency cache).
- `create` takes the spec's `services` and `snapshot`.
- **Capabilities, new:** `services: boolean`, `snapshots: "image" | "host-cache" | "none"`. `host` declares `services: false` and `host-cache`; `docker` declares `services: true` and `image`.

### 5.3 `packages/db`: the milestone 3 migration (ticket 06)

One new migration, additive only. Every row carries `organizationId`; every project record carries `projectId` with the composite key to the project.

| Change | What |
|---|---|
| `AgentProfile` | + `approvalRules` (JSON, parsed by the protocol's schema), `planFirst` (default false), `access` (`everyone`, `listed`; default `everyone`), `archivedAt`, `mcpServers` (JSON: name, transport, URL or command, and secret refs for headers) |
| New `AgentProfileMember` | Who may use a `listed` profile: `profileId`, `memberId`. Unique `(profileId, memberId)` |
| New `AgentProfileSkill` | `profileId`, `name`, `body` (the `SKILL.md` text), `files` (JSON of path and blob ID). Unique `(profileId, name)` |
| `Task` | + `agentProfileId` (the profile it started with), `planState` (`none`, `proposed`, `approved`) |
| New `TaskApprovalRule` | A "for this task" rule: `taskId`, `tool`, `pattern`, `approvalId`, `createdByMemberId`. Unique `(taskId, tool, pattern)` |
| `Approval` | + `ruleId`, `ruleSource`, `subjectKind`, `subjectValue`, `denyReason` |
| `NeedsYouItem` | + `questionId`, `planTurnId`, `notifiedAt` |
| New `DiffComment` | `taskId`, `taskRepoId`, `memberId`, `path`, `side` (`old`, `new`), `line`, `headSha`, `body`, `state` (`draft`, `sent`, `deleted`), `sentInSeq`, `outdatedAt` |
| New `DiffCache` | `repoId`, `baseSha`, `headSha`, `result` (JSON), `fetchedAt`. Unique `(repoId, baseSha, headSha)` |
| New `TaskPullRequest` | Every PR a task repo has had: `taskRepoId`, `number`, `url`, `branchName`, `state` (`open`, `merged`, `closed_unmerged`), `draft`, `draftByOstra`, `openedAt`, `closedAt` |
| `TaskRepo` | + `behindBy`, `behindCheckedAt`, `generation` (default 1) |
| New `CheckRun` | `taskId`, `sessionId`, `turnOrdinal`, `checkId`, `repoId`, `status`, `exitCode`, `durationMs`, `outputBlobId`, `startedAt`, `finishedAt` |
| `Check` | + `timeoutSeconds` (default 600), `position` |
| `Turn` | + `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `spentMicroUsd`, `estimated`, `agentMs` (F-084, filled as the turn's usage arrives) |
| `Service` | no change: a service's health is an event, not a column |
| `Snapshot` | + `runnerId` (the `docker` runner that holds it), `buildInputsHash`, `secretScan` (`passed`, `failed`), `buildDurationMs` (added 2026-11-19, ticket 06's decisions) |
| New `Notification` | One per member and moment: `memberId`, `needsYouItemId` (nullable for a test), `kind`, `taskId`, `readAt`, `state` (`open`, `answered`, `dismissed`) |
| New `NotificationDelivery` | One per notification and channel: `notificationId`, `channel` (`panel`, `tracker`, `email`), `adapter`, `state` (`pending`, `sent`, `skipped`, `failed`), `idempotencyKey` (unique), `providerMessageId`, `attempts`, `error` (words and IDs), `dueAt` |
| New `NotificationPreference` | `memberId`, `kind`, `channel`, `enabled`, `updatedAt` (added 2026-11-19, ticket 06's decisions). Unique `(memberId, kind, channel)`. No row means the default (ADR 0050) |
| New `EmailSettings` | The instance's email: `provider` (`off`, `resend`, `smtp`), `fromAddress`, `fromName`, `resendApiKeySecretRef`, `smtpHost`, `smtpPort`, `smtpSecure`, `smtpUser`, `smtpPasswordSecretRef`, `lockedBySettings`, `lastTestAt`, `lastTestResult`. One row |
| New `CliSession` | A member's `ostra login`: `memberId`, `userId`, `tokenHash`, `name` (the machine's name the CLI sends), `createdAt`, `lastUsedAt`, `expiresAt`, `revokedAt` |
| `DeviceCode` | + `purpose` (`runner`, `cli`; default `runner`) |
| `User` | + `githubUserId` (unique where set), `githubLogin`, `githubLinkedAt` |
| `InstanceSetting` | + `emailDelaySeconds` (null: the setting's default) |
| Enums | `NeedsYouReason` keeps its values. `CommandKind` + `question_answer`, `plan_answer`, `snapshot_build`. New `ProfileAccess`, `DiffCommentState`, `DiffSide`, `CheckRunStatus`, `PullRequestState`, `NotificationChannel`, `NotificationState`, `DeliveryState`, `EmailProvider`, `PlanState`. `SnapshotState` keeps its values |

### 5.4 `packages/domain` (ticket 07)

- **Lifecycles,** new inputs, each with exhaustive tests: task `plan_proposed` (→ needs you, `plan`), `plan_answered` (→ running while the box is warm, else queued), `ticket_closed` (→ needs you, `ticket_closed`, from running), `keep_working` and `reopen_after_merge` (a merged task → queued, with the merged repos marked for a fresh branch). Approval `answer` gains the task rule and the reason. A needs-you item's `answer` from a notification is the same input as from the task page.
- **Rules:** a pure matcher for an approval rule against a request's subject (path globs with `**`, command prefixes on the parsed first words, never a shell), and the "for this task" pattern drawn from a subject (section 11, item 3). The adapters use it for `runner-only` agents, the runner for task rules, and the panel to show what a rule covers. *Changed 2026-11-19 (Q190):* the matcher and the pattern rule live in `@ostra/protocol` (section 5.1), because the runner and the adapters are Apache-2.0 and can't import this package; the domain re-exports them and adds the four presets.
- **Notifications:** the audience resolver (an item's audience → members: the driver; the project's members when there's no driver; reviewers and refine owners return none until milestone 6), the default choices per kind and channel, and the coalescing rule for the tracker.
- **Email templates:** pure renderers, one per kind, producing `{ subject, html, text }` from the kind, the organization, the project, the task's title and key, one line about the moment (a command or a path for an approval, at most 200 characters), and the link. Inline styles, a table layout, the brand's colours and the Hinge mark as a hosted image from the install's own address, a text part with the same content, and no task content beyond those fields (ADR 0050).
- **Prompts:** the renderers for the plan-mode preamble, the approved plan, a deny's re-prompt (milestone 1's fixed line, or the reason as data), diff comments, update branch, `@ostra` comments, "fix the checks" (the failing checks' tails as data) and "keep working". Every piece of member, PR or agent text sits in a marked block. *Changed 2026-11-19 (Q190):* the four the runner sends (the plan-mode preamble, the approved plan, the revision request and the deny's re-prompt) and the marked-block helper live in `@ostra/protocol`, for the same license reason; the domain re-exports them.
- **Use-case signatures:** `saveAgentProfile`, `archiveAgentProfile`, `profilesForMember`, `setProjectDefaultProfile`, `recordApprovalRequested`, `answerApproval` (extended), `answerQuestion`, `recordPlanProposed`, `answerPlan`, `fanOutNotification`, `recordDelivery`, `markNotificationRead`, `saveNotificationPreferences`, `saveEmailSettings`, `saveDiffComment`, `sendDiffComments`, `recordChecksRun`, `requestUpdateBranch`, `recordBehind`, `acceptPrComment`, `linkGitHubUser`, `unlinkGitHubUser`, `reopenAfterMerge`, `recordTicketClosed`, `scheduleSnapshot`, `recordSnapshotResult`, `startCliSession`, `revokeCliSession`.
- **Jobs, new names** (IDs only in payloads, each with its key rule, ADR 0037): `notify.fanout` (key: item and change), `notify.deliver` (key: delivery; email's delayed by the setting), `diff.fetch` (key: repo, base and head), `task.reconcile-behind` (an idempotent pass, so a pg-boss schedule is allowed), `github.comment` (key: the comment's ID), `snapshot.schedule` (key: project and reason, `singletonSeconds` 60), `snapshot.nightly` (an idempotent pass), `cli-session.expire` (a sweep).
- **Settings, new,** each with a working default and its line in `docs/configuration.md`:

| Setting | Default |
|---|---|
| `OSTRA_EMAIL_PROVIDER` | unset: the panel decides, and mail is off until an admin sets it (`resend`, `smtp` or `off` lock the panel's choice) |
| `OSTRA_EMAIL_FROM`, `OSTRA_EMAIL_FROM_NAME` | unset; `ostra` |
| `OSTRA_RESEND_API_KEY` | unset; read when the provider is `resend` |
| `OSTRA_SMTP_HOST`, `OSTRA_SMTP_PORT`, `OSTRA_SMTP_SECURE`, `OSTRA_SMTP_USER`, `OSTRA_SMTP_PASSWORD` | unset, `587`, `starttls`; read when the provider is `smtp` |
| `OSTRA_EMAIL_DELAY_SECONDS` | `120` |
| `OSTRA_TRACKER_NOTIFY_COALESCE_MINUTES` | `10` |
| `OSTRA_CHECK_TIMEOUT_SECONDS`, `OSTRA_CHECKS_TOTAL_MINUTES` | `600`, `30` |
| `OSTRA_CLI_SESSION_DAYS` | `30` |
| `OSTRA_SNAPSHOT_NIGHTLY_HOUR` | `3` (UTC) |
| `OSTRA_DIFF_MAX_FILES`, `OSTRA_DIFF_MAX_PATCH_KIB` | `300`, `1024` |

---

## 6. Packages, licenses and owners

| Package | License | New in M3 | Built by |
|---|---|---|---|
| `packages/protocol` | Apache-2.0 | minor 2 | core (01) |
| `packages/adapter-sdk` | Apache-2.0 | agent, code host, tracker, notification and executor additions; the fake agents; the notification suite | adapters (02, 03, 04, 05) |
| `packages/adapters/adapter-opencode` | Apache-2.0 | permissions from rules, plan mode, skills, MCP, the config that wins | adapters (08) |
| `packages/adapters/adapter-github` | Apache-2.0 | compare, drafts, comment and push webhooks, reactions, the user link | adapters (09) |
| `packages/adapters/adapter-linear` | Apache-2.0 | users by email, mentions | adapters (10) |
| `packages/adapters/adapter-notify-panel` (new) | Apache-2.0 | the panel channel, behind a rows port core backs (as `adapter-blob-postgres` does) | adapters (11) |
| `packages/adapters/adapter-notify-tracker` (new) | Apache-2.0 | the ticket channel over any `TrackerAdapter` | adapters (11) |
| `packages/adapters/adapter-email-resend` (new) | Apache-2.0 | email through Resend, on `resend` (ADR 0007) | adapters (12) |
| `packages/adapters/adapter-email-smtp` (new) | Apache-2.0 | email through SMTP, on `nodemailer` (ADR 0007) | adapters (13) |
| `packages/adapters/adapter-executor-docker` | Apache-2.0 | snapshots, services, checks | runner (14) |
| `packages/adapters/adapter-executor-host` | Apache-2.0 | the dependency cache, the mirrors, checks | runner (15) |
| `apps/runner` | Apache-2.0 | the profile at launch, the MCP proxy, approvals, plan mode, questions, checks, `ostra login` and `ostra checkout` | runner (29 to 33) |
| `packages/db` | Sustainable Use | the M3 migration | core (06) |
| `packages/domain` | Sustainable Use | inputs, rules, audiences, templates, prompts, use cases, jobs, settings | core (07); bodies by core and api |
| `apps/core` | Sustainable Use | profiles in the spec, approvals, plans, questions, steering, notifications, email, diffs, checks, behind, `@ostra`, after the merge, snapshots, services, usage | core (16 to 28) |
| `packages/api` | Sustainable Use | profiles, approvals, plans, Home, notifications, email, diffs, checks, take it local, CLI sessions, the GitHub link, usage, services | api (34 to 40) |
| `apps/web` | Sustainable Use | the M3 screens, and `/api/cli/v1` | web (41 to 48) |
| `e2e/m3-step-in` (new) | Sustainable Use | the demo | core (50) |

The license line holds (ADR 0045, ADR 0048): no Apache-2.0 package depends on a Sustainable Use one. `adapter-notify-panel` keeps its rows behind a port and never imports `packages/db`; `adapter-notify-tracker` imports only `adapter-sdk`. `pnpm check:licenses` runs on every commit.

---

## 7. The builders and their tickets

Five builders: **core**, **runner**, **web**, **api** and **adapters**. Core and adapters make the contracts first (01 to 07). Ticket 51 is the maintainer's.

| # | Ticket | Builder | Blocked by |
|---|---|---|---|
| 01 | Protocol: minor 2 | core | none |
| 02 | Adapter SDK: the agent interface for profiles, rules and plan mode | adapters | 01 |
| 03 | Adapter SDK: code host additions | adapters | none |
| 04 | Adapter SDK: notifications and tracker mentions | adapters | none |
| 05 | Adapter SDK: executor additions for checks, snapshots and services | adapters | 01 |
| 06 | DB: the milestone 3 migration | core | none |
| 07 | Domain: inputs, rules, audiences, templates, prompts, use cases, jobs and settings | core | 01, 06 |
| 08 | OpenCode adapter: rules, plan mode, skills, MCP and the config that wins | adapters | 02 |
| 09 | GitHub adapter: compare, drafts, comments, push and the user link | adapters | 03 |
| 10 | Linear adapter: users and mentions | adapters | 04 |
| 11 | The panel and tracker notification adapters | adapters | 04 |
| 12 | The Resend email adapter | adapters | 04 |
| 13 | The SMTP email adapter | adapters | 04 |
| 14 | Docker executor: snapshots, services and checks | runner | 05 |
| 15 | Host executor: the dependency cache, the mirrors and checks | runner | 05 |
| 16 | Core: the profile in the task spec | core | 06, 07 |
| 17 | Core: approvals, task rules and expiry | core | 07, 16 |
| 18 | Core: plan first and questions | core | 07, 16 |
| 19 | Core: steering, the driver race and queued messages | core | 07 |
| 20 | Core: notification fan-out and delivery | core | 07, 11 |
| 21 | Core: email delivery and its settings | core | 12, 13, 20 |
| 22 | Core: the diff and diff comments | core | 07, 09 |
| 23 | Core: checks before the PR, and drafts | core | 07, 09 |
| 24 | Core: behind, update branch, and after the merge | core | 07, 09 |
| 25 | Core: `@ostra` on the PR | core | 07, 09 |
| 26 | Core: scheduling snapshots | core | 07, 14 |
| 27 | Core: services and where a task may run | core | 07 |
| 28 | Core: usage per task and per turn | core | 06 |
| 29 | Runner: the profile at launch, and the sidecar's MCP proxy | runner | 01, 08 |
| 30 | Runner: approvals, task rules and question answers | runner | 01, 08 |
| 31 | Runner: plan mode, and steering on a real model | runner | 01, 08 |
| 32 | Runner: checks after a turn | runner | 01, 14, 15 |
| 33 | CLI: `ostra login` and `ostra checkout` | runner | 01, 39 |
| 34 | API: agent profiles and project defaults | api | 07 |
| 35 | API: approvals, questions, plans and steering | api | 17, 18, 19 |
| 36 | API: Home and the needs-you list | api | 20 |
| 37 | API: notification choices and email settings | api | 20, 21 |
| 38 | API: the diff and diff comments | api | 22 |
| 39 | API: checks, update branch, take it local, CLI sessions, the GitHub link and usage | api | 23, 24, 25, 28 |
| 40 | API: services and snapshots | api | 26, 27 |
| 41 | Milestone 3 screen targets | web | none |
| 42 | Web: agent profiles and the profile picker | web | 34, 41 |
| 43 | Web: the task page for approvals, questions, plans, steering and usage | web | 35, 39, 41 |
| 44 | Web: Home, the board view and Needs you | web | 36, 41 |
| 45 | Web: notification choices and email settings | web | 37, 41 |
| 46 | Web: the Changes tab, diff comments, update branch and after the merge | web | 38, 39, 41 |
| 47 | Web: checks, take it local and Account | web | 39, 41 |
| 48 | Web: the environment's checks, services and snapshot | web | 40, 41 |
| 49 | ostra builds ostra | core (lead) | 50, 51 |
| 50 | The end-to-end demo and the ledger | core (lead) | 21, 24, 25, 29 to 33, 42 to 48 |
| 51 | The maintainer's steps outside the code | maintainer | none for the decisions; 39 and 47 for the GitHub link; 50 for steps 6 and 7 |

**Who starts when.** core takes 01, then 06, then 07; adapters take 03 and 04 at once, 02 and 05 after 01. runner takes 14 and 15 after 05, and 29 to 31 after 08. api starts on 34 once 07 is in. web takes 41 at once; its screen tickets wait for the targets' approval (section 12). Milestone 2's tickets come first wherever both touch a file: a milestone 3 ticket that meets a milestone 2 ticket still open on the same package waits for it, and says so in its `## Comments`.

---

## 8. Test seams

Agreed here so builders don't each invent one.

- **Postgres:** milestone 1's helper, a database per test file. Every test that reads data also checks another organization's rows stay invisible. Every notification and Home test also checks a member sees only items of projects they can open.
- **A second member:** `seedMember(db, { username, email, password, role })` in `@ostra/domain/testing`, the same code `pnpm dev:seed-member` calls (section 11, item 1).
- **Agents:** the two scripted fake agents of ticket 02 (one with native plans, modes and reject-and-continue, one without mid-turn steering). OpenCode runs the same suite against the stub models and, gated on `model.env`, against the real endpoint, where the steer and the plan turn are the cases that need a real model (ADR 0032).
- **MCP:** a fake MCP server over streamable HTTP in `@ostra/adapter-sdk/testing` with one tool, which refuses a call without its bearer token, so a test proves the sidecar added it and the agent never held it.
- **GitHub:** milestone 2's fake code host gains compare (with its limits), drafts, `issue_comment`, `pull_request_review_comment` and `push` webhooks (signed), reactions, and the user OAuth endpoints with a revocation the fake counts. The live cases run against `ostra-test/test1` and `test2`.
- **Linear:** milestone 2's fake Linear server gains users with emails and the mention markdown. The live cases run against `OST`.
- **Email:** a fake Resend API in-process (the `POST /emails` shape, idempotency keys, a 429) and a fake SMTP server on `node:net` written in the test seam (`EHLO`, `STARTTLS` refused or accepted, `AUTH PLAIN`, `MAIL`, `RCPT`, `DATA`), so neither suite needs a network or a new dependency. The live cases send to Resend's test recipient through its API and its SMTP relay, gated on `email.env`. *Added 2026-11-19 (Q186):* there is no Resend key yet, so Resend is proved on the fake API, and SMTP is proved with the real adapter sending over loopback to the `node:net` server, run in the test with `STARTTLS` and `AUTH` (ticket 13), with no new dependency; the scripted demo uses that server for its mails until `email.env` exists (ticket 50).
- **The CLI:** a temporary folder with bare repos standing in for GitHub, a clone of each, and the CLI run as a child process against the dev server; its config folder in the temporary folder.
- **Docker:** the `docker` executor's tests stay unit tests against a fake engine (milestone 1's), plus the live tests gated on a Docker host, which this machine lacks.
- **Time:** the email delay, the coalescing window, the approval wait, the checks' timeouts, the nightly hour and the CLI session's expiry read the `Clock` port or a setting.

---

## 9. Every ticket's checks and commit

As milestones 1 and 2 (`../m1-first-pr/spec.md`, section 9). In short:
- `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for the touched packages, and `pnpm check:licenses` passes.
- Tickets that touch auth, credentials, the schema, the runner protocol, webhooks or anything that runs agent output (01, 02, 05, 06, 08, 09, 14, 15, 16, 17, 25, 29 to 33, 39, 50) run all the checks for the whole repo.
- Every new setting has a working default and its line in `docs/configuration.md`. A fresh install with only the required settings still works, with mail off.
- **Proof** (`AGENTS.md`; *changed 2026-11-21, the maintainer: "keep tests, drop extras"*): each condition of a row's "done when" has a test named with its key (`it("F-nnn/c1: ...")`) that exercises it through the real code path, and CI runs it. No break-it pass, no proof file. A condition only a live run shows (Linux, macOS, kind, the e2e workflow) waits for the launch-gate Proof run.
- No secret in the commit. Logs carry IDs and fields, never tokens, prompts, ticket text, comments, plans, check output, mail bodies or agent output. Member, PR and agent text is never interpolated into a shell command; a check's command is the environment's, run as a command line the admin wrote, never built from task text.
- A `package.json` change goes with its `pnpm-lock.yaml`. `resend` and `nodemailer` are already approved (ADR 0007); nothing else is added without the maintainer's yes.
- Stage only the ticket's own paths, a gitmoji message of at most 50 characters, no AI attribution, `git pull --rebase origin main`, `git push origin main`, retrying on a rejected push.
- The ticket file gets its `Status:` updated and a line under `## Comments` with the commit's hash.

---

## 10. What each ticket ports

| From | What | To (ticket) |
|---|---|---|
| `spikes/how-should-the-runner-drive-opencode/src/cases/steer-probe.ts` | the steer probe, run on every OpenCode bump | 02, 08, 31 |
| same, `src/cases/t7-permissions.ts` | the permission request, the reject that ends the turn, the re-prompt | 02, 08, 30 |
| same, `src/cases/t8-questions.ts` | the elicitation form and its answer | 02, 30 |
| same, `src/cases/t5-events.ts` (the plan half) | the plan from `todowrite` during a read-only turn | 08, 31 |
| `spikes/what-is-inside-a-box/src/snapshot/dockerfile.ts` | the generated Dockerfile | 14 |
| same, `src/snapshot/image-scan.ts` and its negative control | the scan for a setup secret before the image is used | 14 |
| `spikes/github-app-and-git-proxy/src/github/pr-flow.ts` | the PR's comments and the review shape | 09 |
| `spikes/live-stream-and-task-view/src/harness/checks-api.ts` | the watcher can't send; two members answer one approval and one wins | 19, 35 |

**Dependencies.** None new. `resend` (MIT) and `nodemailer` (MIT-0) were confirmed by the maintainer on 2026-11-19 (ADR 0007): Resend first, SMTP second. The diff renders without a highlighting library, and the email templates without a template library (ADRs 0050, 0051). The device-code grant reuses milestone 1's better-auth setup.

---

## 11. Choices this spec makes

The maintainer delegated every decision of this spec on 2026-11-19 ("continue working on everything throughout the night"). Each choice below is the recommendation applied, recorded in `context/open-questions.md` under its number and, where it's hard to reverse, in an ADR. If the maintainer disagrees with one, it moves back to the open list and the ticket that holds it changes.

1. **A second member for development** (Q165). Invites are milestone 4, so the demo and the tests seed one: `pnpm dev:seed-member <username>` creates an account and a membership through the same code the first admin's seed uses. It refuses to run unless `NODE_ENV` is `development` or `test`, and the production build doesn't include the script. It's a test tool, as milestone 2's script creating tickets is.
2. **Approval rules** (Q166, ADR 0049). A rule names a tool (`edit`, `execute`, `fetch`, `mcp`) and a match (a path glob, command prefixes, "a command outside this allowlist", or anything). The panel offers four presets, "Adding a dependency", "Writing a migration", "Commands outside an allowlist" and "Reaching the network", each editable, and custom rules. The adapter maps them to the agent's own "ask" settings, and the runner checks every request against them too. A rule is a person in the loop, not a wall: a shell can write a file the edit rule watches, and the docs say so (ADR 0031).
3. **"Approve for this task"** (Q167, ADR 0049). The task rule is the request's tool and its subject narrowed to a pattern: the exact path for a file; the program and its first argument for a command (`pnpm add`, with any further arguments); the host for a URL; the tool's name for an MCP call. The card shows the pattern before the member presses it.
4. **Who answers a question** (Q168, ADR 0049). The driver, like a message. Approvals stay any member's (F-026). A member who isn't the driver sees the question and "Take over to answer".
5. **Plan first** (Q169, ADR 0049). Only the task's first turn, and a turn whose profile has it on. Plan mode reads and searches and never writes or runs a shell. The plan is the agent's plan entries plus its last message. Three answers: "Approve plan", "Edit and approve" (the edited text becomes the plan), "Ask for changes" (another plan turn).
6. **MCP servers and skills** (Q170, ADR 0049). An HTTP MCP server is reached through the sidecar's MCP proxy, which adds its secret headers, so the agent sees a sidecar address and no credential. A stdio server runs a command already in the image, with variables that hold no secret. A skill is its `SKILL.md` text and up to 20 files of at most 1 MiB *(working values)*, written where the agent reads skills in the task's own config folder, never in the repo.
7. **The profile over the repo** (Q171, ADR 0049). The adapter makes the profile's permissions and MCP list win over a repo's own agent config, and its contract suite proves it with a repo config that allows everything. An agent that can't guarantee that declares `projectConfigOverride: false`, and the runner then hides the repo's agent config files from the agent for the task.
8. **Notifications** (Q172, ADR 0050). Three channels in milestone 3: the panel (always on), the ticket (on by default, for tasks with a ticket) and email (when set up). Until reviewers exist, "a PR ready for review" goes to the driver. On the ticket: one new comment per moment, so the tracker notifies, mentioning the audience's tracker users matched by email; within 10 minutes *(working value)* a later moment edits the last comment instead.
9. **Email** (Q173, ADR 0050). Set per install by the instance admin, in the panel or by settings (which lock the panel). Resend first, SMTP second, one at a time. A mail waits 2 minutes *(working value)* and isn't sent if the member read it in the panel or the item closed. It carries the organization, the project, the task's title and key, the moment, one line about it and a link: never ticket text, agent output, diffs or check output. No action buttons that answer from the mail: every answer is made signed in.
10. **Email templates** (Q174, ADR 0050). ostra's own pure renderers in `packages/domain`, HTML with inline styles and a text part. No template library.
11. **The diff** (Q175, ADR 0051). From the code host's compare of the pushed branch, cached by base and head, shown "as of the last turn". ostra's own unified-diff view with no syntax highlighting in milestone 3. Over 300 files or 1 MiB a file *(working values)*, the panel links to the code host.
12. **Diff comments** (Q176, ADR 0051). Drafts per member until sent; anchored by repo, path, side, line and head; outdated, not moved, when the line changes. Sending follows the composer's rule.
13. **`ostra login` and `ostra checkout`** (Q177, ADR 0051). A CLI session is its own credential, made by a device-code grant, valid 30 days *(working value)*, listed and revocable in "Account". It reads branch names and clone URLs and nothing else. `ostra checkout` uses the member's own git access, finds clones by remote, and refuses a dirty tree.
14. **Checks** (Q178, ADR 0052). After every turn with changes, before the push. A failure doesn't stop the push: the PR is a draft, or becomes one, and the panel offers "Ask the agent to fix". When every check passes again, a PR ostra made a draft is marked ready; one a person made a draft stays one.
15. **Update branch** (Q179, ADR 0052). A merge of the base into the branch, never a rebase, so no push is forced.
16. **After the merge** (Q180, ADR 0052). The fresh branch is the old name with `-2`, `-3`; every PR is kept in `TaskPullRequest`; the new PR links the same ticket.
17. **A ticket closed while its task runs** (Q181, ADR 0052). The turn is interrupted, and the work so far is saved as after any turn. "Stop the task" or "Keep working" ("Carry on where you stopped.").
18. **`@ostra`** (Q182, ADR 0052). Issue comments and line comments on the task's PRs. A comment while a session is going waits for the turn's end. A comment from anyone not linked, or not able to open the project, is dropped without a reply, so an outsider learns nothing.
19. **The verified link** (Q183, ADR 0052). On the account, not the membership: one GitHub identity per person across organizations, unique per install. The OAuth token is revoked before the callback returns. The App's callback URL list gains the link's callback; a new App gets it in its manifest, and an existing one needs it added once (ticket 51).
20. **Snapshots and services on `docker` and `host`** (Q184, Q185, ADR 0038 amended). On `docker` with no registry, the runner that builds a snapshot keeps it, and a box on another runner builds its own or falls back to the full setup. On `host`, a per-project repo mirror and a dependency cache folder stand in for the image. A task whose environment has services is offered only to runners whose executor declares `services`, and waits with the reason otherwise.

**Added 2026-11-19, while preparing the build** (the decisions sit in each ticket's `## Decided 2026-11-19`; Q186 to Q190):

21. **Email without a Resend key** (Q186). Resend is proved on a fake of its API; SMTP with the real adapter against the `node:net` server run in the test. The live Resend send and the SMTP relay case wait for the key (ticket 51), and until then the scripted demo mails through a local SMTP server.
22. **`@ostra` needs the App's webhook** (Q187). Nothing polls PR comments. An App without a webhook never sees a comment, and the docs say so.
23. **Checks and repos** (Q188). A check that names a repo runs on a turn that changed that repo, in its folder; one that names none runs once, at the workspace root. A repo's PR reads every check that applies to it.
24. **Archiving a profile a project defaults to** (Q189). Allowed; the defaults move to the built-in profile, whose access is always "everyone"; tasks keep the profile they started with; no restore in milestone 3.
25. **Where the shared rules and prompts live** (Q190). In `@ostra/protocol`, since the runner and the adapters are Apache-2.0 and can't import `packages/domain`.

---

## 12. Screens that need a design target

`build-order.md`: a milestone's screens are designed first, image first. The maintainer requires the `ui-taste` skill and Higgsfield targets, approved before building, against `context/brand/brief.md` and `context/brand/app-design.md`. **This spec names them; ticket 41 makes them,** in the form milestones 1 and 2's approved targets have (`context/brand/app-targets/m1/README.md`: a picture, a build spec and a prompt per screen). Until they're approved (recorded in ticket 41's `## Comments`), tickets 42 to 48 don't start their UI; their routers and tests can go ahead.

**New targets**, for what's new in milestone 3:

| # | Target | Screen | Feature | Starts from |
|---|---|---|---|---|
| 1 | `agent-profiles` | The organization's agent profiles: the list (name, agent, model, plan first, rules, who may use it, the projects that default to it), the built-in OpenCode profile, "New profile" | F-021 | `app-targets/m1/models` |
| 2 | `agent-profile` | One profile's editor: agent and model, instructions, skills, MCP servers (with secrets kept as "set"), approval rules with the four presets and custom rules, plan first, who may use it, archive | F-021, F-026, F-063 | `app-targets/m1/environment` |
| 3 | `task-approval` | The task page with approvals: the pending card naming the rule and the subject, "Approve once", "Approve for this task" showing its pattern, "Deny" with a reason; two approvals at once; the receipts (once, for this task, by a rule, denied, expired, cancelled); a question's form, and "Take over to answer" for a watcher | F-026, F-024 | `app-targets/m1/task` |
| 4 | `task-plan` | Plan first: the plan turn's marker, the proposed plan as "Needs you · plan", "Approve plan", "Edit and approve" with the plan editable, "Ask for changes", and the approved plan's receipt | F-063 | `app-targets/m1/task` |
| 5 | `task-changes` | The Changes tab: per repo, behind and ahead, "Update branch", the files with their counts, a unified diff, a line comment being written, drafts, "Send 3 comments to the agent", sent and outdated comments, a file too large to show | F-027, F-072, F-070 | `app-targets/m1/task` |
| 6 | `task-checks` | The Checks tab and the PR's check state: each check with its status, time and output, a failed check with "Ask the agent to fix", the draft PR's line | F-054 | `app-targets/m1/task` |
| 7 | `take-it-local` | "Take it local" on the task page: `ostra checkout OST-142` with copy, the plain git commands per repo, and the first-time hint for `ostra login` | F-028, F-103 | `app-targets/m1/task` |
| 8 | `needs-you` | The "Needs you" page, the panel's notification list: unread first, grouped by project, each with its reason, its task and an inline answer where one fits (approve, plan, question), and a "Done" tab | F-036, F-062 | `app-targets/m1/home` |
| 9 | `home-board` | Home's second view: the organization's tasks as a board grouped by state, with the project's colour square on each card | F-062 | `app-targets/m1/home` |
| 10 | `notification-settings` | A member's notification choices: each moment by channel (panel, ticket, email), the mail address, and "Mail is off on this install" | F-036, F-115 | `app-targets/m1/models` |
| 11 | `email-settings` | The instance's email: off, Resend or SMTP, their fields, the from address, "Send a test mail" with its result, and the locked state when settings set it | F-115 | `app-targets/m2/storage-settings` |
| 12 | `email-needs-you` | The needs-you mail, at a mail client's width, in light and dark: an approval's mail, with a plan's and a question's variants in the build spec, and its text part | F-115 | `app-targets/m1/sign-in` |
| 13 | `account` | The member's own Account page: the GitHub link (link, linked as `@login`, unlink), the CLI sessions with machine, last use and "Revoke" | F-119, F-103 | `app-targets/m1/runners` |
| 14 | `environment-services` | The environment's services (image, port, variables, health check, and their health on the last box), the checks list with order and timeouts, and the snapshot section (`docker`: state, built when, by which runner, rebuild; `host`: "worktree and dependency cache") | F-094, F-051, F-054 | `app-targets/m1/environment` |
| 15 | `phone-approval` | Answering an approval and a plan from "Needs you" at phone width | F-075, F-026, F-063 | `app-targets/m2/phone-task` |

**Screens that only grow**, built against their existing targets with the changes listed in the ticket that builds them:
- `app-targets/m1/task`: the watcher's read-only composer and "Sam is driving · Take over" bar, queued messages for everyone, the usage rows (F-084) in the properties panel, and the tabs Activity, Changes, Checks.
- `app-targets/m1/home`: the Needs you section live across the organization (F-062), as the target already draws it.
- `app-targets/m1/project`: the default profile per task kind (F-021).
- `app-targets/m1/task-new` and `app-targets/m2/inbox`: the profile picker, limited to the member's profiles (F-021).
- `app-targets/m1/device`: the code's purpose, "Sign in the ostra CLI on <machine>" next to the runner's wording (F-103).
- `app-targets/m2/task-reopen`: the fresh-branch marker after a merge (F-066), and the markers for a PR comment, diff comments and update branch.
- `app-targets/m2/task-limits`: the `ticket_closed` state with "Stop the task" and "Keep working" (F-066).
- The sidebar (`app-targets/m1/README.md`'s shell): "Needs you" with its count under the personal views, "Agent profiles" under Organization, and "Account" in the member menu.
