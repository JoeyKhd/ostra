# 24: Runner: restore on the same box or a fresh one

Status: ready-for-agent
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

- [ ] Tests on `host` with the fake agent: each origin from the right spec; a fresh worktree from a different data folder restores the session and the agent answers about earlier turns; a moved branch merges, and a conflicting one reports `conflict` and carries on; a corrupt archive falls back to `rebuilt`; a pending message is sent once.
- [ ] Gated on `model.env` and `github-test.env`: a real session on `test1` restores on a second runner and answers spike 2's five questions, 5 of 5 or the shortfall recorded.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ restore a session on any box`.

## Comments
