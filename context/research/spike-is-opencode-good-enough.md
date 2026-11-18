# Research: Spike 10, `is-opencode-good-enough`: does OpenCode, on an ordinary model, turn realistic tickets into PRs a reviewer would merge?

**Status:** Research, 2026-11-18. Feeds ADR 0032 (OpenCode first, whose default this spike was kept to test), ADR 0031 and ADR 0029 (what contains an agent, and the `host` executor), ADR 0035 and `research/agent-ui-stream.md` (what the event log records), ADR 0042 and ADR 0033 (metering and prices), F-019, F-089, F-084 and F-117. Tests the decisions behind Q45 and Q46 (`PASSBAR`).
**Method:**
- I wrote this from the spike's README, from the 30 run records and the rating sheet that sit on this machine, and from the files named below. I did not run `pnpm spike`, `pnpm report` or `pnpm score`, started no run and spent no model tokens. The README says `pnpm spike` was not rerun for its last update (`README:157`). So B1 and B3 below are the README's reading of the records by the conditions in `SPIKE/src/harness/real-criteria.ts`, not a fresh run of the harness.
- The real runs: 2026-11-18, 20:20:18Z (first `startedAt`) to 20:42:17Z (last `endedAt`) in the 30 `run.json` files, on Windows 11 Pro build 26200 with Node 24.14.0 (`SPIKE/.runs/real-deepseek-deepseek-v4.1-flash-1017/set.json`; `README:43,45`).
- I re-derived what I could. I summed the 30 `run.json` files with a throwaway script that is not in the repo, and counted the `rating` column of the two rating files (not their notes). Every total the README gives came out the same: 30 completed, 6,840,135 tokens, $0.20398 (the README rounds it to $0.2040), 443 model calls, 735 tool calls (312 read, 241 execute, 146 edit, 34 search, 2 other), 5,175 events, 89 files changed, +1,811 -197, 25 approvals, the proxy's turn count equal to OpenCode's on 30 of 30, ratings of 28 + 2 and 27 + 3, one ID they differ on, and the four failed tool calls at the README's sequence numbers. Figures the README doesn't give (events per minute, wire bytes, the split of spend by kind of token, the seeded-fault counts) are mine and are marked RUN.
- I did not open `key.json` or `model.env`. From `sheet.md` I read the ticket of the one pull request the raters split on and of the two both held back for small edits (the sheet shows the ticket and not the run). I name only the first, and I did not copy the raters' reasons into this file, so a person who reads it before rating isn't primed (section 2.2).
- The code that ran is the code as it stands. No file under `SPIKE/src`, `SPIKE/sample-repo`, `SPIKE/test` or the spike's config files was written after 21:06 local time on 2026-11-18 (file times), and the first real run began at 21:20 local. The README was written later, at 23:33. This write-up cites no commit and no diff.
- Not checked: the model's price list and the provider's billing (so every dollar figure is the harness's, from prices set in `model.env`, which I backed out of the records), Linux, macOS, and OpenCode's own docs (what I say about OpenCode's behaviour comes from the README and from `SPIKE1`, which read them).
- Anything from the README that I didn't re-derive is marked "README, not rerun". Anything I read in the code and didn't run is marked "inferred". Anything I couldn't check against a source is marked **unverified**.

**Source links.**
- `SPIKE` means `spikes/is-opencode-good-enough`. A cite like `SPIKE/src/runner/policy.ts:14-16` is a file and its lines. `README` means `SPIKE/README.md` as it stood at 23:33 local; a cite like `README:83` is a line of it.
- `RUN` means the real set, `SPIKE/.runs/real-deepseek-deepseek-v4.1-flash-1017/`: `set.json` and, for each of the 30 runs, `runs/<ticket>-r<n>/run.json`, `events.jsonl`, `diff.patch`, `summary.txt`, `proxy-calls.json` and `proxy-log.jsonl`. `SHEET` means `SPIKE/.runs/rating-2026-11-18T20-42-31/`, with `sheet.md`, `ratings/claude-ai.csv` and `ratings/fable.csv`. `.runs/` is gitignored (`SPIKE/.gitignore:3`), so all of it stays on this machine.
- `PASSBAR` means the spike's pass bar, `context/build-order.md:186-193`. `ADR32` means `context/decisions/0032-opencode-first-own-acp-driver.md`, and `ADRnn` the ADR with that number. `SPIKE1` means `context/research/spike-how-should-the-runner-drive-opencode.md`, `SPIKE2` means `context/research/spike-can-a-session-move-to-a-fresh-box.md`, `SPIKE3` means `context/research/spike-what-is-inside-a-box.md`, and `SPIKE6` means `context/research/spike-runner-transport.md`.

---

## Facts (checked 2026-11-18)

| Thing | Version | License | Note | Source |
|---|---|---|---|---|
| OpenCode V2 (`@opencode/cli`) | 2.3.2, exact pin | MIT | Driven over ACP. The platform binary's SHA-256 in every record is `5d52d86e2c3fd2c4d51cefc893f64c9ee66bc2e9535332195802f7c646b2a3a3`, the one `SPIKE1` recorded | `README:396`; `RUN` set.json `agent`; `SPIKE1` Facts |
| The model | `deepseek/deepseek-v4.1-flash-1017`, through OpenRouter, in Anthropic's format | not checked | Prices as configured: **$0.036 per million input tokens, $0.50 output, $0.01 cache read** (a fit over the 30 records gives these round numbers). Cache writes were 0 tokens, so no cache-write price shows. **Unverified** against the provider's list | `README:41`; `RUN` set.json `pricing: "configured"`; `RUN` (least-squares fit of `spend` over the 30 `run.json`) |
| `@agentclientprotocol/sdk` | 2.7.0, exact pin | Apache-2.0 | The driver, copied from spike 1 | `README:375,395` |
| TypeScript, for the CI check on a run's result | 7.0.2 (the sample's pin) | Apache-2.0 | The root workspace pins 6.0.3, so a result that typechecks here hasn't been checked against the root's compiler | `README:398,402` |
| Node | 24.14.0 | MIT | | `RUN` set.json |
| Machine | Windows 11 Pro build 26200, no Docker, no WSL | n/a | The runs were the maintainer's own account, no sandbox | `README:45,73,332` |
| The sample repo | `calc`, an expression calculator of about 400 lines, 34 tests, strict TypeScript, no run-time dependencies, no `node_modules` | n/a | | `README:185,206,217` |

---

## 1. The question, and the answer

**Question.** Does OpenCode, on an ordinary model, turn realistic tickets into PRs a reviewer would merge? It tests Q45 (OpenCode is the default agent) and Q46 (the bake-off, replaced by this acceptance run in `ADR32:57`), and the metering it records is ADR 0042's (`PASSBAR`; `README:5-9`).

**Answer.** Yes on the bar as this spike reads it, with narrower evidence than the bar's words. All 30 runs (10 tickets, three each) completed on OpenCode 2.3.2 through the spike's copy of spike 1's ACP driver and key proxy: CI green on 30 of 30, the hidden acceptance tests passed on 30 of 30, 6,840,135 tokens and $0.2040 in all (`README:21`; RUN). Two AI reviewers, **Claude Opus and Claude Fable**, each rated all 30 pull requests blind and alone. Both put every run at "merge as it is" or "merge with small edits" (28 + 2 and 27 + 3, no reject) against a bar of 50%. They give the same rating on 29 of the 30 and split on one pull request (`README:24,118-143`; SHEET, counted). **No human rated.** B2 rests on the two AI raters by the maintainer's decision of 2026-11-18 (`README:161`). B1 and B3 PASS. B3's one condition that only `pnpm spike` checks, the scan for the real key's value in every record, was not run (`README:155,157`). The bar's fallback (repeat on a second model, then compare agents) isn't triggered, and the default agent stands.

**What a pass here means.** "OpenCode, on this model, solves toy tickets on a small repo" (`README:204`). The repo is a calculator of about 400 lines. One author wrote the tickets, the hidden checks and the reference solutions. No tracker issue, box, git proxy or GitHub PR was in the loop. The raters are two Claude models that read a sheet and didn't run the code. And the model's shell ran as the maintainer's own account with no sandbox. Every check passed on every run, so the set can't say how close to the line the agent was. A pass is evidence that OpenCode isn't obviously unfit, not a merge rate for real work. Section 2.5 carries the full list of limits, as the README asks (`README:213`). One thing the spike teaches that isn't about OpenCode: the harness recorded no shell command, so the audit of the host runs couldn't rule out a read outside the worktree (section 2.4). That drives section 4, item 1.

---

## 2. Results per pass-bar criterion

`PASSBAR` has three bullets. The harness runs them as B1, B2 and B3. B1 and B3 are read off the run records, and B2 is the verdict of `pnpm score` over every rater's file (`README:157`). A set counts only if it holds the bar's 30 runs, every ticket three times, with a rating sheet that shows exactly those 30 and no infrastructure failure among them (`README:264-268`). This set meets all three conditions (RUN; `README:47,105`).

| # | Criterion | Result | What keeps it from a plain PASS |
|---|---|---|---|
| B1 | 10 tickets (3 bug fixes, 3 small features, 2 refactors, 2 that add tests), three runs each, on the model in `model.env` | **PASS** | The tickets are toy tickets on a toy repo (2.5). Windows only |
| B2 | Rated blind: at least half "merge as it is" or "merge with small edits" *(working value)* | **PASS, on two AI raters and no human** | Not a human review. Both raters are Claude models and judged from the sheet, not by running the code. `PASSBAR` says only "rated blind", names no rater, and still does |
| B3 | Recorded per run: spend from the proxy, time, turns, approvals and events | **PASS** on the records | The key scan wasn't run, and `pnpm spike` wasn't rerun |

Source for every result and label: `README:151-157`; RUN.

### 2.1 B1: the set, 30 of 30

| | |
|---|---|
| Runs | 10 tickets x 3, one at a time, 20:20:18Z to 20:42:17Z. `retriedRuns` is 0: none was redone with `--retry-failed` (RUN, set.json) |
| Limits per run | 20 minutes, 3,000,000 tokens and $2 (RUN, set.json `limits`). The $2 is the manifest's, not the $5 default (`README:45,222`) |
| Policy | `workspace-only-installs-ask`: allow everything, deny `external_directory`, ask before an install-type shell command. Every ask was allowed once and counted (`SPIKE/src/runner/policy.ts:57-61`; `README:219`) |

- **Outcome.** 30 of 30 `completed`, every one stopped `end_turn`. No timeout, cap, error or crash, and no rate-limit, server or client error from the endpoint (RUN, `outcome`, `stopReason` and `modelErrors` in all 30 `run.json`). That matters for the bar's fairness: a rate-limited or crashed run would have counted as an unmergeable pull request (`README:259,267`).
- **Checks.** CI (the repo's tests and the strict typecheck) green on 30 of 30. The hidden acceptance tests passed on 30 of 30 (RUN, `checks`).
- **The six "add tests" runs.** The agent's tests passed the pristine module in all six and killed 7 of 7 seeded faults in each of the three CALC-9 runs and 6 of 7 in each of the three CALC-10 runs, against the 5 of 7 the check asks for. The survivor is the same fault, `default-limit-is-50`, in all three CALC-10 runs. `touchedSource` is false on all six: none changed `src/` (RUN, `checks.acceptance.mutation` and `checks.touchedSource`).
- **Why 30 of 30 isn't a broken checker.** Before any real run, the oracle showed that every acceptance check fails on the unmodified sample and passes with its reference solution (10 of 10 each), and a dry-run on a stub model showed the checkers catching five scripted failures: nothing done, half done, a broken test, a thin test suite and an escape from the workspace (`README:153,346-348`; README, not rerun).

| Ticket | Kind | Time s | Model calls | Tokens | Spend | CI | Accept |
|---|---|---|---|---|---|---|---|
| CALC-1 `2^3^2` | bug | 28.5 | 13.0 | 174,535 | $0.0051 | 3/3 | 3/3 |
| CALC-2 division by zero | bug | 22.3 | 11.7 | 150,568 | $0.0036 | 3/3 | 3/3 |
| CALC-3 float noise | bug | 35.1 | 13.3 | 171,234 | $0.0054 | 3/3 | 3/3 |
| CALC-4 `%` operator | feature | 27.0 | 14.3 | 226,501 | $0.0051 | 3/3 | 3/3 |
| CALC-5 `min` and `max` | feature | 29.7 | 13.7 | 206,831 | $0.0057 | 3/3 | 3/3 |
| CALC-6 `ans` | feature | 32.2 | 14.0 | 217,817 | $0.0057 | 3/3 | 3/3 |
| CALC-7 operators in one place | refactor | 118.7 | 28.0 | 614,410 | $0.0223 | 3/3 | 3/3 |
| CALC-8 testable command line | refactor | 57.8 | 18.3 | 269,968 | $0.0088 | 3/3 | 3/3 |
| CALC-9 tokenizer tests | tests | 25.2 | 11.0 | 138,284 | $0.0038 | 3/3 | 3/3 |
| CALC-10 history tests | tests | 18.8 | 10.3 | 109,896 | $0.0026 | 3/3 | 3/3 |

Means over each ticket's three runs. Source: `README:54-69` (my sums of the 30 `run.json` match every cell); the kind column is `README:187-198`.

- **The heavy ticket** is CALC-7: 614,410 tokens and $0.0223 a run, against 109,896 to 269,968 tokens for any other ticket (`README:52`).

### 2.2 B2: rated blind, by two AI raters

> If you are a person about to rate these pull requests, rate first, from `SHEET/sheet.md` alone, by the steps at `README:109-116`. Then read the rest of this section. It names the one pull request the two AI raters split on, and the reasons for the others stay in their files for the same cause.

| Rater | `merge-as-is` | `merge-with-small-edits` | `reject` | Mergeable | Per ticket |
|---|---|---|---|---|---|
| `claude-ai` (Claude Opus) | 28 | 2 | 0 | 100% | 3/3 on all 10 |
| `fable` (Claude Fable) | 27 | 3 | 0 | 100% | 3/3 on all 10 |

Source: `README:118-137`; SHEET, the `rating` column of `ratings/claude-ai.csv` and `ratings/fable.csv`, counted.

- **Each rated alone.** By their own reports, Opus read only `sheet.md` and `ratings-template.csv`, and Fable read only those two as well and didn't open `claude-ai.csv`, `key.json`, the `.runs/real-*` folders or the README. Neither ran git or edited another file (`README:118,120`). I can't check what they read, only what they wrote. Their files are `SHEET/ratings/claude-ai.csv` and `SHEET/ratings/fable.csv`: 30 rows each, in the template's format, a one-line reason per pull request.
- **Agreement.** The same rating on 29 of 30 (97%), the same side of the bar on 30 of 30 (`README:129,139`; SHEET, one ID differs). The split is **R-8a538d**, which is CALC-8's pull request (`SHEET/sheet.md`, the header under that ID): Opus `merge-as-is`, Fable `merge-with-small-edits`. Fable held it back because nothing tests the `import.meta.main` path the ticket asks to keep, and wants one spawn smoke test and the usage text asserted exactly. Opus took the injected-`io` tests as enough (`README:141`). Both gave `merge-with-small-edits` to the same two other pull requests, so Opus's two are a subset of Fable's three (`README:143`; SHEET, counted).
- **Two notes Fable made and didn't rate down:** several descriptions carry the agent's narration ("I'll start by reading the README..."), and some say typecheck could not run locally while CI shows the strict typecheck clean on all 30 (`README:120`). The first comes from the harness using the agent's last message as the description (`README:236`). ostra's PR body is written by the agent through the sidecar's MCP tool instead (`context/specs/m1-first-pr/spec.md`, section 3, step 10). So the narration is a harness effect and not a finding about OpenCode (inferred). The second is the sample having no `node_modules` (`README:90`).
- **What B2 rests on.** Two AI raters, by the maintainer's decision of 2026-11-18. They were asked to rate the 30 themselves and asked for Claude Fable to review them, as the second blind reviewer beside Opus's first pass (`README:161`). `PASSBAR` says "a reviewer" and this spike had read that as "a person, not this harness", so counting two AI reviewers is the maintainer's reading (`README:147`). Two limits on what it shows. Both raters are Claude models from one vendor and can share blind spots, though the model under test is DeepSeek, so neither graded its own work. And both judged from the diff, the agent's description and the CI result, not by running the code (`README:147`).
- **What the scorer counts.** The bar's denominator is all 30 runs, held per model and against the strictest rater, where "strictest" is the lowest share rated mergeable and a tie names the first rater listed. These are the spike's readings of "at least half are...", which `PASSBAR` doesn't spell out (`README:259`). Both raters are at 100%, so the PASS line names `claude-ai` as strictest, which says nothing about which of the two is stricter. The verdict is the same either way (`README:145`). A human's file joins the score if one is added, and the bar is then held against the strictest of three (`README:147`).

### 2.3 B3: recorded per run

| Measure | Result (RUN unless marked) |
|---|---|
| Spend | 6,840,135 tokens: 571,905 input, 246,342 output, 6,021,888 cache read (88%), 0 cache write. **$0.2040** at the configured prices: $0.0068 a run on average, from $0.0019 (calc-10-r2) to $0.0273 (calc-7-r1). The proxy's count over the calls that offered tools equals OpenCode's own turn usage on 30 of 30 runs (0% off; the bar allows 2%), with 0 calls missing their usage (`README:49`) |
| Time | 19.8 minutes of agent time in all. 11.7 s (calc-9-r3) to 143.7 s (calc-7-r1) a run, 39.5 s on average (`wallMs`) |
| Turns | 443 model calls (14.8 a run), 30 calls that offered no tools (one title call a run), 735 tool calls (24.5 a run), 30 prompts, **0 questions** |
| Approvals | 25 requested, 25 allowed, 0 rejected, every one of kind `execute`: package installs, since the sample has no `node_modules`. One in each of 25 runs. Five runs asked for none (calc-1-r2, calc-4-r1, calc-5-r2, calc-9-r3, calc-10-r2) (`README:51`) |
| Events | 5,175 driver events: 2,373 `agent_thought_chunk` (46%), 735 `tool_call` and 1,713 `tool_call_update` (47% together), 214 `agent_message_chunk`, and 140 others (usage, permission, prompt-finished and available-commands updates). Per run 189.5 to 415.0 a minute, median 259.2, and 261.8 over all the time. The wire (inbound ACP bytes) carried 4,132,131 bytes: 209 KB a minute, 793 bytes a message |
| The key scan | **Not run.** It needs `model.env` and is the one B3 condition that fails the bullet whatever else holds. The audit's regex for key-like strings over every file in the set matched none, and the real key's value wasn't searched for (`README:91,155`) |

- **The meter agreed with the agent to the token.** Every one of the 473 proxy calls in the logs is status 200 with the key swapped, and the line count matches `proxy-calls.json` in every run (`README:88`; RUN, 473 `proxy.call` lines = 443 + 30). The reference is OpenCode's parse of the same response bytes, not the provider's bill (`SPIKE1` section 2.4), so this validates the meter and not the dollars. **Unverified against billing.**
- **Events here are driver events,** counted before ostra's own coalescing: `README:231,233` defines them as the driver's event count, and `perMinute` is that count over the wall time (`SPIKE/src/runner/run-ticket.ts:304`). ADR 0035 sends partial text at most every 250 ms and stores completed messages (`ADR35:12,14`), so the log stores fewer than this (inferred).

### 2.4 The host runs and their audit (not a pass-bar criterion)

**Approval.** `--real` runs the model's shell as the member's own account, with no sandbox. The maintainer approved that for this set, when asked directly on 2026-11-18. So for these 30 runs `AGENTS.md:95`'s "An agent's reach ends at its task's workspace" did not hold (`README:73`).

**Audit.** A separate session audited the set after it ran, against the harness's records and this machine's files (`README:75-99`). The bottom line is in three parts (`README:77-81`):
- **No evidence** that any run touched `~/.config/ostra-dev`, the hidden acceptance tests, the reference solutions, other runs' folders or the home directory.
- **One confirmed use of the network other than the key proxy:** `npm install` runs, which went to the npm registry. The policy's `ask` rule gated them, and the harness allowed every ask.
- **That isn't proof that nothing happened.** The harness never records what an agent ran or read. Only side effects could be checked, and a read leaves none.

| What was searched | What it showed (README, not rerun unless marked) |
|---|---|
| What the harness keeps | Per run `events.jsonl` (sequence, time, update type, tool-call ID, tool kind, status), `run.json`, `diff.patch`, `summary.txt`, `proxy-calls.json` and `proxy-log.jsonl`. **No tool input, shell command, path or output is recorded anywhere** (`README:83`). I read the `events.jsonl` files today: their fields are `seq`, `at`, `kind`, `update`, `toolCallId`, `toolKind`, `status` and `stopReason` and no more (RUN). The task folders (workspace, home, XDG, temp) were deleted when each run ended, so no worktree, OpenCode session store or shell history could be inspected |
| Tool calls | 735, of them 312 read, 241 execute (shell), 146 edit, 34 search and 2 other, both in calc-7-r1 (`README:87`; RUN, counted). **The 241 shell commands are unrecorded** |
| Failed tool calls | Four, each a candidate for an `external_directory` refusal that can't be told from an ordinary error: calc-2-r1 (a read, seq 35), calc-7-r1 (an execute, seq 512, failed in 4 ms where other shell calls in that run took 250 to 400 ms, so it never ran a process), calc-7-r3 (an edit, seq 264) and calc-8-r2 (a search, seq 74) (`README:87`; RUN, the four `tool_call_update` rows with status `failed`) |
| The key proxy | 473 `proxy.call` lines, every one status 200 with the key swapped. No `proxy.rejected`, no `proxy.upstream_error`, no bad, missing or revoked key. It sees model traffic only, not what a shell command sent elsewhere (`README:88`) |
| Approvals | The 25 above. The exact commands are not recorded (`README:89`) |
| The network | With no `node_modules`, agents hit a missing `@types/node` and `typescript`. About nine runs say in their own `summary.txt` that they installed or meant to install dependencies. That is self-report and covers fewer runs than the 25 approvals. `curl`, `Invoke-WebRequest` and `git fetch` can't be checked, and the Windows firewall and DNS logs were not looked at (`README:90`) |
| Agent text and diffs | All 30 `summary.txt` and `diff.patch` files were searched for names and paths outside the workspace and for key-like strings. Nothing refers to anything outside the workspace, and every diff path is workspace-relative (`README:91`) |
| Files, by modified time | `~/.config/ostra-dev` and its 7 files unchanged in the window. The acceptance, reference, `solutions.ts` and `mutants.ts` files last changed before it. No stray file in the spike folder. NTFS last-access updates are off on this machine, so **reads cannot be seen** (`README:92`) |
| OpenCode's real home | Four new "cli starting" lines in `~/.local/share/opencode/log/opencode.log`, inside calc-7-r1's time span, matching exactly four read-only commands described in `SPIKE2`, which a concurrent session wrote. The attribution rests on that match, not on a process record (`README:93`) |
| Package caches | 50 files in the real npm cache and 161 in the pnpm store, mostly packages the calc repo doesn't use, so attributed to other sessions. One `typescript` entry overlaps and can't be ruled out (`README:94`) |
| Unattributed changes | Many files in the repo changed in the window, fitting milestone 1's work and `git status`. mtime can't say whether any came from an agent (`README:95`) |

**What the records cannot settle** (`README:97`):
- Any shell command or its target path.
- Any read of `~/.config/ostra-dev`, the acceptance or reference files, other runs' diffs or the home directory. The policy let the shell do all of it.
- Whether the four failed tool calls were permission refusals.
- What the 25 approved install-type commands were.

**What follows.** The model key in `~/.config/ostra-dev/model.env` was within the shell's reach for all 30 runs. The audit found no sign it was read, but a read leaves no trace, so the earlier warning stands: use only a key you can afford to have read (`README:101`).

### 2.5 Limits of this evidence

The README says this research file must carry this section (`README:213`). A pass here doesn't mean the bar as worded. `PASSBAR` asks about *realistic* tickets, and `context/build-order.md` runs the spike last, on what milestones 1 to 4 built. This spike is narrower in ways that all favour the agent (`README:202-211`):

- **The repo is a toy.** About 400 lines, no dependencies, no history, no CI beyond `node:test` and `tsc`, no module a ticket has to find among hundreds, and conventions that fit in a short README.
- **One author** wrote the tickets, the hidden checks and the reference solutions, and knew what the fix is. The checks hold an agent to that author's reading of each ticket.
- **No ticket-to-PR flow was exercised.** No tracker issue, no box, no git proxy, no GitHub PR. The "PR" is a local diff on a branch, and the reviewer read it on a sheet.
- **The rating is two AI raters, no human.** Both are Claude models and can share blind spots, and both judged from the sheet, not by running the code.
- **The agent's shell was not isolated** (a host run), and the workspace has no `node_modules`, which a real box would usually have installed.
- **Approvals are installs only.** The policy asks only before a package is installed or a downloaded tool runs, so "approvals" counts those requests and not everything a member would be asked.

So a pass is evidence the agent isn't obviously unfit, and a miss on this repo would have been strong evidence against it (`README:213`). The README names two ways to close the gap before this finding was written: run one ticket of each kind (a bug, a feature, a refactor, an "add tests") end to end through spike 3's box and spike 4's PR flow on a repo in `ostra-test`, or have the maintainer reword the bar to what this measures. **Neither has happened.** Section 4, item 3 recommends both, and the choice is the maintainer's.

---

## 3. What surprised us, and the gotchas

**Surprises**

1. **Nothing failed, so the set can't tell the runs apart.**
   - Every run completed, passed CI and passed its hidden check, and both raters put every run at mergeable. Even the seeded-fault check, which asks for 5 of 7, never came below 6 of 7 (section 2.1; RUN). The bar's 50% was never in range.
   - The checkers can fail (section 2.1, "Why 30 of 30 isn't a broken checker"), so this is the set being easy, not the harness being blind.
   - The consequence for the plan is to read "100% mergeable" as "the agent isn't obviously unfit on toy tickets", and never as the share of real PRs a team will merge.

2. **The whole set cost 20 cents, and cache reads were most of the tokens but not most of the money.**
   - $0.2040 for 30 pull requests. The most expensive run was $0.0273 (calc-7-r1), about 900 times under ADR 0042's $25 task cap (`ADR42`, "Limits"). That is this model on toy tickets (inferred from RUN).
   - 88% of the tokens were cache reads, and at the configured prices (above) they were 30% of the spend: $0.060 of $0.204. Output was 3.6% of the tokens and 60% of the spend ($0.123). Fresh input was 8.4% of the tokens and 10% of the spend (RUN, tokens by kind, priced at the fitted per-million prices).
   - So the dollar figure depends on pricing four kinds of token separately. Section 4, item 5.
   - Calls that offered no tools (titles) were 25,569 of the 6,840,135 tokens, 0.37% (RUN, `totalTokens` minus `turnTokens`). `SPIKE1` saw 1.4%. Both show that a count built from the agent's turn reports undercounts, by a small amount that varies from run to run (`SPIKE1` section 2.4; `ADR42`, "Metering").

3. **Approvals measured the sample repo, and no question was ever asked.**
   - 25 of 30 runs asked for an approval, all of them an install, because the sample has no `node_modules`. The harness allowed all 25 (RUN; `README:51,79`). In ostra an environment's setup script installs dependencies before the agent starts (F-051, F-112, inferred), so this isn't a rate for F-026's pings.
   - **0 questions in 30 runs** (RUN, `turns.questions`). The neutral reply the harness sends to a question was never used with a real model, and the declined-question path was never run (finding 11 below).

4. **Spike 6 sized its load from a rate that this set doesn't repeat.**
   - `SPIKE6` ran 250 sessions at 392 events a minute and about 640 B an event, read from a spike 1 run that is no longer on this machine (`SPIKE6:125,129`). `SPIKE1` recorded 448 events a minute for one small turn and said spike 10's longer runs should replace both (`SPIKE1:122,273`). They weren't longer: toy tickets made short runs.
   - This set gives 189.5 to 415.0 events a minute a run, median 259.2 and 261.8 over all the time, at 793 B a wire message and 209 KB a minute (section 2.3). So 392 sits between this set's median and its maximum.
   - Its runs are short (39.5 s on average) and on one fast model, so a slower model or a longer task is unmeasured. The count is also before ostra's coalescing (section 2.3). 46% of the events are thought chunks (RUN).

5. **The agent's tests converge on the same gaps.** All three CALC-10 runs missed the same seeded fault, `default-limit-is-50`, and all three CALC-9 runs killed all seven (section 2.1; RUN). Three runs of one ticket aren't three independent samples of what a reviewer would notice missing.

6. **An audit on a shared machine can't attribute changes.** A concurrent session's four OpenCode commands, npm-cache packuments for packages the calc repo doesn't use, 161 pnpm-store files and many repo files all landed in the same window. The audit could say they "fit" other sessions and no more (`README:93-95`).

**Gotchas**

7. **The harness recorded no shell command, and reads leave no trace.**
   - Type-only events were a choice: the harness kept to `AGENTS.md:82`, "Logs carry IDs and structured fields, never content" (`README:236`). A third of the agent's tool calls (241 of 735) were shell commands (RUN). So the audit could check side effects and nothing else, and on this machine NTFS last-access times are off (`README:92`), so even a file read left nothing to find.
   - This is the lesson that matters for the product. Section 4, item 1.

8. **`external_directory: deny` bounds OpenCode's file tools and not its shell.**
   - With `allow *` alone, a scripted `write` to an absolute path outside the workspace landed and a `read` of a file outside it worked. With the `external_directory` deny after it, both were refused, and the shell is a separate matter (`README:355`; the control run of every `pnpm spike`, README, not rerun).
   - The policy file says so in its own comment: the shell tool "is not covered by this rule: on a host run it reaches whatever the member's account does" (`SPIKE/src/runner/policy.ts:14-16`).
   - `SPIKE2` item 15 says the same of a real model's shell on a directory box: it is "guarded, not bounded", and the boundary is the box (`SPIKE2:215`).
   - Milestone 1's spec says the opposite for `host`. Section 4, item 2.

9. **A refusal and an ordinary error look the same in the record.** Four tool calls failed and none can be told from a permission refusal, because the harness stored a status and not the error (section 2.4; `README:87`). One of them (calc-7-r1 seq 512) failed in 4 ms where other shell calls in that run took 250 to 400 ms, so it never ran a process. That points to a refusal and doesn't prove one (`README:87`).

10. **An approval by tool kind can't tell a new file from an edit.** ACP reports both `edit` and `write` as kind `edit`, and `write` replaced an existing file in the dry-run (`README:357`). ADR 0036's "Approve for this task" rule is "a tool kind and a pattern" (`ADR36:43`), so the pattern has to carry the difference (inferred).

11. **A declined question ends the turn.** When the driver answered an `elicitation/create` with `decline`, OpenCode failed the question tool and the turn ended `cancelled`, so an unattended run that declines scores an agent as dead for asking (`README:354`; dry-run, README, not rerun). The spike sends a fixed neutral reply and counts the question. ADR 0041's automatic rounds have no member present, and a search of that ADR for "question" finds nothing (section 4, item 7).

12. **Shell permission rules match on the command, and the command is in the request.** A request arrived for `npm install ...` and for nothing else, with the command in `rawInput` (`README:356`; dry-run, README, not rerun). So the gap in section 2.4 is the harness's: OpenCode hands over the command, and the spike threw it away.

13. **Two compilers.** The spike's CI check ran TypeScript 7.0.2 (the sample's pin) and the root workspace pins 6.0.3, so "typecheck clean" on all 30 hasn't been checked against the root's compiler (`README:402`).

14. **Windows only.** No Linux or macOS run, and the code's only Windows-only part is spike 1's `process-tree.ts`, whose POSIX paths have run in no test (`README:370`).

---

## 4. What this changes in the plan

These are recommendations for the maintainer. I changed no other file.

1. **ostra's event log must record every tool call's input, and the box must contain the agent. This is the audit's key lesson.**
   - **What happened.** The harness kept type-only events, so 241 shell commands, 312 reads and every path a tool touched went unrecorded (section 2.4). After 30 host runs the audit could report "no evidence of reach beyond the workspace" and could not say "no reach". The model's key was readable the whole time and nobody can show it wasn't read (`README:81,97,101`).
   - **Why both controls.** A record makes an audit possible after the fact, and it tells a member what the agent did. But a record shows a `cat` of a path, not what a program the agent compiled read. A box stops the read whether or not anyone looks. Neither replaces the other, and `host` has no box (`ADR29:22`). Milestone 1's demo runs on `host`, on a personal runner (`context/specs/m1-first-pr/spec.md`, section 1, "The demo runs on the `host` executor"), and every personal runner is `host` (`ADR29:10`). Spike 3's Docker and Kubernetes halves haven't run: its bar stands at 0 of 5 bullets with 0 FAIL (`SPIKE3:39`). So the box's containment is still unproven.
   - **Pin the event log.** ADR 0035 already says every tool call is saved first (`ADR35:12`), and `research/agent-ui-stream.md:417,419` maps `tool_call` to `tool.called` with a normalized `input` and a capped `raw`, and the completed call to `tool.completed` with its `output`. Make these explicit in ADR 0035 and in milestone 1's tickets 02 (the event union, `context/specs/m1-first-pr/issues/02-protocol-events-and-task-config.md:12`) and 09 (the mapping, `context/specs/m1-first-pr/issues/09-acp-driver-and-event-mapping.md:16`):
     - A tool call's `input` is saved in full for every kind: an `execute`'s command and cwd, a `read`'s and a `search`'s paths, a `fetch`'s URL, an edit's paths. The cap belongs on `raw` and `output`. An `execute`'s `output` already carries a `truncated` flag (`agent-ui-stream.md:313`), and `raw` needs the same, so that anything cut says so.
     - A failed or refused tool call keeps its error text, so a policy refusal reads differently from a missing file (finding 9).
     - An approval event keeps the command it was asked about (finding 12). The approved installs' commands were unknown here (`README:89`).
     - `AGENTS.md:82`'s "never content" is a rule for log lines. The event log isn't a log line: it is the task's history in the database, behind the project's access rules (`ADR35`, "Authorization"). Say so in ADR 0035, or a builder who reads the rule strictly will rebuild this spike's gap.
   - **Pin the contract suite.** Give it a positive control, as this spike's control run did for the file tools (`README:346`): a canary file outside the task's workspace, a scripted shell call that reads it, and an assertion that the event log shows that call. Run the same canary from the shell, not the file tools, in spike 3's checklist and in the executors' suites. ADR 0031 has spike 3 test its lines from a shell in the agent's container (`ADR31`, Consequences), and a shell is a third of what an agent runs (finding 7).
   - **Any future host run** of a spike or of ostra's own tests either records tool inputs or runs in a box (`README:365`).

2. **Correct milestone 1's sentence about `host` reach.**
   - `context/specs/m1-first-pr/spec.md:360` says OpenCode's `external_directory` deny means "On `host`, that's the agent's reach, which ends at its task's workspace (`AGENTS.md`)". Findings 7 and 8 show the deny bounds the file tools only, and the shell reaches whatever the member's account does. It should say that, and point to ADR 0029's "not isolated" label (`ADR29:22`).
   - The demo already claims no more than that the agent's process doesn't get the key (`spec.md:23`). `AGENTS.md:95` is the other sentence to look at: "an agent's reach ends at its task's workspace" is a goal that only a box meets, and it is false on `host`. Whether `AGENTS.md` says so is for the maintainer.
   - On a pool, `host` runs the agent as a separate OS user (`ADR29:22`, Q27), and that user is what bounds the shell there. It needs a canary case of its own (item 1).

3. **Reword the bar, and add the realistic gate. The maintainer decides.**
   - `PASSBAR` (`context/build-order.md:190-193`) says "realistic tickets", "rated blind" and names no rater. What this set measured is "the 10 spike tickets, on a toy repo, rated blind by two AI reviewers". I'd reword the bar to that, and move the realistic claim to a gate after milestone 1's end-to-end demo (ticket 39): one ticket of each kind (bug, feature, refactor, tests) through the real flow on a repo in `ostra-test`, with at least one person rating. That is the README's second option (`README:213,367`) and its first one, combined.
   - Add it to `context/open-questions.md` as Q128. The highest number in that file is Q127 (Q126 and Q127 are open). It asks: is spike 10's bar reworded, is the realistic gate added, and does a person rate a sample of the 30?
   - `context/build-order.md:210`, "Where the spikes stand", still says "none yet" for spike 10. It can point here.

4. **ADR 0032: the default stands, and say what stands on.**
   - Q45 and Q46 stay settled. The bar's fallback, a second model and then a comparison of agents (`PASSBAR`; `ADR32:70`), isn't triggered. The README adds that no second model is needed (`README:368`).
   - ADR 0032 names spike 10 as still testing "whether OpenCode's PRs are good" (`ADR32:44`) and as a reopening trigger (`ADR32:70`). Add that it passed on a toy repo with two AI raters, and what that doesn't cover (section 2.5). F-019 stays `planned`: a spike is throwaway code (`AGENTS.md`).
   - Spike 2's reopening trigger is a separate matter, and `SPIKE2` has its own finding.

5. **ADR 0042 and ADR 0033: price four kinds of token.**
   - 88% of this set's tokens were cache reads, priced at about a quarter of fresh input ($0.01 against $0.036 a million), and output was 60% of the spend (finding 2). ADR 0042's price sources (the endpoint's model list, models.dev, an admin's price) are named without cache-read or cache-write prices, and a search of ADRs 0033 and 0042 for "cache" finds none. Name all four kinds in ADR 0042 and in F-089 and F-084, and store all four counts per call, as the spike's proxy did (`README:229`).
   - Whether models.dev and endpoints' own lists carry cache prices wasn't checked: **unverified**. If one doesn't, the admin's price form needs the two fields.
   - ADR 0042 already says the proxy meters every call whatever it offers (`ADR42`, "Metering"). This set confirms it with a smaller number (0.37%, against 1.4%).

6. **Load sizing: F-117, and spikes 6 and 7.**
   - F-117's load test runs "at the event rates spike 1 recorded" (`context/features.md:226`). Add this set's: median 259 and maximum 415 events a minute a run, 209 KB a minute, 793 B a wire message, with the note that they are driver events before coalescing (section 2.3).
   - Spike 6's 392 events a minute and 250,892 B a minute sit inside this range, between the median and the maximum (`SPIKE6:125`). Its floor sizing stands. Its note that the 392 figure can't be re-derived from spike 1's files (`SPIKE6:129`) now has a source in RUN.
   - The load generator should take a mix of rates, since a run's rate went from 190 to 415. A different model's rate is unmeasured.

7. **Approvals and questions: don't read this set as a rate.**
   - F-026's ping rate can't come from the 25 approvals in 30 runs (finding 3). A real environment installs first (F-051, inferred), and a real project asks for more than installs.
   - Decide what answers a question in an automatic round (ADR 0041, which says nothing of questions) and say so in ADR 0041. The spike's fixed neutral reply, counted, is one answer. Declining isn't, because it ends the turn (finding 11).
   - Steering and the deny re-prompt were never exercised in this set: `prompts` is always 1 and 0 requests were rejected (`README:231`; RUN, `approvals.rejected`). `SPIKE1`'s open items on both stay open.

8. **The ledger.** No row becomes `done` (a spike is throwaway code, `AGENTS.md`). F-019 stays `planned`. F-089 and F-084 change only as in item 5, F-117 as in item 6, and F-023 and the event log as in item 1.

---

## 5. What's still open

**For the maintainer to decide** (the spike can't):
- **The bar.** Reword it, run the realistic gate, or both (section 4, item 3). The README's other readings are also the spike's own and want a yes or a change (`README:369`): all 30 runs as the denominator, per model, held against the strictest rater (a tie names the first listed), two thirds of the seeded faults for an "add tests" ticket, $5 and 3,000,000 tokens per run (the real set ran with a $2 cap), and `--retry-failed` redoing an `error` or `crash` run, which can favour the agent if a model's refusals are retried. The count in the real set is 0.
- **A human rating.** Optional and not waited on (`README:363`). A person's rating would add what two Claude models can't say: whether a person reads these pull requests as they did. If one is added, rate from `SHEET/sheet.md` and save `SHEET/ratings/<name>.csv`, then `pnpm score --sheet=.runs/rating-2026-11-18T20-42-31`, keeping `key.json` shut until every rater is done. The two AI raters' one-line reasons are in their files and not copied here, so a person who reads this file first isn't primed.
- **Rotate the model key** if it isn't one you can afford to have read (`README:101,366`).
- **Where the evidence lives.** The 30 records, diffs, the sheet, the key and both rating files are in the gitignored `.runs/` and exist on this machine only (`SPIKE/.gitignore:3`). If the maintainer wants them kept, say where.

**Left to run**
- **`pnpm spike`**, to confirm B1 and B3 by the harness's own conditions and to run the scan for the real key's value in every record (`README:364`). Its B2 line will read PASS on the two AI files, since the scorer can't tell them from a human's (`README:147,364`).
- **The realistic gate** (section 4, item 3), through spike 3's box and spike 4's PR flow. Spike 3's Docker half needs the Linux machine (`SPIKE3:39`).
- **Linux and macOS.** Neither ran (`README:370`).
- **A second model's set,** if one is ever wanted: it needs the same host-run approval again, or a safer place (`README:310`). The bar's fallback doesn't call for one.

**Not covered, though no bar line names it**
- Opening the PR on GitHub and the co-author trailer (spike 4), and the box, so the agent's shell wasn't isolated (spike 3) (`README:370`).
- A long task. The average run was 39.5 s, and a task that is steered, reopened or runs for an hour isn't in this set.
- Steering mid-turn on a real model, and the deny re-prompt end to end (section 4, item 7).
- What the agent ran in its shell, and what it read (item 1 of section 4 is the fix for the product; for this set the answer is lost).
