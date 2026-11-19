# 23: Runner: the idle timer, stop and release

Status: ready-for-agent
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

- [ ] Tests with a fake clock: the session ends after the idle time and not before; a steer resets the timer; a waiting turn is cancelled, saved, then ended; `release` removes everything and is idempotent; nothing of the task is left in the temp folder after release.
- [ ] Committed as `✨ add the idle timer and release`.

## Comments
