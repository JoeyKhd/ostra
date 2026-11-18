# 27: Session end: PRs, no empty PRs, stop and crash

Status: resolved
Builder: core
Blocked by: 13, 26
Features: F-030, F-078, F-065, F-025, F-047 (the first case)
Packages: `packages/domain` (`recordSessionEnd`, `openPullRequests`, `stopTask`), `apps/core` (`src/reactions/`)
Spec: `../spec.md`, sections 3 and 4

## What to build

- **`task.session-ended`:** for each repo of `session.ended`: ahead → the task repo is "branch pushed", and enqueue `task.open-pull-requests`. Nothing ahead in any repo → a needs-you item for the driver with the agent's last message as its summary, task → needs you (F-065). Never a PR.
- **`task.open-pull-requests`:** per task repo, idempotent by a key per task repo and by the adapter's `findPullRequest`: the title from the prompt (F-030: a prompt task's title comes from its prompt), shortened to GitHub's limit; the body from the session's `pr.text_set` for that repo, or the agent's last message when the agent didn't call the tool, then a footer that links the task in the panel (`OSTRA_PUBLIC_URL`) and the task's other PRs. Open it through the App with a token narrowed to `pull_requests: write` on that repo. Store the number and URL, emit `pr.opened`, task → in review (`waiting_for_reviewer`, spec section 4).
- **`stopTask`** (called by the panel through ticket 33): write the `stop` command to the outbox with the lease epoch, task → stopped when the runner's `session.ended` or a stop ack arrives, or after the grace. The branch and hidden ref stay on GitHub (F-025).
- **Crash:** `session.crashed` → needs you for the driver, the box failed, the branch and hidden ref kept.
- Audit entries: PR opened, task stopped (by whom).

## Done when

- [ ] Tests against the fake GitHub: a session with changes opens one PR per changed repo, once, even when the job runs twice; a session without changes opens none and lands in needs you with the summary; stop and crash reach their states.
- [ ] Gated live run: a PR on a test branch of `test1` is opened by the App with the expected title and footer, then closed and its branch deleted.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add PR opening and session end`.

## Comments

- 2026-11-18, core: done in the commit that carries this line (`✨ add PR opening and session end`). Domain: `recordSessionEnd` (the event at `eventSeq` must be the session's `session.ended`; the session ends with or without changes, the lease is released and the box stopped; each repo that is ahead is `branch_pushed`; with changes a `task.open-pull-requests` job, without changes needs you (driver) with the agent's last message as the summary; a stopped task gets neither), `openPullRequests` (per changed repo: skip one already `pr_open`, reuse an open PR the host finds for the branch, else open one through the adapter, which narrows its token to `pull_requests: write`; the title from the prompt cut to 256 characters, the body from `pr.text_set` or the agent's last message, then a footer linking `OSTRA_PUBLIC_URL/tasks/<id>` and the task's other PRs; then `pr.opened`, an audit entry, and the task to `in_review`/`waiting_for_reviewer`). `stopTask`'s panel half is the api builder's (ticket 33): it stops the task at once and writes the `stop` command. Core's half, in `src/reactions/session-end.ts`: the two workers, and a runner's `done`/`rejected` answer to a stop, which ends the session and frees the lease. A crash is handled at ingest (ticket 25). 5 tests against the fake code host (a PR once even when the job runs twice and the host fails once; no changes → needs you with the summary, no PR; stop → no PR, the branch kept; crash; another organization's runner can't answer our stop), and the gated live run, done here with `github.env`: a PR on a test branch of `ostra-test/test1`, opened by the App's bot with the expected title and footer, then closed and its branch deleted. The domain's seams test now lists all 14 use cases as written. Whole-repo checks green.
