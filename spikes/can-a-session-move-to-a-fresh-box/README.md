# Spike 2: can a session move to a fresh box?

Milestone 0, spike 2 (`context/build-order.md`). Throwaway code: it answers one question. Its finding goes into `context/research/` once the runs that need Docker, and a CI workflow in the GitHub test repo, are in.

## The question

Can a task carry on in a new box, with its context and its unfinished work?

**Tests the decisions:** Q42, Q53, Q99 (ADR 0039, and ADR 0006's three steps as amended). F-033 rests on it.

**Passes when** (copied from `context/build-order.md`):

- After export, upload, a fresh container, import and `session/load`, the agent answers 5 of 5 questions about earlier turns and finishes an edit it was interrupted in.
- Uncommitted and untracked files come back from the hidden ref. GitHub accepts that ref and starts no CI for it.
- It still works after OpenCode's patch version changes.
- A 200-turn session restores in under 30 s *(working value)*. The archive's size is recorded.
- The rebuild template alone gets at least 4 of 5.

**If it fails:** pin another OpenCode version, or make the rebuild template the normal path and say so in F-033.

## Architecture

```
harness (pnpm spike)
 ├─ stub model (OpenAI format, scripted) ── or the endpoint in model.env
 ├─ "GitHub": a local bare repo per task; the task's branch
 ├─ "the server": a loopback blob store (PUT/GET, bearer token, files on disk)
 │
 ├─ box A ── a directory tree (workspace clone, HOME, XDG, temp) or, with Docker, a fresh container;
 │    key proxy; `opencode acp`; six turns; after each: commit + push (finished turns), hidden ref,
 │    export → gzip → upload; then destroyed: agent stopped, container removed, the tree deleted
 │
 ├─ control ── fresh box, no import: session/load must fail
 ├─ box B ── fresh box at A's path: clone, hidden ref, download, `session import`, `opencode acp`,
 │           session/load, 5 questions (tools rejected), "finish the interrupted edit"
 ├─ template ── fresh box, new session from the fixed rebuild template, the same 5 questions;
 │              then the template's two other forms, each on a fresh box of its own (below)
 └─ elsewhere ── fresh box at another path, `session import --directory`, session/load (recorded)
```

- **Copied from spike 1** (`src/lib/`, not imported): the ACP driver, the key proxy, the usage meter, the stub model servers, the process-tree helpers and the OpenCode launch helpers. `opencode.ts` resolves the binary per patch version (2.3.2, 2.3.1, 2.3.0), and its 1.x config builder is gone.
- **Two kinds of box** (`src/harness/fixture.ts`). A *directory* box is a tree with its own workspace, HOME, XDG and temp dirs, so OpenCode's database lives in the box and dies with it. A *container* box (`src/lib/docker-box.ts`) is a fresh container per box, from an image with git, Node 24.14.0 and the pinned `@opencode/cli-linux-*`. The box's tree is mounted at `/box`, so the host's git and the checks see the workspace. OpenCode's data, HOME and XDG data/state/cache are in the container's own filesystem. The agent is `docker exec -i <box> opencode acp`, and the CLI calls are `docker exec <box> opencode session …`. The agent's variables go in by name (`-e NAME`), so the fake key is never an argument. The key proxy then listens on `0.0.0.0` and the agent reaches it as `host.docker.internal`. Every container carries the run's label. **Built, never run:** this machine has no Docker.
- **The agent's reach** (`src/lib/deciders.ts`). Every box's OpenCode config asks for every tool (`* * ask`) and denies `external_directory`. The decider approves a tool call only when every path it names (ACP `locations`, and path fields of `rawInput`) resolves inside the box's workspace. It reads shell commands too, and rejects one that names an absolute path outside the workspace, a parent dir (`..`) or the home dir (`~`, `$HOME`, `%USERPROFILE%`). It also rejects network fetches. That's a guard against mistakes, not a boundary: a shell command can reach outside without naming a path. Only a container closes that, so on a directory box a real model still runs as the member's OS user.
- **The hidden ref** (`src/lib/hidden-ref.ts`): `refs/ostra/wip/<task>`, as ADR 0039 names it. The commit has a `git stash` shape. Its tree is the working tree, read through a temporary index (`git add -A`, so ignored files stay out). Parent 1 is HEAD, and parent 2 is a commit of the index, so the staged state comes back too. Saving never touches HEAD, the index or a branch. Restoring on a fresh clone is a two-tree `read-tree -m -u` from HEAD to the saved tree, then the index from parent 2.
- **The session archive** (`src/lib/session-archive.ts`): `opencode session export <id> --standalone` and `opencode session import <file> --standalone [--directory]`, run with the box's own environment, on the host or in the container. `--standalone` runs a private server for the one command, so OpenCode's background service never starts (spike 1, finding 5). The archive is gzipped and goes through the blob store (`src/lib/blob-store.ts`), never through a log. Blob keys are a branded `BlobKey` (`<task>/<name>`).
- **The rebuild template** (`src/lib/rebuild-template.ts`): string assembly only, no model call. It holds the ticket, the PR's text, every member message, the agent's last message, `git log --stat` of the branch, and a line saying whether unfinished work was restored. Each part is fenced longer than any backtick run inside it. **The agent's last message is its reply in the last turn that finished** (`end_turn`). When the last turn was interrupted, what the agent had written in it gets a section of its own, "The turn that was interrupted", and never takes the last message's place (finding 7). The run builds three forms, each in a new session on its own fresh box (`src/cases/move.ts`, `TemplateForm`):
  - *fixed*: the template above. B5 gates on it.
  - *literal*: ADR 0039's wording read literally, the spike's first form: the last turn with any text is the last message, an interrupted turn's fragment included. Recorded only, to compare with the runs before the fix.
  - *every*: every agent message, oldest first. A proposed variant, a check of its own in B5.
- **The question set** (`src/harness/questions.ts`): one question per kind of trace. q1 is a fact the member stated, q2 a file the agent created, q3 a tool output (`RESULT-<n>` from the clock), and q4 an edit the member asked for. q5 is a decision the agent stated (a port): the last port turn 5's reply states, because a real model can think aloud and name others first (finding 12). The facts are random per run. The agent is told to answer from memory, and the box enforces it: during a question every tool call is rejected, and an answer counts only when it holds the fact and no tool call completed during it. So q2 and q4 can't be read back off the disk.
- **The interrupted turn is checked, not assumed.** After the cancel, the harness checks that turn 6 ended `cancelled`, that the slow check was running when the cancel went out, and that the last edit (step 7) isn't on disk. A move passes "finishes an edit it was interrupted in" only when all three hold.
- **The stub never remembers anything.** It answers a question by finding the fact in the messages OpenCode sent it in that request. So a stub's right answer proves the fact reached the model's context after the move, and the real model shows the agent uses it.
- **Two long sessions** (`src/cases/long-session.ts`). The gating run (B4) has auto-compaction off and a 10M-token context, so turn 1 stays in the context verbatim. A second run, recorded only, keeps OpenCode's defaults (a 128K context, auto-compaction on), as a real long session would. The stub answers OpenCode 2.3.2's compaction call in the template its prompt asks for (read from the binary). Its summary keeps the codename, as the prompt's "preserve exact … identifiers" rule asks. A real model may keep less.
- **GitHub** (`src/lib/github.ts`, `src/cases/github-ref.ts`): the test App's JWT signed with `node:crypto`, an installation token for the one test repo, and REST calls through `fetch`. git gets the token through `GIT_CONFIG_*` environment variables, never as an argument. The token asks for `contents: write`, `actions: read` and `metadata: read`. A second, optional token adds `checks: read`; if the App lacks it, GitHub refuses that mint, and the run records that check suites weren't readable. After the control branch's CI shows up, the run looks again for runs on any other ref, so the quiet window lasts until GitHub has visibly handled a push. The run deletes the control branch and the hidden ref when it ends.

## How to run it

```sh
cd spikes/can-a-session-move-to-a-fresh-box
pnpm install          # its own workspace; no install script runs
pnpm typecheck        # strict tsc
pnpm lint             # the root's ESLint rules (eslint.config.js), run with the root workspace's ESLint
pnpm test             # unit tests: hidden ref, template, the last message and the stated port, blob store and keys, stub patterns and compaction answer, decider, key proxy, usage meter
pnpm check:inputs     # which inputs are present; never prints a value
pnpm spike            # every criterion it can run here, about 10 minutes with model.env and GitHub (GitHub's quiet window is 4 of them)
pnpm spike --only=stub,patch,long   # a subset: stub (with stub:chatty), model (with model:chatty), patch, long, container, github
pnpm spike --turns=1000             # longer long sessions
pnpm spike --allow-skipped          # exit 0 when nothing failed, even if a bullet was skipped
pnpm clean                          # deletes .runs/
```

`--only` takes group names, and a run's own name (`stub:chatty`, `model:chatty`, `patch:up`) selects its group. `model:chatty` is the endpoint run with one line added to the interrupted turn's prompt: "Before your first tool call, tell me in one short sentence what you are about to do." It makes a real model do what the chatty stub does. An unknown name, or an unknown argument, stops the harness with exit 64 before anything runs.

`pnpm spike` exits 1 when a bullet fails or the process check fails. It exits 2 when nothing fails but a bullet is skipped, and 0 only when every bullet passes. Each run writes `.runs/run-<time>/` (gitignored): `report.json` (with the answers and agent text, which are session content and never printed), `status.md`, the stand-in remotes and the blobs. Boxes are deleted as the run goes. A run keeps the three newest runs, the runs this README cites, and any run still going (its folder holds a `.running` file with its PID).

It ends with a sweep, also run on Ctrl+C or SIGTERM. The sweep finds this run's processes: the agents and the OpenCode CLI calls by PID and creation time, and anything with the run's folder or marker in its command line (the slow checks). It also finds this run's containers, by label. Another run's processes match none of these, so parallel runs leave each other alone. The sweep is a check of its own, "no process left behind". It fails when it had to kill or remove anything, when a process survives the kill, or when the process list can't be read.

The unit tests write only under `.runs/` (`test/temp-dir.ts`), never to the system temp dir.

### Inputs

| Input | Needed by | If missing |
|---|---|---|
| `OSTRA_DEV_MODEL_BASE_URL`, `OSTRA_DEV_MODEL_API_KEY`, `OSTRA_DEV_MODEL_ID`, from the environment or `~/.config/ostra-dev/model.env` | B1 and B5 with a real model | Those checks are SKIPPED |
| `OSTRA_DEV_MODEL_API_FORMAT` (`openai` or `anthropic`), optional | the endpoint run | Detected from `GET /models` |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_TEST_ORG`, `GITHUB_TEST_REPO` (`GITHUB_APP_INSTALLATION_ID` optional), **from the environment only**: `set -a; . ~/.config/ostra-dev/github.env; . ~/.config/ostra-dev/github-test.env; set +a`. The test repo needs a push-triggered workflow, so the control can show CI starting for a branch. The App needs `contents: write` and `actions: read`; `checks: read` is optional | B2's GitHub checks | SKIPPED |
| Docker (`docker version` answers), and the network the first time, to build the box image (`node:24.14.0-bookworm-slim`, git, `@opencode/cli-linux-*` from npm) | B1's fresh containers | SKIPPED |

LINEAR_* and DATABASE_URL aren't used. The spike needs no Postgres: the blob store is a stand-in on disk.

## Status on this machine (2026-11-18)

Windows 11 Pro (build 26200), Node 24.14.0, pnpm 11.28.2, git 2.53.0. All three input files were loaded into the environment (`set -a; . ~/.config/ostra-dev/model.env; . ~/.config/ostra-dev/github.env; . ~/.config/ostra-dev/github-test.env; set +a`): the model endpoint, and the test GitHub App on the sandbox org's first test repo. There's no Docker.

Two full `pnpm spike` runs today, both with every input but Docker:

- **Before the fixes:** `run-2026-11-18T20-00-24-b039`. It exited 1: B1 and B5 failed, B2 was SKIPPED, and B3 and B4 passed. B1 failed only on a scoring mistake of the harness's, not the agent's (finding 12).
- **After the fixes:** `run-2026-11-18T20-09-58-5f8c`. The template's last message is now the last finished turn's reply (finding 7), and q5's port is the last one turn 5 states (finding 12). The run also adds `model:chatty`. It exited 2: B3, B4 and B5 pass, and B1 and B2 are SKIPPED, each on one check: B1 on Docker, and B2 on CI, because the test repo has no workflow. No check failed.

In both runs the process check passed (the final sweep killed 0 processes and removed 0 containers, and 0 survived). A check afterwards found no `opencode` process. A listing of both test repos' refs through the App found no `refs/ostra/*` and no `ostra-spike2-*` branch: each run had deleted its own (HTTP 204 for both). `pnpm typecheck` and `pnpm lint` are clean, and `pnpm test` passes 41 of 41.

The table is the run after the fixes. Each column is one kind of input. *Stub* is the scripted model with a local bare repo as "GitHub". *model.env* is the real endpoint, run twice: as it comes, and as `model:chatty`. *GitHub* is the test App and repo.

| | Status | Bullet | Stub | model.env | GitHub |
|---|---|---|---|---|---|
| B1 | **SKIPPED** | After export, upload, a fresh container, import and `session/load`, the agent answers 5 of 5 questions about earlier turns and finishes an edit it was interrupted in. | PASS really interrupted (`cancelled` during the slow check, the last edit not on disk)<br>PASS export, upload, a fresh box, import and session/load replay the history (31 updates, turn 1 among them; the import keeps the session ID)<br>PASS 5 of 5<br>PASS the interrupted edit is finished<br>PASS control: a fresh box without the archive can't load the session (`session not found`)<br>**SKIPPED** in fresh containers (the four checks): needs Docker | PASS really interrupted<br>PASS 5 of 5, with every tool rejected while it answered<br>PASS the edit finished<br>Recorded, `model:chatty`: 5 of 5, the edit finished | n/a |
| B2 | **SKIPPED** | Uncommitted and untracked files come back from the hidden ref. GitHub accepts that ref and starts no CI for it. | PASS uncommitted changes come back: `git status` in box B equals box A's (`A  src/<module>.ts`, ` M notes.txt`, `D  old.txt`, `?? scratch/<module>-plan.md`)<br>PASS untracked files come back<br>PASS the hidden ref leaves the branch alone (not moved; its commit is on no branch)<br>PASS a plain clone doesn't fetch `refs/ostra/*` | n/a | PASS GitHub accepts the ref: the push succeeds, and the API reads `refs/ostra/wip/<task>` back at the saved commit<br>PASS the ref on GitHub restores into a fresh clone (3 status entries, the same as saved)<br>**SKIPPED** starts no CI: the test repo has 0 workflows, so the control branch started none either (none after 184 s), and the check can't tell anything. Its hidden ref got 0 workflow runs and 0 check suites over a 247 s window |
| B3 | PASS | It still works after OpenCode's patch version changes. | PASS 2.3.0 → 2.3.2 (five days apart): really interrupted, restored, 5 of 5, edit finished<br>PASS 2.3.1 → 2.3.2 (82 minutes apart): the same<br>PASS 2.3.2 → 2.3.1 (a rollback): the same | n/a | n/a |
| B4 | PASS | A 200-turn session restores in under 30 s *(working value)*. The archive's size is recorded. | PASS 2,525 ms from an empty box to `session/load` returned (2,074 ms of it the session's own: download, import, start, load), **with compaction off**<br>PASS the restored session still answers with turn 1's fact<br>PASS recorded: 1,088,403 bytes, 175,891 gzipped, 693 messages | n/a | n/a |
| B5 | PASS | The rebuild template alone gets at least 4 of 5. | PASS quiet interrupted turn: 4/5 (q3 wrong)<br>PASS chatty interrupted turn: 4/5 (q3 wrong)<br>PASS every agent message: 5/5 in both | PASS as it comes: 4/5 (q3 wrong)<br>PASS `model:chatty`: 4/5 (q3 wrong)<br>PASS every agent message: 5/5 in both | n/a |

**B5, before and after the fix.** The fixed template now takes the last finished turn's reply as the last message. Each form below is a new session on a fresh box. The chars column is how much the interrupted turn wrote before the cancel:

| Run | Chars | *literal*: ADR 0039 read literally (before) | *fixed* (after) | *every* agent message |
|---|---|---|---|---|
| Stub, quiet | 0 | 4/5 (q3) | 4/5 (q3) | 5/5 |
| Stub, chatty | 67 | **3/5 (q3, q5)** | 4/5 (q3) | 5/5 |
| model.env, as it comes | 0 | 4/5 (q3) | 4/5 (q3) | 5/5 |
| model.env, `model:chatty` | 180 | **3/5 (q3, q5)** | 4/5 (q3) | 5/5 |
| model.env, `run-2026-11-18T19-01-29-c6ee` (earlier, before the fix) | 25 | **3/5 (q3, q5)** | not built yet | not built yet |

The scoring didn't change: the same five questions, the same rule (the answer holds the fact, and no tool completed during it), and the same bar of 4 of 5. The template's session finished the interrupted edit in every run, in all three forms.

**Recorded** (the run after the fixes unless named):

| What | Value |
|---|---|
| Restore of the 6-turn session, empty box to `session/load` | 2,551 ms (stub); 2,465 ms (model.env); 2,421 ms (`model:chatty`); 2,445 to 2,616 ms (the patch runs) |
| Its phases (stub) | clone 145, hidden ref 318, download 5, import 1,012, spawn and initialize 341, `session/load` 709 ms |
| The 6-turn archive | 22,654 bytes, 3,525 gzipped (stub); 41,402 and 6,716 (model.env); 42,831 and 7,357 (`model:chatty`) |
| After-turn work per turn: commit and push, hidden ref, export, gzip, upload | 825 to 1,056 ms |
| `session import --directory` into another path, then `session/load` there | loaded; 5 of 5 |
| Tool calls the workspace decider saw | stub: 10 approved on box A, 1 on box B, 0 rejected; model.env: 16 and 2 approved, 0 rejected |
| Answers during which the agent tried a tool | 0 of 5 (stub); 0 of 5 (model.env) |
| Ignored files (`debug.log`) come back from the hidden ref | no, by design |
| The 200-turn restore's phases (compaction off) | clone 122, hidden ref 306, download 10, import 1,008, spawn and initialize 323, `session/load` 733 ms; 586 updates replayed |
| The 200-turn session: building it, exporting it | 23 s; export 508 ms |
| **200 turns with compaction on** (OpenCode's defaults: 128K context, auto-compaction) | 2 compaction calls; 1,085,026 bytes, 175,586 gzipped (`compaction 2` among the message types); restored in 2,553 ms; turn 1's fact answered, from the stub's summary |
| **1,000 turns, compaction off** (`--turns=1000`, `run-2026-11-18T19-11-59-12c3`, before the review fixes) | 5,445,678 bytes, 875,644 gzipped, 3,467 messages; restored in 2,461 ms, import 957 ms, `session/load` 767 ms; turn 1 still answered |
| The template prompt | 2,569 to 2,847 chars (the fixed form) |
| Ports named in the model's turn-5 reply | 3 (model.env) and 4 (`model:chatty`); in `run-2026-11-18T20-00-24-b039` it named 4173 first and settled on 4500 (finding 12) |
| GitHub: the App's tokens | one with `contents: write`, `actions: read` and `metadata: read`; a second with `checks: read` minted too, so check suites were readable |
| GitHub: workflows in the test repo | 0 active, and no `.github/workflows` directory. The App has no `workflows` permission, so it couldn't push one either |
| GitHub: the hidden ref's CI | 0 workflow runs and 0 check suites after the 60 s quiet wait, and 0 runs on any ref once the control's wait ended (247 s in all). The control branch got 0 runs in 184 s |
| GitHub: cleanup | the control branch and the hidden ref deleted (HTTP 204 each), in both runs; neither run left a ref on either test repo |
| GitHub: the whole check | 256 s, most of it the two waits |
| Binaries, `@opencode/cli-windows-x64`, SHA-256 | 2.3.2 `5d52d86e2c3fd2c4d51cefc893f64c9ee66bc2e9535332195802f7c646b2a3a3` (the same as spike 1's); 2.3.1 `11556a2ee7d8b9a2f2b09c06f101c19be536f8bbed6d2f5498d3d25edab51b6b`; 2.3.0 `38153a142354634c82b5cfe6c00b19df15a71e6cf8c17ef5f5c1a4cc684a6917` |

### Findings worth carrying into the research file

1. **OpenCode 2.3.x's export and import round-trip.** `research/rivet.md` §5 cites a failed round trip on 2.0.4 (opencode#49314). On 2.3.0, 2.3.1 and 2.3.2, in both directions, the import keeps the session ID. In a box whose OpenCode data started empty, `session/load` replays the history, and the agent uses it: a real model answered 5 of 5, with every tool rejected while it answered, and finished the edit. It did so in both endpoint runs after the fixes.
2. **The archive is the session.** Without it, `session/load` on a fresh box fails with `session not found`. Nothing on disk outside the archive carries it.
3. **The path needn't match.** `session import --directory <path>` binds the session to another directory, and `session/load` works there. `research/rivet.md` §5 says `session/load` needs the same `cwd`. So a box's workspace path can differ from the old box's, if the import names it.
4. **Restore time is mostly fixed cost.** About 2.4 to 2.6 s on this machine, whatever the size: 6 turns 2.5 s, 200 turns 2.5 s, 1,000 turns 2.5 s. Import, `session/load` and the agent's start are each under 1.1 s. Against the 30 s working value, the headroom is for the container's own start and the repo's clone. The container start isn't measured here (no Docker); the container run records it as its own phase.
5. **Archive size.** About 5.4 KB a turn raw and 0.9 KB gzipped, with turns sized like real work (a 24 KB file read every fifth turn, 4 KB of shell output every tenth). gzip shrinks it about 6x. A real model's 6 turns came to about 42 KB raw and 7 KB gzipped. ADR 0039's "several megabytes" holds only for long sessions: 1,000 turns is 5.4 MB raw and 0.9 MB gzipped.
6. **Compaction doesn't shrink the archive.** With OpenCode's defaults, a 200-turn session compacted twice, and its export was about the same size (1,085,026 bytes against 1,088,403). The export keeps every message and adds the `compaction` entries. The restore took the same time. Turn 1's fact survived only because the stub's summary kept it, so whether a real model's summary keeps such a fact is open.
7. **An interrupted turn's fragment must not count as the agent's last message.** Read literally, ADR 0039's "the agent's last message" is the last turn with any text. When the interrupted turn writes a sentence before its tools ("I'll start with step 1.", 25 chars from the real model in `run-2026-11-18T19-01-29-c6ee`), that fragment becomes the last message. The template then loses the agent's last real reply, and with it the decision (q5): 3/5, and B5 fails. That happened to the chatty stub, to the real model on its own, and to the real model when asked to be chatty (`model:chatty`, 180 chars). The fix stays within the plan's rule: a fixed template, string assembly, no model call by ostra. **The last message is the reply of the last turn that finished** (`end_turn`), and an interrupted turn's text gets its own section, "The turn that was interrupted". After the fix the fixed template scored 4/5 in all four runs: stub quiet, stub chatty, model.env, and `model:chatty`. Each time the miss is q3, a tool's output, which the template never holds by design. ostra's event log already marks how each turn ended (ADR 0035), so the runner can tell which reply is the last finished one. The variant with **every agent message** scored 5/5 in all four runs, and it also makes no model call. Whether F-033 and ADR 0039 take "the last finished turn's reply" as their wording, or every agent message, is the maintainer's call. The open question isn't filed yet: this spike writes only in its own folder.
8. **After-turn work costs about 1 s a turn** on this machine: commit and push, the hidden ref, the export, gzip and upload. Most of it is spawning OpenCode for the export. A runner may want to export through the running agent's own server instead (OpenCode's HTTP API), which this spike didn't try.
9. **The archive points at OpenCode's internal snapshots.** Each assistant message holds `snapshot.start` and `snapshot.end` tree hashes from OpenCode's own snapshot store in its data dir, which a fresh box doesn't have. So `/undo` or a revert across a move probably fails. **Unverified.**
10. **A runner's git must never search above its workspace.** The harness's first run created the task's branch with the run folder as cwd. That folder sits inside the ostra checkout, so git acted on ostra's own repo: it read ostra's `main` and pushed it into the stand-in remote. Only local files were touched. Every git call now runs with `GIT_CEILING_DIRECTORIES` set to the run folder, and the branch is made inside the bare repo. The runner needs the same guard, or an explicit `--git-dir`.
11. **OpenCode's permission rules reach ACP.** With `* * ask`, every tool call came to the decider as `session/request_permission`: 10 on a stub box A, 16 on the model's. So a runner can enforce its own path rules on top of OpenCode's `external_directory: deny`. Neither covers what a shell command reaches, and only a container does.
12. **The real model thinks aloud in its replies.** Its turn-5 reply named several ports before it settled, 3 or 4 in the run after the fixes: "I will use port 4173 is outside range... Let's choose 4500." and then "I will use port 4500 because …". The harness took the first port as the fact, so in `run-2026-11-18T20-00-24-b039` it expected 4173. The agent answered 4500, its decision, and was marked wrong three times: after the move (B1 4/5), in the literal template, and in the every-message one. The harness now takes the last port the reply states. A panel that reads facts out of agent text (a summary, a "what did it decide") meets the same thing.
13. **GitHub takes a push to `refs/ostra/wip/<task>` from an App installation token.** The REST API reads the ref back at the pushed commit, a fresh clone fetches and restores it, and the App's token can delete it (HTTP 204). In 247 s the ref got no workflow run and no check suite, but with no workflow in the test repo that proves nothing yet (B2's last check).

## What's left

- **Fresh containers** (B1). Run `pnpm spike --only=stub,container` on a machine with Docker. The docker executor is built but has never run, so expect a fix or two. On Docker Desktop the bind mount, `host.docker.internal` and the proxy on `0.0.0.0` are the likely places. Then the container start joins the restore time (finding 4). Spike 3 builds the real box. Until this runs, every B1 PASS is a fresh directory tree with its own HOME and XDG dirs, not a container.
- **GitHub's CI** (B2's last check). The test repo needs a push-triggered workflow, for example `.github/workflows/ci.yml` with `on: push` and one `echo` step. The maintainer adds it: the App has no `workflows` permission. Then run `pnpm spike --only=stub,github`. Everything else on GitHub has passed.
- **The template** (B5). The maintainer decides the wording for ADR 0039 and F-033: the last *finished* turn's reply with the interrupted turn on its own (4/5 in every run, finding 7), or every agent message (5/5 in every run). The open question goes into `context/open-questions.md`: "Rebuild template: the last finished reply, or every agent message?"
- **The agent's reach.** On a directory box, the model run's shell is only guarded, not bounded. Run the model case in a container once the executor works.
- **Compaction with a real model.** Run the long session with compaction on through model.env, and see whether its summary keeps turn 1's fact (finding 6).
- Re-run B3 on each OpenCode bump. The pinned versions here are five days apart at most.
- Check finding 9 (undo across a move) if the panel offers undo.
- Run on Linux and macOS. Only Windows has run, and the POSIX process paths are spike 1's, untested here.
- Write `context/research/spike-can-a-session-move-to-a-fresh-box.md` from these runs, with every claim cited, in the commit that adds the spike.

## Dependencies

All pinned exactly.

| Package | Version | License | Why |
|---|---|---|---|
| `@agentclientprotocol/sdk` | 2.7.0 | Apache-2.0 | The driver, copied from spike 1 (answers 4.6, ADR 0032) |
| `@opencode/cli` | 2.3.2 | MIT | OpenCode, the version spike 1 and `research/rivet.md` pin. The `@opencode/cli` package carries the 2.x line (the `opencode-ai` package on npm is 1.x). Spike 1 named this addition beyond the allowed list too |
| `opencode-cli-2-3-1` → `@opencode/cli@2.3.1` | 2.3.1 | MIT | The patch before, for B3 (a pnpm alias) |
| `opencode-cli-2-3-0` → `@opencode/cli@2.3.0` | 2.3.0 | MIT | Two patches before, for B3 (a pnpm alias) |
| `zod` | 4.6.7 | MIT | Validation at every boundary |
| `typescript` | 7.0.2 | Apache-2.0 | `tsc --noEmit`; the code runs on Node 24's type stripping |
| `@types/node` | 24.19.2 | MIT | Node types |
| `vitest` | 5.1.1 | MIT | Unit tests |

No other npm dependency. The GitHub calls use `node:crypto` and `fetch`, not Octokit, and the blob store is `node:http`. The container image, built only where Docker is, starts from `node:24.14.0-bookworm-slim` (Node: MIT; Debian's packages under their own licenses) and installs `git`, `ca-certificates` and `procps` from Debian and `@opencode/cli-linux-*` (MIT) at the pinned version. `pnpm lint` runs the root workspace's ESLint 10.15.0, typescript-eslint 8.73.0 and eslint-plugin-unicorn 80.0.0 (all MIT), so it needs the root's `pnpm install`. The wrappers' postinstall scripts are denied (`allowBuilds`): the binaries are resolved from the platform packages. pnpm 11's minimum release age needed exclusions for the pinned OpenCode and vitest releases.
