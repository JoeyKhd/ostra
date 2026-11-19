# 22: Runner: after every turn

Status: done
Builder: runner
Blocked by: 02, 04, 10, 12
Features: F-096, F-047
Packages: `apps/runner` (`src/task-host/`, `src/server/` for the bulk client), `packages/adapters/adapter-executor-host`, `packages/adapters/adapter-executor-docker`
Spec: `../spec.md`, section 4 ("After every turn")

## What to build

From minor 1, a turn's end no longer ends the session.

- **After every turn,** in this order: commit what's left and push the task's branch in every repo (milestone 1's `commitAndPush`); `saveWorkInProgress` (each repo's working tree to the hidden ref, forced, through the git proxy); `exportSession`, gzip with `node:zlib`, and upload through the bulk path in 1 MiB chunks with its SHA-256, resuming after a drop; then send `session.saved`. The session stays open, and the agent waits for the next turn.
- **Failures don't fail the turn:** a failed export or upload sends `session.saved` with `archive: null` and logs the reason in words; a failed hidden-ref push sends `hiddenRefSha: null`. The branch push is what matters for the PR.
- **Both executors:** `host` implements `saveWorkInProgress` on the worktree; `docker` on the agent container's workspace, through the sidecar. The executor suite covers both; `docker`'s live run waits for Linux.
- **The git guard:** every git call sets `GIT_CEILING_DIRECTORIES` to the task's workspace, so git never acts on a repo above it (spike 2, gotcha 12).
- **The working figures:** the time the after-turn work takes and the archive's size, per turn, as structured fields on one log line (no content), so the demo can record them.
- **A minor-0 server:** the runner keeps milestone 1's behaviour, one turn and `session.ended`.

## Port from

`spikes/can-a-session-move-to-a-fresh-box/src/lib/hidden-ref.ts`, `session-archive.ts`, `git.ts`; `history.ts` (the after-turn order).

## Done when

- [x] Tests on `host` with the fake agent and the git upstream stub: after each of three turns the branch, the hidden ref and the archive are there; a dropped upload resumes; a failed export still sends `session.saved`; a staged, an unstaged, a deleted and an untracked file are all in the hidden ref, and an ignored one isn't.
- [ ] Gated on `model.env` and `github-test.env`: two real turns on `test1`, each followed by a hidden ref on GitHub and an archive in the blob store.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ save work and the archive after every turn`.

## Comments
- 2026-11-20, runner: done in `d37490c` (`✨ save work and the archive after every turn`), after `9d86daf` (`✨ add agent commands and kept boxes to executors`: `runAgentCommand` and `resumeBox` on `ExecutorAdapter`, additive). Whole-repo typecheck, lint, test and check:licenses green. The gated live box stays open: it needs a whole stack (core's blob store, the App's tokens for `test1`), which is ticket 39's run; everything it checks runs here against the git upstream stub and the fake server's bulk path. For tickets 17, 23 to 26, 38 and 39:
  - **When a session spans turns:** a spec with `limits.idleMinutes` on a connection whose minor reads `session.saved`. Anything else (a minor-0 spec) keeps milestone 1's one turn, `session.ended` and release, unchanged.
  - **After every turn, in order** (`saveWork` in `apps/runner/src/task-host/task-run.ts`): `commitAndPush` (the branch's `git.pushed`), `saveWorkInProgress` (one `git.pushed` per repo for `refs/ostra/wip/<taskId>` with the work-in-progress commit's SHA, which replaces milestone 1's second event for the hidden ref), the archive, then `session.saved`. A stopped or crashed turn's work goes the same way, before the stop's end or `session.crashed`. A failed branch push still saves the hidden ref and the archive and sends `session.saved` (with `headSha: null`), then crashes the session with milestone 1's words. The agent's fake key lasts 24 h in such a session; its end revokes it.
  - **The archive's bytes are the runner's own envelope** (`apps/runner/src/task-host/session-archive.ts`): gzip of one JSON line (`format: "ostra-session-archive/1"`, the agent adapter's name, the agent's session ID, which `session/load` needs and the spec doesn't carry) and then the export's bytes. Core stores it as an opaque blob. The export runs through the new `ExecutorAdapter.runAgentCommand` (with `stdoutTo` for OpenCode), bound to the folder the agent's session opened on (the checkout, with one repo).
  - **The bulk client** (`apps/runner/src/server/bulk.ts`, on `ServerLink.uploadBlob` and `downloadBlob`): 1 MiB chunks, a drop or a 5xx or `offset-mismatch` starts again with the same digest and size, which resumes from core's `receivedBytes`; `stale-lease` and `digest-mismatch` end it at once. A download reads the `x-ostra-sha256` header (`runnerHeaders.blobSha256`, added in `8b3fbdf`), which ticket 12's endpoint already sends.
  - **The executors:** `host` implements `saveWorkInProgress` and `restoreWorkInProgress` on the shared helper; `docker` delegates, so git runs in the agent's container through the bridge. Every git call of the host executor sets `GIT_CEILING_DIRECTORIES` to the task's workspace. The executor suite's work-in-progress cases now run on both (a fresh box of the same task: the suite's second box shares the first's task ID).
  - **The working figures:** one `work saved after the turn` line per turn, with `turnOrdinal`, `afterTurnMs`, `archiveBytes`, `hiddenRefs` and `branchPushed`. A failed export or upload logs `the session archive wasn't saved` with the reason in words.
  - **For ticket 38:** the fake server (`apps/runner/src/testing/fake-server.ts`) plays the bulk path, with faults (`dropChunks`, `refuseUploads`, `failDownloads`, `corruptDownloads`), and `apps/runner/src/testing/task-host-harness.ts` is a one-process runner for milestone 2's cases.
