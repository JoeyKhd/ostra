# 27: Session end: PRs, no empty PRs, stop and crash

Status: ready-for-agent
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
