# Research: Spike 2, `can-a-session-move-to-a-fresh-box`: can a task carry on in a new box, with its context and its unfinished work?

**Status:** Research, 2026-11-18. Feeds ADR 0039 (idle boxes, hidden refs and session archives), ADR 0006 (tasks are long-lived), ADR 0043 (the real size of an archive), ADR 0032 (the reopening rule) and F-033, F-096 and F-047. Tests the decisions behind Q42, Q53 and Q99 (`PASSBAR`). It runs the cases T11 and T12 of the test list in `research/rivet.md` (`RIVET:492-493`).
**Method:**
- I did not re-run `pnpm spike`. A full run takes about 10 minutes, spends model tokens, and waits 4 minutes on GitHub. I read the runs' own `report.json` and `status.md`, and the console logs beside them. The run that answers the question is `run-2026-11-18T20-09-58-5f8c`: it started at 20:09:58Z, its report was written at 20:20:00Z (10 min 2 s), and it exited 2, "some bullets were SKIPPED" (`SPIKE/.runs/real-2.log`, last lines; `SPIKE/src/harness/spike.ts:209-212`).
- Four earlier runs are kept in `SPIKE/.runs/`. I use them only where I name them: `RUN-1901` (`run-2026-11-18T19-01-29-c6ee`, the first with a real model), `RUN-1911` (`...19-11-59-12c3`, 1,000 turns), `RUN-1951` (`...19-51-54-3316`) and `RUN-2000` (`...20-00-24-b039`, before the port fix in surprise 4). Their code was older than the code that ran in `RUN`, so they are evidence for how the harness changed, not for the result.
- **Stub** below means: the real OpenCode binary, with a scripted model server behind it, and a local bare repo standing in for GitHub. **Real model** means the endpoint in `model.env`. **Real GitHub** means the test App on the sandbox org's `test1` repo. Every box that passed is a fresh **directory tree** with its own workspace, HOME and XDG dirs, not a container (`README:42`; `SPIKE/src/harness/fixture.ts:222`).
- The code that ran is the code in the working tree. The newest file under `SPIKE/src` and `SPIKE/test` was written at 21:09:43 local time (20:09:43Z), 15 s before `RUN` began (file times). `README.md` was edited afterwards. I ran no git, and the session's git status at its start listed this spike's files as modified and `SPIKE/test/history.test.ts` as untracked, so I can't say what `HEAD` holds. I cite the working tree.
- I re-ran `pnpm typecheck` and `pnpm lint` in the spike on 2026-11-18: both exit 0. I did not re-run `pnpm test` (README, not rerun: 41 of 41, `README:100`).
- I ran four read-only commands on the pinned OpenCode 2.3.2 binary (`--version`, `session --help`, `session export --help`, `session import --help`), and downloaded OpenCode's OpenAPI document to read it locally. Both went to the session's scratchpad, not the repo. I re-hashed the three Windows binaries: the SHA-256 values equal the README's (`README:147`). I read the structure of the real model's archive in `RUN`, and searched all 27 session archives under `SPIKE/.runs/*/blobs` for the word "snapshot". They are synthetic sessions.
- I read these docs on 2026-11-18: OpenCode's ACP page, CLI page and `llms.txt`; its OpenAPI document; the ACP session-setup page; GitHub's page on events that trigger workflows; git's `push` page and the git-lfs `pre-push` man page; and the npm registry for versions, licenses and release times.
- I print no value from `model.env`. The model's ID is not named here, and the run's report doesn't record it (section 3, gotcha 16).
- Anything from the README that I didn't rerun is marked "README, not rerun". Anything I read in the code and didn't run is marked "inferred". Anything I couldn't check against a primary source is marked **unverified**.

**Source links.**
- `SPIKE` means `spikes/can-a-session-move-to-a-fresh-box`. A cite like `SPIKE/src/lib/hidden-ref.ts:90-121` is a file and its lines.
- `RUN` means the output of `run-2026-11-18T20-09-58-5f8c`, cited by criterion (B1 to B5) and check name. Its structured copy is `SPIKE/.runs/run-2026-11-18T20-09-58-5f8c/report.json`, with `status.md` beside it. `.gitignore` excludes `.runs/` (`SPIKE/.gitignore:3`), so they stay on this machine.
- `PASSBAR` means the spike's pass bar, `context/build-order.md:97-106`. `README` means `SPIKE/README.md`. `ADR39` means `context/decisions/0039-idle-boxes-hidden-refs-and-session-archives.md`, `ADR06` is `0006-tasks-are-long-lived.md`, `ADR32` is `0032-opencode-first-own-acp-driver.md`, `ADR43` is `0043-files-and-blobs.md`. `RIVET` means `context/research/rivet.md`.
- `OC-ACP` means [OpenCode's ACP page](https://opencode.ai/docs/cli/acp). `OC-API` means [OpenCode's OpenAPI document](https://opencode.ai/docs/openapi.json). `OC-HELP` means the `--help` output of the pinned 2.3.2 binary. `ACP` means [the ACP session-setup page](https://agentclientprotocol.com/protocol/session-setup).

---

## Facts (checked 2026-11-18)

| Thing | Version | License | Note | Source |
|---|---|---|---|---|
| OpenCode | 2.3.2, exact pin. 2.3.1 and 2.3.0 under pnpm aliases | MIT | `@opencode/cli`; npm `latest` is 2.3.2. Released 2026-11-13 (2.3.0), 2026-11-18T00:08Z (2.3.1) and 2026-11-18T01:30Z (2.3.2), so 5 days and 82 minutes apart. The earlier 2.x releases: 2.2.5 on 10-30, 2.2.6 on 11-06, 2.2.7 on 11-10 | `SPIKE/package.json:21-23`; `npm view @opencode/cli license dist-tags time` |
| ACP SDK | `@agentclientprotocol/sdk` 2.7.0, exact pin | Apache-2.0 | The driver, copied from spike 1 | `SPIKE/package.json:20`; `README:183` |
| zod, TypeScript, vitest | 4.6.7, 7.0.2, 5.1.1, exact pins | MIT, Apache-2.0, MIT | Validation, `tsc --noEmit`, unit tests | `SPIKE/package.json:24,28,29`; `npm view <pkg> license` |
| Machine | Windows 11 Pro (build 26200), Node 24.14.0, pnpm 11.28.2, git 2.53.0.windows.1. No Docker | n/a | `docker` isn't on the `PATH` here | `README:93`; `node --version`, `pnpm --version`, `git --version` |
| Model endpoint | the one in `model.env`, Anthropic message format | n/a | The archive's provider ID is `ostra-anthropic`, which the harness builds from the endpoint's format | `SPIKE/src/harness/fixture.ts:280`; the run's archive |
| GitHub | the test App on the sandbox org's `test1` repo | n/a | 0 workflows. The App can read `checks` and has no `workflows` permission | RUN, B2 recorded; `README:143` |

---

## 1. The question, and the answer

**Question.** Can a task carry on in a new box, with its context and its unfinished work? It tests Q42, Q53 and Q99, which are ADR 0039 and the three reopening steps of ADR 0006, and F-033 rests on it (`PASSBAR`; `README:5-19`).

**Answer.** Yes for the move, with limits. The bar is not fully answered. The harness's 42 checks came out 37 PASS, 5 SKIPPED and 0 FAIL, and its process check passed (RUN, my count of `report.json`). B3, B4 and B5 are PASS. B1 and B2 are SKIPPED, B1 on four checks that need Docker and B2 on one check that needs a push-triggered workflow in the GitHub test repo, which has none. On OpenCode 2.3.0 to 2.3.2, in fresh directory-tree boxes, an agent restored from an exported session archive answered 5 of 5 questions about earlier turns, with every tool call rejected while it answered, and finished the edit it was interrupted in. A real model did so too, and answered the question about a tool's output correctly. A fresh box without the archive could not load the session (`session not found`). The hidden ref brought back a staged new file, an unstaged edit, a staged delete and an untracked file, with a `git status` identical to the old box's. GitHub accepted a push to `refs/ostra/wip/<task>`, and the ref restored into a fresh clone. Whether GitHub starts CI for it is still unknown. A 200-turn session restored in 2,525 ms against the working value of 30 s, and its archive was 1,088,403 bytes, 175,891 gzipped. The rebuild template alone scored 4 of 5 in all four runs after its wording changed, and 3 of 5 when read as ADR 0039 words it and the interrupted turn had written a sentence. Its one miss, a tool's output, is by design. The variant with every agent message scored 5 of 5 each time. So the plan stands, and the template's wording is a decision for the maintainer (section 4).

---

## 2. Results per pass-bar criterion

`PASSBAR` has five bullets. The harness runs them as B1 to B5, and a criterion is SKIPPED if any of its checks is SKIPPED, FAIL if any failed, and PASS only if all passed (`SPIKE/src/harness/report.ts:2-3,27-32`). Every PASS below is on Windows only.

| # | Criterion | Result | What keeps it from a full PASS |
|---|---|---|---|
| B1 | After export, upload, a fresh container, import and `session/load`, the agent answers 5 of 5 questions about earlier turns and finishes an edit it was interrupted in | **SKIPPED** (8 PASS, 4 SKIPPED) | The four container checks need Docker. Every fresh box that passed is a directory tree. The replay check ran on the stub only |
| B2 | Uncommitted and untracked files come back from the hidden ref. GitHub accepts that ref and starts no CI for it | **SKIPPED** (6 PASS, 1 SKIPPED) | "Starts no CI" can't be told: the test repo has no workflow, so the control branch started no CI either |
| B3 | It still works after OpenCode's patch version changes | **PASS** (12 of 12) | Stub model only. Three consecutive 2.3 patches, one machine |
| B4 | A 200-turn session restores in under 30 s *(working value)*. The archive's size is recorded | **PASS** (3 of 3) | Stub model only. A directory box, a local repo and a loopback blob store, so no container start and no network |
| B5 | The rebuild template alone gets at least 4 of 5 | **PASS** (8 of 8) | At the bar exactly, after two changes (surprises 2 and 3). The fifth question can't be answered by design |

Source for every result and label: RUN, the block of that criterion (`SPIKE/src/harness/pass-bar.ts:110-269`; `SPIKE/.runs/run-2026-11-18T20-09-58-5f8c/status.md`).

### 2.1 B1, the move: SKIPPED

Box A runs six turns and is destroyed: its agent stops and its tree, with OpenCode's own database, is deleted. Then a fresh box at A's path clones the branch, restores the hidden ref, downloads the archive, imports it, starts `opencode acp` and calls `session/load`. The agent gets five questions with every tool call rejected, then a request to finish the edit (`SPIKE/src/cases/move.ts:1-16,201-261`; `SPIKE/src/harness/restore.ts:1-4,58-78`; `SPIKE/src/harness/questions.ts:61-94`).

| Case | Ran on | Result (RUN) |
|---|---|---|
| The turn was really interrupted | stub; real model | PASS in both: turn 6 `cancelled`, the slow check was running, the last edit was not on disk |
| Export, upload, a fresh box, import and `session/load` replay the history | stub only | PASS: 31 updates replayed, turn 1 among them; the import kept the session ID. The model run leaves this check out (`pass-bar.ts:117`) |
| Control: a fresh box without the archive | stub | PASS: `session/load failed: Invalid params: session not found` |
| 5 of 5 questions about earlier turns | stub; real model | PASS 5/5 in both. In the real model's run, 0 of its 5 answers tried a tool |
| The interrupted edit is finished | stub; real model | PASS in both: all five on-disk expectations held, `stopReason=end_turn` |
| The same four, each box a fresh container | none | **SKIPPED**: "Docker (`docker version` must answer)". This machine has none |
| `model:chatty` (the real model asked to say a sentence first) | real model | Recorded: 5/5, the edit finished |
| `session import --directory` into another path, then `session/load` there | stub only | Recorded: loaded, 31 updates, 5/5 |

Restore, empty box to `session/load` returned: 2,551 ms (stub) and 2,465 ms (real model). The stub's phases were clone 145, hidden ref 318, download 5, import 1,012, spawn and initialize 341, `session/load` 709 ms (RUN, B1 recorded).

- **What 5 of 5 means.** An answer counts only if it holds the fact and no tool call completed during it, and the box rejects every tool call while a question is asked (`questions.ts:61-91`). So the question about a file the agent created (q2) and the one about an edit the member asked for (q4) can't be answered by reading the disk. RUN found 0 answers in which the agent even tried a tool, on the stub and on the real model.
- **What the stub proves.** The stub never remembers anything. It finds the fact in the messages OpenCode sent it in that request (`SPIKE/src/harness/scenarios.ts:4-8,145-151`). So a right stub answer proves the fact reached the model's context after the move. The real model shows the agent uses it. The real model answered q3 (the number a shell command printed, 59,998) correctly after the move, so a tool's output survives the archive (`report.json`, `details.model.restored.score`). Its answer to q1 also mentioned that the slow check had been interrupted (same place), so the cancelled turn came through as a cancelled turn.
- **One real model, six turns.** The real session was 6 turns and 41,402 bytes (6,716 gzipped), 31 messages, including 8 reasoning parts and 16 tool parts (`report.json`, `details.model.history.archive`; the archive). One model, one run per variant, a quiet interrupted turn.
- **The control is the evidence that the archive carries the session.** A fresh tree with a new OpenCode database failed `session/load` without the import (`move.ts:215-229`; RUN, control row). Nothing on disk outside the archive and the hidden ref carried anything over, because box B's tree is built from scratch (`fixture.ts:330-336`).
- **A fresh box in these runs is not a fresh container.** The container executor is built (`SPIKE/src/lib/docker-box.ts:1-18`) and has never run: "this machine has none". On Docker Desktop the bind mount, `host.docker.internal` and the key proxy on `0.0.0.0` are the likely places for a first fix (README, not rerun: `README:167`). Spike 3 builds the real box.
- **The path.** Box B sits at box A's path (`fixture.ts:222`; `move.ts:235`). `OC-ACP` says: "To load, resume, or fork a session, the client must pass that session's directory as `cwd`." and "OpenCode rejects a different `cwd` with an invalid params error." The `--directory` flag of `session import` ("Directory in which to import the session", `OC-HELP`) rebinds the session, so the two fit together: RUN's "elsewhere" case imported with `--directory` and then `session/load` worked at the new path (stub only; `move.ts:282-297`). `RIVET:261` says `session/load` needs the same `cwd`. That holds unless the import names the new directory.

### 2.2 B2, the hidden ref: SKIPPED

The hidden ref is a commit shaped like a `git stash` commit. Its tree is the working tree as `git add -A` sees it, read through a temporary index. Parent 1 is `HEAD` and parent 2 is a commit of the index, so the staged state comes back. Saving touches no `HEAD`, index or branch, and the push is `+<commit>:refs/ostra/wip/<task>` (`SPIKE/src/lib/hidden-ref.ts:1-16,49-75`; the unit test `SPIKE/test/hidden-ref.test.ts:44-71`).

| Case | Ran on | Result (RUN) |
|---|---|---|
| Uncommitted changes come back (a staged new file, an unstaged edit, a staged delete): `git status` identical | local bare repo | PASS: box A and box B both ` M notes.txt`, `?? scratch/<module>-plan.md`, `A  src/<module>.ts`, `D  old.txt` |
| Untracked files come back | local bare repo | PASS: 1 untracked before, the same after |
| The hidden ref leaves the branch alone (not moved, its commit on no branch) | local bare repo | PASS |
| A plain clone doesn't fetch `refs/ostra/*` | local bare repo | PASS: no `refs/ostra/*` after `git clone` |
| GitHub accepts the ref (the push succeeds, and the API reads the ref back at the saved commit) | real GitHub | PASS |
| The ref on GitHub restores into a fresh clone | real GitHub | PASS: 3 status entries back, the same as saved |
| GitHub starts no CI for the ref, while a branch push of the same commit does | real GitHub | **SKIPPED**: the control branch got 0 workflow runs in 184 s, because the test repo has 0 workflows, so the check "proves nothing" |
| Ignored files (`debug.log`) come back | local bare repo | Recorded: no. By design |

- **What the GitHub run did.** It used the test App's installation token with `contents: write`, `actions: read` and `metadata: read`, and a second token with `checks: read`, which GitHub minted, so check suites were readable. It pushed the ref, waited 60 s, counted workflow runs and check suites for the commit, pushed the same commit to a throwaway branch as a control, and waited up to 180 s for CI to show. Over a 247 s window the hidden ref got 0 workflow runs and 0 check suites, and 0 runs on any other ref. The run then deleted the control branch and the ref (HTTP 204 each) (`SPIKE/src/cases/github-ref.ts:29-30,51-63,83-127`; RUN, B2 recorded). A listing afterwards found no `refs/ostra/*` and no `ostra-spike2-*` branch on either test repo (README, not rerun: `README:100`).
- **Why the SKIPPED stays.** The check is built so that a repo with no push workflow can't pass: if the control starts no CI, the check is SKIPPED (`github-ref.ts:105-107`). The 0 runs for the hidden ref are therefore not evidence. GitHub's own page says only that `push` "Runs your workflow when you push a commit or tag, or when you create a repository from a template." ([events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)). It mentions no other kind of ref, so the docs don't answer it for `refs/ostra/*` either. The maintainer adds the workflow, because the App has no `workflows` permission and Q122 keeps it that way for v1 (README, not rerun: `README:143,168`; `context/open-questions.md:218`).
- **Update 2026-11-19: the check ran by hand, and a hidden ref starts no CI.** `test1` had got a push workflow on 2026-11-18 (`.github/workflows/ci.yml`, `on: push` and `pull_request`, one `echo` step). With the test App's token, a commit pushed only to `refs/ostra/wip/b2-ci-check-20261119b` got 0 workflow runs in 75 s. The same commit, then pushed to a throwaway branch as the control, got 1 `push` run within 45 s. An earlier commit pushed only to a hidden ref got 0 runs in about 2 min. Both refs and the branch were deleted afterwards (HTTP 204 each) (RUN, 2026-11-19, recorded in `context/specs/m2-tickets-in/issues/40-maintainer-steps-outside-the-code.md`). This was a plain `git push` with the App's token, not the spike's harness, and not through spike 4's proxy. The forced update of the ref is untested too.
- **Only the creation of the ref ran on GitHub.** The GitHub case pushes the ref once (`github-ref.ts:79`). Every later turn would be an update to a commit that isn't a descendant of the last one, which the `+` forces (`hidden-ref.ts:70`). The local runs updated the ref six times on the bare repo, which accepts it. See gotcha 8.
- **The proxy wasn't in this path.** The GitHub push in this spike used the App's token directly (`github-ref.ts:79`). Spike 4's proxy accepts exactly `refs/ostra/wip/<task>` and any non-delete update of it, by its policy (`spikes/github-app-and-git-proxy/src/policy.ts:30-39,45`; `context/research/spike-github-app-and-git-proxy.md:90,96`). Its policy has no fast-forward rule, so I expect it to pass a forced update (inferred, not run).

### 2.3 B3, a patch version change: PASS

Box A runs one OpenCode version and box B another (`move.ts:202,235`; `SPIKE/src/harness/spike.ts:166-170`). Each case ran the whole move: really interrupted, export, upload, import and replay, 5 of 5, edit finished (RUN, B3).

| From to | What it is | Ran on | Result (RUN) |
|---|---|---|---|
| 2.3.0 to 2.3.2 | An upgrade across two patches, five days apart | stub | PASS: 31 updates replayed, the ID kept, 5/5, the edit finished |
| 2.3.1 to 2.3.2 | An upgrade, 82 minutes apart | stub | PASS, the same |
| 2.3.2 to 2.3.1 | A rollback | stub | PASS, the same |

- **The dates are real.** npm gives the three releases at 2026-11-13T08:54Z, 2026-11-18T00:08Z and 2026-11-18T01:30Z (`npm view @opencode/cli time`), which is five days and 82 minutes.
- **What it covers.** Three consecutive patches of one minor, the stub model, Windows. It doesn't cover a minor change, a real model across versions, or an older archive restored by a much newer OpenCode. `OC-API` says its import route "Accepts transcripts exported by earlier releases", which fits what ran. The 2.x line has had a release about every 3 to 7 days (npm times in the facts table), so this check will run often.

### 2.4 B4, a 200-turn session: PASS

| Check (RUN) | Result |
|---|---|
| A 200-turn session restores in under 30 s (compaction off; fresh box: clone, hidden ref, download, import, start, `session/load`) | PASS: 2,525 ms in all, 2,074 ms of them the session's own share |
| The restored session still holds turn 1 | PASS: the codename was answered 199 turns back |
| The archive's size is recorded | 1,088,403 bytes, 175,891 gzipped, 693 messages (user 200, assistant 293, idle 200). Export 508 ms. 586 updates replayed |

| Recorded (RUN, B4) | Value |
|---|---|
| Phases of the 200-turn restore | clone 122, hidden ref 306, download 10, import 1,008, spawn and initialize 323, `session/load` 733 ms |
| 200 turns with OpenCode's defaults (128K context, auto-compaction) | 2 compaction calls; 1,085,026 bytes, 175,586 gzipped; 694 messages (`compaction 2` among the types); restored in 2,553 ms; turn 1 answered |
| 1,000 turns, compaction off (`RUN-1911`, older code) | 5,445,678 bytes, 875,644 gzipped, 3,467 messages; restored in 2,461 ms (import 957, `session/load` 767); 2,934 updates replayed; turn 1 answered |

Source: `report.json`, `details.long`, `details.longCompacted`; `RUN-1911`'s `report.json`, `details.long`.

- **Everything in B4 ran on the stub.** The 200 turns are the stub's `tick` turns: a few hundred characters of text each, a 24 KB file read every fifth turn, 4 KB of shell output every tenth, a grep every third (`scenarios.ts:172-186`; `SPIKE/src/cases/long-session.ts:49`). The agent is the real OpenCode, so the restore timing is real for the agent, and the questions are answered by the stub.
- **The compacted run's turn 1 only survived because the stub's summary says so.** The stub answers OpenCode's compaction call in the template its prompt asks for, and puts the codename in it (`scenarios.ts:192-241`). Whether a real model's summary keeps such a fact is open (section 5).
- **Not in the 2.5 s.** The container's start, the clone of a real repo or the pull of a project's snapshot (ADR 0038), a download over a real network (3 to 10 ms here, from loopback), and the first model request after the load. That request carries the whole history again, and I have no measure of its time or cost (inferred; not run).
- **The blob store is a stand-in.** One loopback HTTP server with a bearer token and files on disk (`SPIKE/src/lib/blob-store.ts:1-8`), not ADR 0043's adapter and not the runner protocol's bulk path.

### 2.5 B5, the rebuild template alone: PASS

The template is string assembly and nothing else: the ticket, the pull request's text, every member message, the agent's last message, `git log --stat` of the branch, and a line on whether unfinished work was restored (`SPIKE/src/lib/rebuild-template.ts:1-5,50-85`). It goes into a new session on a fresh box with the restored workspace, and the same five questions follow. The run builds three forms, each on its own fresh box (`move.ts:122-173`):

- **fixed**: the last message is the reply of the last turn that finished (`end_turn`) with any text, and an interrupted turn's text gets its own section. B5 gates on it (`history.ts:234-246`).
- **literal**: ADR 0039's wording read literally: the last turn with any text, a fragment included (`history.ts:227-232`). Recorded only.
- **every**: every agent message, oldest first (`move.ts:140-142`). A proposed variant, a check of its own.

| Run | Ran on | Chars the interrupted turn wrote | literal (before the fix) | fixed (gates B5) | every |
|---|---|---|---|---|---|
| Quiet interrupted turn | stub | 0 | 4/5 (q3) | 4/5 (q3) | 5/5 |
| Chatty interrupted turn | stub | 67 | **3/5 (q3, q5)** | 4/5 (q3) | 5/5 |
| As it comes | real model | 0 | 4/5 (q3) | 4/5 (q3) | 5/5 |
| `model:chatty` | real model | 180 | **3/5 (q3, q5)** | 4/5 (q3) | 5/5 |

Source: RUN, B5 rows and recorded lines. The template's session also finished the interrupted edit in every form of every run (RUN, B5 recorded). The template prompt was 2,569 to 2,847 characters in the fixed form.

- **What each part of the template can answer, by construction.** Two questions are about things the member said (q1, the codename, and q4, the word for the README): the member messages hold them (`history.ts:125,128`). The file the agent created (q2) is in the branch's log, because turn 2's changes were committed (`history.ts:217`). The port the agent decided on (q5) is in the last message. A tool's output (q3) is in none of the parts. So 4 of 5 is the ceiling of the five parts on this question set. The real model said, for q3: "I don't have that number", and did not guess (`report.json`, `details.model.template.score`).
- **The bar was reached after changes.** Three earlier runs failed B5 or B1. `RUN-1901`: the real model wrote a 25-character fragment before the cancel (23 after trimming), and the template scored 3/5 (q3, q5). `RUN-1951`: the same on the chatty stub. `RUN-2000`: the chatty stub again, and the real model's q5, which was the harness's own mistake (surprise 4). Each of these used the literal wording, the template's first form (README, not rerun: `README:46-49,120`; the three reports have no `templateLiteral` field). The fix is in the template's header and in `history.ts:234-246`, and `SPIKE/test/history.test.ts:6-25` and `SPIKE/test/rebuild-template.test.ts:38-44` cover it.

---

## 3. What surprised us, and the gotchas

**Surprises**

1. **OpenCode's export and import are in its binary, and not in the pages of its docs I read, and its HTTP API calls them `experimental`.**
   - `OC-HELP` lists `session export` ("Export session data as JSON", with a `--sanitize` flag, "Redact sensitive transcript and file data") and `session import` ("Import session data from a JSON file or URL", with `--directory`). `OC-API` has them as `experimental.session.export` and `experimental.session.import`, at `/api/experimental/session/...`, in a document whose own description is "Experimental HttpApi surface for selected instance routes."
   - I found no mention of either command on OpenCode's CLI page or ACP page, whose headings are CLI intro, Automation, Mini, Background service, Paths and Uninstall (CLI) and which cover `session/load` and `cwd` (ACP). The docs index `llms.txt` lists the CLI page as the one match. I read page summaries and didn't read every docs page.
   - It works on 2.3.0, 2.3.1 and 2.3.2, in both directions: the import keeps the session ID, and `session/load` replays the history (RUN, B1 and B3). `RIVET:272` cited a failed round trip on 2.0.4 (opencode#49314). So the pin matters, and so does running this check on every bump (`ADR39:40`; `ADR32:67`).

2. **"The agent's last message" has a reading that fails.**
   - ADR 0039 and F-033 list "the agent's last message" (`ADR39:22`; `context/features.md:174`). Read literally, it is the last turn with any text. When the interrupted turn writes a sentence before its tools, that fragment becomes the last message, the template loses the agent's last real reply, and with it the decision (q5): 3/5, and B5 fails. It happened to the chatty stub, to the real model on its own (about 25 characters, `RUN-1901`), and to the real model when asked (180 characters, RUN).
   - The fix stays within the plan's rule (a fixed template, no model call by ostra): the last message is the reply of the last turn that finished, and the interrupted turn's text has its own section (`rebuild-template.ts:6-10`). ostra's event log already marks how each turn ended: the `session/prompt` response's `stopReason` becomes `turn.ended {stopReason}` (`context/research/agent-ui-stream.md:432,437`, which ADR 0035 builds on), so the runner can tell.

3. **The fixed template's 4 of 5 owes something to the question set, and so does the 5 of 5 of the "every" form.**
   - In the fixed form the template holds one agent reply. q5 passes because turn 5, the one that states the decision, is the last turn that finished (`history.ts:129-132,235-239`). If the decision had come two turns earlier, it would not be in the template (inferred from the construction; not run). The "every" form holds it either way.
   - The "every" form scored 5/5 in all four runs, q3 included. It got q3 because turn 3's prompt asks the agent to "tell me what it printed" (`history.ts:127`), so the agent's own message restates the number. An agent that doesn't restate tool output wouldn't have it there (inferred).
   - So 4/5 at the bar is exact, with no headroom, and the miss is q3 on purpose.

4. **A real model thinks aloud in its replies, and the harness scored it wrong.**
   - In `RUN-2000` the model's turn-5 reply began: "I will use port 4173 is outside range... must be 4000-4999. Pick 4321? Let's choose 4500." and then stated 4500 (`RUN-2000`'s `report.json`, `details.model.history.agentTexts`). The harness took the first port as the fact. The agent answered 4500, its decision, and was marked wrong: B1 failed on a mistake of the harness's, in three places (after the move, in the literal template and in the "every" one).
   - The harness now takes the last port stated, and prefers "use port N" (`history.ts:57-66`; `SPIKE/test/history.test.ts:27-32`). In RUN the real model's turn-5 replies held 3 and 4 numbers of the form 4xxx (the range's ends and defaults it said it avoids), and the rule picked its decision, "I will use port 4371" (`report.json`, `details.model.history.agentTexts` and `details.modelChatty`). A panel that reads facts out of agent text meets the same thing.

5. **The path binds the session, and the import can rebind it.**
   - The archive records the directory of the box that made it: `info.location.directory` holds the absolute path of box A's workspace, `C:\Users\...\workspace` here (the run's archive; schema read at `SPIKE/src/lib/session-archive.ts:22-30`). `OC-ACP` says a different `cwd` is rejected. `session import --directory` binds the session to the path you name (`OC-HELP`), and `session/load` then works there (RUN, "elsewhere", stub only).
   - A box on the `host` executor is a worktree on the member's machine (`ADR39:16`), and a container has a path of its own, so the two paths differ (inferred). So the runner should always import with `--directory <the box's workspace>`. A move from a Windows laptop to a Linux container, the archive naming a `C:\` path, was not run.

6. **`session/load` replays the whole history as updates, and compaction doesn't shrink the archive.**
   - `session/load` sent 31 updates for a 6-turn session, 586 for 200 turns and 2,934 for 1,000 (RUN, B1 and B4; `RUN-1911`). `ACP` says the agent "MUST replay the entire conversation to the Client in the form of `session/update` notifications", and must stream them all before it answers the request. So the runner must mark replayed updates, or they become new task events. ADR 0035 already says so (`context/decisions/0035-event-log-and-live-streams.md:13`). These counts are the load that rule carries: it grows with the session.
   - `OC-ACP` says: "`session/load` replays the saved messages. `session/resume` and `session/fork` don't replay them." Whether `session/resume` works after an import, and saves the replay, was not tried.
   - With compaction on, a 200-turn session compacted twice and its export was about the same size, 1,085,026 bytes against 1,088,403. The export keeps every message and adds the `compaction` entries (RUN, B4 recorded). The restore took the same time.

**Gotchas**

7. **A hidden ref restores only onto the commit it was saved on.**
   - `restoreWorkInProgress` throws "the hidden ref was saved on another commit than the branch's head" if the clone's `HEAD` isn't the ref's first parent (`hidden-ref.ts:97-101`; the unit test `hidden-ref.test.ts:73-80`).
   - Any commit that lands on the task's branch between the last turn and the reopen would hit it: a suggestion a reviewer applies on GitHub, or a push by a member. ADR 0039 doesn't say what happens then. The spike has no rule for it.

8. **The hidden ref is a forced push that skips hooks, and only its creation ran on GitHub.**
   - Each turn's ref is a new commit whose parents are `HEAD` and the index commit, not the last ref, so it is never a fast-forward of the old one, and the spike forces it with a `+` (`hidden-ref.ts:5-8,70`). git: "The `+` is optional and does the same thing as `--force`", and `--force` "disables that check" of whether the old value is an ancestor ([git push](https://git-scm.com/docs/git-push)). On GitHub only the first push of a ref ran (`github-ref.ts:79`). Whether GitHub accepts a forced update of a custom ref through an App token, and through the proxy, is **unverified**.
   - The push also uses `--no-verify` (`hidden-ref.ts:70`). git: "With `--no-verify`, the hook is bypassed completely." (git push, same page). The git-lfs `pre-push` command "Responds to Git pre-hook events" and sends the LFS objects of the pushed commits to the LFS API ([git-lfs pre-push](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-pre-push.adoc), paraphrased). The spike's git has no global config and so no LFS (`SPIKE/src/lib/git.ts:41-42`). So a hidden ref over an LFS-tracked file was not tried, and its objects may not be uploaded (inferred, not run).

9. **Ignored files don't come back, by design.** The tree is read with `git add -A`, so `.gitignore` applies (`hidden-ref.ts:5-8`; RUN, B2 recorded: `debug.log` not back). A `.env.local`, a build output or a local database file the agent made is gone on a fresh box. F-096 says "uncommitted and untracked files included" (`features.md:93`) and doesn't say this.

10. **A cancelled turn is not a lost box.**
    - The interruption in the spike is `session/cancel` on a live agent, and the after-turn work (hidden ref, export, upload) then runs with the agent still alive (`history.ts:188-200,216-220`). ADR 0039 lists "a box lost mid-turn" among the cases where the hidden ref differs from the branch (`ADR39:9`). A box that dies can't write a ref or an archive after that turn.
    - So the ref and the archive of a lost box are those of the last finished turn, and the archive lacks the member's last message (inferred from `ADR39:7-10`, "after every turn"; not run). The three reopening steps don't say who replays that message.

11. **The archive carries more than the conversation.** In the real model's archive: the box's absolute workspace path, the model's reasoning (8 parts), cost and token counts, and tool outputs that include local paths (the run's archive: `info`, `content` parts). ADR 0039 already treats the archive as session content, stored and checked like the task's history and never logged (`ADR39:42`). The `--sanitize` flag exists (`OC-HELP`), and what it redacts, or whether a sanitized archive restores, is **unverified**.

12. **A runner's git must never search above its workspace.** The harness's first run created the task's branch with the run folder as `cwd`. That folder sits inside the ostra checkout, so git acted on ostra's own repo: it read ostra's `main` and pushed it into the stand-in remote. Only local files were touched (README, not rerun: `README:160`). Every git call now sets `GIT_CEILING_DIRECTORIES` (`SPIKE/src/lib/git.ts:25-30,44`). The runner needs the same guard, or an explicit `--git-dir`.

13. **The after-turn work costs about 1 s a turn, and the export runs beside a live agent.**
    - Commit and push, the hidden ref, export, gzip and upload took 825 to 1,056 ms per turn on the stub, 797 to 1,047 ms on the real model, of which the export was about 500 ms (RUN, B1 recorded; `report.json`, `details.model.history`). Each turn uploads the whole archive again (`history.ts:105-112`): 176 KB gzipped at 200 turns, 876 KB at 1,000 (RUN; `RUN-1911`).
    - `session export --standalone` starts a private OpenCode server for one command while `opencode acp` has its own server on the same data directory. It worked on every turn of every run. A busy agent writing while the export reads wasn't stressed (inferred). README, not rerun: exporting through the running agent's own HTTP API might avoid the second process, and wasn't tried (`README:158`).

14. **The README's finding 9 isn't supported by the archives.** It says (`README:159`, marked unverified there) each assistant message holds `snapshot.start` and `snapshot.end` hashes, so that `/undo` across a move "probably fails". I searched all 27 archives under `SPIKE/.runs/*/blobs` for the word "snapshot" and found none, and the real model's assistant messages have the keys `id, time, type, agent, model, content, finish, rawFinish, cost, tokens`. So the premise holds for no 2.3.x export on this machine. Whether undo works across a move is still **unverified**, because nothing ran it.

15. **On a directory box the real model's shell is guarded, not bounded.** With `* * ask` and `external_directory: deny`, every tool call reached the decider, 16 on box A and 2 on box B, none rejected (RUN, B1 recorded; `fixture.ts:268-271`). The decider reads shell commands too, but "a command can reach outside without naming a path". The boundary is the box (`SPIKE/src/lib/deciders.ts:1-15`; README, not rerun: `README:43,161`).

16. **The report doesn't record which model answered.** `report.json` has the endpoint's presence and the API format, not the model ID. The archives do. The finding's "real model" is one unnamed model, and a re-run should write its ID to the report.

---

## 4. What this changes in the plan

These are recommendations for the maintainer. I changed no other file.

1. **ADR 0039 stands, with amendments.**
   - Step 2 stays the normal path. The archive round trip works on 2.3.0 to 2.3.2, so `ADR06:19` ("If spike 2 shows that an archive can't be restored reliably, step 3 becomes the normal path") isn't triggered, and neither is the reopening rule of `ADR32:70` ("or spike 2 shows an OpenCode session can't move to a fresh box").
   - Rewrite `ADR39:38-40` to record what ran: the round trip (a 6-turn real session, a 200-turn stub session), the import keeping the session ID, GitHub accepting the ref, the CI check still open, and that OpenCode's export and import are in no doc page I found and are `experimental` in its API (surprise 1). Keep the pin and the per-bump run.
   - Add the rules the spike found missing:
     - **Import with `--directory <workspace>`, always** (surprise 5).
     - **A moved branch** (gotcha 7). I'd restore the work onto the commit it was saved on, then merge the branch's new commits, and on a conflict leave the ref alone and raise a "needs you" item. That is untried, and it is the maintainer's call.
     - **A lost box** (gotcha 10): say that the ref and the archive are those of the last finished turn, and that the runner replays the member's unanswered message from the event log (ADR 0035). Add a case for it to the contract suite.
     - **Ignored files stay behind** (gotcha 9), and **the ref is updated with a force** (gotcha 8). State both, and check the forced update through the git proxy and on GitHub.
   - Try `session/resume` after the import in the contract suite. If it works, it skips the replay (surprise 6).

2. **The rebuild template: choose the wording.**
   - Add a question to `context/open-questions.md`. The highest number there is Q127 (`open-questions.md:244`), so the next free one is Q128, unless another finding takes it first (spikes 6 and 7 both proposed Q111, `open-questions.md:203`). It asks: does the template carry the last finished reply, or every agent message?
   - I'd choose every agent message, oldest first, plus the interrupted-turn section, with a cap whose size is a *(working value)* to measure. It never scored below the fixed form (5/5 against 4/5 in all four runs), it keeps decisions from earlier than the last finished turn, and it needs no model call. Its cost is that it grows with the session, and I measured it only to 6 turns. The fixed form needs no cap and loses earlier decisions by construction (surprise 3).
   - Whichever is chosen, replace "the agent's last message" with the exact wording in `ADR39:22`, `ADR06:11`, F-033 (`features.md:174`) and `context/domain-model.md:219`. The literal wording scored 3/5 in every run where the interrupted turn wrote text.
   - Leave tool outputs out. The miss on q3 is the price of a template that makes no model call, and the bar allows one miss.
   - **Glossary.** "Rebuild template" is used in ADR 0039, F-033 and the domain model, and has no entry in `context/GLOSSARY.md` (a search for it finds only the "Avoid: cache, template" line of another entry at line 166). Add one.

3. **F-033** (`features.md:174`): the text changes in two places and the status stays `planned`, because the spike is throwaway code.
   - The template's wording, from item 2.
   - A sentence that a fresh box restores uncommitted and untracked files, and not ignored ones.

4. **F-096 and F-047.**
   - F-096 (`features.md:93`): "which starts no CI" is a claim no run has shown. GitHub accepts the ref, and the CI check is SKIPPED. Keep the sentence only with "to verify" until the CI check runs, and add "ignored files stay behind". The text can also give the cost, about 1 s a turn and the whole archive uploaded each turn (gotcha 13), as working figures from one Windows machine. It stays `planned`.
   - F-047 (`features.md:223`) says one action reopens the task on a fresh box "when the old one is gone". Add the lost-box rule from item 1.

5. **ADR 0043, ADR 0032 and ADR 0006.**
   - ADR 0043 (`ADR43:26`: "Spike 2 records the real size of an archive. If archives are small, Postgres alone is enough for far longer."). They are small: 175,891 bytes gzipped at 200 turns and 875,644 at 1,000 (about 5.2 MiB raw), against the 64 MiB cap per blob (`ADR43:7`). `ADR39:41` says "several megabytes each", which holds only for sessions near 1,000 turns, and only raw. Gzip before upload (the spike does, `history.ts:107`), and record that each turn uploads the whole archive again.
   - ADR 0032: no change to the decision. `ADR32:67` says spike 2's restore test runs on every bump. I'd make that `pnpm spike --only=stub,model,patch`, which is B1 and the local half of B2 on directory boxes, B3 and B5, and give it its own CI job (a suggestion; not tried).
   - ADR 0006: no change.

6. **`context/build-order.md:202`.** Replace "none yet" for spike 2 with this finding. State: "Windows only, directory boxes. B3, B4 and B5 pass, nothing failed, B1 and B2 skipped." Waiting on: Docker (spike 3's box), and a push-triggered workflow in `test1`. Add that workflow to "Outside the code" (`build-order.md:218`), since only the maintainer can add it.

7. **No ADR change for the runner's git guard** (gotcha 12). Put `GIT_CEILING_DIRECTORIES`, or an explicit `--git-dir`, in the runner's git helper in milestone 1.

---

## 5. What's still open

**SKIPPED in the run (5 checks, in 2 criteria).**
- **Fresh containers (B1).** Run `pnpm spike --only=stub,container` on a machine with Docker. The executor is built and has never run, so expect a fix or two. The container's start then joins the restore time, and the 30 s budget has about 27 s of headroom (RUN, B4). Spike 3 builds the real box.
- **GitHub's CI for the ref (B2).** The maintainer adds a push-triggered workflow, for example `.github/workflows/ci.yml` with `on: push` and one `echo` step, to `test1`. Then run `pnpm spike --only=stub,github` (README, not rerun: `README:168`). It should also push the ref twice (a forced update, gotcha 8) and once through spike 4's proxy. If CI does start, no fallback is written: ADR 0039's only relief for CI cost is to push at idle (`ADR39:43`).

**Not run, though the bar names or implies it.**
- **A real model across patch versions, and a real long session.** B3 and B4 are stub only. A 200-turn real session, with compaction on, would show whether a model's summary keeps turn 1's fact (surprise 6), and what the first request after a restore costs.
- **Other models.** One model ran. ADR 0039 says this spike gates the choice of agent as much as spike 1 (`ADR39:39`).
- **Linux and macOS.** Only Windows ran. The POSIX process paths are spike 1's and untested here (README, not rerun: `README:174`).
- **A task with several repos** (ADR 0027). The spike has one repo and one hidden ref. A hidden ref per repo, restored together, wasn't run.
- **A box lost mid-turn, a moved branch and an LFS file** (gotchas 10, 7 and 8).
- **Importing into a box that already has the session.** `OC-API` lists a 409 `ConflictError` for the import route and says nothing on what causes it. A retry after a failed restore could hit it.
- **Undo across a move.** Check it if the panel offers undo (gotcha 14).
- **Another agent taking the task over** through the template (`ADR39:22`). Only OpenCode exists until milestone 7.
- **The template's size in long sessions.** The "every" form was measured to 6 turns (surprise 3).

**Decisions the spike can't make:** the template's wording (item 2, Q128), the rule for a moved branch and the lost-box replay (item 1), and the workflow in `test1`.
