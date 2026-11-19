# 24: Runner: restore on the same box or a fresh one

Status: done
Builder: runner
Blocked by: 10, 22
Features: F-033, F-032, F-045, F-047
Packages: `apps/runner` (`src/task-host/`), the two executors
Spec: `../spec.md`, sections 4 ("Reopen") and 11 (items 6 and 7)

## What to build

The runner follows the spec's `restore.origin`. It never chooses the step itself.

- **`resumed`:** the box is still kept. Start the agent again in it and `session/load` its own session. No archive, no hidden ref.
- **`restored`:** a fresh box. Create and prepare it as usual (milestone 1), check out the task's branch in each repo, `restoreWorkInProgress` from each repo's hidden ref (onto its saved commit, then the branch's new commits merged; on a conflict, the branch's head and `hiddenRef: "conflict"`), download the archive through the bulk path, check its digest, gunzip, `importSession` with `--directory` set to this box's workspace, start the agent, and `session/load`. Replayed updates are marked and never sent as new events. Then send `session.restored` with the origin, the replay count and the hidden ref's result.
- **`rebuilt`:** a fresh box without the archive. Restore the hidden ref as above, start a new session, and send the spec's prompt (the rebuild template) as its first turn.
- **Pending messages:** after the restore, each pending message is sent as the next turn, in order, with `user.message { replayed: true }` for one a lost box never answered.
- **A failed restore falls back:** an archive that doesn't download, doesn't match its digest or doesn't import ends in `rebuilt`, and the event says why in words.
- **The rules are ADR 0039's** (Q150): the import always names this box's workspace; a conflict restores nothing and leaves the ref alone; a lost box's ref and archive are its last finished turn's, and the replayed message comes from the spec's pending messages. The panel says on a reopened task that ignored files stay behind.

## Done when

- [x] Tests on `host` with the fake agent: each origin from the right spec; a fresh worktree from a different data folder restores the session and the agent answers about earlier turns; a moved branch merges, and a conflicting one reports `conflict` and carries on; a corrupt archive falls back to `rebuilt`; a pending message is sent once.
- [ ] Gated on `model.env` and `github-test.env`: a real session on `test1` restores on a second runner and answers spike 2's five questions, 5 of 5 or the shortfall recorded.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ restore a session on any box`.

## Comments
- 2026-11-20, runner: done in `2dba251` (`✨ restore a session on any box`), on `9d86daf`'s `resumeBox` and `runAgentCommand` and `4b9f1ee`'s `fallbackReason`. Whole-repo typecheck and lint, the runner's and the executors' tests, and check:licenses green. The gated live box stays open for ticket 39's whole-stack run (it needs core's reopen, the App's tokens and OpenCode on `test1`); `apps/runner/src/task-host/restore.test.ts` runs every step here, with two runners from two data folders. For tickets 18, 30, 36, 38 and 39:
  - **`resumed`:** the task host hands the new session the box a session of the task left kept (`claimKeptBox`): a session still waiting in it ends first (it sends `session.ended`), and a dispatch for that box takes its slot, whatever the capacity. `ExecutorAdapter.resumeBox` points the box's git at the new proxies; the agent starts again and `session/load`s its own session (the ID kept from the last session). No archive, no hidden ref: `session.restored { origin: "resumed", hiddenRef: "none", previousBox: "kept", replayedUpdates }`.
  - **`restored`:** a fresh box (milestone 1's create and prepare), `restoreWorkInProgress` for the spec's `hiddenRefs` (`conflict` if any repo conflicts or the restore fails, else `applied` if any applied, else `none`), then the archive: downloaded, checked against the spec's size and SHA-256, unwrapped (the runner's envelope from ticket 22 names the agent and its session ID), imported with the folder the agent's session opens on, and loaded. `rebuilt`: the fresh box and the hidden refs, a new session, and the spec's `prompt` (the rebuild template) as the first turn.
  - **Falling back:** a box that isn't kept here any more (or ran another agent, or can't be resumed), a spec with no archive, an archive that doesn't download, match its digest, unwrap, or import, and a `session/load` that fails, each end in `rebuilt`, with the reason in words in `session.restored.fallbackReason` (minor 2; a minor-1 server gets the event without it). A load that fails starts the agent again on a new session in the same box. The runner never picks a step of its own beyond that fallback.
  - **Pending messages:** a resumed or restored session's first turn is the first pending message; a rebuilt one's is the template, then the pending messages. Each is a turn of its own, in order, sent once; with none, the session waits on its idle timer. The `user.message { replayed: true }` is core's to write (a runner can't send `user.message`, ADR 0036): the runner only runs the turn.
  - **`previousBox`:** the runner says only `kept`; for a fresh box it can't tell a released one from a lost one, so it leaves the field out for core's own words.
  - **Not here:** `session/resume` instead of `session/load` after an import (ticket 10 found it works on OpenCode 2.3.2, without the replay); the driver has no `resume` yet. On `docker`, a kept box needs the stopped containers ticket 23 leaves to the Linux run.
