# 23: Runner: the idle timer, stop and release

Status: done
Builder: runner
Blocked by: 22
Features: F-096, F-079
Packages: `apps/runner` (`src/task-host/`, `src/box-dispatcher.ts`), the two executors
Spec: `../spec.md`, section 4 ("The idle timer")

## What to build

- **The idle timer:** `limits.idleMinutes` after a turn ends with no new turn, the runner stops the agent (its whole process tree), sends `session.ended` with each repo's ahead state, and marks the box `stopped`. A new turn (a `steer` to the idle session) before then resets it.
- **A turn that waits on a person** when the timer fires: the turn is cancelled first, then the after-turn work of ticket 22 runs (so the hidden ref holds the half-done work), then the session ends. The needs-you item stays open on the server.
- **What stays:** on `host` the worktree stays until a `release`; on `docker` the stopped containers stay until a `release` or until the host needs the space. A `docker` runner checks its free disk and releases its oldest stopped boxes when it falls under 10% *(working value)*, reporting each as released with the reason `disk`. That part waits for the Linux run.
- **The `release` command:** remove the box and its workspace, the task's OpenCode directories and its temp files (OpenCode's tool outputs under `…/opencode/tool-outputs/<taskId>` in the system temp folder on `host`, M1's demo gap, as Q134's interim answer says), ack `done`. A box already gone acks `done` too.
- **Same-box resume** stays possible while the box is `stopped` and kept: ticket 24 uses it.

## Done when

- [x] Tests with a fake clock: the session ends after the idle time and not before; a steer resets the timer; a waiting turn is cancelled, saved, then ended; `release` removes everything and is idempotent; nothing of the task is left in the temp folder after release.
- [x] Committed as `✨ add the idle timer and release`.

## Comments
- 2026-11-20, runner: done in the commit after `7aa7759` on `main` (`✨ add the idle timer and release`). Runner and host executor typecheck, lint and test green, check:licenses green. For tickets 17, 20, 24 and 38:
  - **The idle timer** reads a `TaskTimers` port (`deps.timers`, the real one by default; `manualTimers()` in `apps/runner/src/testing/task-host-harness.ts` for tests). It runs while the session waits between turns, and while a turn waits on a person (a question); a steer between turns is the next turn, and the timer starts again when the session next waits. When it fires between turns: the agent's tree stops (`executor.stop`, the box `stopped`), and `session.ended` goes up with each repo's ahead state from the last push. When it fires on a waiting turn: the turn is cancelled, its work saved (`session.saved`, the hidden ref holds it), then `session.ended`. `limits.idleMinutes` missing (a minor-0 spec) keeps milestone 1, with no timer.
  - **What stays:** every session across turns that got its box ready keeps it (idle, stopped or crashed), and the task host lists it (`TaskHost.kept()`) with the agent's own session ID, for ticket 24's resume. A stop with reason `requested` keeps it too, so a reopen can resume.
  - **`release`** (`apps/runner/src/task-host/task-host.ts`): a session waiting between turns ends first, as its timer would (so it sends `session.ended`); a box whose turn runs answers `rejected`, `box-busy`. Then `executor.release` with the command's reason, and `removeAgentLeftovers` deletes `<system temp>/opencode/tool-outputs/<id>` for the task's ID and the agent's session ID, since Q134's research hasn't settled which names the folder. A box already gone acks `done`; the host executor now also removes the task's folder of a box it forgot (a runner restart), unless another box of the task lives there.
  - **Waits for the Linux run:** `docker`'s stopped containers kept until a release or the host's disk falls under 10%, with the release reason `disk`. The pool runner's box dispatcher still removes a box when its sidecar exits, and acks a `release` of a box it no longer runs `done`.
