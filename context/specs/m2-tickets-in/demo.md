# Milestone 2's demo: tickets in, nothing lost

**Result, 2026-11-19 (final run 15:34:42 UTC):** a real ticket in the Linear workspace `ostra-test` became a task from the project's Inbox, and the task's PR on `ostra-test/test1` was linked on the ticket, which moved to "In Progress" at the start and to "Done" at the merge. The box went idle and stopped, the first runner and its worktree went away, and the task reopened with a message on a **second personal runner**, restored from its session archive on a fresh worktree: the agent answered about its first turn and its new commit updated the same PR. The final run's ticket is **[OST-79](https://linear.app/ostra-test/issue/OST-79/add-greeting-7277md-that-says-hello-from-ostra)** and its PR **[#75](https://github.com/ostra-test/test1/pull/75)** (merged). `pnpm e2e:m2` passed **three times in a row, each from an empty data folder** on a stack started fresh (`pnpm dev:reset --yes; pnpm dev`) on ports 3210, 8810 and 54410, with all 22 checks after the run each time (runs B, C and D below, 11 to 13 minutes each).

**What it doesn't cover yet** (section "What's still missing"): step 1's real "Connect Linear" click and step 8's day-old refreshed token wait for the maintainer (ticket 40); the repo checks wait for ticket 40's public repos or paid plan; the failure suite (ticket 38) isn't built; and the `docker` cases wait for a Linux machine.

**On this machine:** Windows 11, Node 24.14, no Docker. The demo runs on the **host executor** (spec section 1): two personal runners on this machine, each task in a worktree. Core's public address is a cloudflared quick tunnel to core's port, so Linear's webhooks reach it.

## How to run it

```
# A tunnel to core's port: cloudflared tunnel --url http://localhost:8810
export OSTRA_WEB_PORT=3210 OSTRA_CORE_PORT=8810 OSTRA_DEV_PG_PORT=54410
export OSTRA_CORE_PUBLIC_URL=https://<tunnel> OSTRA_DEV_PUBLIC_URL=https://<tunnel>
export OSTRA_BOX_IDLE_MINUTES=2 OSTRA_RECONCILE_MINUTES=2 OSTRA_ALLOW_DEFAULT_PASSWORD=true
pnpm dev:reset --yes && pnpm dev                       # one terminal: an empty stack
set -a; for f in model github github-test linear; do . ~/.config/ostra-dev/$f.env; done; set +a
export OSTRA_E2E_PANEL_URL=http://localhost:3210 OSTRA_E2E_CORE_URL=http://localhost:8810 OSTRA_PUBLIC_URL=http://localhost:3210
pnpm e2e:m2                                            # another terminal
pnpm --filter @ostra/e2e-m2 clean-up --keep-pr <n> --keep-ticket <OST-n>
```

`docs/development.md` ("Milestone 2's demo") says what each piece does. The script is `e2e/m2-tickets-in/`: `demo.ts` (the steps), `seed-linear.ts` (the development connection), `extras.ts` (the checks that need a second task), `linear.ts` (the test tool's own calls to Linear, with the maintainer's key, as a person would make them) and `clean-up.ts`.

## The two runs, recorded apart (spec section 3)

- **The overnight run** (this record): Linear's consent-free grant is off on the test app, so `seed-linear.ts` connects the organization with `LINEAR_API_KEY`: `credentialKind: api_key`, state `active`, `appUserId` null, the key in the secret store and nowhere else. The panel labels it "Personal API key (development)" ([08](demo/08-linear-connected.png)). With the tunnel up, the seed registers a workspace webhook on team `OST` (`Issue`, `Comment`, `IssueLabel`, `Attachment`) at `/webhooks/linear/<connectionId>` with a secret it generates and keeps in the secret store, and deletes it at the end of the run. Comments, moves and links come from the maintainer's user, not an app user, and with no app user there's no own-echo filter: every write is still found by its marker before it's made.
- **The morning run** (not done yet): step 1 by hand ("Connect Linear", Create in Linear, the three values, Authorize), then steps 8 and 9 on that connection at least a day later, so the access token has expired and been refreshed. Ticket 40 holds it.

## The steps

From the final run D, 15:34:42 to 15:47:19 UTC. Run B's and C's figures are in the table after this one.

| Step | What happened | Screenshot |
|---|---|---|
| Before | `pnpm dev` on an empty data folder: the embedded Postgres, every migration, core and the panel. Milestone 1's helpers (`@ostra/e2e-m1/setup`): the seeded admin `demo` changes the default password, the model provider (the dev endpoint, allowed on personal runners, its model the OpenCode profile's), the existing GitHub App, the project on `ostra-test/test1` | [01](demo/01-change-password.png) to [07](demo/07-environment-saved.png) |
| 1. Connect Linear | The development seed (above). The Linear page: connected to `ostra-test`, "Webhooks: receiving", the webhook URL on the tunnel, the API key "never refreshes", the backstop poll every 2 min | [08](demo/08-linear-connected.png) |
| 2. Attach the board | Boards, "Attach a team": `Ostra-test · OST`. The mapping drafted itself: open = Backlog and Todo, started = In Progress, in review = In Progress (OST has no review state), done = Done; "Integration not installed", so ostra moves tickets to done itself (`doneBy: "ostra"`) | [09](demo/09-board-attached.png) |
| 3. A ticket arrives | The script made `OST-79` through Linear's API: a title, a description naming a file of its own (`GREETING-7277.md`, so an earlier run's merge can't leave the agent nothing to do), an uploaded image, the label `ostra-demo`, and a comment. Linear's webhook brought it into the ticket cache **1.3 s** after its creation. The Inbox showed it at once on the next load (9.6 s, which includes the dev server's page load); the Inbox refetches every 10 s and has no push yet (ticket 35's gap) | [12](demo/12-inbox.png) |
| 4. Start it | In the Inbox panel: kind Code, profile OpenCode, Run on `demo-runner`, Start task. The panel turned into the queued task, with Open task. On Linear, **3.2 s** later: the ticket in "In Progress", ostra's comment with the task's link, and a link attachment to the task | [13](demo/13-inbox-started.png), [14](demo/14-task-queued.png), [15](demo/15-task-ticket.png) |
| 5. Context | The task page shows the ticket's key, status and link, and "What the agent got: title, description and labels, 1 file". The first prompt is the project's template with the ticket's text in `ticket-text` blocks: the title, the description, the label, the person's comment, and the image's path, `.ostra/ticket/<blobId>.png`, which the runner wrote before the agent started. ostra's own progress comment is left out (fixed tonight, below). The branch is `ostra/ost-79-<last 8 hex of the task ID>-<slug>` | [15](demo/15-task-ticket.png) |
| 6. The PR | The turn ended with a commit. After the turn the runner pushed the branch, wrote `refs/ostra/wip/<taskId>`, and uploaded the session archive (3,465 bytes, gzipped; the save after the turn took 3,561 ms). Core opened **[#75](https://github.com/ostra-test/test1/pull/75)** 21.2 s after the task page opened: title `OST-79: …`, body `Closes OST-79`. On Linear the PR was linked, the progress comment edited in place; "in review" is "In Progress" on OST, so no move | [16](demo/16-working.png), [17](demo/17-pull-request.png) |
| 7. Idle | No one sent anything. With `OSTRA_BOX_IDLE_MINUTES=2` the runner ended the session 115.0 s later ("the session was idle for its limit"), and the task stayed in review. The archive is in the blob store and the hidden ref on GitHub, and that ref started **no CI**: 0 workflow runs for its commit after 60 s, on `test1`'s push workflow (F-096) | [18](demo/18-idle-stopped.png) |
| 8. Reopen elsewhere | The script stopped the first runner and deleted its task folder, as cleanup would. A second runner, from another data folder, signed in by device code and was the only one online. Reopen, with: *Also add this sentence at the end of the file: "Reopened from its session archive." And what did you change in your first turn, and why?* The thread said **"Restored from the session archive · the box before it was lost · 21 updates replayed · unfinished work restored"** 9.8 s after the click. The agent answered about its first turn (the file, the heading, the sentence, the comment it followed) and its commit updated the same PR 31.4 s after the click. The ticket got no second comment: the progress comment was edited. The restored history named the old worktree's path, under the first runner's folder: on `host` a fresh box on another runner has another path, and the agent, finding it gone, switched to its own workspace (below) | [19](demo/19-device-approve.png) to [23](demo/23-reopened-commit.png) |
| 9. Merge | The script squash-merged the PR as the test App. The App's webhooks go to the maintainer's address, not this stack's, so core learned it from the reconcile (`OSTRA_RECONCILE_MINUTES=2`), 105 s later. The task is merged, the box released, the hidden ref deleted, and ostra moved the ticket to Done | [24](demo/24-merged.png) |

**Per run** (each from an empty data folder, all on the same code but the last commit's screenshot wait):

| | Run B | Run C | Run D |
|---|---|---|---|
| Ticket, PR | OST-74, [#69](https://github.com/ostra-test/test1/pull/69) | OST-77, [#73](https://github.com/ostra-test/test1/pull/73) | OST-79, [#75](https://github.com/ostra-test/test1/pull/75) |
| Ticket in the cache (webhook) | 2.1 s | 0.3 s | 1.3 s |
| Start → moved, commented, linked on Linear | 3.2 s | 3.2 s | 3.2 s |
| Task page → PR link | 18.1 s | 21.1 s | 21.2 s |
| First turn's after-turn save (push, hidden ref, archive), archive size | 3,285 ms, 3,489 B | 3,565 ms, 4,167 B | 3,561 ms, 3,465 B |
| Idle stop after the PR | 115.1 s | 115.0 s | 115.0 s |
| Reopen → "restored from the session archive" | 6.7 s | 7.6 s | 9.8 s |
| Reopen → new commit on the PR | 28.5 s | 29.6 s | 31.4 s |
| Merge → task merged (reconcile) | 65 s | 60 s | 105 s |
| Whole run | 11 min 36 s | 13 min 5 s | 12 min 37 s |

Logs: [`live/run-B.txt`](live/run-B.txt), [`live/run-C.txt`](live/run-C.txt), [`live/run-D.txt`](live/run-D.txt) (the script's output; IDs and timings, no secret: each was searched for every dev secret by value before it was committed).

## The checks after the run

All passed in runs B, C and D; the details are run D's.

| Check | Result |
|---|---|
| No duplicates (F-046) | PASS. On the ticket: 1 progress comment, 1 PR link, 1 task link. In ostra's tracker outbox: one write per mapped move (started → in review → done), 1 comment, 1 task link, 16 of 16 writes done. On GitHub: 1 PR for the branch. Linear's own history merges one actor's state changes into one entry, so the outbox is what counts the moves |
| The PR names the ticket (spec section 11, item 5) | PASS. Title `OST-79: …`, `Closes OST-79` in the body, branch `ostra/ost-79-…` |
| Cleanup after the merge (F-079) | PASS. The hidden ref deleted, every box of the task released |
| Nothing reached the agent that shouldn't | PASS. No dev secret (the model key, the App's key, the Linear key, GitHub's token pattern) in the event log or in the stack's and both runners' logs, and the Linear key in none of the files of both runners' folders. Ticket text is data in the prompt's blocks; nothing of it goes into a shell |
| A hidden ref starts no CI (F-096) | PASS. 0 workflow runs for the hidden ref's commit at least 60 s after its push; `test1`'s push workflow runs within 45 s for a branch (ticket 40) |
| "Create ticket" (F-097) | PASS. A second, prompt task on the second runner; "Create ticket" made OST-80 on `OST`, which links the task, and the task names it ([26](demo/26-create-ticket.png)). Creating it also moved it to started, as a ticket task's start does |
| A reopen on the warm box (F-033, step 1) | PASS. The prompt task's second message, sent while its box was warm and idle: the composer reopens an in-review task, and the thread said "resumed" ([27](demo/27-resumed.png)) |
| The rebuild template (F-033, step 3) | PASS, 5 of 5. After the prompt task's box stopped, its two archives were deleted and its runner went offline (the first runner came back instead), so core had neither a kept box nor an archive and chose the template. Spike 2's five questions, asked with no tool allowed: the codename the member gave, the file it created, the output of a command it ran, the word for the README, the port it picked. Runs B and C: 5 of 5; the validation run before them, 4 of 5 (it missed the port) ([29](demo/29-rebuilt.png)) |
| Drift (F-044) | PASS. With the seed's webhook deleted and the connection still in webhooks mode, a title edit reached the cache by the drift poll 45 s later; the poll runs every `OSTRA_RECONCILE_MINUTES` (2 here, 5 by default) |
| Private install (F-042) | PASS. With the connection in polling mode, as the seed leaves it with no public address, a title edit reached the cache 20 s later (the poll runs every 60 s) |
| The repo checks (F-055, F-060) | WAITING on ticket 40's steps 1 to 4: `test1` and `test2` are private repos on a free plan, so GitHub refuses to read or switch a ruleset. Recorded as waiting, not failed. The panel already warns that `test1`'s default branch isn't protected ([12](demo/12-inbox.png)) |
| Runaway protection (F-068) | Not in this run: it belongs to the failure suite (ticket 38), on the scripted fake agent |

Spend: a session on the dev model cost under a cent (the panel shows "$0.01 of $25.00" at most, rounding to cents).

## What tonight's runs found, and fixed

Each fix is its own commit on `main`, with a test that fails without it.

- **A runner restarted between turns left its session idle forever** (`ca68b7a`). Since milestone 2 a session stays open between turns. When the runner restarted, its connection put back each session it held and at once dropped the ones whose events were all acked, which an idle session's are, before the task host asked which sessions to report as crashed. So nothing told core, the session stayed `idle`, the box `idle`, and the idle timer never ran again. A restarted runner now keeps those sessions until the task host reports them (`session.crashed`: an in-review task stays in review, its box fails, and its next reopen restores on a fresh box), and the report continues the session's own sequence. Test: `apps/runner/src/connection/peer.test.ts`, "still names the session as restored, though every event was acked, and its next event follows on".
- **The first prompt held ostra's own progress comment as ticket text** (`a5608e2`). The start writes the progress comment while `ticket.fetch-context` reads the ticket, and with the development key there is no app user to filter by. Comments carrying the progress comment's marker, and any by the connection's app user, are now left out. Test: `apps/core/src/tracker/context.test.ts`.
- **A failed hidden-ref push said only "exit 1"** (`8b47566`). Once, in an early run, the after-turn push of the hidden ref failed and nothing said why; it didn't happen again in the runs since. The save now names git's own `[rejected]` reason, and nothing else of git's output, whose lines can hold the git proxy's secret path. Test: `packages/adapter-sdk/src/executor/work-in-progress.test.ts`.
- **The demo itself** (`8e0b82d` and the commits after it): milestone 1's demo steps became a module both demos share; a demo runner is matched by its exact name; each run's ticket names its own file; the reopen asks for a change the first turn can't have made (one run's agent had already dated the file in its first turn, so the reopen had nothing to commit); the clean-up closes only this stack's PRs; screenshots wait for the task page's data.

**A mistake of mine, put right:** two early clean-ups closed PRs that weren't this demo's, and deleted their branches: milestone 1's kept demo PR [#45](https://github.com/ostra-test/test1/pull/45), and [#71](https://github.com/ostra-test/test1/pull/71) of another session's stack. Both branches were recreated at their heads and both PRs reopened. The hidden ref of #71's task (`…20647d98`) was deleted too and couldn't be put back. The clean-up now acts only on PRs whose body links a task on this stack's panel.

## What's still missing

- **Step 1 by hand, and step 8 a day later** (ticket 40): the real Create / three values / Authorize, the app user, and a reopen after the access token expired and was refreshed. Until then, F-005 stays `building`.
- **The repo checks** (F-055, F-060): ticket 40's public repos or paid plan, the rulesets, and `GITHUB_TEST_ADMIN_TOKEN`.
- **The failure suite** (ticket 38, F-048): not built. F-043, F-044, F-045, F-046, F-047 and F-068 rest on it as much as on this demo.
- **Proof files** in `context/proof/` for the milestone's rows. The ledger rows are `building`, each with a dated note on what the demo showed; none is set `done` without its proof.
- **The Inbox's live update**: it refetches every 10 s and has no push (ticket 35's gap), so a ticket the cache has in under a second can take up to 10 s to show on an open Inbox.
- **A restored session remembers the old box's path.** On `host`, a fresh worktree on another runner lives under that runner's data folder, so the archive's history names paths that no longer exist; in run D the agent tried one, got an error and moved to its own workspace. Spike 2 restored at the same path, and on `docker` the workspace path is the same in every box, so this is `host`'s alone (ADR 0029's differences don't list it yet).
- **The GitHub App's webhooks on this stack**: the test App's webhook goes to the maintainer's address, so a merge reaches a second stack by the reconcile only.
- **Waiting for Linux** (spec section 3): the same cases on `docker` (a sidecar dropping out, a stopped box kept and resumed in place, released when its host needs the space) and `kill -9` with POSIX semantics.
