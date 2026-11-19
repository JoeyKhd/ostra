# 22: Runner: after every turn

Status: ready-for-agent
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

- [ ] Tests on `host` with the fake agent and the git upstream stub: after each of three turns the branch, the hidden ref and the archive are there; a dropped upload resumes; a failed export still sends `session.saved`; a staged, an unstaged, a deleted and an untracked file are all in the hidden ref, and an ignored one isn't.
- [ ] Gated on `model.env` and `github-test.env`: two real turns on `test1`, each followed by a hidden ref on GitHub and an archive in the blob store.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ save work and the archive after every turn`.

## Comments
