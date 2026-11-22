# 06: Runner: a repeat review's success and a read-only kind's save

Status: ready-for-agent
Builder: runner
Blocked by: 01
Features: F-151
Packages: `apps/runner` (`src/sidecar/mcp-tools.ts`, `src/task-host/task-run.ts`)
Spec: `../spec.md`, sections 4, 5.1 and 6; the targets' README, content fixes 5 and 6

## What to build

- **Minor 9:** the runner speaks minor 9 in `hello` (ticket 01's version), with minor 8's codecs for an older core.
- **The repeat review's answer:** the sidecar's `submit_review` answers `{ reviewRunId, already: true }` as a success (`answer(…, false)`), with `reviewResultText`'s words, so the agent reports the call done and the thread never draws it failed. Its log line is `review submitted` with `already: true` and the run's ID, no content. A refusal is still an error, as now.
- **A read-only kind's save** (content fix 5): after a turn of a refine or review task (`pushesWork` false), `session.saved` lists no repos (`repos: []`): nothing of a repo is ever saved for those kinds, so nothing reads as "unfinished work not saved". The session archive still goes up, so a reopen restores the conversation, as milestone 6 built it.
- **Parity:** the same on `docker`, `kubernetes` and `host`, and for a personal and a pool runner: neither change reads the executor.

## Done when

- [ ] Tests named for `F-151/c7`: the sidecar's `submit_review` against a fake core answering `already` returns a result that isn't an error, with the already words; a refusal still returns an error (break-it: answer `already` as an error, and the test fails).
- [ ] Tests named for `F-151/c1`: a review task's after-turn save emits `session.saved` with no repos and an archive; a code task's still lists each repo with its hidden ref.
- [ ] The runner's version tests pass at minor 9 against a minor-8 and a minor-9 core.
- [ ] Checks for the whole repo pass (spec section 10: what a runner answers an agent).
- [ ] Committed as `✨ answer a repeat review as done`.

## Comments
