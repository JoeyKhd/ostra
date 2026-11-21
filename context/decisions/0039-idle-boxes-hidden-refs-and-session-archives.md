# Idle boxes, hidden refs and session archives

**Status:** accepted (2026-11-18, from the delegated answers in `context/history/answers-2026-11-18.md`). Settles Q42, Q53 and Q99, and rewords ADR 0006's three steps for boxes. **Amended 2026-11-18 after spike 4, and 2026-11-19 after spike 2** (`research/spike-github-app-and-git-proxy.md`, `research/spike-can-a-session-move-to-a-fresh-box.md`): the rebuild template carries every agent message and an interrupted turn's text on its own (Q128), the hidden ref is a forced push that leaves ignored files behind, a moved branch and a lost box have rules (Q150), the archive is imported into the box's own workspace, and the sizes and timings are recorded. **Amended 2026-11-21 by ADR 0068:** a box someone watches stays warm past the idle timer for up to 60 minutes after its last turn, and "Start the app" starts a box with the lease's purpose `app`, with no agent (ADR 0068, "Warm while watched, and starting the app").

A box can vanish at any time, and nobody should pay for an idle one. So a task never depends on its box: after every turn, everything needed to carry on leaves it.

**After every turn**, the box:
1. **commits what's left and pushes the task's branches** through the git proxy (ADR 0030).
2. **writes each repo's working tree to the task's hidden ref**, `refs/ostra/wip/<task>`: a commit outside the task's branches. After a finished turn it matches the branch. It differs when a turn was cut short (a cancel, an interrupt, the idle timer during a wait), so that half-done work never lands on a branch unasked and still survives. A box lost mid-turn can't write a ref afterwards, so it differs in another way (below).
3. **exports the agent's own session archive** (for OpenCode, `opencode session export`), gzips it and uploads it to the server, which stores it through the blob store (ADR 0043). The runner uploads through the server, so it still needs only one address. Each turn uploads the whole archive again.

**How the hidden ref is made** (spike 2, Q150):
- **It holds the working tree as `git add -A` reads it.** Staged and unstaged edits, deletions and untracked files come back, and a fresh box's `git status` matches the old box's. Ignored files don't: a `.env.local`, a build output or a local database file the agent made is gone on a fresh box. That is by design, and the panel says so on a reopened task. A task whose spec has `commitPaths` (the onboarding task) keeps only those paths' changes, with nothing staged, since its git proxy refuses any other path (ADR 0038, amended 2026-11-21).
- **Every update is a forced push.** Each turn's ref is a new commit whose parents are `HEAD` and the index commit, never the previous ref, so it is never a fast-forward of the old one, and the box pushes it with `+`. The git proxy accepts any non-delete update of the hidden ref (ADR 0030). GitHub accepted the ref's creation. A forced update of an existing ref, through an App token and through the proxy, hasn't run on GitHub, and F-096's test checks it.
- **The push skips hooks** (`--no-verify`), so a hook can't hold up or alter it. That includes git-lfs's `pre-push`, so an LFS-tracked file in the working tree may reach the ref without its objects. Nothing ran this. F-096's test has a case for it, and until it passes the docs say that LFS-tracked changes may not come back.
- **Whether GitHub starts CI for the ref is unknown.** The test repo has no workflow, so the control branch started none either. A push-triggered workflow in `test1` settles it (`build-order.md`, "Outside the code"). If CI does start, the only relief is the one under Consequences: push at idle.
- **A restore needs the commit it was saved on.** See "A moved branch" below.
- **The runner's git never searches above its workspace.** Spike 2's first run let git find the ostra checkout above its run folder and push its `main` into a stand-in remote. Every git call of the runner sets `GIT_CEILING_DIRECTORIES` (or an explicit `--git-dir`), in the runner's git helper from milestone 1.

**The idle timer** (Q42, Q99). A box stays warm for 15 minutes after a turn ends *(working value)*, then it stops.
- A turn that waits on a person follows the same timer. After 15 minutes the turn is cancelled and the box stops. The "needs you" item stays open, and answering it reopens the task with the decision.
- **`docker`:** a stopped box is kept until its host needs the space, so the next turn can resume in place.
- **`kubernetes`:** the pod is deleted.
- **`host`:** the agent's process stops. The worktree stays until cleanup needs the space (F-079).
- The box's lifecycle is a discriminated union: creating, preparing, ready ⇄ idle, stopped, then released, or failed.

**Reopening** tries three things, in order (Q53, ADR 0006):
1. **The same box**, while it's kept: the agent resumes its own session with `session/load`.
2. **A fresh box, from the archive. This is the normal path.** The box starts from the project's snapshot (ADR 0038), fetches the task's branches, restores the hidden ref, imports the archive and calls `session/load`. The import always names the box's workspace (for OpenCode, `session import --directory <workspace>`), because the archive records the absolute path of the box that made it and the agent rejects a different `cwd`. A move from a laptop to a container has two different paths.
3. **A rebuild from a fixed template**, when the archive can't be restored or another agent takes over the task. ostra makes no model call of its own. The template is string assembly, and holds:
   - the ticket, if the task has one, and the PR's text
   - every member message, oldest first
   - **every agent message, oldest first** (Q128)
   - **an interrupted turn's section:** when the last turn didn't finish, whatever it had written is set apart, labelled as an unfinished turn, and never takes the place of the agent's last reply
   - the branch's log with its file statistics
   - a line saying whether unfinished work was restored from the hidden ref

   It holds no tool output. That is the price of a template that makes no model call, and the one question of five it misses is about a tool's output. A cap on its size, 100,000 characters *(working value)*, cuts the oldest messages first and says how many it cut; it was measured only up to 6 turns.

**The template says "every agent message", and not "the last message"** (Q128). Spike 2 ran three forms on four runs, a stub and a real model, a quiet and a chatty interrupted turn. This ADR's first wording, read literally, took the last turn with any text as the last message. When the interrupted turn wrote a sentence before its tools, that fragment replaced the agent's last real reply and with it the decision: 3 of 5. The last finished turn's reply plus the interrupted turn's own section scored 4 of 5 in all four runs, and forgets by construction any decision made before the last finished turn. Every agent message plus the section scored 5 of 5 in all four. ostra's event log already marks how each turn ended (`turn.ended` with its stop reason), so the runner can tell the interrupted turn without a model.

**A moved branch** (Q150). A hidden ref restores only onto the commit it was saved on. If a commit lands on the task's branch between the last turn and the reopen (a suggestion a reviewer applied on GitHub, a push by a member), the fresh box restores the saved work onto that commit first, then merges the branch's new commits into it. On a conflict it leaves the ref alone, restores nothing, and raises a "needs you" item for the driver. This rule is untried; F-096's contract test has a case.

**A lost box** (Q150). A box that dies can't write a ref or an archive after its turn, so the hidden ref and the archive are those of the last finished turn, and the archive lacks the member's message that the lost turn was answering. The runner replays that message from the event log (ADR 0035) as the first prompt of the new session. The contract suite has a case for it.

A session records how it began: resumed in the same box, restored from an archive, or rebuilt from the template. Each reopen raises the task's lease epoch, so a stopped box that wakes up later can't write or push (`research/runner-transport.md` §6).

## Considered options

- **Keep the box, or pause it, while it waits on a person** (Q42 as first written; `research/elastic-sandboxes.md`'s "keep, pause or release"). Rejected: a box that waits holds its CPU and memory while nobody uses them, and `research/rivet.md` §4 recommends cancelling and resuming for long approvals.
- **One timer for idle boxes and another for waits.** Rejected: one timer is easier to explain, and both cases end the same way.
- **Keep a box for the task's whole life.** Rejected: at 1,000 tasks, most boxes would sit idle.
- **Save the archive and the hidden ref only when the box stops.** Rejected: a box can be lost without warning, on a crash or a lost node, so both happen after every turn.
- **Unfinished work as a tarball in the database.** Rejected: the hidden ref is plain git, goes through the same git proxy, and needs no new store (`research/elastic-sandboxes.md`, unknown 6).
- **Replaying the history as text into a new session**, as Rivet does with 12,000 characters. Rejected: weaker than both the archive and the template (`research/rivet.md` §5).
- **The template's "agent's last message" as the last turn with any text** (this ADR's first wording). Rejected: 3 of 5 whenever the interrupted turn wrote a sentence.
- **Only the last finished turn's reply in the template.** Rejected: 4 of 5, with no headroom, and it forgets a decision made earlier by construction. Every agent message costs a template that grows with the session, which the cap bounds.
- **A model-written summary of the history** (ADR 0006's third step as written). Rejected: ostra never calls a model itself (`project.md`). A fixed template keeps that true.

## Consequences

- Spike 4 checked the hidden ref on GitHub: GitHub accepts a push to `refs/ostra/wip/<task>` through the git proxy.
- **Spike 2 (`can-a-session-move-to-a-fresh-box`) gates the choice of agent as much as spike 1 does, and its result is in** (Windows only, in directory boxes with no containers; B3, B4 and B5 pass, nothing failed, B1 and B2 are skipped for want of Docker and of a workflow in the test repo). On OpenCode 2.3.0 to 2.3.2, an agent restored from an exported archive answered 5 of 5 questions about earlier turns, with every tool call rejected while it answered, and finished the edit it was interrupted in, on a stub and on a real model. A fresh box without the archive couldn't load the session. The hidden ref brought back a staged new file, an unstaged edit, a staged delete and an untracked file. The move survived a patch upgrade, an upgrade across two releases and a rollback. So step 2 stays the normal path, and neither fallback fired: ADR 0006's "if an archive can't be restored reliably" and ADR 0032's reopening rule.
- **OpenCode's export and import are `experimental`.** They are in its binary and in the `experimental` part of its HTTP API, and in none of the docs pages the spike read. They work on 2.3.0 to 2.3.2 in both directions and keep the session ID, after failing a round trip on 2.0.4 (`research/rivet.md` §5). So the agent's version is pinned in the base image, the restore test runs on every bump as its own CI job, and step 3 must be good on its own.
- **Archives are small.** A 200-turn session is 1,088,403 bytes, 175,891 gzipped, and a 1,000-turn one 875,644 gzipped (about 5.2 MiB raw), against the blob cap of 64 MiB (ADR 0043). Compaction doesn't shrink an archive. The blob store still takes them, and an S3-compatible store is still recommended above a few hundred tasks a day, because every turn uploads the whole archive again.
- **The restore is fast, on the test bench.** 200 turns restored in 2,525 ms against the working value of 30 s: clone 122, hidden ref 306, download 10, import 1,008, spawn and initialize 323, `session/load` 733 ms. That is a directory box, a local repo and a loopback blob store, so it leaves out a container's start, the pull of a project's snapshot, a real clone and network, and the first model request after the load, which carries the whole history again. The after-turn work (commit and push, hidden ref, export, gzip, upload) took 0.8 to 1.1 s a turn, about half of it the export *(working figures, one Windows machine)*.
- **`session/load` replays the whole history as updates**: 31 for a 6-turn session, 586 for 200 turns and 2,934 for 1,000. The runner marks them so they aren't stored as new events (ADR 0035). The contract suite tries `session/resume` after an import, which OpenCode's docs say doesn't replay; if it works, it saves the replay.
- **The archive carries more than the conversation:** the box's absolute workspace path, the model's reasoning, cost and token counts, and tool outputs that hold local paths. It is session content, stored and checked like the task's history and never logged. Whether OpenCode's `--sanitize` flag redacts enough, and whether a sanitized archive restores, is unverified. So is whether undo works across a move.
- **Not yet run:** real containers (B1's four checks), a real model across patch versions, a real long session with compaction on (whether a model's summary keeps turn 1's fact), other models, Linux and macOS, a task with several repos (a hidden ref per repo, restored together), a box lost mid-turn, a moved branch, an LFS file, and an import into a box that already has the session, which OpenCode's API answers with a 409.
- An archive never holds a real credential, because the agent never had one (ADR 0030). It holds the session's content, so it's stored and checked for access like the task's history, and never logged.
- A push after every turn may cost a project too much CI time. If it does, the project can choose to push only when the box goes idle.
- If members dislike the wait after a pause, the warm time becomes a project setting.
- Cleanup (F-079) covers stopped boxes and blobs. **It deletes refs, never LFS objects, and ostra can't give a task's LFS storage back.** Spike 4's cleanup deleted its test refs and the LFS objects stayed in the repo's storage. GitHub says the same: the objects "continue to count toward your Git LFS storage quota" until the repository is deleted and recreated. So a task's LFS objects count against the organization's quota on the code host's side, and the docs and the configuration reference say so and promise nothing else (Q120). The test repo `test1` has to be recreated now and then, or LFS tests use a throwaway repo.
- The wait for a person is the idle timer, **15 minutes** (above). Spike 1's test list said 10 minutes for a held request. They are aligned to 15, so one timer governs both.
- Ledger rows: F-033, F-045, F-047 and F-096.
