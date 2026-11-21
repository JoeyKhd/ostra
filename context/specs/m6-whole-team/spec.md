# Milestone 6: The whole team, and autonomy

**Status:** spec, 2026-11-19. Tickets in `issues/`, one file each (`docs/agents/issue-tracker.md`).
**Milestone:** 6 (`context/build-order.md`).
**Features:** F-011, F-106, F-107, F-012, F-040, F-077, F-099, F-100, F-101, F-102, F-035, F-105, F-113. It finishes rows earlier milestones left `building` for this one: F-010 (several at once), F-036 (the reviewer and refine-draft audiences), F-111 ("Remember this" on an AI finding) and F-048 (the schedule hunt). Its demo signs in as milestone 1's default first admin, and its second and third members arrive by milestone 4's invitations.
**Decisions it builds on:** ADR 0011 (nothing acted on before it's saved), 0013 (Linear's two modes, the fast lane, the heartbeat, who a stop comes from), 0025 (everything is an adapter), 0027 (several repos), 0028 (refine, code and review), 0030 (no credential in the agent's container), 0031 (outside tasks wait; refine and review only fetch; nothing automatic without a limit), 0035 (the event log), 0037 (pg-boss, and schedules on ostra's own table), 0038 (the environment and the onboarding task), 0040 (the App, the independent-review check), 0041 (the loops and their caps), 0044 (memory proposals), 0049 (profiles, approval rules), 0050 (notifications and their audiences), 0051 (the diff and its comments), 0052 (checks, `@ostra`, the verified link), 0055 (the budget gate). **New for this spec:** ADR 0056 (automations: intake rules, schedules and starting many), 0057 (starting from Linear, and tasks from outside), 0058 (the review loop: CI, AI review, rounds and reviewers), and amendments to 0013 (agent mode in practice), 0028 (refine and review in practice), 0038 (the onboarding task in practice) and 0040 (a "changes requested" reviewer stays independent).
**Spikes it ports from:** 5 (`linear-agent-mode`: the fast lane, the agent-session state, the heartbeat, the real-run harness), 8 (`durable-queue-choice`: the scheduler tick and the schedule hunt) and 10 (`is-opencode-good-enough`: the neutral reply to a question nobody is there to answer), section 10. Product code never imports `spikes/`. A builder copies the code into the product's package and adapts it, with a one-line provenance comment (`// Ported from spikes/<spike>/<path>.`).
**Builds on milestones 1 to 5** as they were built (`../m1-first-pr/spec.md` to `../m4-the-organization/spec.md`, and `../m5-the-fleet/spec.md` once it lands), not only as they were specified. Milestone 1 is done; 2 and 3 are being built; 4 is specced; 5 is being specced while this spec is written. Where their code ends up different from their specs, this spec follows the code, and the ticket that meets the difference says so in its `## Comments`. Where this spec names something milestone 5 owns (pools, pool labels, admission and the project's cap on a pool, the protocol's minor), it uses milestone 5's words as its spec settles them, and ticket 01 or the ticket that meets it records the reading.

Terms follow `context/GLOSSARY.md`. Lifecycles follow `context/domain-model.md`.

---

## 1. What milestone 6 ends with

Product people refine tickets. Rules and schedules start tasks. PRs arrive green and already reviewed by an agent, and a reviewer finds them under "needs you". Anyone in Linear hands a ticket to ostra (`build-order.md`).

In more words: a member starts a refine task on a vague ticket; its agent reads the code, never pushes, and hands in a typed draft that a member edits and writes back to the ticket, splitting it into sub-issues and marking it ready. Starting a code task on a ticket with sub-issues starts one task per sub-issue, and the parent's page follows them. A project admin writes intake rules that turn matching tickets into tasks, with a dry run that offers "Start all", and schedules that start work at set times, once per occurrence however many replicas run. A member starts many Inbox tickets in one action, through the same gates as one. Someone in Linear delegates a ticket to ostra's app, sees a live agent session, sends a follow-up or a stop from Linear; a person ostra can't match to a member gets a task that waits until a member of the project approves it. When a task's PR opens, ostra waits for CI; a failing CI goes back to the agent with its logs, at most twice; a green PR gets an AI review, posted on GitHub as comments, whose blocking findings go back to the agent, at most twice, with four automatic turns in all before a person must act. Then the PR waits for its reviewers, matched from GitHub's requested reviewers and CODEOWNERS, on a review screen with the ticket and the findings beside the diff. A reviewer's "changes requested" on GitHub reopens the task with that review. An onboarding task tests a project's environment by running it, proposes the corrected environment for a project admin to accept, and adds an `AGENTS.md` where a repo has none.

### What milestones 1 to 5 leave that milestone 6 starts from

Read from the code on `main` on 2026-11-19, and from milestones 2 to 4's specs for what they add, so builders don't rebuild what exists:

- **The schema already holds this milestone's nouns.** `Automation` (kind `intake_rule` or `schedule`, `taskKind`, `agentProfileId`, `poolLabels`, `filter` as JSON, `schedule` as a cron string, `enabled`) exists and nothing reads it. `TaskKind` is `refine`, `code` and `review`; `Task.reviewOfTaskId` links a review task to its code task; `TaskState` has `awaiting_approval` and `done`; `TaskSubState` has `ci_running`, `fixing_ci`, `ai_review`, `fixing_findings` and `waiting_for_reviewer`; `NeedsYouReason` has `draft_ready`, `round_cap`, `waiting_for_reviewer` and `environment_proposal`; `TaskStopReason` has `rejected`. A project has a default profile per task kind (Q28). None of them is set by any code path but the code kind's.
- **The git proxy already has a read-only mode** for refine and review tasks (`apps/runner/src/sidecar/git-proxy/git-proxy.ts`): it refuses every push, LFS upload and lock check. Nothing dispatches a task that uses it.
- **The tracker interface declares `agentSessions` and `subIssues`** (`packages/adapter-sdk/src/tracker/capabilities.ts`), and a ticket's context already carries its parent and children (milestone 2, F-064). No operation acts on either. Milestone 2's Linear app asks for the `AgentSessionEvent` webhook type in its manifest, and its scopes stop at `read`, `write`, `issues:create`, `comments:create`: agent mode re-authorizes with `app:assignable` and `app:mentionable` (milestone 2's spec, section 11, item 3).
- **The Linear app for `ostra-test` exists and has never been authorized.** `~/.config/ostra-dev/linear.env` holds `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`, the personal `LINEAR_API_KEY` and the test team's key and ID, and no `LINEAR_REFRESH_TOKEN` or app token: nobody has pressed Authorize, and the app refuses the client-credentials grant (`unauthorized_client`; milestone 2's ticket 40, `context/research/linear-app-token-without-consent.md`). Milestones 2 to 4 run on a connection seeded from the personal key, which can read and write tickets and **can't post an agent activity** (403, ADR 0013). So no part of agent mode can run against real Linear until the maintainer authorizes the app (section 3).
- **The sidecar has ostra's MCP server** with `set_pull_request_text` (milestone 1) and the three memory tools (milestone 4), behind a bearer that grants one task's tools, forwarding to core over the runner's HTTP with the task's token.
- **Milestone 3 leaves:** needs-you items with audiences (the driver, or the project's members), whose `reviewer` audience resolves to nobody and whose refine-draft owner is unbuilt (F-036 stays `building`); the panel, ticket and email channels; `@ostra` on the PR, which waits for a turn's end; checks before the PR, whose failure makes a draft and offers "Ask the agent to fix", with nothing looping by itself; the Changes tab with diff comments sent as one prompt; the verified GitHub link; the fixed prompts in `@ostra/protocol` (Q190).
- **Milestone 4 leaves:** the budget gate on every turn start, with the origin `automatic-round` already in its union and its test (F-037); `listReviews`, check runs and the `pull_request_review` webhook in the code host interface, and the `ostra/independent-review` check (F-104); invitations, so the demo's members are real; memory proposals with "Remember this" on diff and `@ostra` comments (F-111 stays `building` for the AI finding).
- **Milestone 5 leaves** (as its spec is written in parallel): runner pools with labels, pool runners joining with a token, admission with the project's cap on a pool (F-067) and the choice of a runner by labels and box size (F-069), and the protocol's next minor. An outside task and an automation run "on one of the project's pools" through that admission, never on a personal runner.
- **`packages/jobs` has `schedule()` on pg-boss's own cron,** used for idempotent passes only. ADR 0037 (amended after spike 8) moves schedules that start work onto ostra's own `automation_run` table; nothing of that exists. Milestone 2's failure suite has no schedule hunt (F-048 stays `building`).

### What is in, and what is not

**In:** intake rules with filters by label, status, assignee, board and the tracker's project, a dry run with "Start all", an hourly limit per rule; schedules that check a rule's filter or start a prompt task, on ostra's own occurrences, with the missed-occurrence rule and pause, edit and delete; starting many Inbox tickets at once; sub-issues as one task each, with the parent's page and its progress comment; Linear agent mode (the re-authorization, "Start from Linear" per board, the fast lane, the session's activities, the heartbeat, follow-ups and stops from Linear, a stop from the panel); outside tasks waiting for a member's approval; refine tasks with the draft tool, the draft editor, images, "Update ticket", sub-tickets, "Mark ready" and "Create ticket"; CI on the task's PRs with its logs and the fixing rounds; the AI review task, its findings on GitHub, the fixing rounds and the four-turn cap; reviewers from requested reviewers and CODEOWNERS, their needs-you and mail, the review screen with "Fix this" and "Remember this"; "changes requested" reopening the task; the onboarding task with its environment proposal and its `AGENTS.md` PR; the schedule hunt in the failure suite.

**Not in** (and when it comes):
- a refine or a review started from Linear: agent mode starts code tasks only in v1 (Q215). A member starts refine from the panel or the Inbox
- reviewing PRs people wrote: F-123, after v1. The review kind already allows a PR as its source
- every PR or ticket comment reaching the agent: F-034's remainder, later. Only `@ostra`, a linked member's "changes requested" and the panel's own actions reach it (ADR 0041)
- screenshots of the running app in a refine draft: F-121, after v1. Members upload their own images
- ordering sub-issue tasks by Linear's "blocked by" relations: they start together (Q213)
- expanding a GitHub team in CODEOWNERS into its members: the App asks for no `members` permission (Q226)
- `workflows: write`: an agent still can't change CI (ADR 0040, Q122), so a fixing round can't fix a workflow file
- Jira itself: F-008, after v1. Every tracker operation of this milestone runs against the Jira fake too
- Claude Code: F-018, after v1 (it was milestone 7 until 2026-11-19). Every agent-facing change is proved against OpenCode and the scripted fake agents

### On this machine

The same adjustment as milestones 1 to 4: the demo runs on the `host` executor, here as a personal runner and a pool runner on `host` (the admin's opt-in, ADR 0031, milestone 5), and a "box" is a worktree. What needs more than that:
- **Linux with Docker:** the onboarding task's box "built from the base image" and its services (F-113), and the refine and review tasks' read-only git proxy on the box network. The `docker` share is unit-tested against the fake engine and joins F-017's live run on the Linux machine; F-113 stays `building` until it has run.
- **Kubernetes:** milestone 5's cluster tests gain a refine task and a review task (the read-only proxy in the pod's sidecar). No row of this milestone waits on it alone; they wait with milestone 5's `kubernetes` rows.
- **macOS:** nothing of this milestone is specific to it.
- **Real Linear's agent mode:** needs the maintainer's Authorize click and a person pressing "Send stop request" (section 3). Without them F-012 stays `building`, with every condition the fake can prove proved.

---

## 2. The features, and where each one lives

"At M6's end" is the ledger status the demo ticket (39) sets, if and only if every condition in the row's "done when" holds.

| F-ID | What milestone 6 builds | Packages | Tickets | At M6's end |
|---|---|---|---|---|
| F-011 Intake rules | Rules per project: a filter (labels, status, assignee, board, the tracker's project), a task kind, a profile, pool labels, "wait for approval" (off); acting when a ticket starts to match, once per ticket per rule; a dry run of the current matches with "Start all"; 20 starts an hour, then the rule pauses itself (ADR 0056) | `packages/db`, `packages/domain`, `apps/core`, `packages/api`, `apps/web` | 05, 06, 11, 24, 31 | done |
| F-106 Schedules | A cron expression and a time zone on an automation, evaluated by ostra's own code; one scheduler tick a minute inserting each due occurrence in `automation_run` with its job; a rule's filter checked, or one prompt task started, per occurrence; "skip while the last one is open"; the 6-hour missed rule; pause, edit and delete at the next tick; the schedule hunt (ADR 0037, ADR 0056) | `packages/jobs`, `packages/domain`, `apps/core`, `packages/api`, `apps/web`, `e2e/m2-failure-suite` | 05, 06, 10, 24, 31, 37 | done |
| F-107 Start many at once | Select up to 50 Inbox tickets and start them in one action, or "Start all" from a dry run; each ticket in its own transaction, idempotent per request and ticket; each start through admission, the project's cap on a pool and the budget; a result per ticket (ADR 0056) | `packages/db`, `packages/domain`, `apps/core`, `packages/api`, `apps/web` | 05, 06, 11, 25, 32 | done, if milestone 5's admission (F-067) is in; otherwise `building` for its pool cap |
| F-012 Start from Linear | "Turn on agent mode" re-authorizes with the agent scopes; "Start from Linear" on one board per team; delegations and mentions through the fast lane (claim, 200, first thought from the server); the session's state in Postgres; ostra's activities from an outbox; the 20-minute heartbeat; follow-ups and stops from Linear; a stop from the panel; the token's rotation (ADR 0013 amended, ADR 0057) | `adapter-sdk`, `adapter-linear`, `packages/db`, `packages/domain`, `apps/core`, `packages/api`, `apps/web`, `e2e/m6-linear-agent-mode` | 02, 05, 06, 07, 13, 26, 33, 38 | done, if the maintainer authorizes the app and presses "Send stop request" in the manual run (ticket 40); otherwise `building`, with every condition the fake proves `proved` |
| F-040 Approval for outside tasks | A task started by a tracker user ostra can't match to a member who can open the project waits in "Needs approval" on the project's default profile for its kind, on a pool; any project member approves or rejects; on by default, switched off per project by an organization admin (ADR 0057) | `packages/db`, `packages/domain`, `apps/core`, `packages/api`, `apps/web` | 05, 06, 14, 26, 33 | done |
| F-077 Sub-issues | A code start on a ticket with open sub-issues starts one task per leaf on the project's boards, up to three levels and 50 tasks; the parent never runs code; its page and its progress comment follow the children (ADR 0056) | `adapter-sdk`, `adapter-linear`, `packages/domain`, `apps/core`, `packages/api`, `apps/web` | 02, 06, 07, 12, 25, 32 | done |
| F-099 Refine tasks | The built-in read-only Refine profile; refine tasks from the Inbox, a ticket, a prompt or a rule; `submit_draft` on the sidecar's MCP server; drafts versioned per turn; "Draft ready" for the draft's owner; the editor with images; "Update ticket" (description sections, images as attachments, sub-tickets as sub-issues), "Mark ready" through the board's new "ready" status, "Create ticket" for a prompt; no push of any kind (ADR 0028 amended) | `packages/protocol`, `adapter-sdk`, `adapter-linear`, `adapter-opencode`, `packages/db`, `packages/domain`, `apps/core`, `apps/runner`, `packages/api`, `apps/web` | 01, 02, 05, 06, 07, 09, 15, 22, 27, 34 | done |
| F-100 AI review | The built-in read-only Review profile; one review task per code task, reopened on each round's heads; `submit_review` with typed findings; one comment-type review per PR, lines in the diff as line comments and the rest in its body; never an approval or a change request; on by default, switched off per project (ADR 0058) | `packages/protocol`, `adapter-sdk`, `adapter-github`, `packages/db`, `packages/domain`, `apps/core`, `apps/runner`, `packages/api`, `apps/web` | 01, 03, 05, 06, 08, 09, 17, 22, 28, 35 | done |
| F-101 Review rounds | Blocking findings to the coding agent as one prompt, at most 2 rounds; nits listed only; 4 automatic turns with the CI rounds, counted since a person last acted; every automatic turn through the spend cap and the budget gate; the cap's needs-you; the fixed neutral reply to a question in an automatic turn (ADR 0041, ADR 0058) | `packages/protocol`, `packages/domain`, `apps/core`, `apps/runner`, `adapter-opencode`, `packages/api`, `apps/web` | 01, 04, 06, 09, 18, 23, 28, 35 | done |
| F-102 Review screen and reviewers | The review screen: each PR's diff with a file tree, the ticket with its acceptance criteria, the findings inline with "Fix this" and "Remember this", line comments as one prompt; reviewers from requested reviewers and CODEOWNERS, matched by the verified link; their needs-you and mail; approving and merging on GitHub (ADR 0058) | `adapter-sdk`, `adapter-github`, `packages/db`, `packages/domain`, `apps/core`, `packages/api`, `apps/web` | 03, 05, 06, 08, 19, 28, 35 | done |
| F-035 Fix failing CI | CI read from the code host's check runs and commit statuses on the PR's head, ostra's own left out; none within 2 minutes is "no CI"; a failure reopens the task with the failing checks and their log tails as files, at most 2 rounds; then needs you (ADR 0041, ADR 0058) | `adapter-sdk`, `adapter-github`, `packages/db`, `packages/domain`, `apps/core`, `apps/runner`, `packages/api`, `apps/web` | 03, 05, 06, 08, 16, 18, 23, 28, 35 | done |
| F-105 "Changes requested" reopens the task | A `changes_requested` review from a linked member who can open the project reopens the task with the review's body and line comments as one prompt, after the running turn; no round cap; the spend cap and the budget apply; no co-author trailer for the reviewer (ADR 0040 amended, ADR 0058) | `adapter-sdk`, `adapter-github`, `packages/domain`, `apps/core` | 03, 06, 08, 20 | done |
| F-113 Onboarding task | "Test this environment" starts a code task from a built-in template on the detected draft, in a box from the base image; it runs the setup, the services and the checks; `propose_environment` hands in the corrected environment, which a project admin accepts, edits or rejects; only `AGENTS.md` is committed, in each repo that lacks one (ADR 0038 amended) | `packages/protocol`, `packages/db`, `packages/domain`, `apps/core`, `apps/runner`, `packages/api`, `apps/web` | 01, 05, 06, 21, 23, 29, 36 | building: the box from the base image and its services need `docker` on Linux. The `host` half is proved |

**Rows this milestone finishes** (left `building` by earlier milestones for this one):
- **F-010 Ticket inbox:** several at once is F-107 (tickets 25, 32). `done` with F-107.
- **F-036 Notifications:** the reviewer audience (19) and the refine draft's owner (15) resolve, on every channel. `done`, if milestone 3 left only these two.
- **F-111 Memory proposals:** "Remember this" on an AI review finding (28, 35). `done`.
- **F-048 Failure tests:** the schedule hunt (37). `done`, if milestone 2 left only the hunt.

**Rows this milestone touches without finishing:** F-064 (ticket context) gains the accepted refine draft's acceptance criteria in a code task's prompt, and needs no new status. F-031 (ticket sync) gains the parent's progress comment, with no new status. F-017's live run on Linux gains a refine, a review and an onboarding task.

**Built in from the first milestone** (`build-order.md`), checked again by ticket 39:
- Organization-scoped data: every new row carries `organizationId`, every project record `projectId` with the composite key (05). Milestone 4's generated isolation test covers every new model, and fails until each has its fixture.
- The event log and the durable queue: a ticket match, an occurrence, a bulk start's item, a Linear webhook, an agent activity, a draft, a CI result, a review, a round, a reviewer's request, an approval of an outside task and an environment proposal each are saved before they are acted on, and acted on from the queue (10 to 21).
- No credential in the agent's container: the draft, review and environment tools reach core through the sidecar with the task's token (22, 23); CI logs reach the agent as files core fetched with the App's token (16, 23); the Linear app's token never leaves core (13).
- ACP as the only way to talk to an agent: the fixed neutral reply answers an ACP elicitation (09, 23).
- Strict typing, dark first, responsive, English text in message files: as milestones 1 to 4.

---

## 3. The end-to-end demo

Ticket 39 runs it and records the result under its `## Comments` and in `demo.md` next to this spec. Everything runs against the Linear workspace `ostra-test` (team `OST`) and the GitHub org `ostra-test` (repos `test1` and `test2`). Secrets come from `~/.config/ostra-dev/` with `set -a; . ~/.config/ostra-dev/<file>; set +a`, and are never printed, logged or committed.

**Two runs, and what each can reach.** The scripted run (`pnpm e2e:m6`) runs every step it can without a person. The manual run, once, in real browsers, adds what only a person can do.

**Linear's app token.** Agent mode posts activities with the app's own OAuth token, and a personal key is refused (ADR 0013). No app token exists today (section 1). So:
- **The maintainer's one click** (ticket 40, step 1): on "Connect Linear", "Turn on agent mode" sends them to Linear's consent page with `actor=app`, the agent scopes and PKCE; they press Authorize. ostra stores the tokens; the maintainer also saves the refresh token as `LINEAR_REFRESH_TOKEN` in `linear.env`, so the scripted run can seed the connection with `credentialKind: app_oauth`. Each scripted run rotates it and writes the new one back to `linear.env` (`e2e/m6-whole-team/linear-token.ts`, never printed), since a refresh token is single use.
- **Without `LINEAR_REFRESH_TOKEN`,** the scripted run seeds the connection from `LINEAR_API_KEY` as milestones 2 to 4 do, runs steps 9 and 10 against the fake Linear server only, marks them `skipped: no app token` in its report, and every other step runs as written. F-012 then stays `building`.
- **A person's stop:** "Send stop request" can only be pressed in Linear's interface (ADR 0013). The manual run does it in step 10; the scripted run proves the stop on the fake.

**Deterministic loops.** A real model doesn't fail CI or write a blocking finding on cue. So:
- **CI fails on a marker.** `test1`'s workflow (ticket 40, step 3) fails when a changed file under `docs/` holds the text `TODO-CI`, and its log says so. Step 5's ticket asks for that placeholder. If the agent's first push passes anyway, the script pushes one commit adding the marker with the test token, as a person might, and records that it did.
- **The scripted run's reviewer is a stub.** Its project's review profile uses milestone 1's stub model endpoint (`@ostra/adapter-sdk/testing`'s stub models), scripted so OpenCode calls `submit_review` with one blocking finding in the first review and none in the second. The manual run uses the real model in `model.env` for both agents, and records what the review found.

**Before:** a fresh clone, `pnpm install`, `pnpm dev:reset`, `tunnel.env` loaded so core has a public address, and `pnpm dev`. Milestones 1 to 5's setup is done by their scripts' helpers: a model provider from `model.env`, the test App (with ticket 40's new events), the Linear connection (above), projects `test1` (repo `test1`, board `OST`) and `test2` (repo `test2`, board `OST`), a personal runner on `host` and a pool `default` with one pool runner on `host` (the admin's opt-in) listed by both projects, and the maintainer's GitHub user linked to Demo. The panel signs in as the **default first admin, `demo@demo.com` / `demo`**; the scripted run sets `OSTRA_ALLOW_DEFAULT_PASSWORD=true` and `OSTRA_SCHEDULE_MIN_INTERVAL_MINUTES=1`. Sam joins by invitation (milestone 4's flow, the mail sink in the scripted run) as a member of both projects, and the reviewer user of `GITHUB_TEST_REVIEWER_TOKEN` is linked to Sam (`pnpm dev:link-github sam <login>` in the scripted run, the App's OAuth in the manual one). AI review is on in `test1` (the default) and off in `test2`, so the loops run in one place.

1. **The built-in profiles.** Organization, "Agent profiles" lists "Refine" and "Review" beside milestone 3's built-in profile, each marked read-only, each on the organization's default model. `test1`'s settings show them as its defaults for the refine and review kinds, and its "Review" settings show AI review on, 2 CI rounds, 2 review rounds and 4 automatic turns.
2. **A refine task.** The script creates a ticket in `OST`: "Users want to see the version somewhere." Demo opens `test1`'s Inbox and starts it as a **refine** task. The session reads the repo; the event log shows no push and no attempt at one, and the git proxy's log shows only fetches. The agent calls `submit_draft`: a description, acceptance criteria, edge cases, open questions and two sub-tickets. Demo's "Needs you" shows "Draft ready", and the mail sink has the mail (no draft text in it). Demo opens the draft: edits one acceptance criterion, uploads `e2e/m6-whole-team/fixtures/version-mock.png`, and presses "Update ticket": the ticket's description in Linear has the sections, the image is attached, and two sub-issues exist under it, each with its own text. Then "Mark ready": the ticket moves to `OST`'s "Todo", which the board's mapping drafted as "ready". The refine task is done.
3. **Sub-issues.** Demo starts the parent ticket as a code task from the Inbox. The start sheet says "This starts 2 tasks, one for each sub-issue". Two tasks start; the parent has none. The parent's page lists both children with their states and PRs, and the parent's progress comment in Linear lists them too. Each child's prompt holds its own text and the parent's accepted acceptance criteria. Both reach review (their PRs go through step 5's loop in `test1`; the script waits for each to reach "waiting for a reviewer", then closes both PRs so the rest stays short).
4. **Many at once.** The script creates four tickets in `OST` ("Add the line `bulk-1` to `NOTES.md`", up to `bulk-4`) and starts `bulk-4` by itself. In `test2`'s Inbox Demo selects all four and presses "Start 4 tasks": three start, and `bulk-4` shows "skipped: it already has a task". Every started task passed admission on the pool; with the pool's cap at 2 (milestone 5), one waits queued with its reason until a place frees.
5. **Fix failing CI.** The script creates a ticket in `OST`: "Add `docs/ci-demo.md`, a short note on how CI runs here, ending with a line `TODO-CI` as a placeholder." Demo starts it in `test1`. The PR opens; the task's sub-state is "CI running"; `test1`'s workflow fails ("docs/ci-demo.md:… placeholder TODO-CI isn't allowed"). The task moves to "fixing CI, round 1 of 2": the agent's prompt names the failing check, and the check's log tail is in the task's config folder at `ci/<check>.log`. The agent removes the marker and pushes; CI passes.
6. **AI review and a round.** The review task starts on the PR's head, on the Review profile, in its own worktree, read-only. It calls `submit_review`. On GitHub the PR has one review from the App of type "Commented", with the findings on their lines; its event is `COMMENT`, never an approval or a change request. In the scripted run the stub's blocking finding sends the coding agent into "fixing findings, round 1 of 2"; it pushes; CI passes; the review task reopens on the new head and finds nothing blocking. In the manual run, whatever the real model found is recorded. The task page shows each round in the thread, the automatic turns used ("2 of 4"), and the sub-state "waiting for a reviewer".
7. **Reviewers and the review screen.** `test1`'s `CODEOWNERS` (ticket 40, step 4) names the reviewer user, so GitHub requested their review. The task's reviewers list Sam, matched through the verified link. Sam's "Needs you" shows "Waiting for your review", and Sam has the mail. Sam opens the review screen: the PR's diff with its file tree, the ticket with its acceptance criteria beside it, and the AI's findings inline, the fixed blocking one marked resolved and any nit open. Sam presses "Remember this" on a finding: `test1`'s Memory shows a proposal with the finding as its source. Sam writes a line comment ("Say which workflow file runs CI") and presses "Send to agent": one prompt, the task reopens, pushes, and the loop runs again (CI, review, waiting for a reviewer).
8. **"Changes requested".** The reviewer user submits a GitHub review with "Request changes", a body and two line comments, with `GITHUB_TEST_REVIEWER_TOKEN`. The task reopens after its running turn with that review as one prompt; the thread says "Changes requested by Sam on GitHub". The agent pushes; CI passes; the AI review finds nothing blocking; the task waits for a reviewer again. No commit on the branch has a trailer for Sam. The reviewer approves: `ostra/independent-review` passes ("Approved by Sam"), since Sam drove nothing. The script merges the PR with the test token; the task is merged; the ticket moves to done.
9. **Intake rules and schedules.** In `test2`, "Automations", Demo creates an intake rule "Label ostra-auto": label `ostra-auto`, kind code, the project's default profile, no pool labels. The script has created two `OST` tickets with that label beforehand: the dry run lists them, and "Start all 2" starts both. The script creates a third ticket with the label: within a minute a task starts for it, "Started by the rule Label ostra-auto". It removes the label and adds it again: nothing more starts. Demo creates a schedule "Every 2 minutes": cron `*/2 * * * *`, time zone `Europe/Amsterdam`, kind code, prompt "Append the current UTC time to `schedule-log.txt`", "skip while the last one is open" on. The first occurrence starts a task; the next one, while that task is still open, is recorded as "skipped: the last task is still open" in the rule's history. Demo pauses the schedule: no task starts at the next occurrence. The script stops core for five minutes and starts it again with the schedule resumed: one occurrence starts, for the latest due time, and the history shows the others as missed. With `LINEAR_REFRESH_TOKEN` loaded, the rule's third ticket arrived by webhook; without it, by polling within 60 s.
10. **Start from Linear, and an outside task** (with the app token; the fake Linear otherwise). Demo opens "Connect Linear": agent mode is on, with the app user and the scopes `app:assignable` and `app:mentionable` shown. On `test2`'s board `OST` Demo turns on "Start from Linear". `OST` tickets now offer ostra as a delegate.
    - The script creates a ticket delegated to ostra's app user with the personal key. Within 10 seconds the ticket's agent session shows a thought: "Waiting for a member of test2 to approve this task in ostra". The key's Linear user matches no member (Demo's address is `demo@demo.com`), so it's an outside task: `test2`'s "Needs approval" lists it, "Started in Linear by <name>, not a member", with the project's default profile and the pool it will run on. Sam approves it. It runs on the pool runner, never the personal one; the session shows "Working on it in ostra", an action for the PR it opened, and a final response with the PR's link, in ostra's own words.
    - Demo invites the key's Linear user's address as a member (milestone 4). The script delegates a second ticket: it matches that member, so it starts at once. While it runs, the script replies in the session's thread with a follow-up: the thread in ostra shows it as that member's message after the running turn. The task's next turn answers it.
    - **The manual run only:** on a third delegated ticket, while its turn runs, the maintainer presses "Send stop request" in Linear. ostra stops the turn, posts one final response, and the task is stopped; the audit log says who stopped it in Linear.
    - On a fourth, Demo presses Stop in ostra's panel: ostra posts the final response with the app's token, saying it was stopped in ostra.
    - Ticket 38's harness (run once, with the app token, in a project `agent-mode-load` whose outside approval is on): 50 tickets delegated 250 ms apart, each acknowledged within 5 s with the durable insert and the tunnel in the path, measured on this machine's clock from the delegation's API response to the 200, and each with a first thought within 10 s, with no runner online; then all 50 rejected in one action, each session ending with a final response. A 35-minute turn with no post but the heartbeat stays alive with one ephemeral heartbeat, and Linear never shows it stale.
11. **The onboarding task.** `test2`'s environment has milestone 1's detected draft. Demo presses "Test this environment": an onboarding task starts from the built-in template. It runs the setup script and the checks (no services: `host` declares none, and the task page says so), changes what fails, and calls `propose_environment`. `test2`'s environment shows "Proposed by the onboarding task", a diff per repo of the setup script, checks and variable names; Demo presses "Accept", and the environment is saved as a new version. `test2` has no `AGENTS.md`: the task opens one PR that adds only `AGENTS.md`, and the thread says which other changes it didn't commit.
12. **Budgets hold the loops.** Demo sets `test1`'s budget to just under its month's spend (milestone 4). The script pushes a `TODO-CI` commit to a new task's PR in `test1`: the CI round is held, "Held: test1's budget for November is reached", and the task's sub-state stays "fixing CI" with the hold shown. Demo raises the budget: the round starts.

**The checks after the run** (ticket 39 scripts what it can, in `e2e/m6-whole-team/`):
- **Nothing leaked.** The Linear app's access and refresh tokens, the webhook secret, the task tokens, the GitHub tokens and every CI log's text appear in no log line, no event and no worktree but the task's own `ci/` files (searched by value, never printed). No agent activity in Linear holds agent output, a tool's input, a plan or a draft's text: each is matched against ostra's own message templates.
- **Refine and review never push.** Every git proxy request of every refine and review task was a fetch; a scripted push from a refine task's shell is refused before a byte reaches GitHub, and so is one for its hidden ref (F-099, F-100).
- **The review agent never approves.** Every review the App posted has the event `COMMENT` (F-100).
- **The caps.** On the fake code host with the stub reviewer: two failing CI rounds then needs you; two blocking review rounds then needs you; CI, review, CI, review as four automatic turns, then needs you with "4 automatic turns"; a member's message resets the count; a question in an automatic turn gets the fixed reply and the turn carries on (F-035, F-101).
- **Rules and occurrences start once.** A replayed ticket webhook, a poll and the webhook for the same change, and a second scheduler each start nothing twice; the schedule hunt of ticket 37 passes; a rule that reaches 20 starts in an hour pauses itself (F-011, F-106).
- **Bulk starts.** A replayed bulk request starts nothing twice; 51 tickets are refused with the limit; a budget at 100% leaves every started task queued with its reason (F-107).
- **Outside tasks.** An outside task never reaches a personal runner, never runs a profile other than the project's default for its kind, and starts nothing before its approval; with the project's switch off, it starts at once; only an organization admin can turn the switch off (F-040).
- **Linear's agent mode on the fake.** Spike 5's scenarios, ported: the ack under 5 s and the first thought under 10 s with no runner; a stop on another replica stops the turn; the heartbeat after 20 minutes of silence and none while posts flow; a replayed `created` webhook starts one task; an unmatched user's follow-up gets a thought and reaches no agent (F-012).
- **Sub-issues.** A three-level tree starts only its leaves; a child on no board of the project is listed, not started; 51 leaves are refused with the limit (F-077).
- **Clean-up:** the demo's tickets archived in `OST`, its PRs closed, branches and hidden refs deleted, `test1`'s branch protection as it was, the agent sessions ended, in `test1` and `test2` only.

---

## 4. How it fits together in milestone 6

```
 browser ──▶ apps/web: Automations, the rule editor and dry run, the Inbox's bulk start, the parent
                │       ticket, Linear agent mode, Needs approval, the refine draft, the review
                │       screen, the task's rounds, Review settings, the environment proposal
                ▼
             packages/api ──▶ Postgres: automations, automation runs, bulk starts, agent sessions
                │                       and activities, drafts, CI runs, review runs, findings,
                │                       rounds, reviewers, environment proposals
                ▼                                 ▲
 apps/core workers: scheduler.tick, automation.occurrence, intake.match, bulk.start-item,
                    linear.agent-event, linear.activity.send, linear.heartbeat, ci.evaluate,
                    round.start, review.start, review.post, reviewers.refresh, changes.reopen,
                    draft.apply, environment.propose
                │                                 │
 runner ──WS──▶ gateway        runner: read-only kinds, the review checkout, automatic turns,
   └─ sidecar: ostra MCP (PR text, memory, submit_draft, submit_review, propose_environment)
               ──HTTPS, task token──▶ /runner/v1/tasks/:id/{draft,review,environment-proposal}
 Linear ──webhook──▶ core: AgentSessionEvent (created, prompted), Issue changes
 core ──▶ Linear: agent activities, ticket text, sub-issues, attachments, status moves
 GitHub ──webhook──▶ core: check_run, check_suite, status, pull_request (review_requested),
                           pull_request_review (changes_requested)
 core ──▶ GitHub: comment-type reviews with line comments; reads check runs, statuses, job logs,
                  requested reviewers, CODEOWNERS, review comments
```

**The flows:**
- **An intake rule.** Milestone 2's ticket ingest (webhook or poll) upserts a ticket and, in the same transaction, enqueues `intake.match` for the ticket when any enabled rule of its board's project has no schedule. The job evaluates each such rule's filter against the cached ticket (pure, ticket 06) and, for a rule it matches, inserts `AutomationRun { kind: ticket_match, automationId, ticketId }` with `ON CONFLICT DO NOTHING`; only an inserted row starts a task, through the one start use case, with the rule as its origin. So a ticket starts at most one task per rule, ever: a member starts more by hand. The rule's hourly count is taken inside that transaction; the 21st start in an hour pauses the rule (`pausedReason: hourly_limit`), records the match as skipped and notifies the project's admins.
- **The dry run and "Start all".** `automations.dryRun` evaluates the filter over the board's cached open tickets and lists them with what each would do (start, skip: already has a task, skip: started by this rule before). "Start all" is a bulk start (below) with the rule as the origin of each task.
- **A schedule.** `scheduler.tick` runs once a minute (a pg-boss schedule, idempotent). It reads every enabled, unpaused automation whose `nextOccurrenceAt` is due, and for each inserts `AutomationRun { kind: occurrence, occurrenceAt }` with `ON CONFLICT DO NOTHING` and, in the same transaction, the job `automation.occurrence` keyed `automation:<id>:<ISO time>`, then advances `nextOccurrenceAt` by ostra's cron evaluator in the schedule's time zone. An occurrence more than 6 hours late is inserted as `missed` with an audit entry, and only the latest due one under 6 hours fires. `automation.occurrence` checks the rule's filter (starting each match not yet started by the rule, up to the bulk limit) or starts the schedule's prompt task, unless "skip while the last one is open" finds the previous occurrence's task still open.
- **A bulk start.** `inbox.startMany` (or "Start all") writes `BulkStart` and one `BulkStartItem` per ticket, then enqueues `bulk.start-item` per item keyed by the item. Each item runs the one start use case in its own transaction and records its outcome; the panel streams them. Admission, the project's cap on a pool and the budget act on each started task as on any other: a task that can't run yet is queued with its reason, not refused.
- **Sub-issues.** The start use case, for a code start on a ticket whose tracker declares `subIssues`, reads the ticket's tree through `getTicketContext` (milestone 2) to three levels, keeps the open leaves that are on one of the project's boards, and starts one task per leaf (each through the one-active-task index), with `parentTicketId` set. Over 50 leaves, nothing starts and the member is told. The parent gets no task. Milestone 2's tracker writer keeps one progress comment on the parent, edited as the children move.
- **Linear agent mode.** A delegation or a mention sends `AgentSessionEvent` `created`. Core's webhook route verifies the signature, claims the delivery ID and the signature hash in one insert (milestone 2's inbox) with its own deadline, answers 200, and enqueues `linear.agent-event`. That job writes the `AgentSession` row, resolves the board with "Start from Linear" on for the ticket's team, matches the session's creator to a member (ADR 0057), starts the task (outside or not) and, in the same transaction, writes the first `AgentActivity` (a thought), sent by `linear.activity.send` from the outbox with the app's token, idempotent by its key. Nothing in the path waits for a runner. A `prompted` event carries a follow-up or, with `signal: "stop"`, a stop: the stop is written to the task's state in Postgres and acted on by whichever replica holds the turn's lease; the follow-up from a matched member becomes a message after the running turn (`linear-follow-up`), and from anyone else a thought that says only members of the project can steer it. Each post to a session moves its `heartbeatDueAt` 20 minutes on; `linear.heartbeat`, a sweep once a minute, posts an ephemeral thought for each session due.
- **An outside task.** The start use case gives a task started by an unmatched tracker user the state `awaiting_approval`, the project's default profile for its kind, and `poolOnly`, when the project's `outsideApproval` is on. Its needs-you item has the project's members as audience. `tasks.approve` moves it to queued in one transaction with the audit entry; `tasks.reject` stops it with the reason `rejected`. Admission never offers a `poolOnly` task to a personal runner.
- **A refine task.** The dispatch gives the spec `kind: refine`, the git proxy's read-only mode, and the sidecar's `submit_draft` tool. The agent calls it; the sidecar forwards it to `POST /runner/v1/tasks/:id/draft`; core stores a new `RefineDraft` version and, at the turn's end, the task moves to needs you with `draft_ready` for the draft's owner (the driver, else the project's members). "Update ticket" and "Mark ready" are tracker writes in milestone 2's outbox: the description, the images as attachments (`attachments`), the sub-tickets as sub-issues (`subIssues`, or as linked tickets where the tracker lacks it), the move to the board's "ready" status; then the task is done. The runner pushes nothing for a refine task, not even its hidden ref.
- **CI.** A `check_run`, `check_suite` or `status` webhook on a task PR's head, a PR opening, and milestone 2's PR reconcile enqueue `ci.evaluate` keyed by the task repo and head (`singletonSeconds` 10). It reads the head's check runs and commit statuses through the code host adapter, leaves out ostra's own App's, and writes `CiRun` for the head: `pending`, `passed`, `failed`, `none` (nothing appeared within 2 minutes of the push) or `timed_out` (still pending after 60). For a task in review, the task's sub-state follows the combined result over its open PRs' heads.
- **A round.** `round.start` (keyed by task, kind and the head or review that caused it) checks the caps (ADR 0041: 2 CI rounds, 2 review rounds, 4 automatic turns since a person last acted), then the budget gate with origin `automatic-round`, then the spend cap, then starts a turn on the task with the round's prompt (`fix-ci` with the failing checks and the log files, or `fix-findings` with the blocking findings) and `automatic: true`. A cap reached moves the task to needs you (`round_cap`) for its driver; a closed gate holds the turn as milestone 4 does. The runner answers any question in an automatic turn with the fixed reply from `@ostra/protocol` and records it.
- **The AI review.** When CI is `passed` or `none` on every open PR of a code task in review, and the project's AI review is on, `review.start` reopens the code task's one review task (creating it the first time) on those heads: its spec carries `review { codeTaskId, round, repos: [{ repoId, prNumber, baseSha, headSha }] }`, and the runner checks each repo out at its head, read-only. The agent calls `submit_review` with typed findings; core stores the `ReviewRun` and its `Finding` rows; `review.post` posts one review per PR through `createReview` with the event `COMMENT`: each finding whose line is in the PR's diff as a line comment, the others in the review's body. The review task is done; blocking findings start a findings round; none moves the code task to "waiting for a reviewer".
- **Reviewers.** A `pull_request` `review_requested` or `review_request_removed`, a PR opening and the reconcile enqueue `reviewers.refresh` for the task repo: it reads the PR's requested users and teams, and the owners `CODEOWNERS` names for the changed paths at the base, maps each GitHub user to an active member through the verified link, and writes `TaskReviewer` rows. A task entering "waiting for a reviewer" writes a needs-you item whose audience is its matched reviewers, or its driver when none is matched (F-036).
- **"Changes requested".** Milestone 4's `pull_request_review` handler, for a `changes_requested` review from a GitHub user linked to an active member who can open the project, enqueues `changes.reopen` keyed by the review's ID. It reads the review's body and its line comments, saves them as one member message from that member with the intent `changes-requested` and the origin `changes-requested` for the gate, and starts the turn when the running one ends. No co-author trailer is added for it (ADR 0040, amended).
- **The onboarding task.** "Test this environment" starts a code task from the built-in onboarding template on the current environment, with the snapshot left out (a box from the base image), the sidecar's `propose_environment` tool, and `commitPaths: ["AGENTS.md"]`. The agent runs the setup, services and checks in its box and calls the tool; core scans the proposal for secret values (milestone 4's scan), stores an `EnvironmentProposal`, and writes a needs-you item (`environment_proposal`) for the project's admins. After every turn the runner commits only the allowed paths in each repo and records what it left out, so the only PR is the `AGENTS.md` one. "Accept" saves the proposal as the environment's next version in one transaction with the audit entry.

---

## 5. The contracts

Every contract change in milestone 6 is **additive**: a new optional field, a new union member, a new endpoint, a new table, column or enum value. Nothing is renamed or dropped (`AGENTS.md`). Each lands as one small commit that names the contract and updates every caller in the same commit. Tickets 01 to 06 make them first, each with the fakes its callers test against; everything else builds on them.

### 5.1 `packages/protocol`: the next minor (ticket 01)

- **The version.** The protocol goes one minor past milestone 5's: minor 5 if milestone 5 takes minor 4, as its spec is expected to; ticket 01 reads `main` and names the number. This spec calls it "minor 5". The window stays one minor either way, so a minor-4 runner still works: core offers it no refine, review or onboarding task (the dispatch note says why), and starts an automatic round on a fresh box of a minor-5 runner rather than on a minor-4 one. Everything else of milestone 6 is core's, and works on it unchanged.
- **Events, new members of the union:**
  - `question.auto_answered { questionId, reply }`: the runner answered an agent's question in an automatic turn with the fixed reply (Q160).
  - `commit.filtered { repoId, kept, dropped, droppedCount }`: an onboarding turn's commit kept only the allowed paths; `dropped` lists at most 50 paths.
  - Server-only, added to `serverOnlyKinds`: `automation.started { automationId, occurrenceAt | null }`; `task.approval_requested { by: { kind: "tracker-user", name } }`, `task.approved { memberId }`, `task.rejected { memberId, reason }`; `tracker.session_event { kind: "created" | "follow-up" | "stop", byName, matchedMemberId | null }`; `draft.submitted { draftId, version }`, `draft.applied { draftId, ticketKey, subTickets }`; `ci.updated { repoId, prNumber, headSha, state, failing: [{ name, conclusion }] }`; `round.started { kind: "ci" | "findings" | "changes-requested", number, automatic }`, `round.capped { kind, reason: "rounds" | "automatic-turns" }`; `review.submitted { reviewRunId, blocking, nits }`, `review.posted { reviewRunId, repoId, prNumber, url }`; `reviewers.updated { repoId, prNumber, memberIds, logins }`; `environment.proposed { proposalId }`.
- **Commands:** `steer` and `dispatch` gain `automatic: boolean` (false when absent); `user.message.intent` and `steer.intent` gain `fix-ci`, `fix-findings`, `changes-requested` and `linear-follow-up`.
- **The task spec, new optional fields** (a minor-4 runner gets the old shape, and no task that needs them):
  - `review: { codeTaskId, round, repos: [{ repoId, prNumber, baseSha, headSha }] } | null`: a review task's checkout, each repo at its PR's head, read-only.
  - `tools: ("pr-text" | "memory" | "draft" | "review" | "environment")[]`: which of ostra's MCP tools the sidecar serves this task; absent means milestone 4's set.
  - `commitPaths: string[] | null`: repo-relative paths (an exact path or a glob) the runner may commit; `null` means everything.
  - `automatic: boolean` on the spec's first turn, for a round that starts a fresh session.
  - CI logs travel as milestone 2's `contextFiles`, under the folder `ci/`.
- **Runner HTTP, new** (the sidecar on behalf of one task, with the task's token):
  - `POST /runner/v1/tasks/:taskId/draft { description, acceptanceCriteria, edgeCases, openQuestions, subTickets: [{ title, description }] }` → `{ draftId, version }`, or `{ code: "wrong-kind" | "invalid" | "limit-reached" }`
  - `POST /runner/v1/tasks/:taskId/review { summary, findings: [{ repoId, path, line, side: "new" | "old", severity: "blocking" | "nit", title, body, suggestion | null }] }` → `{ reviewRunId }`, or `{ code: "wrong-kind" | "invalid" | "limit-reached" | "not-in-review" }`
  - `POST /runner/v1/tasks/:taskId/environment-proposal { repos: [{ repoId, setupScript, checks, variableNames }], services, notes }` → `{ proposalId }`, or `{ code: "secret-found", found }`, `{ code: "wrong-kind" }`, `{ code: "invalid" }`
  - The refusals' words are what the tool returns to the agent.
- **The MCP tools' schemas** in `src/mcp/tools.ts`, Zod first, shared by the sidecar and core: `submit_draft`, `submit_review`, `propose_environment`, each with its description for the agent, and the draft, the finding and the proposal as strict objects.
- **The fixed prompts** in `src/agent/prompts.ts` (Q190): the neutral reply ("No one is available to answer. Use your best judgment, say what you assumed, and carry on."), and the framing lines of the `fix-ci`, `fix-findings` and `changes-requested` prompts, which wrap untrusted text as quoted data.
- **Limits** as named working values: a draft's description 32 KiB, 30 acceptance criteria, 30 edge cases, 30 open questions, 20 sub-tickets of 8 KiB each; 30 findings a review, a finding's body 4 KiB; a CI log tail 64 KiB, 5 checks a round; an environment proposal 256 KiB; 50 paths in `commit.filtered`.
- The schemas' descriptions say what's never logged: a draft's text, a finding's text, a log's text, a proposal's scripts.

### 5.2 `packages/adapter-sdk` (tickets 02 to 04)

**`TrackerAdapter`** (ticket 02), each operation implemented by Linear (07), by the Jira fake and by `test-adapters/tiny-adapters.ts` in the same commit:
- **Agent sessions** (capability `agentSessions`; Linear yes, the Jira fake no): `parseAgentSessionEvent(body)` → `{ sessionId, action: "created" | "prompted", ticketExternalId, teamExternalId, creator: { userId, name, email | null }, prompt | null, signal: "stop" | null, commentId | null }`, tolerant of unknown fields; `postAgentActivity(sessionId, { kind: "thought" | "action" | "elicitation" | "response" | "error", body, ephemeral, idempotencyKey })` → `{ activityId }`; `setAgentSessionLink(sessionId, url)` where the tracker has it. A tracker's stop is an event ostra receives, never a call ostra makes (ADR 0013).
- **People:** `getUser(userId)` → `{ userId, name, email | null, active }`, for matching a session's creator.
- **Sub-issues** (capability `subIssues`; Linear yes, the Jira fake yes, as sub-tasks): `createTicket` gains an optional `parent`; `getTicketContext`'s `children` keeps its shape and gains each child's `open`.
- **Writing a draft:** `updateTicket(board, ref, { description })`, and `attachFile(board, ref, { name, contentType, bytes, marker? })` behind `attachments`, with `listAttachments(board, ref)` reading each attachment's marker back, so a retry attaches nothing twice (ticket 41). A tracker that can't take a structured field declares it (`ticketFields: { acceptanceCriteria: boolean }`; Linear no), and the field goes into the description.
- **The authorization:** `agentScopes` on the capability, the scopes agent mode needs, so core can tell an install's token lacks them.
- **The fake Linear server** (milestone 2's, ported from spike 5) grows agent sessions: delegations, mentions, `prompted` follow-ups, stops with `signal: "stop"`, the staleness rule and its clock, the 403 for a personal key's activity, and a record of every activity, so the suite can check what was posted.
- **The tracker contract suite** gains: a session's events parsed and an unknown field tolerated; an activity posted once per key; a stop handled as an event; a child created under a parent and read back; a description written and an attachment attached; each optional capability's absence declared by the Jira fake or the tiny adapter.

**`CodeHostAdapter`** (ticket 03):
- `listCiResults(access, headSha)` → `{ checkRuns: [{ id, name, appSlug, status, conclusion, detailsUrl, startedAt, completedAt }], statuses: [{ context, state, targetUrl, description }] }`.
- `getCiLog(access, ref)` → the tail of a check run's log (for an Actions job, its job log; for any other check, its output's summary and text) up to a byte cap, or `null` with the reason.
- `createReview(access, number, { commitId, body, event: "COMMENT", comments: [{ path, line, side, body }] })` → `{ reviewId, url }`. The adapter refuses any other event, so no caller can approve or request changes. `diffLines(access, number)` → the lines a line comment may sit on, per file and side.
- `listRequestedReviewers(access, number)` → `{ users: [{ userId, login }], teams: [{ slug }] }`, and `readCodeOwners(access, ref)` → the `CODEOWNERS` file's text or `null`.
- `listReviewComments(access, number, reviewId)` → the review's line comments, `[{ id, path, line, side, body, userId }]`.
- `parseWebhook` gains `check_run`, `check_suite` and `status` hints (the head SHA, the repo) and `pull_request` `review_requested` and `review_request_removed`.
- **Capabilities, new:** `ciResults`, `ciLogs`, `reviewComments` (posting a comment-type review), `requestedReviewers`, `codeOwners`.
- **The fake code host** gains check runs and statuses from other apps with logs, a review created with line comments (refusing a line outside the diff as GitHub does), requested reviewers and teams, a `CODEOWNERS` file, a review's line comments, and the webhooks above.

**`AgentAdapter`, notifications and the suites** (ticket 04):
- **Capability, new:** `elicitation: boolean`: the agent asks its questions as ACP elicitations, so the runner can answer one in an automatic turn. An agent without it can't be asked anything mid-turn, and an automatic turn needs no reply for it.
- **The agent contract suite** gains: an automatic turn in which the agent asks a question and the runner's fixed reply lets it carry on (spike 10's case, ported); a read-only task whose push is refused by the git proxy; a review task's checkout at given heads; `submit_draft`, `submit_review` and `propose_environment` listed for the kinds that have them and absent for the others; a turn with `commitPaths` whose other changes stay uncommitted.
- **The scripted fake agents** grow: one calls `submit_draft`, one `submit_review` (scripted findings, blocking or not), one `propose_environment`; one asks a question in an automatic turn.
- **`NotificationAdapter`:** `Notification.kind` gains `draft_ready`, `review_requested`, `task_approval`, `round_cap` and `automation_paused`, each a `moment`. The email templates (ticket 06) carry the task's title and key, the moment and one line, as ADR 0050 says.

### 5.3 `packages/db`: the milestone 6 migration (ticket 05)

One new migration, after milestone 5's, additive only. Every row carries `organizationId`; every project record carries `projectId` with the composite key to the project.

| Change | What |
|---|---|
| `Automation` | + `timeZone` (IANA, default `UTC`), `prompt` (a prompt schedule's, never logged), `title` (a prompt task's), `requireApproval` (default false), `skipWhileOpen` (default true), `pausedAt`, `pausedReason` (`member`, `hourly_limit`), `nextOccurrenceAt`, `lastOccurrenceAt`, `createdByMemberId`, `updatedByMemberId`, `deletedAt`. `filter` is parsed by the domain's `intakeFilterSchema`. Index `(enabled, nextOccurrenceAt)` where `schedule IS NOT NULL` |
| New `AutomationRun` | `automationId`, `kind` (`occurrence`, `ticket_match`, `start_all`), `occurrenceAt`, `ticketId`, `state` (`started`, `skipped`, `missed`), `skipReason` (`last_open`, `has_task`, `paused`, `hourly_limit`, `over_limit`, `budget`), `taskId`, `bulkStartId`, `createdAt`. Unique `(automationId, occurrenceAt)` where `kind = 'occurrence'`; unique `(automationId, ticketId)` where `kind = 'ticket_match'` |
| New `BulkStart` | `memberId`, `source` (`inbox`, `dry_run`), `automationId`, `requestKey` (unique per member), `taskKind`, `agentProfileId`, `requested`, `createdAt` |
| New `BulkStartItem` | `bulkStartId`, `ticketId`, `state` (`pending`, `started`, `skipped`, `failed`), `reason`, `taskId`. Unique `(bulkStartId, ticketId)` |
| `Task` | + `origin` (new `TaskOrigin`: `member`, `automation`, `tracker`, `pr_review`, `onboarding`; default `member`), `automationId`, `bulkStartId`, `parentTicketId`, `trackerActorId`, `trackerActorName` (as the tracker gave it), `poolOnly` (default false), `approvedByMemberId`, `approvedAt`, `rejectedReason`, `ciRounds`, `reviewRounds`, `automaticTurns` (each default 0, since a person last acted), `lastPersonActionAt`, `onboarding` (default false) |
| `Project` | + `aiReview` (default true), `outsideApproval` (default true), `outsideApprovalChangedByMemberId` |
| `Board` | + `agentMode` (default false), with a partial unique index on `(organizationId, connectionId, externalId)` where `agentMode`. `statusMap` gains an optional `ready` status ID, parsed by `boardMappingSchema` |
| `Connection` | + `scopes` (the token's scopes as granted), `agentModeAt` |
| New `AgentSession` | `connectionId`, `externalSessionId` (unique per connection), `ticketId`, `taskId`, `boardId`, `state` (`active`, `awaiting_approval`, `ended`), `creatorExternalId`, `creatorName`, `matchedMemberId`, `lastPostAt`, `heartbeatDueAt`, `endedAt`, `createdAt`. Index `(heartbeatDueAt)` where `state <> 'ended'` |
| New `AgentActivity` | The outbox of posts: `agentSessionId`, `kind` (`thought`, `action`, `elicitation`, `response`, `error`), `ephemeral`, `body` (ostra's own words), `idempotencyKey` (unique), `state` (`pending`, `sent`, `failed`), `externalActivityId`, `attempts`, `sentAt`, `createdAt` |
| New `RefineDraft` | `taskId`, `version`, `description`, `acceptanceCriteria` (JSON), `edgeCases` (JSON), `openQuestions` (JSON), `subTickets` (JSON), `source` (`agent`, `member`), `editedByMemberId`, `appliedAt`, `appliedByMemberId`, `readyAt`, `createdTicketKey`, `createdAt`. Unique `(taskId, version)` |
| New `RefineDraftImage` | `draftId`, `blobId`, `name`, `contentType`, `size`, `attachedAt` |
| New `CiRun` | `taskRepoId`, `headSha`, `state` (`pending`, `passed`, `failed`, `none`, `timed_out`), `checks` (JSON: name, conclusion, the external ID), `firstSeenAt`, `completedAt`, `logBlobIds` (JSON). Unique `(taskRepoId, headSha)` |
| New `TaskRound` | `taskId`, `kind` (`ci`, `findings`, `changes_requested`), `number`, `automatic`, `causeRef` (the head, the review run or the review), `turnId`, `state` (`started`, `held`, `capped`), `createdAt`. Unique `(taskId, kind, causeRef)` |
| New `ReviewRun` | `codeTaskId`, `reviewTaskId`, `round`, `heads` (JSON per repo), `state` (`running`, `submitted`, `posted`, `failed`), `summary`, `blocking`, `nits`, `postedAt`. Unique `(codeTaskId, round)` |
| New `Finding` | `reviewRunId`, `taskRepoId`, `path`, `line`, `side`, `severity` (`blocking`, `nit`), `title`, `body`, `suggestion`, `postedAs` (`line_comment`, `review_body`), `externalCommentId`, `state` (`open`, `resolved`, `outdated`), `resolvedInRunId` |
| New `TaskReviewer` | `taskRepoId`, `githubUserId`, `login`, `teamSlug`, `memberId` (null when unmatched), `source` (`requested`, `codeowners`, `team`), `lastReviewState`, `updatedAt`. Unique `(taskRepoId, githubUserId)` and `(taskRepoId, teamSlug)` |
| New `EnvironmentProposal` | `environmentId`, `taskId`, `body` (JSON, parsed by the environment's schema), `notes`, `state` (`proposed`, `accepted`, `rejected`, `superseded`), `decidedByMemberId`, `decidedAt`, `resultVersion` |
| `AgentProfile` | + `builtInKind` (`refine`, `review`, null), so the two built-in profiles are found and can't be deleted, only edited |
| Enums | `NeedsYouReason` + `awaiting_approval`. The notification kinds + `draft_ready`, `review_requested`, `task_approval`, `round_cap`, `automation_paused`. `ProposalSourceKind` and `MemorySourceKind` + `ai_finding`. New `TaskOrigin`, `AutomationRunKind`, `AutomationRunState`, `AutomationSkipReason`, `AutomationPauseReason`, `BulkStartSource`, `BulkStartItemState`, `AgentSessionState`, `AgentActivityKind`, `AgentActivityState`, `DraftSource`, `CiRunState`, `RoundKind`, `RoundState`, `ReviewRunState`, `FindingSeverity`, `FindingPostedAs`, `FindingState`, `ReviewerSource`, `EnvironmentProposalState` |

The migration backfills nothing. It seeds no profile: ticket 06's organization seeding (the first admin's seed, for a fresh install) and a one-time job for existing ones create the built-in Refine and Review profiles. *Changed 2026-11-19: the seeding said "milestone 4's, for new organizations", whose creation moved after v1 with several organizations (F-134); `createOrganization` will seed them then.*

### 5.4 `packages/domain` (ticket 06)

- **Lifecycles,** new, each with exhaustive tests: an automation (`enabled` → `paused` → `enabled`, `deleted`), an occurrence (`due` → `started` | `skipped` | `missed`), a bulk item, an agent session (`active` ⇄ `awaiting_approval` → `ended`), an outside task's approval (inside the task's union: `awaiting_approval` → `queued` | `stopped`), a draft (versions, `applied`, `ready`), a CI run per head, a round (`started` | `held` | `capped`), a review run, a finding (`open` → `resolved` | `outdated`), an environment proposal. The code task's in-review sub-states become the transition table `domain-model.md` draws, with every edge tested.
- **Intake filters:** `intakeFilterSchema` (labels any or all, label exclusions, status IDs or categories, assignee IDs or "unassigned" or "the app", board IDs, tracker project IDs), and `matchesFilter(ticket, filter)`, pure, over milestone 2's cached ticket.
- **Schedules:** ostra's own cron evaluator (five fields, ranges, steps, lists and names; no seconds, no `L`, `W` or `#`), `nextOccurrence(cron, timeZone, after)` through `Intl.DateTimeFormat`, tested across both daylight-saving changes in three zones; the minimum interval; the missed rule.
- **Starts:** one `startTask` use case every origin goes through (the panel, an intake rule, an occurrence, a bulk item, a sub-issue leaf, Linear, an outside task, onboarding), with the origin a closed union; the sub-issue tree walk with its depth and limit; the member matching rule (ADR 0057): a tracker user's address against active members' account addresses, case-folded, and access to the project.
- **The review loop:** `ciVerdict(results, ownAppSlug, now, pushedAt)` → `pending` | `passed` | `failed` | `none` | `timed_out`; `roundAllowed(task, kind, limits)` → `allowed` | `capped { reason }`; the counters' reset on a person's action; `placeFindings(findings, diffLines)` → line comments and the review body; the CODEOWNERS parser (last match wins, users and teams, `*` and directory patterns) with `ownersFor(paths)`.
- **Templates and prompts:** the refine prompt (the ticket, the repos, the draft tool's contract), the review prompt (the ticket, the acceptance criteria, the PRs, the findings tool's contract), the onboarding prompt (the draft environment, the checks to pass, the proposal tool, "add `AGENTS.md` only where it's missing"), the `fix-ci`, `fix-findings` and `changes-requested` prompts around `@ostra/protocol`'s framing lines; the draft rendered as a ticket description (sections per field) for a tracker without structured fields; the mail templates for the five new kinds.
- **The agent-session copy:** every activity ostra posts, as one renderer per moment (received, waiting for approval, approved, working, a PR opened, needs you with a link, stopped in Linear, stopped in ostra, done, failed), with no agent output, tool input, plan or draft text in any of them.
- **Use-case signatures:** `saveAutomation`, `pauseAutomation`, `deleteAutomation`, `dryRunAutomation`, `matchIntakeRules`, `tickScheduler`, `runOccurrence`, `startMany`, `startBulkItem`, `startTask`, `startSubIssues`, `enableAgentMode`, `setBoardAgentMode`, `handleAgentSessionEvent`, `postAgentActivity`, `sendHeartbeats`, `approveOutsideTask`, `rejectOutsideTask`, `setOutsideApproval`, `saveDraft`, `editDraft`, `applyDraft`, `markTicketReady`, `createTicketFromDraft`, `evaluateCi`, `startRound`, `startReview`, `postReview`, `refreshReviewers`, `reopenOnChangesRequested`, `startOnboarding`, `proposeEnvironment`, `decideEnvironmentProposal`, `rememberFinding`.
- **Jobs, new names** (IDs only in payloads, each with its key rule, ADR 0037): `scheduler.tick` (a pg-boss schedule, every minute, idempotent), `automation.occurrence` (key: automation and occurrence time), `intake.match` (key: ticket and its `trackerUpdatedAt`), `bulk.start-item` (key: item), `linear.agent-event` (key: delivery), `linear.activity.send` (key: activity), `linear.heartbeat` (a sweep, once a minute), `ci.evaluate` (key: task repo and head, `singletonSeconds` 10), `round.start` (key: task, kind, cause), `review.start` (key: code task and round), `review.post` (key: review run and repo), `reviewers.refresh` (key: task repo, `singletonSeconds` 10), `changes.reopen` (key: review), `draft.apply` (key: draft version), `environment.propose` (key: proposal), `profiles.seed-built-in` (key: organization).
- **Settings, new,** each with a working default and its line in `docs/configuration.md`:

| Setting | Default |
|---|---|
| `OSTRA_SCHEDULE_MIN_INTERVAL_MINUTES` | `60` |
| `OSTRA_SCHEDULE_MISSED_HOURS` | `6` |
| `OSTRA_INTAKE_STARTS_PER_HOUR` | `20` |
| `OSTRA_BULK_START_MAX` | `50` |
| `OSTRA_SUB_ISSUES_MAX`, `OSTRA_SUB_ISSUES_DEPTH` | `50`, `3` |
| `OSTRA_LINEAR_HEARTBEAT_MINUTES`, `OSTRA_LINEAR_HEARTBEAT_KIND` | `20`, `ephemeral` |
| `OSTRA_CI_NONE_SECONDS`, `OSTRA_CI_WAIT_MINUTES` | `120`, `60` |
| `OSTRA_CI_LOG_TAIL_KIB`, `OSTRA_CI_LOG_CHECKS` | `64`, `5` |
| `OSTRA_CI_ROUNDS`, `OSTRA_REVIEW_ROUNDS`, `OSTRA_AUTOMATIC_TURNS` | `2`, `2`, `4` |
| `OSTRA_REVIEW_FINDINGS_MAX` | `30` |
| `OSTRA_DRAFT_IMAGES_MAX` | `10` (10 MiB each, milestone 2's ticket-image cap) |

The rounds are per install in v1; a project's "Review" settings show them and change only the AI review switch.

---

## 6. Packages, licenses and owners

| Package | License | New in M6 | Built by |
|---|---|---|---|
| `packages/protocol` | Apache-2.0 | minor 5, the MCP tools' schemas, the fixed prompts | core (01) |
| `packages/adapter-sdk` | Apache-2.0 | agent sessions, people, sub-issues, draft writes; CI, reviews, reviewers, CODEOWNERS; the suites and fakes | adapters (02, 03, 04) |
| `packages/adapters/adapter-linear` | Apache-2.0 | agent sessions and activities, the agent scopes, sub-issues, description and attachments, users | adapters (07) |
| `packages/adapters/adapter-github` | Apache-2.0 | CI results and logs, comment-type reviews, requested reviewers, CODEOWNERS, review comments, the webhooks, the manifest's events | adapters (08) |
| `packages/adapters/adapter-opencode` | Apache-2.0 | read-only kinds, the neutral reply's mapping, the new tools in its MCP list | adapters (09) |
| `apps/runner` | Apache-2.0 | refine and review tasks, the review checkout, the three tools in the sidecar, automatic turns, `commitPaths` | runner (22, 23) |
| `packages/jobs` | Sustainable Use | the scheduler tick's schedule | core (10) |
| `packages/db` | Sustainable Use | the M6 migration, the isolation fixtures | core (05) |
| `packages/domain` | Sustainable Use | lifecycles, filters, cron, starts, the review loop, templates, use cases, jobs, settings | core (06); bodies by core and api |
| `apps/core` | Sustainable Use | the scheduler, rules, bulk starts, sub-issues, agent mode, outside tasks, drafts, CI, rounds, reviews, reviewers, "changes requested", onboarding | core (10 to 21) |
| `packages/api` | Sustainable Use | automations, bulk starts, the parent ticket, agent mode, approvals, drafts, review, onboarding | api (24 to 29) |
| `apps/web` | Sustainable Use | the M6 screens | web (30 to 36) |
| `e2e/m6-whole-team`, `e2e/m6-linear-agent-mode` (new) | Sustainable Use | the demo, the agent-mode harness | core (38, 39) |

The license line holds (ADR 0045, ADR 0048): no Apache-2.0 package depends on a Sustainable Use one. The sidecar's tools reach core over HTTP and import only `packages/protocol`; the prompts and the neutral reply live there too. `pnpm check:licenses` runs on every commit.

---

## 7. The builders and their tickets

Five builders: **core**, **runner**, **web**, **api** and **adapters**. Core and adapters make the contracts first (01 to 06), each with the fakes its callers need. Ticket 40 is the maintainer's.

| # | Ticket | Builder | Blocked by |
|---|---|---|---|
| 01 | Protocol: minor 5 | core | none (milestone 5's minor lands first) |
| 02 | Adapter SDK: agent sessions, people, sub-issues and draft writes | adapters | none |
| 03 | Adapter SDK: CI, comment-type reviews, reviewers and CODEOWNERS | adapters | none |
| 04 | Adapter SDK: the agent suite's new cases, the fakes, and five notification kinds | adapters | 01 |
| 05 | DB: the milestone 6 migration | core | none |
| 06 | Domain: lifecycles, filters, cron, starts, the review loop, templates | core | 01, 05 |
| 07 | Linear adapter: agent sessions, sub-issues, drafts and users | adapters | 02 |
| 08 | GitHub adapter: CI, reviews, reviewers, CODEOWNERS and the webhooks | adapters | 03 |
| 09 | OpenCode adapter: read-only kinds, the new tools and automatic turns | adapters | 04 |
| 10 | Core: the scheduler tick and occurrences | core | 06 |
| 11 | Core: intake rules, the dry run and bulk starts | core | 06 |
| 12 | Core: sub-issues | core | 06, 07 |
| 13 | Core: Linear agent mode | core | 06, 07 |
| 14 | Core: outside tasks and their approval | core | 06 |
| 15 | Core: refine drafts and writing them to the tracker | core | 06, 07 |
| 16 | Core: CI on the task's PRs | core | 06, 08 |
| 17 | Core: the AI review task and posting its findings | core | 06, 08, 16 |
| 18 | Core: rounds, caps and the automatic turn | core | 06, 16, 17 |
| 19 | Core: reviewers and their needs-you | core | 06, 08 |
| 20 | Core: "changes requested" reopens the task | core | 06, 08, 18 |
| 21 | Core: the onboarding task and environment proposals | core | 06 |
| 22 | Runner: refine and review tasks, and their tools | runner | 01, 09 |
| 23 | Runner: automatic turns, CI logs and the onboarding commit | runner | 01, 09 |
| 24 | API: automations | api | 10, 11 |
| 25 | API: bulk starts and the parent ticket | api | 11, 12 |
| 26 | API: agent mode and outside approvals | api | 13, 14 |
| 27 | API: refine drafts | api | 15 |
| 28 | API: the review screen, rounds and review settings | api | 16 to 20 |
| 29 | API: onboarding and environment proposals | api | 21 |
| 30 | Milestone 6 screen targets | web | none |
| 31 | Web: automations, the editor, the dry run and the history | web | 24, 30 |
| 32 | Web: the Inbox's bulk start and the parent ticket | web | 25, 30 |
| 33 | Web: agent mode, Needs approval and the awaiting task | web | 26, 30 |
| 34 | Web: the refine draft | web | 27, 30 |
| 35 | Web: the review screen, the task's rounds and review settings | web | 28, 30 |
| 36 | Web: the onboarding task and the environment proposal | web | 29, 30 |
| 37 | Failure suite: the schedule hunt | core | 10 |
| 38 | The Linear agent-mode harness on real Linear | core | 13, 26 |
| 39 | The end-to-end demo and the ledger | core (lead) | 10 to 23, 31 to 38 |
| 40 | The maintainer's steps outside the code | maintainer | none for the decisions; 39 for the review of the run |

**Who starts when.** core takes 01 and 05 at once, then 06; adapters take 02 and 03 at once, 04 after 01, then 07, 08 and 09. core's 10, 11, 14 and 21 need only 06; 12, 13 and 15 wait for 07, and 16 to 20 for 08. runner takes 22 and 23 after 09. api starts each router once its core ticket is in. web takes 30 at once; its screen tickets wait for the targets' approval (section 12). Milestones 2 to 5's tickets come first wherever both touch a file: a milestone 6 ticket that meets an earlier milestone's ticket still open on the same package waits for it, and says so in its `## Comments`.

---

## 8. Test seams

Agreed here so builders don't each invent one.

- **Postgres:** milestone 1's helper, a database per test file. Every test that reads data also checks another organization's rows and a restricted project's rows stay invisible, and milestone 4's generated isolation test gets a fixture for each new model.
- **Time:** the scheduler tick, the occurrences, the missed rule, the heartbeat, the CI waits and the hourly limit read the `Clock` port. The schedule tests run the evaluator over a year of minutes in three zones against a reference list kept in the test, and the hunt runs on the real clock.
- **Replicas:** ticket 37's hunt starts several `apps/core` processes on one database and kills them at spike 8's points; `packages/jobs/testing` gains a helper that starts and kills a core process by name.
- **Linear:** milestone 2's fake Linear server, grown by ticket 02 with agent sessions and spike 5's staleness clock. The live cases run against `OST` only with `LINEAR_REFRESH_TOKEN` loaded (or `LINEAR_API_KEY` for the plain API), and archive what they create.
- **GitHub:** the fake code host grown by ticket 03 (check runs and statuses from other apps, logs, comment-type reviews, requested reviewers, CODEOWNERS). The live cases run against `ostra-test/test1` and `test2`, with the review by `GITHUB_TEST_REVIEWER_TOKEN` and merges by the test token.
- **Agents:** milestone 4's scripted fakes plus ticket 04's: a drafting fake, a reviewing fake with scripted findings, a proposing fake, and one that asks in an automatic turn. **The stub reviewer:** milestone 1's stub model endpoint, scripted per request, so OpenCode itself calls `submit_review` with given findings in the demo's scripted run.
- **Tracker users:** a fixture set of Linear users and members with addresses that differ only by case, by a plus suffix and by a trailing space, so the matching rule's edges are tested.
- **Text that is data:** every prompt test feeds ticket text, review comments, findings and CI logs holding shell syntax, prompt-like instructions and marker strings, and asserts none reaches a log line, a shell command or an agent activity.

---

## 9. Every ticket's checks and commit

As milestones 1 to 4 (`../m1-first-pr/spec.md`, section 9). In short:
- `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for the touched packages, and `pnpm check:licenses` passes.
- Tickets that touch auth, credentials, the schema, the runner protocol, webhooks or anything that runs agent output (01, 02, 03, 05, 07, 08, 09, 13, 14, 15, 16, 17, 20, 21, 22, 23, 26, 39) run all the checks for the whole repo.
- Every new setting has a working default and its line in `docs/configuration.md`. A fresh install with only the required settings still works: with no automations, agent mode off, AI review on and finding nothing to review, and no CI, every task behaves as in milestone 5.
- **Proof** (`AGENTS.md`; *changed 2026-11-21, the maintainer: "keep tests, drop extras"*): each condition of a row's "done when" has a test named with its key (`it("F-nnn/c1: ...")`) that exercises it through the real code path, and CI runs it. No break-it pass, no proof file. A condition only a live run shows (Linux, macOS, kind, the e2e workflow) waits for the launch-gate Proof run.
- No secret in the commit. Logs carry IDs and fields, never tokens, ticket text, drafts, findings, review comments, CI logs, prompts or agent output. None of that text is interpolated into a shell command, a SQL string or a Linear activity.
- A `package.json` change goes with its `pnpm-lock.yaml`. Nothing new is added without the maintainer's yes; milestone 6 needs no new dependency (section 10).
- Stage only the ticket's own paths, a gitmoji message of at most 50 characters, no AI attribution, `git pull --rebase origin main`, `git push origin main`, retrying on a rejected push.
- The ticket file gets its `Status:` updated and a line under `## Comments` with the commit's hash.

### 9.1 How each row gets proved

Each condition of a row's "done when" gets a test named with its key. This is where those tests are expected to come from; the building tickets write them, and ticket 39 checks every one. "Needs" names hardware or a person this machine lacks; such a condition keeps its row `building` until it has run, with a dated note in the ledger, never a pass the run didn't show.

| F-ID | Proved by tests (kind, ticket) | Live evidence (step of section 3) | Needs |
|---|---|---|---|
| F-011 | The filter's every field with a near miss; once per ticket per rule under a replayed webhook, a poll racing the webhook and two replicas; the dry run equals what a start would do; the rule names a kind, a profile and pool labels and never a repo, and the pool labels reach admission; the hourly limit pauses (06, 11, 24) | Step 9, with the rule's history | none |
| F-106 | The cron evaluator over a year in three zones; the tick inserts each occurrence once with its job in one transaction; the 6-hour rule with the clock moved; pause, edit and delete at the next tick; the gates on an occurrence's start; the hunt: every (automation, occurrence) once with every replica but one killed at spike 8's points (06, 10, 37) | Step 9, with the hunt's log from ticket 37 | none; Linux and Postgres 16/17 runs of the hunt are extra, not in the row |
| F-107 | Up to 50 at once; each through admission, the pool cap and the budget, held tasks queued with their reasons; a replayed request; "start all" from a dry run; outcomes per ticket (11, 25) | Step 4 | milestone 5's pool cap (F-067) |
| F-012 | Spike 5's fake scenarios ported: the fast lane with no runner, the deadlines, the durable claim before the 200, a stop on another replica, the heartbeat's timer and its reset, the kind switch; the setup's Create, paste and Authorize; the install route behind an admin session; a stop never sent with a key; the panel's stop posting with the app's token; the token's daily refresh with rotation (07, 13, 26) | Step 10, and ticket 38's harness log: the install, 50 delegations with their acks and first thoughts, follow-up and stop, 35 silent minutes | the maintainer's Authorize click, and a person pressing "Send stop request" |
| F-040 | An unmatched starter waits; the project's default profile for its kind and a pool only; any project member approves or rejects, audited; on by default; only an organization admin switches it off; a matched member starts at once (06, 14, 26) | Step 10 | none (the fake Linear proves it without the app token; step 10 shows it live) |
| F-077 | Leaves only, to three levels; the parent never gets a code task; a child on no board of the project listed and skipped; the limit; the parent's page and progress comment follow the children; the Jira fake's sub-tasks (06, 12, 25) | Step 3 | none |
| F-099 | The read-only proxy refuses a push and a hidden ref; the default profile is read-only on its own model; typed draft fields through the tool; needs you for the owner; edits and images; "Update ticket" and "Mark ready" through the outbox, nothing written without a member; the board's "ready" mapping (15, 22, 27) | Step 2 | Linux with Docker for the proxy on the box network (unit-tested against the fake engine) |
| F-100 | A review task per code task in its own box, on the PR's head, read-only, with the review profile and its model; findings typed with severity, file and line; one `COMMENT` review per PR with line comments; the adapter refuses any other event; the project switch (08, 17, 22, 28) | Step 6, with the reviews' URLs | none |
| F-101 | Blocking findings as one prompt, nits listed only; 2 rounds; 4 automatic turns with CI; the spend cap and the budget gate on every automatic turn; needs you at a cap; the fixed neutral reply, never a decline (spike 10's case) (09, 18, 23) | Steps 6 and 12 | none |
| F-102 | The review screen's parts; line comments as one prompt (milestone 3's); reviewers from requested reviewers and CODEOWNERS, matched by the link; their needs-you; nothing approves or merges from ostra (19, 28, 35) | Step 7 | none |
| F-035 | The verdict over check runs and statuses, ostra's own left out, "no CI" and the timeout; the failing checks and their log tails as files; 2 rounds then needs you; the spend cap and the budget (16, 18, 23) | Steps 5 and 12 | none |
| F-105 | A linked member's `changes_requested` reopens with the review's body and comments as one prompt, after the running turn; anyone else ignored; no round cap; the spend cap and the budget; no trailer for the reviewer (20) | Step 8 | none |
| F-113 | The template's start on the detected draft, with no snapshot; the proposal through the tool, scanned for secrets; accept, edit and reject by a project admin; only `AGENTS.md` committed, and only where it's missing; on `host`, the setup and checks run and the task says services aren't available (21, 23, 29) | Step 11 | Linux with Docker: the box from the base image and its services. Until then the conditions on the box and services stay `partial`, citing the `host` run and the fake-engine tests |
| F-010, F-036, F-111, F-048 (finished) | F-107's tests (F-010); the reviewer and draft-owner audiences on the three channels (19, 15); "Remember this" on a finding (28); the hunt (37) | Steps 4, 2 and 7, 7, 9 | as their rows |

---

## 10. What each ticket ports

| From | What | To (ticket) |
|---|---|---|
| `spikes/linear-agent-mode/src/server.ts`, `webhook-verify.ts` | the fast lane: verify, claim, 200, then the work; the transit-time warning | 13 |
| same, `src/agent-sessions.ts`, `src/turn-driver.ts` | the session's events, the stop's handling (halt, one final response), the heartbeat's timer and its reset on any post | 13 |
| same, `src/webhook-schema.ts` | the `AgentSessionEvent` shape, loose, with `signal` | 07 |
| same, `src/fake-linear/` (agent sessions, `rules.ts`) | the fake's sessions, staleness and activity record | 02 |
| same, `src/real-run.ts`, `src/scenarios/*.ts` | the real-run harness and the fake scenarios: latency, stop and follow-up, keep-alive, webhook edges | 38, 13 |
| `spikes/durable-queue-choice/` (the C4 hunt and its kill points) | the schedule hunt, against the scheduler tick | 37 |
| `spikes/is-opencode-good-enough/` (the question tool's case) | an automatic turn's question answered with the neutral reply, as an agent contract case | 04, 23 |

**Dependencies.** None new. The cron evaluator is ostra's own, on `Intl` (Q211); `cron-parser`, already in pg-boss's tree, would need the maintainer's yes and isn't used. Linear's agent API is GraphQL over `fetch`, as milestone 2's adapter is; `@linear/sdk` isn't added (Q219). The CODEOWNERS parser is ostra's own. The diff-line map for line comments uses milestone 3's compare.

---

## 11. Choices this spec makes

The maintainer delegated every decision of this spec on 2026-11-19. Each choice below is the recommendation applied, recorded in `context/open-questions.md` under its number and, where it's hard to reverse, in an ADR. If the maintainer disagrees with one, it moves back to the open list and the ticket that holds it changes.

1. **What an intake rule matches, and when it acts** (Q210, ADR 0056). Labels, status, assignee, board and the tracker's project. It acts when a ticket starts to match after the rule exists, once per ticket per rule; existing matches start only from the dry run's "Start all". 20 starts an hour, then it pauses itself.
2. **How a schedule is written and run** (Q211, ADR 0056). Five-field cron in an IANA time zone, evaluated by ostra's own code; at least an hour apart; a schedule checks a rule's filter or starts one prompt task; "skip while the last one is open" on by default; the 6-hour missed rule.
3. **Starting many** (Q212, ADR 0056). 50 at once; each ticket in its own transaction, idempotent per request; a result per ticket; started tasks wait in the queue rather than fail a gate.
4. **Sub-issues** (Q213, ADR 0056). A code start runs the open leaves on the project's boards, three levels deep and 50 at most, all at once; the parent never runs code and shows its children; a refine start refines the parent itself.
5. **Who is a member when a task starts in Linear** (Q214, ADR 0057). The Linear user's address against the active members' account addresses, case-folded, with access to the project. Anyone else starts an outside task.
6. **Which project a delegation goes to** (Q215, ADR 0057). The one board with "Start from Linear" on for the ticket's team; at most one per team per organization. Agent mode starts code tasks only.
7. **What ostra posts in a Linear agent session** (Q216, ADR 0057). ostra's own words, counts and links, never agent output, tool input, a plan or a draft; one thought at each turn's start, an action per PR, an elicitation per needs-you moment with a link, one final response or error.
8. **Follow-ups and stops from Linear** (Q217, ADR 0057). A stop from anyone in the session, always honored. A follow-up from a matched member becomes their message after the running turn; from anyone else, a thought that says who may steer.
9. **Outside tasks** (Q218, ADR 0057). On by default per project, switched off only by an organization admin; any project member approves or rejects; no expiry; an automation's task isn't an outside task, and a rule can ask for approval.
10. **No Linear SDK** (Q219, ADR 0057). GraphQL over `fetch` with ostra's own schemas.
11. **The app token for the demo** (Q220, section 3). The maintainer's Authorize click once; the scripted run rotates the refresh token in `linear.env`; without it, agent mode runs on the fake only and F-012 stays `building`.
12. **A refine draft on the tracker, "ready", and prototypes** (Q221, ADR 0028 amended). Fields as description sections where the tracker has no field; sub-tickets as sub-issues; "ready" defaults to the first `unstarted` status; refine and review tasks push nothing, not even the hidden ref.
13. **When a PR is ready for review, and what CI is** (Q222, ADR 0058). The head's check runs and statuses, ostra's own left out; none within 2 minutes is no CI; a 60-minute wait; the App gains the `check_run`, `check_suite` and `status` events.
14. **One review task, and how findings are posted** (Q223, ADR 0058). One review task per code task, reopened per round on every open PR's head; one `COMMENT` review per PR; findings off the diff in the review's body; 30 at most.
15. **What counts as an automatic turn** (Q224, ADR 0058). The coding agent's CI and findings turns; counted since a person last acted; the review task's own turns don't count.
16. **CI logs to the agent** (Q225, ADR 0058). Log tails as files under `ci/` in the task's config folder, 64 KiB a check, 5 checks; Actions logs through `actions: read`, other checks' output text.
17. **Reviewers** (Q226, ADR 0058). Requested users and CODEOWNERS' users for the changed paths, matched by the link; teams shown, not expanded; ostra requests nobody; the driver when nobody matches.
18. **A "changes requested" reviewer stays independent** (Q227, ADR 0040 amended). No co-author trailer for the review's prompt.
19. **The onboarding task's push and proposal** (Q228, ADR 0038 amended). It commits only `AGENTS.md`, and only where a repo lacks one; the proposal holds variable names and never values, is scanned for secrets, and becomes the environment's next version on a project admin's "Accept".
20. **The protocol window** (Q229, section 5.1). One minor past milestone 5's; a runner one minor older gets no refine, review or onboarding task and no automatic round.

---

## 12. Screens that need a design target

`build-order.md`: a milestone's screens are designed first, image first. The maintainer requires the `ui-taste` skill and Higgsfield targets, approved before building, against `context/brand/brief.md` and `context/brand/app-design.md`. **This spec names them; ticket 30 makes them,** in the form milestones 1 to 4's approved targets have (`context/brand/app-targets/m1/README.md`: a picture, a build spec and a prompt per screen). Until they're approved (recorded in ticket 30's `## Comments`), tickets 31 to 36 don't start their UI; their routers and tests can go ahead.

**New targets**, for what's new in milestone 6:

| # | Target | Screen | Feature | Starts from |
|---|---|---|---|---|
| 1 | `automations` | A project's "Automations": intake rules and schedules in one list, each with its kind, filter or schedule in words, profile, pool labels, last start, next occurrence, paused state and reason, and its switch; "New rule", "New schedule"; the empty state | F-011, F-106 | `app-targets/m1/runners` |
| 2 | `automation-edit` | The rule and schedule editor: the filter builder (labels, status, assignee, board, the tracker's project), kind, profile, pool labels, "wait for approval"; for a schedule the cron with presets, its sentence ("Every Monday at 09:00, Amsterdam time"), the zone and the next three occurrences, the prompt or "check this rule's filter", "skip while the last one is open"; the dry run beside it, its matches with what each would do and "Start all N" | F-011, F-106, F-107 | `app-targets/m3/agent-profile` |
| 3 | `automation-history` | A rule's history: matches and occurrences with started, skipped (and why), missed, the tasks they started, and the pause notice with "Resume" | F-011, F-106 | `app-targets/m4/audit-log` |
| 4 | `inbox-bulk-start` | The Inbox with tickets selected: the selection bar ("Start 4 tasks"), the kind and profile for all, then each ticket's result (started, skipped with its reason, queued with its reason), and a ticket with sub-issues marked "starts 2 tasks" | F-107, F-077 | `app-targets/m2/inbox` |
| 5 | `ticket-parent` | A parent ticket's page: its children as rows with each task's state, PRs and needs-you, a progress bar, children not on the project's boards listed apart, and the parent's own refine task if it had one | F-077 | `app-targets/m2/task-ticket` |
| 6 | `linear-agent-mode` | "Connect Linear", grown: the agent-mode section with "Turn on agent mode", the public address check, the app user and its scopes, the token's renewal, each board's "Start from Linear" switch, the last session events; the copy of every activity ostra posts in Linear, in the build spec | F-012 | `app-targets/m2/connect-linear` |
| 7 | `needs-approval` | A project's "Needs approval" list and Home's rows for it: each outside task with who started it in Linear and why they aren't a member, the ticket, the profile and pool it will run on, "Approve" and "Reject" with a reason; the project's switch for organization admins | F-040 | `app-targets/m3/needs-you` |
| 8 | `refine-draft` | The refine task's draft: the typed fields, each editable (description, acceptance criteria as a list, edge cases, open questions, sub-tickets with their own titles and text), images with "Upload", the versions the agent handed in, a preview of what the ticket will say, "Update ticket", "Mark ready", "Create ticket" for a prompt, and the applied state with links to the sub-issues | F-099 | `app-targets/m3/task-plan-edit` |
| 9 | `review-screen` | The review screen: a tab per PR, the file tree, the diff with the AI's findings inline (blocking and nit, open and resolved) with "Fix this" and "Remember this", the ticket with its acceptance criteria beside it, the reviewers and their states, the round line, line comments with "Send to agent", "Open on GitHub to approve" | F-102, F-100, F-111 | `app-targets/m3/task-changes` |
| 10 | `task-rounds` | The task page in review: the sub-state as a line of stages (CI running, fixing CI 1 of 2, AI review, fixing findings, waiting for a reviewer), "automatic turns 3 of 4", each round as a card in the thread (the failing checks with their log files, the findings sent, "Changes requested by Sam on GitHub"), a held round, the cap's needs-you with "Keep working" | F-035, F-101, F-105 | `app-targets/m1/task` |
| 11 | `review-settings` | A project's "Review" settings: AI review on or off, the review and refine profiles, the round limits as the install sets them, "Outside tasks need approval" (an organization admin's switch), and each repo's CI as ostra last saw it | F-100, F-101, F-040 | `app-targets/m2/repo-checks` |
| 12 | `environment-proposal` | The environment page with an onboarding task's proposal: "Test this environment", the running task's line, the proposal as a diff per repo (setup script, checks, variable names, services), its notes, "Accept", "Edit and accept", "Reject", and the `AGENTS.md` PR's link | F-113 | `app-targets/m3/environment-services` |

**Screens that only grow**, built against their existing targets with the changes listed in the ticket that builds them:
- `app-targets/m1/task`: the kind's badge (refine, review); "Started by the rule …", "Started in Linear by …", "Sub-issue of OST-…"; the awaiting-approval banner with "Approve" and "Reject"; a review task's link to its code task and back; a refine task's "Draft" tab.
- `app-targets/m1/task-new`: the kind picker (code, refine), "This starts N tasks, one for each sub-issue".
- `app-targets/m2/inbox`: sub-issues folded under their parent; the checkbox column (the selection itself is `inbox-bulk-start`).
- `app-targets/m1/home` and `app-targets/m3/needs-you`: the new rows (draft ready, waiting for your review, needs approval, round cap, a paused rule).
- `app-targets/m3/email-needs-you`: the five new kinds' subjects and lines, in its build spec.
- `app-targets/m3/task-checks`: the code host's CI per PR beside ostra's checks, with each failing check's log file and the round it started.
- `app-targets/m2/project-boards`: the board's "ready" status in the mapping, and "Start from Linear" per board.
- `app-targets/m3/agent-profiles` and `app-targets/m3/agent-profile`: the built-in Refine and Review profiles, marked read-only and undeletable.
- `app-targets/m4/memory-proposals`: the source "AI finding" with its review's link.
- `app-targets/m1/environment`: "Test this environment", and the proposal's banner (the proposal itself is `environment-proposal`).
- The sidebar (`app-targets/m1/README.md`'s shell): "Automations" under each project, and the "Needs approval" count beside "Needs you".
