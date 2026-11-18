# Idle boxes, hidden refs and session archives

**Status:** accepted (2026-11-18, from the delegated answers in `context/history/answers-2026-11-18.md`). Settles Q42, Q53 and Q99, and rewords ADR 0006's three steps for boxes.

A box can vanish at any time, and nobody should pay for an idle one. So a task never depends on its box: after every turn, everything needed to carry on leaves it.

**After every turn**, the box:
1. **commits what's left and pushes the task's branches** through the git proxy (ADR 0030).
2. **writes each repo's working tree to the task's hidden ref**, `refs/ostra/wip/<task>`: a commit outside the task's branches. After a finished turn it matches the branch. It differs when a turn was cut short (a cancel, an interrupt, the idle timer during a wait, a box lost mid-turn), so that half-done work never lands on a branch unasked and still survives.
3. **exports the agent's own session archive** (for OpenCode, `opencode session export`) and uploads it to the server, which stores it through the blob store (ADR 0043). The runner uploads through the server, so it still needs only one address.

**The idle timer** (Q42, Q99). A box stays warm for 15 minutes after a turn ends *(working value)*, then it stops.
- A turn that waits on a person follows the same timer. After 15 minutes the turn is cancelled and the box stops. The "needs you" item stays open, and answering it reopens the task with the decision.
- **`docker`:** a stopped box is kept until its host needs the space, so the next turn can resume in place.
- **`kubernetes`:** the pod is deleted.
- **`host`:** the agent's process stops. The worktree stays until cleanup needs the space (F-079).
- The box's lifecycle is a discriminated union: creating, preparing, ready ⇄ idle, stopped, then released, or failed.

**Reopening** tries three things, in order (Q53, ADR 0006):
1. **The same box**, while it's kept: the agent resumes its own session with `session/load`.
2. **A fresh box, from the archive. This is the normal path.** The box starts from the project's snapshot (ADR 0038), fetches the task's branches, restores the hidden ref, imports the archive and calls `session/load`.
3. **A rebuild from a fixed template**, when the archive can't be restored or another agent takes over the task. The template holds the ticket, the PR's text, every member message, the agent's last message and the branch's log. ostra makes no model call of its own.

A session records how it began: resumed in the same box, restored from an archive, or rebuilt from the template. Each reopen raises the task's lease epoch, so a stopped box that wakes up later can't write or push (`research/runner-transport.md` §6).

## Considered options

- **Keep the box, or pause it, while it waits on a person** (Q42 as first written; `research/elastic-sandboxes.md`'s "keep, pause or release"). Rejected: a box that waits holds its CPU and memory while nobody uses them, and `research/rivet.md` §4 recommends cancelling and resuming for long approvals.
- **One timer for idle boxes and another for waits.** Rejected: one timer is easier to explain, and both cases end the same way.
- **Keep a box for the task's whole life.** Rejected: at 1,000 tasks, most boxes would sit idle.
- **Save the archive and the hidden ref only when the box stops.** Rejected: a box can be lost without warning, on a crash or a lost node, so both happen after every turn.
- **Unfinished work as a tarball in the database.** Rejected: the hidden ref is plain git, goes through the same git proxy, and needs no new store (`research/elastic-sandboxes.md`, unknown 6).
- **Replaying the history as text into a new session**, as Rivet does with 12,000 characters. Rejected: weaker than both the archive and the template (`research/rivet.md` §5).
- **A model-written summary of the history** (ADR 0006's third step as written). Rejected: ostra never calls a model itself (`project.md`). A fixed template keeps that true.

## Consequences

- Spike 4 checked the hidden ref on GitHub: GitHub accepts a push to `refs/ostra/wip/<task>` through the git proxy. That no CI starts for it is still for spike 2 to check, so this ADR stands as written.
- Almost every reopen lands on a fresh box, so step 2 is routine, and spike 2 (`can-a-session-move-to-a-fresh-box`) gates the choice of agent as much as spike 1 does. It passes when a restored agent answers 5 of 5 questions about earlier turns, the hidden ref brings back uncommitted and untracked files, GitHub accepts the ref and starts no CI for it, a 200-turn session restores in under 30 s *(working value)*, and the template alone gets 4 of 5.
- OpenCode's export and import have failed a round trip before (`research/rivet.md` §5). So the agent's version is pinned in the base image, and step 3 must be good on its own. If spike 2 fails, the template becomes the normal path, and F-033 says so.
- Archives are several megabytes each, every few minutes, at 1,000 tasks. That's why files go through the blob store, with an S3-compatible store recommended above a few hundred tasks a day (ADR 0043).
- An archive never holds a real credential, because the agent never had one (ADR 0030). It holds the session's content, so it's stored and checked for access like the task's history, and never logged.
- A push after every turn may cost a project too much CI time. If it does, the project can choose to push only when the box goes idle.
- If members dislike the wait after a pause, the warm time becomes a project setting.
- Cleanup (F-079) covers stopped boxes and blobs. **It deletes refs, never LFS objects, and ostra can't give a task's LFS storage back.** Spike 4's cleanup deleted its test refs and the LFS objects stayed in the repo's storage. GitHub says the same: the objects "continue to count toward your Git LFS storage quota" until the repository is deleted and recreated. So a task's LFS objects count against the organization's quota on the code host's side, and the docs and the configuration reference say so and promise nothing else (Q120). The test repo `test1` has to be recreated now and then, or LFS tests use a throwaway repo.
- The wait for a person is the idle timer, **15 minutes** (above). Spike 1's test list said 10 minutes for a held request. They are aligned to 15, so one timer governs both.
- Ledger rows: F-033, F-045, F-047 and F-096.
