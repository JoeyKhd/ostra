# Spike 10: is OpenCode good enough?

Milestone 0, spike 10 (`context/build-order.md`). Throwaway code: it answers one question, and its finding goes into `context/research/` once the real runs and the rating are in.

## The question

Does OpenCode, on an ordinary model, turn realistic tickets into PRs a reviewer would merge?

**Tests the decisions:** Q45 (OpenCode is the default agent) and Q46 (the bake-off, replaced by this acceptance run: ADR 0032). The metering it records is ADR 0042's.

**Passes when** (copied from `context/build-order.md`):

- 10 tickets (3 bug fixes, 3 small features, 2 refactors, 2 that add tests), three runs each, on the model in `model.env`.
- Rated blind: at least half are "merge as it is" or "merge with small edits" *(working value)*.
- Recorded per run: spend from the proxy, time, turns, approvals and events.

**If it fails:** repeat on a second model. If both miss the bar, compare agents before milestone 1 builds further on OpenCode.

## Where this stands (2026-11-18)

The real set is made and checked: **30 of 30 runs completed, CI green on 30 of 30, the hidden acceptance tests passed on 30 of 30, 6,840,135 tokens, $0.2040**, on `deepseek/deepseek-v4.1-flash-1017` through OpenRouter, in the Anthropic format. The runs went through the real ACP driver, the real key proxy and the real OpenCode 2.3.2 (see [Results of the real runs](#results-of-the-real-runs-2026-11-18)). The bar's three bullets:

- **B1 PASS.** 30 runs on the 10 tickets, none an infrastructure failure.
- **B2 not counted yet.** An AI did a first-pass rating of all 30 blind, but B2 counts only once at least one **human** reviewer has rated. A reviewer: the steps are under [The blind rating](#the-blind-rating), and rating comes before reading the results.
- **B3 PASS** on the records, with the one scan that only `pnpm spike` runs still to confirm (see [The pass bar, now](#the-pass-bar-now)).

The maintainer approved running the model's shell on their own account, with no sandbox, and an audit of the set found no evidence of reach beyond the workspace, though it cannot prove there was none (see [Host-run approval and audit](#host-run-approval-and-audit)). The dry-run that proved the pipeline first (against spike 1's stub model) is kept under [Dry-run status](#dry-run-status-before-the-real-runs-2026-11-18).

**What this result is.** A pass here means "OpenCode, on this model, solves toy tickets on a small repo" (see [Limits of this evidence](#limits-of-this-evidence)). 30 of 30 on every objective check also means the hidden checks did not separate the runs: they say the agent is not obviously unfit, not how it would fare on a hard ticket.

A pass can only be earned by the bar's own 30 runs: a trial of one run, a half-finished set, a rating sheet made before the set was whole, or a set with a rate-limited run in it reads SKIPPED, whatever the rating says (see [What counts as the bar's runs](#what-counts-as-the-bars-runs)).

## Results of the real runs (2026-11-18)

### The set

`.runs/real-deepseek-deepseek-v4.1-flash-1017/` (gitignored). `pnpm report .runs/real-deepseek-deepseek-v4.1-flash-1017` prints the per-run table; the per-ticket table below is its second half, as printed.

| | |
|---|---|
| Model | `deepseek/deepseek-v4.1-flash-1017`, through OpenRouter, in the Anthropic format |
| Agent | OpenCode 2.3.2 over ACP, the policy `workspace-only-installs-ask` |
| Runs | 10 tickets x 3, one at a time, 2026-11-18 20:20:18Z to 20:42:17Z (21:20 to 21:42 local, UTC+1); none redone with `--retry-failed` |
| Limits per run | 20 minutes, 3,000,000 tokens, and the $2 the set's manifest records (not the $5 default) |
| Where | Windows 11 Pro (build 26200), Node 24.14.0, on the maintainer's own account, no sandbox (see [Host-run approval and audit](#host-run-approval-and-audit)) |

- **Outcome.** 30 of 30 `completed`, every one stopped `end_turn`: no timeout, cap, error or crash, and no rate-limit, server or client error from the endpoint.
- **Checks.** CI (the repo's tests and the strict typecheck) green on 30 of 30. The hidden acceptance tests passed on 30 of 30; on the six "add tests" runs that means the agent's tests passed the pristine module and caught enough seeded faults, and none of them touched `src/`.
- **Spend.** 6,840,135 tokens, **$0.2040**: $0.0068 a run on average, from $0.0019 (calc-10-r2) to $0.0273 (calc-7-r1). 6,021,888 of the tokens (88%) are cache reads; the rest are 571,905 input and 246,342 output, and none are cache writes. The proxy's count over the calls that offered tools equals OpenCode's own turn usage on 30 of 30 runs (a deviation of 0%; the bar allows 2%), with no call missing its usage.
- **Time and turns.** 19.8 minutes of agent time in all, from 11.7 s (calc-9-r3) to 143.7 s (calc-7-r1) a run. 443 model calls, 735 tool calls, 5,175 events, and no question asked. The changes add up to 89 files, +1,811 -197.
- **Approvals.** 25 requested, 25 allowed, 0 rejected, all kind `execute`: package installs, since the sample repo has no `node_modules`. Five runs asked for none (calc-1-r2, calc-4-r1, calc-5-r2, calc-9-r3, calc-10-r2).
- **The heavy ticket** is CALC-7 (operators in one place): 614,410 tokens and $0.0223 a run, against 109,896 to 269,968 tokens for any other ticket.

```text
per ticket (means over its runs)
    ticket          runs  time s  calls      -  appr  events       -    tokens     spend  CI ok  accept
    calc-1             3    28.5   13.0      -   0.7     135       -    174535   $0.0051    3/3     3/3
    calc-2             3    22.3   11.7      -   1.0     105       -    150568   $0.0036    3/3     3/3
    calc-3             3    35.1   13.3      -   1.0     141       -    171234   $0.0054    3/3     3/3
    calc-4             3    27.0   14.3      -   0.7     122       -    226501   $0.0051    3/3     3/3
    calc-5             3    29.7   13.7      -   0.7     144       -    206831   $0.0057    3/3     3/3
    calc-6             3    32.2   14.0      -   1.0     146       -    217817   $0.0057    3/3     3/3
    calc-7             3   118.7   28.0      -   1.0     542       -    614410   $0.0223    3/3     3/3
    calc-8             3    57.8   18.3      -   1.0     223       -    269968   $0.0088    3/3     3/3
    calc-9             3    25.2   11.0      -   0.7      98       -    138284   $0.0038    3/3     3/3
   calc-10             3    18.8   10.3      -   0.7      69       -    109896   $0.0026    3/3     3/3

total: 30 runs, 6840135 tokens, $0.2040
```

### Host-run approval and audit

**Approval.** `--real` runs the model's shell as the member's own account, with no sandbox (see [The real runs](#the-real-runs)). The maintainer approved that for this set, in the session that made the runs, when asked directly on 2026-11-18. So the 30 runs went ahead on the maintainer's own account, not on a throwaway machine or a low-privilege account, and for them `AGENTS.md`'s "an agent's reach ends at its task's workspace" did not hold.

**Audit.** After the set, a separate session audited it against the harness's records and this machine's files.

Bottom line:

- **No evidence** that any run touched `~/.config/ostra-dev`, the hidden acceptance tests, the reference solutions, other runs' folders or the home directory.
- **One confirmed use of the network other than the key proxy:** `npm install` runs, which went to the npm registry. The policy's `ask` rule gated them, and the harness auto-approved every ask.
- **That is not proof that nothing happened.** The harness never records what an agent ran or read, and a shell `cat`, `type` or `dir` outside the worktree leaves no trace. Only side effects could be checked, and reads leave none.

What the harness keeps (`src/runner/run-ticket.ts`): per run `events.jsonl` (type-only: sequence, time, update type, tool-call ID, tool kind, status), `run.json`, `diff.patch`, `summary.txt` (the agent's own last text), `proxy-calls.json` and `proxy-log.jsonl`. No tool input, shell command, path or output is recorded anywhere. The task folders (workspace, home, XDG, temp) lived under `%TEMP%\ostra-spike-10\p<pid>\` and were deleted when each run ended, so no worktree, OpenCode session store or shell history could be inspected. The policy (`src/runner/policy.ts`) is `allow *`, `external_directory` denied, and `ask` for install-type shell commands; its own comment says the shell tool is not covered by the directory rule and reaches whatever the account does, `~/.config/ostra-dev/` and the hidden tests included. The agent's environment was an allowlist: HOME, USERPROFILE, APPDATA, LOCALAPPDATA and TEMP pointed at the scratch folder, and only the fake key.

What was searched, and what it showed:

- **Tool calls** (`events.jsonl`, all 30 runs): 735, of them 312 read, 241 execute (shell), 146 edit, 34 search and 2 other (both in calc-7-r1). The 241 shell commands are unrecorded. Four calls ended `failed`, each a candidate for an `external_directory` refusal that cannot be told from an ordinary error such as a missing file: calc-2-r1 (a read, seq 35, failed 7 ms after starting), calc-7-r1 (an execute, seq 512, failed in 4 ms, where other shell calls in that run took 250 to 400 ms, so it never ran a process), calc-7-r3 (an edit, seq 264) and calc-8-r2 (a search, seq 74).
- **The key proxy** (`proxy-log.jsonl`, `proxy-calls.json`): 473 `proxy.call` lines, every one status 200 with `keySwapped: true`; no `proxy.rejected` or `proxy.upstream_error`, and no `bad_key`, `no_key` or `revoked` attempt. The line counts match `proxy-calls.json` in every run. The proxy sees model traffic only, not what a shell command sent elsewhere.
- **Approvals** (`run.json`): the 25 above, one in each of 25 runs. Under the policy an approval is a command matching `npm install*`, `npm exec*`, `npx *`, `pnpm ...`, `yarn ...`, `pip install*` and the like; the exact command is not recorded.
- **Network other than the proxy:** with no `node_modules` in the sample, agents hit the missing `@types/node` and `typescript` typecheck failure. About nine runs say in their own `summary.txt` that they installed or meant to install dependencies (calc-3-r1, -r2 and -r3, calc-4-r2, calc-6-r3, calc-8-r3, calc-9-r1 and -r2, calc-10-r3). That is self-report, not harness data, and it covers fewer runs than the 25 approvals, so the other approved commands are unknown. Other network use (`curl`, `Invoke-WebRequest`, `git fetch`) cannot be checked, and the Windows firewall and DNS logs were not looked at.
- **Agent text and diffs:** all 30 `summary.txt` and `diff.patch` files were searched for names and paths outside the workspace (`ostra-dev`, `.config`, drive and user paths, `USERPROFILE`, `APPDATA`, `.runs`, `acceptance`, `reference`, `hidden`, `key.json`, `.env`, `.pem`, `curl`, `wget`, URLs, `../`, `.ssh`, `.npmrc`, `secret`, `sandbox`, `outside` and more). Nothing refers to anything outside the workspace; the hits are the install mentions above and ordinary code (`../src/*.ts` imports in new tests, `spawnSync(process.execPath ...)` in the calc-8-r1 and calc-8-r3 tests). Every diff path is workspace-relative (`src/*`, `test/*`, `README.md`). A regex for key-like strings (`sk-`, `Bearer`, `x-api-key`, `api_key`, `ghp_`, `lin_api_`, `BEGIN`) over every file in the set matched none. The actual key value was not searched for, since `model.env` was not read.
- **Filesystem side effects** (modified and changed times only: NTFS last-access updates are off on this machine, so reads cannot be seen). `~/.config/ostra-dev` and its 7 files were unchanged in the window; the newest, `model.env`, is from 21:18:33, before the first run. `src/tickets/acceptance/*`, `src/tickets/reference/*`, `solutions.ts` and `mutants.ts` were all last changed before the window. Nothing else in the spike folder was created or changed except the set and the rating folder (no stray files, the other `.runs/spike-*` folders unchanged). A scan of the home directory (skipping AppData, `node_modules`, `.claude`, `.claude-mem`, `.cache`, `.npm` and `.pnpm-store`) found changes only in `.copilot/logs`, in OpenCode's real log (next bullet) and under `` (last bullet); none under `.ssh` or `.config`. A full AppData sweep was not completed: the search timed out.
- **The one trace in the real OpenCode home:** `~/.local/share/opencode/log/opencode.log` has four new "cli starting" lines (OpenCode 2.3.2) at 20:25:14.9Z to 20:25:15.2Z: `--version`, `session --help`, `session export --help` and `session import --help`. The real `opencode.db` was last changed on Nov 10 and is untouched. These match exactly the four read-only commands described in `context/research/spike-can-a-session-move-to-a-fresh-box.md`, written by a concurrent session; the run agents' HOME and XDG_DATA_HOME were scratch folders. The lines fall inside calc-7-r1 (20:23:53Z to 20:26:20Z), so the attribution rests on that match, not on a process record.
- **Package caches:** 50 files were written to the real npm cache in the window (21:28:14 to 21:28:26 and 21:38:17 to 21:39:23 local). They are packuments for `next`, `react`, `tailwindcss`, `@trpc/*`, `better-auth`, `vitest`, `zod`, `@agentclientprotocol/sdk`, `typescript` and similar, which are not the calc repo's dependencies (`@types/node` 24.19.2 and `typescript` 7.0.2); there is no `@types/node` entry. The `typescript` packument (21:28:25.9) is the one that overlaps, among `zod`, `vitest` and `@agentclientprotocol/sdk`, so it looks like a concurrent session's run, but the agents cannot be ruled out for that one entry. 161 files were also written to the pnpm store; the calc repo uses npm, so they are attributed to other sessions, and were not checked one by one.
- **Unattributed changes** (concurrent sessions, per `AGENTS.md`): many files under `` changed in the window (`packages/domain`, `packages/api`, `packages/jobs`, `packages/adapter-sdk`, `apps/runner`, `context/specs/m1-first-pr`, `docs/configuration.md` and others). They fit the milestone 1 product work and `git status`, none looks calc-related, and mtime cannot say whether any one came from an agent.

What the records cannot settle: any shell command or its target path; any read of `~/.config/ostra-dev`, the acceptance or reference files, other runs' diffs or the home directory (the policy let the shell do all of it; the workspace was in `%TEMP%`, outside the spike folder, but the OpenCode binary lives under this spike's `node_modules`, so its path could have hinted at the spike root); whether the four failed tool calls were permission refusals; and what the 25 approved install-type commands were.

All 30 runs ended `completed` / `end_turn`, and none has an `agent-stderr.txt` or `checks.txt`.

**What follows.** The model key in `~/.config/ostra-dev/model.env` was within the shell's reach for all 30 runs. The audit found no sign it was read, but a read leaves no trace, so the earlier warning stands: use only a key you can afford to have read.

### The blind rating

The sheet is `.runs/rating-2026-11-18T20-42-31/`, made after the last run ended and showing exactly these 30 runs: `sheet.md` (the 30 pull requests under random IDs, in random order), `ratings-template.csv` (`id,rating,notes`, one row each), `patches/` (the same diffs, one file per ID), `ratings/` (the filled-in copies) and `key.json` (which run each ID is).

**For a human reviewer**, from `spikes/is-opencode-good-enough`. Rate first and read the rest of this section afterwards: it holds the AI's result, which would colour yours.

1. Rate from the sheet alone, before you read the results on this page, `ratings/claude-ai.csv` or anyone else's ratings.
2. Open `.runs/rating-2026-11-18T20-42-31/sheet.md`. Each pull request shows its ticket, the CI result, what changed, the agent's description and the diff. Rate it as a reviewer who owns the repository would, against its ticket.
3. Open `.runs/rating-2026-11-18T20-42-31/ratings-template.csv` and fill the `rating` column of every row with `merge-as-is`, `merge-with-small-edits` or `reject` (the sheet's header explains the three). `notes` is optional. An unrated row, or a word off the scale, makes the verdict SKIPPED.
4. Save it as `.runs/rating-2026-11-18T20-42-31/ratings/<name>.csv`, with your own name. The name becomes the rater's name in the score. Leave `claude-ai.csv` alone.
5. Run `pnpm score --sheet=.runs/rating-2026-11-18T20-42-31`. It prints each rater's counts and the verdict, then the recorded run data unblinded, so run it only once you have rated.
6. **Do not open `key.json` until every rater is done.** It says which run each ID is, and rating blind is the point. A second human is better than one: each rates alone, and nobody opens another's file before finishing their own.

**AI first pass (done).** An AI rater (Claude) rated all 30 blind: **28 `merge-as-is`, 2 `merge-with-small-edits`, 0 `reject`**, mergeable 100%, 3 of 3 on each of the 10 tickets. By its own report it read only `sheet.md` and `ratings-template.csv`, not `key.json`, the `.runs/real-*` folders or this README's per-run tables, and it ran no git and edited no other file. Its ratings, with a one-line reason for each pull request, are in `ratings/claude-ai.csv`. The scorer takes the rater's name from the file name, so the output shows `claude-ai`. `pnpm score` on that file alone prints a PASS for the set: 100% of the runs rated merge-as-is or merge-with-small-edits, against a bar of at least 50%. The two pull requests it would merge only with small edits, and why, are in that file and not here, so as not to prime a human rater who reads this page first.

**Why that is not B2 yet.** B2 is a person's rating: "a reviewer" in the bar, "a person, not this harness" in this spike. The scorer cannot tell an AI's file from a human's, so `pnpm score` and `pnpm spike` will print a PASS for B2 on `claude-ai.csv` alone. Read that PASS as not counting until a human's file is in `ratings/`. With more than one rater the bar is held against the strictest, and their agreement is reported.

### The pass bar, now

| | Status | Bullet | What ran, and what's missing |
|---|---|---|---|
| B1 | **PASS** | 10 tickets (3 bug fixes, 3 small features, 2 refactors, 2 that add tests), three runs each, on the model in `model.env`. | PASS: the set has 3 + 3 + 2 + 2 tickets, every acceptance check fails on the unmodified sample and passes with its reference solution (from the oracle, [below](#dry-run-status-before-the-real-runs-2026-11-18)). PASS: 30 of 30 runs recorded on `deepseek/deepseek-v4.1-flash-1017` (Anthropic format): 30 completed, 0 redone, no rate-limit, server or client error, so none is an infrastructure failure that would hold the set back |
| B2 | **Pending a human** | Rated blind: at least half are "merge as it is" or "merge with small edits" *(working value)*. | AI first pass: 30 of 30 rated, 28 merge-as-is, 2 merge-with-small-edits, 0 reject (100%). **Not counted:** it needs at least one human reviewer ([steps above](#the-blind-rating)). The harness will print a PASS from the AI's file alone; it does not count |
| B3 | **PASS** on the records | Recorded per run: spend from the proxy, time, turns, approvals and events. | PASS: all five measures on 30 of 30 runs, with no call missing its usage, and the dollars from the configured prices ($0.2040). PASS: the proxy's count equals OpenCode's own turn usage on 30 of 30 completed runs (the bar: within 2%). **Left to `pnpm spike`:** its scan for the real key's value in every record, which needs `model.env` and is the one condition that fails B3 whatever else holds. The audit's regex for key-like strings found none |

B1 and B3 here are read off the run records by the conditions in `src/harness/real-criteria.ts`. `pnpm spike` was not rerun for this update, so its own status lines (and its key scan) are the ones to confirm before the finding is written.

## Architecture

```
pnpm runs / pnpm spike
 ├─ sample-repo/            a small TypeScript calculator with a test suite; the three bugs are in it
 ├─ src/tickets/            the 10 tickets · a hidden acceptance check each · a reference solution each · seeded faults for the 2 "add tests" tickets
 ├─ per run (src/runner/):  workspace: a git checkout of the sample, on the task's branch, in the OS temp folder (not under this spike)
 │    ├─ key proxy ──────── fake key in, real key out; counts tokens from the stream  (copied from spike 1)
 │    │    └─ upstream: the endpoint in model.env  |  a scripted stub model (dry-run)
 │    ├─ ACP driver ─────── `opencode acp` over stdio, explicit env, own HOME/XDG/TMP   (copied from spike 1)
 │    ├─ the turn ───────── ticket → prompt; approvals answered "once" and counted; questions answered neutrally and counted
 │    ├─ the diff ───────── the agent's files, never its .git, committed in a repository the harness made (sandbox.ts, workspace.ts)
 │    └─ the checks ─────── CI (the repo's tests + strict typecheck) · hidden acceptance · seeded faults, all on a copy, with an allowlisted environment
 ├─ src/rating/             blind sheet (random IDs, shuffled, key apart) · scorer (per set, per rater)
 └─ src/harness/            `pnpm spike`: the oracle, the dry-run, the guards, the sheet checks, the real-run criteria, the report
```

A run's record (`run.json`, validated by a Zod schema that rejects unknown fields) is built from the driver's events and the key proxy's table, never from what the agent says about itself.

## The sample repo and the ten tickets

`sample-repo/` is `calc`, an expression calculator (tokenizer, parser, evaluator, history, formatter, CLI) with 34 tests, strict TypeScript, no dependencies at run time, run on Node's own type stripping. It fits ostra's demo story: a team's small service, with conventions in its README (strict types, a change comes with a test). Each run starts from a fresh git checkout of it. The tickets are written as a teammate would file them: what's wrong or wanted, how to see it, the edges that matter. None names the fix.

| ID | Kind | Ticket | What the hidden acceptance check holds it to |
|---|---|---|---|
| CALC-1 | bug | Exponent chains evaluate left to right (`2^3^2` is 64) | `2^3^2` is 512; `-2^2`, `2^-1` and the left-grouping of `-` and `/` unchanged; the CLI prints it |
| CALC-2 | bug | Division by zero prints `Infinity` and exits 0 | `1/0`, `0/0` and `1/(2-2)` throw a `domain` error that says "division by zero"; ordinary division unaffected; the CLI exits 1 with the message on stderr |
| CALC-3 | bug | Results show floating-point noise (`0.1 + 0.2`) | 12 significant digits, trailing zeros dropped, `--thousands` intact, computed values untouched |
| CALC-4 | feature | Support the `%` operator | JavaScript's signs, the precedence of `*`, left grouping, `x % 0` is the same error, works on the CLI |
| CALC-5 | feature | Add `min` and `max` | one or more arguments, nesting, expressions as arguments, `arity` error with none, the unary functions unchanged |
| CALC-6 | feature | `ans`: reuse the previous result | in a session and on the CLI across expressions; unknown before any result; a failed expression leaves it alone; `calculate()` stays stateless |
| CALC-7 | refactor | Define the operators in one place | 14 behaviours the sample already gets right still hold, `parse` returns the same trees, `src/operators.ts` exists and the tokenizer, parser and evaluator import it |
| CALC-8 | refactor | Make the command line testable (`runCli(args, io)`) | `runCli` returns 0, 1 or 2 and writes through `io`; importing the file has no effect; the script behaves as before |
| CALC-9 | tests | Add tests for the tokenizer | the agent's tests pass on the pristine code and fail on at least 5 of 7 seeded faults |
| CALC-10 | tests | Add tests for the history | the same, over 7 seeded faults of `history.ts` |

The sample's own tests don't catch any of the seeded faults and pass at the start (34 of 34); every acceptance check fails on the unmodified sample. The `oracle` proves both (below).

## Limits of this evidence

**A pass here means "OpenCode, on this model, solves toy tickets on a small repo". It does not mean the bar as worded.** The bar asks whether OpenCode turns *realistic* tickets into PRs a reviewer would merge, and `context/build-order.md` runs it last, on what milestones 1 to 4 built. This spike is narrower in ways that all favour the agent:

- **The repo is a toy.** About 400 lines, no dependencies, no history, no CI beyond `node:test` and `tsc`, no module a ticket has to find among hundreds, and conventions that fit in a short README.
- **The tickets, the hidden checks and the reference solutions have one author**, who knew what the fix is. The checks hold an agent to the author's reading of each ticket.
- **No ticket-to-PR flow is exercised.** No tracker issue, no box, no git proxy, no GitHub PR: the "PR" is a local diff on a branch, and the reviewer reads it on a sheet. A real task has a tracker's wording, a box's limits and a PR's review.
- **The agent's shell is not isolated** (host run), and the workspace has no `node_modules`, which a real box would usually have installed.
- **Approvals are installs only.** The policy asks before a package is installed or a downloaded tool runs (see Permissions below), so "approvals" is a count of those requests, not of everything a member would be asked.

So a pass is evidence the agent is not obviously unfit; a miss on this repo is strong evidence against it. Before the finding is written up in `context/research/`, either run at least one ticket of each kind (a bug, a feature, a refactor, an "add tests") end to end through spike 3's box and spike 4's PR flow on a repo in ostra's test GitHub org, or have the maintainer reword the bar in `context/build-order.md` to what this measures. This spike does not edit that file. The research file must carry this section.

## How a run goes

- **Workspace.** A fresh checkout on the branch `ostra/calc-N`, with its own HOME, XDG and temp dirs, **in the OS temp folder** (`<temp>/ostra-spike-10/p<pid>/<run>-<id>/`), not under this spike: a `cd ..` from the workspace doesn't lead to the hidden tests, the reference solutions or the other runs' diffs. It is deleted when the run ends (`pnpm clean` also clears what a crash left). The agent's environment is an allowlist (spike 1's `buildAgentEnv`) holding only a fake key and the proxy's address. There is no `node_modules` in it: an agent that wants `tsc` runs `npm install`, which asks and is counted.
- **Prompt.** The same frame for every ticket (`src/runner/prompt.ts`): the ticket, "read the README first for the conventions, run the tests, don't commit and don't push, finish with a summary written for the pull request description". A real task would carry more (project memory, ADR 0044). This is the least ostra would send.
- **Permissions** (`src/runner/policy.ts`, ADR 0031). The agent may read, edit and run commands in its workspace, and asks before it fetches code: `npm`/`pnpm`/`yarn`/`bun` installs, adds and updates, `npx`, `npm exec`, `pnpm exec`/`dlx`, `yarn dlx`, `bunx`, `pip install`. OpenCode's file tools may not leave the workspace (see the findings). Nobody answers in this spike: each request is allowed once and counted.
- **Questions.** Nobody sits at these runs, so a question gets the same neutral reply every time ("use your best judgement, say what you assumed, carry on"), and is counted. Declining is not an option (finding 1).
- **The pull request** is the diff on the task's branch: ostra commits what the agent left, and the diff against the start is what is rated. The harness never opens the agent's own `.git` (it can hold a hook, a filter or an fsmonitor command, and git would run it): it copies the agent's files into a repository of its own, commits them on top of the pristine sample, and diffs the two. A commit that fails throws, so the run is redone instead of being recorded as one that changed nothing. Opening the PR on GitHub is spike 4's, and the tickets are files here, not Linear issues, so `LINEAR_*`, `GITHUB_*` and `DATABASE_URL` aren't used.
- **Limits per run.** 20 minutes, 3,000,000 tokens, and $5 when prices are set (all flags). A run past a limit is cancelled and recorded as `timeout`, `token-cap` or `spend-cap`. `--max-usd` needs prices and is refused without them (it could not act). ADR 0042's cap is $25 a task *(working value)*; a calculator ticket should be far below any of these.
- **Resumable.** A run that has its record is never run again, **whatever its outcome**, so an interrupted set resumes without paying twice. That includes a run that ended in an error or a crash, or that met a rate limit or a server error: the scorer counts it as unmergeable. `--retry-failed` deletes those records first (and counts them in `set.json`), so the next pass redoes them.

### What is recorded per run

| Measure | Where it comes from |
|---|---|
| **Spend** | tokens (input, output, cache read, cache write) counted by the key proxy over every call, titles included; dollars when prices are set (`OSTRA_SPIKE_PRICE_INPUT` and `_OUTPUT`, per million tokens), else tokens only. `turnTokens` is the same over the calls that offered tools, to cross-check OpenCode's own turn usage. Calls that answered 200 with no usage are counted: a hole in the meter |
| **Time** | `wallMs`, the prompt to the turn's end; `startupMs`, the agent's spawn to a ready session |
| **Turns** | `modelCalls`, the agent's round trips (the proxy's calls that offered tools); `auxiliaryCalls`; `toolCalls`; `prompts` (always 1: nobody steers); `questions` |
| **Approvals** | requests, allowed, rejected, by tool kind, and the policy's name. **Installs and package runners only** (the list above), so about zero on most tickets |
| **Events** | the driver's event count, events per minute, by update type, and the wire's message and byte counts |
| Also | outcome and stop reason, rate-limit and error answers, the diff (files, lines), the agent's version and binary SHA-256, and the checks below |

The record's artifacts sit beside it in the run's folder: `diff.patch`, `summary.txt` (the agent's last message), `events.jsonl` (type-only: kinds, statuses and tool-call IDs), `proxy-calls.json` and `proxy-log.jsonl` (counts only). Logs carry IDs and counts, never content or keys.

### Checks next to the rating, not instead of it

The rating is a person's. These are objective signals beside it, run on a copy of the result:

- **CI**, as a reviewer sees it: the repo's own tests, and the strict typecheck. Shown on the sheet.
- **Acceptance**, which the agent never saw. A hidden test file for a bug, a feature or a refactor. For an "add tests" ticket, the agent's tests are run against the pristine module (must pass) and against 7 seeded faults, one at a time (must fail on at least two thirds of them, a working value). Not shown on the sheet, because it would colour the rating.
- `touchedSource`: an "add tests" ticket that changed `src/`.

These checks **run the agent's code** (its tests, its `tsc` config, the command line it changed) on the host. Every such process gets an allowlisted environment (PATH and the OS variables Node needs, and a HOME and temp folder inside the check's own folder), so a `LINEAR_API_KEY`, a GitHub token or a model key in the shell that started the harness never reaches it. That is all it does: the code still runs as the member's account and can read what the account can. Node's permission flags (`--permission`) are not used: the runner spawns child processes and the acceptance tests import from this spike's `node_modules`, so they would need most of the disk allowed anyway.

## Rating blind

```sh
pnpm sheet --sets=.runs/real-<label>             # one set, or two: --sets=.runs/real-a,.runs/real-b
# a reviewer opens .runs/rating-<time>/sheet.md, fills the rating column of ratings-template.csv,
# and saves it as .runs/rating-<time>/ratings/<name>.csv. A second reviewer does the same.
pnpm score --sheet=.runs/rating-<time>
```

- **The sheet** shows each pull request under a random ID (`R-3fa91c`) in a random order (a seed in `key.json` reproduces it): the ticket, the CI result, what changed, the agent's description and the diff. It says nothing of which run, which model, how long, how much or how many turns. The key is a separate file. The agent's text goes in fenced blocks longer than anything inside them, so it can't alter the sheet. Two sets (two models) can go on one sheet and are shuffled together.
- **The scale** is the research file's: `merge-as-is`, `merge-with-small-edits`, `reject`. A diff with no changes is a `reject`.
- **The bar** is counted over **all** runs (30), not only those that finished: a run that left nothing, or timed out, was a run that wasn't mergeable. At least half must be `merge-as-is` or `merge-with-small-edits`. It is held per set of runs (one model), and against the **strictest** of several raters; their agreement is reported. These are readings of "at least half are..." that the build order doesn't spell out. Change them in `src/rating/score.ts` if the maintainer reads it differently.
- **If the ratings are incomplete** (an unrated run, a word off the scale) the verdict is SKIPPED, never FAIL.

### What counts as the bar's runs

`pnpm spike` judges a real set only when it holds **the bar's 30 runs**: every one of the 10 tickets, three times (`calc-N-r1` to `-r3`), whatever the set's own `set.json` says it was made to hold. Otherwise B1, B2 and B3 read SKIPPED with `N of 30 runs recorded`. Beyond that:

- **A rating sheet counts only if it shows exactly the runs recorded now**: its key lists the set's 30 run IDs, and no run ended after the sheet was made (a retried run replaces the one the sheet shows). An older or partial sheet is passed over, and the SKIPPED note says how many were.
- **B1, B2 and B3 stay SKIPPED while a recorded run is an infrastructure failure** (it ended `error` or `agent-crashed`, or was cut short while the endpoint answered 429, 5xx or 4xx): redo them with `--retry-failed` first. They would otherwise be rated, and counted, as unmergeable pull requests.
- **B3 needs prices.** The bar says spend from the proxy; without `OSTRA_SPIKE_PRICE_INPUT` and `_OUTPUT` the proxy's tokens have no dollars, and B3 is SKIPPED, not PASS. It FAILS when a run is missing a measure or the proxy's count is not within 2% of OpenCode's own turn usage on a completed run, or when a real key is found in any record.

## How to run it

```sh
cd spikes/is-opencode-good-enough
pnpm install            # its own workspace; no install script runs
pnpm typecheck          # strict tsc over the spike and the sample repo
pnpm lint               # the root's ESLint rules (eslint.config.js) over src, test, sample-repo and the configs, run with the root workspace's ESLint
pnpm test               # 79 unit tests: CSV, scoring, the sheet's blindness, the checkers' parsers, the scripted model, the real-run bookkeeping, the sandbox and the diff...
pnpm check:inputs       # which inputs are present; never prints a value
pnpm spike              # every criterion it can run here, about 2 minutes; --quick is about a minute
pnpm spike --allow-skipped   # exit 0 when nothing failed, even if a bullet was skipped
pnpm oracle             # only the oracle: the ticket set against its checkers
pnpm runs --dry         # only the dry-run, with its table
pnpm report <folder>    # the per-run table of any set of runs
pnpm status [folder]    # the status tables of the newest spike run (the tables below)
pnpm clean              # deletes .runs/ and this harness's folders in the OS temp folder
```

`pnpm spike` exits 1 when a bullet fails, 2 when none fails but one is skipped, and 0 only when every bullet passes. It writes `.runs/spike-<time>-<id>/` (gitignored: `report.json`, `status.md`, the dry-run's records, the sheet), keeps the three newest and the ones this README cites, kills only its own processes, ends with a sweep that reports any leftovers, and runs the same sweep on Ctrl+C. It reports on the real runs and ratings as soon as they exist in `.runs/real-*` and `.runs/rating-*`, but it **never starts a real run**.

What "its own processes" means: a PID this harness spawned (the agent, and every `node --test`, `tsc` and `git` the checks start, each tracked while it runs), anything whose command line names one of its folders, and any program created by one of those while it lived, even after its parent exited (an agent's test that forked a loop, which `taskkill /T` can't follow). A child created after its parent ended belongs to whoever reused the PID, and is left alone.

### The real runs

```sh
pnpm check:inputs                                       # the endpoint should read "present"
pnpm runs --real --host-run --tickets=calc-1 --runs=1   # one run first, to see what a run costs (a trial: it is not the bar's runs)
pnpm runs --real --host-run                             # all 10 tickets, three runs each, one at a time
pnpm runs --real --host-run --retry-failed              # after a rate limit or a crash: redo the runs that ended that way
pnpm sheet --sets=.runs/real-<label>                    # then the blind sheet, and a reviewer
```

**`--real` refuses to start without `--host-run`** (or `OSTRA_SPIKE_HOST_RUN=1`), and prints why. The model's shell tool runs as your own account, with no sandbox, so what is in its reach, by absolute path, is:

- **`~/.config/ostra-dev/`**: `model.env` (the real model key: the proxy keeps it out of the agent's environment, but it is on the disk, so the agent can read it and the proxy's metering and spend cap can be bypassed), a GitHub App private key (`github-app-*.pem`) and `linear.env`, if they are there;
- **this spike's hidden tests** (`src/tickets/acceptance/`), **its reference solutions** (`src/tickets/solutions.ts`) and **the earlier runs' diffs** (`.runs/real-*/runs/*/diff.patch`), which would contaminate the blind rating and the independence of the runs;
- everything else your account can read or write.

The workspace is in the OS temp folder, so a `cd ..` doesn't reach them, but nothing stops a path the model has found. This is the one place `AGENTS.md`'s "an agent's reach ends at its task's workspace" does not hold in this spike; only a box (spike 3) closes it. Until then, run the real set **on a throwaway machine, or as a separate low-privilege OS account that cannot read `~/.config/ostra-dev/`** (or this folder), with the three `OSTRA_DEV_MODEL_*` values in the environment of that command rather than in a file that account can read, then pass `--host-run`. Use only a model key you can afford to have read.

The 2026-11-18 set did not follow that advice: the maintainer approved running it on their own account, without a sandbox, and the audit of it is under [Host-run approval and audit](#host-run-approval-and-audit). A second model's set, if one is needed, wants the same approval again or a safer place.

Set `OSTRA_SPIKE_PRICE_INPUT` and `OSTRA_SPIKE_PRICE_OUTPUT` (USD per million tokens, and `_CACHE_READ` and `_CACHE_WRITE` if the model has them) in `model.env` to get dollars and the dollar cap (B3 needs them), and `OSTRA_SPIKE_MODEL_CONTEXT` and `_OUTPUT` if the model's limits differ from 128,000 and 16,000. The set is named after the model's ID (`--label=` to change it). Run the same command again to resume. The only request made before the runs is `GET /models`, to learn the API format; it fails loudly on a 401, a 5xx or an answer that is no model list (set `OSTRA_DEV_MODEL_API_FORMAT` to skip it). If the bar is missed, repeat with another model in `model.env` and another `--label`; `pnpm sheet` takes both sets.

### Inputs

| Input | Needed by | If missing |
|---|---|---|
| `OSTRA_DEV_MODEL_BASE_URL`, `OSTRA_DEV_MODEL_API_KEY`, `OSTRA_DEV_MODEL_ID`, from the environment or `~/.config/ostra-dev/model.env` | the real runs (B1's third check, B3's real check), and so the rating | SKIPPED |
| `OSTRA_DEV_MODEL_ENV_FILE`, optional | where the three above are read from when they are not in the environment | `~/.config/ostra-dev/model.env` |
| `OSTRA_DEV_MODEL_API_FORMAT` (`openai` or `anthropic`), optional | the real runs | detected from `GET /models` |
| `OSTRA_SPIKE_PRICE_INPUT`, `_OUTPUT`, `_CACHE_READ`, `_CACHE_WRITE` (USD per million tokens), optional | spend in dollars, the dollar cap, and B3's pass | spend in tokens only; no dollar cap (`--max-usd` is refused); B3 SKIPPED |
| `OSTRA_SPIKE_MODEL_CONTEXT`, `_OUTPUT` (tokens), optional | the model's limits in OpenCode's config | 128,000 and 16,000 |
| `--host-run`, or `OSTRA_SPIKE_HOST_RUN=1` | `pnpm runs --real` (it refuses without it) | `pnpm runs --real` exits 2 |
| A reviewer (two are better) | B2's rating | SKIPPED |

Nothing else is read, apart from the OS variables the agent and the checks need to run at all (`PATH`, `SystemRoot`, `ComSpec`, `PATHEXT` and the like: `PASSTHROUGH` in `src/lib/opencode.ts` and `src/runner/sandbox.ts`; none is a secret). The dry-run needs none of the inputs above.

## Dry-run status, before the real runs (2026-11-18)

This is the state at the dry-run, kept as the record of what the pipeline proved before any model was called. **The pass bar's current status is [The pass bar, now](#the-pass-bar-now)**; the B1, B2 and B3 rows below are the earlier SKIPPED ones, and are superseded for the real runs.

Windows 11 Pro (build 26200), Node 24.14.0, pnpm 11.28.2, OpenCode 2.3.2, no Docker, no WSL. The tables are `pnpm status` of `spike-2026-11-18T20-02-18-d2a4`, a plain `pnpm spike` (exit 2: the three bullets are SKIPPED, nothing failed). The typecheck, the lint (the root's rules over `src`, `test`, `sample-repo` and the configs, no warnings) and the 79 unit tests pass. A stand-in run of `pnpm runs --real --host-run --tickets=calc-1 --runs=1` (against a local server, in both API formats) wrote a one-run real set and a rated one-run sheet of it; `pnpm spike` read B1, B2 and B3 as SKIPPED with `1 of 30 runs recorded`. Those scratch files were then deleted.

**Pass bar**

| | Status | Bullet | What ran, and what's missing |
|---|---|---|---|
| B1 | **SKIPPED** | 10 tickets (3 bug fixes, 3 small features, 2 refactors, 2 that add tests), three runs each, on the model in `model.env`. | PASS: the set has 3 + 3 + 2 + 2 tickets. PASS: on the unmodified sample every acceptance check fails and the sample's CI is green (10 of 10). PASS: with its reference solution applied every acceptance check passes and CI is green (10 of 10). **SKIPPED:** the three real runs per ticket: `pnpm runs --real --host-run` (needs `OSTRA_DEV_MODEL_BASE_URL`, `_API_KEY` and `_ID`; it spends tokens and lets the model's shell run as your account, so `pnpm spike` never starts it) |
| B2 | **SKIPPED** | Rated blind: at least half are "merge as it is" or "merge with small edits" *(working value)*. | PASS: the sheet hides run, model and measures, with 30 unique IDs. PASS: the order is shuffled and a seed reproduces it. PASS: the key maps every ID to one run. PASS: the scorer, on synthetic ratings (a test of the tool, not a result). **SKIPPED:** the rating itself: the real runs first, then `pnpm sheet` and a reviewer |
| B3 | **SKIPPED** | Recorded per run: spend from the proxy, time, turns, approvals and events. | PASS (dry-run, stub model): all five measures on 30 of 30 runs, and the dollars follow from the tokens. PASS: the stub's reported usage reaches the record unchanged: the proxy's turn count equals OpenCode's on 30 of 30 runs, with no call missing its usage (plumbing: both numbers come from the stub, so this doesn't test the metering against a real endpoint). PASS: an approval (calc-6's install, 3 runs) and a question (calc-5, 2 runs) were recorded and answered without ending a run. **SKIPPED:** the same on the real runs, which also need prices for the dollars |

**Pipeline** (what the dry-run proves, and nothing about any model)

| | Status | Checks |
|---|---|---|
| P1 | PASS | 12 of 12. Typecheck clean. The checkers catch what goes wrong: 5 of 5 failure variants judged as scripted (nothing done, half done, broken, a thin test suite, an escape). 30 of 30 runs went through OpenCode over ACP and the key proxy and ended `end_turn`. Both API formats were driven. The checkers' verdict matched the script on 30 of 30 runs (26 passed acceptance, 1 had red CI). The token cap, the dollar cap and the time limit each cancelled a run and were recorded as such. File tools and the workspace boundary, **with a positive control**: under the policy's rules a write and a read outside the workspace were both refused and the run carried on; under `allow *` alone, the same script's write landed and its read worked. The path a real run takes (an endpoint with a key and a price list) worked against a local stand-in: the key swapped in, dollars from the configured prices, the key in no record. A resumed set reran nothing. No key in any of 1,088 files. No process left behind. No uncaught error |

The dry-run's cast is the script's own: 26 `good` runs, and four that go wrong on purpose (CALC-2 run 3 does nothing, CALC-5 run 2 does half, CALC-7 run 3 breaks a test, CALC-9 run 3 writes a thin test). That is how the checkers are shown to catch a failure, not a result about OpenCode: a stub model passes whatever its script says. Its times (under 4 s a run) and its prices (a made-up $3 and $15 per million tokens) mean nothing either.

## What the dry-run found about OpenCode 2.3.2

Facts a real run will meet; they belong in the finding with the real numbers.

1. **A declined question ends the turn.** When the driver answers an `elicitation/create` with `decline`, OpenCode fails the question tool and the turn ends `cancelled` (seen: CALC-5's run with the question, before the answer was neutral). An unattended run that declines scores an agent as dead for asking. In ostra a member answers; here a fixed neutral reply goes in the question's custom-answer field and the question is counted.
2. **`allow *` lets the file tools leave the workspace.** With only `{action: "*", effect: "allow"}`, a scripted `write` to an absolute path outside the workspace landed, and a `read` of a file outside it worked (the control run of every `pnpm spike` shows both). `{action: "external_directory", resource: "*", effect: "deny"}` after it made both fail (the same script, under the policy's rules, in the same run of `pnpm spike`). The shell tool is a separate matter, and isn't covered.
3. **Shell permission rules match on the command.** `{action: "shell", resource: "npm install*", effect: "ask"}` made a request arrive for `npm install ...` and for nothing else, with the command in `rawInput`. The request offers `allow_once`, `allow_always` and `reject_once`; the driver answers `allow_once`, as ADR 0032 says.
4. **Edits are `edit` and `write`.** Both report their kind as `edit` in ACP, so an approval by kind can't tell a new file from an edit. `write` replaced an existing file (CALC-8's `src/cli.ts`).
5. **The proxy's count and OpenCode's agree.** On all 30 dry-run runs the proxy's token count over the calls that offered tools equalled OpenCode's turn usage exactly. The title call (about 800 tokens a run here) sits outside the turn's usage, so the proxy must meter it too (spike 1's finding 8). Both numbers come from the stub's report, so this is plumbing, not a measure of the proxy against a real endpoint. On the real runs the same equality held on 30 of 30 (see [Results of the real runs](#results-of-the-real-runs-2026-11-18)), which is the measure against a real endpoint.

## What's left

- **Done:** the real runs (30 of 30, see [Results](#results-of-the-real-runs-2026-11-18)), the host-run audit and an AI first pass of the rating.
- **The human rating** (B2). At least one human reviewer, two if possible: the maintainer, or a teammate. Steps are under [The blind rating](#the-blind-rating): fill `ratings-template.csv`, save it as `ratings/<name>.csv`, run `pnpm score --sheet=.runs/rating-2026-11-18T20-42-31`, and leave `key.json` shut until every rater is done. B2 does not count before this.
- **Confirm B1 and B3 with `pnpm spike`.** It reads the records by the same conditions and adds the scan for the real key's value in every record, the one B3 condition not checked by hand here. Mind the B2 line it prints: it will read PASS on the AI's file alone.
- **Decide whether the harness should record what an agent ran.** The audit could settle nothing about the 241 shell commands, because none is recorded (only side effects could be checked). Before another host run, either record what each tool call touched (a shell command's program and target paths, in a form that keeps to `AGENTS.md`'s rule that logs carry no content), or run it somewhere the question cannot arise (spike 3's box).
- **Rotate the model key if it is not one you can afford to have read** (see the audit's "What follows").
- **Close the gap between this evidence and the bar** (see [Limits of this evidence](#limits-of-this-evidence)): run a ticket of each kind end to end through spike 3's box and spike 4's PR flow on a repo in the test GitHub org, or have the maintainer reword the bar in `context/build-order.md` to what this measures.
- **The finding** in `context/research/`, with real numbers and the limits section, once the runs and the rating are in. If the bar is missed: the second model.
- **Decide, or confirm,** the readings in "Rating blind" (all runs as the denominator, per model, the strictest rater) and the working values this spike added: two thirds of the seeded faults for an "add tests" ticket, $5 and 3,000,000 tokens per run (the real set ran with a $2 cap), and `--retry-failed` redoing an `error` or `crash` (which can favour the agent if a model's refusals are retried: the manifest counts the retries, and the finding should quote the count: 0 in the real set).
- **Not covered here, by design:** opening the PR on GitHub and the co-author trailer (spike 4); the box, so the agent's shell isn't isolated (spike 3); a Linux or macOS run. The code uses no Windows-only API beyond spike 1's `process-tree.ts`, whose POSIX paths spike 1 notes have run in no test yet.
- **Commit.** This spike is untracked in the shared checkout; stage it by path (`git add spikes/is-opencode-good-enough`) and commit it with the next change.

## Copied from spike 1

`src/lib/` is a copy, not an import (spikes never import each other), and byte-for-byte identical to spike 1's today: `acp-driver.ts`, `deciders.ts`, `ids.ts`, `key-proxy.ts`, `opencode.ts`, `process-tree.ts`, `sse.ts`, `usage.ts`, `stub-models/server.ts`, `stub-models/normalize.ts` and `stub-models/types.ts`. Left behind: `scenario.ts` (spike 1's stubs pick a script by a marker in the prompt; here the script is chosen by which run the stub serves, so the prompt is exactly what a real run sends), the egress recorder, the packet capture and the T-cases. `src/harness/report.ts` and the structure of `inputs.ts` follow spike 1's too.

## Layout

```
sample-repo/        the calculator (its own package.json, tsconfig, tests; LF endings forced by .gitattributes)
src/lib/            copied from spike 1
src/tickets/        schema · the 10 tickets · acceptance/ (hidden tests) · reference/ · solutions · mutants · apply
src/runner/         one run (run-ticket) · a set (run-set, retry) · checks · policy · prompt · unattended · pricing · records (schemas) · exec, sandbox (the environment, git and task folders of what runs agent code), processes (the sweep) · workspace (the diff) · the CLI
src/rating/         the sheet · the scorer · CSV · their CLIs
src/harness/        spike · oracle · criteria · real-criteria · real-sets · tool-calls · inputs · report tables · secret scan · check:inputs
test/               vitest: the spike's own unit tests
```

## Dependencies

All pinned exactly.

| Package | Version | License | Why |
|---|---|---|---|
| `@agentclientprotocol/sdk` | 2.7.0 | Apache-2.0 | The driver (spike 1's pin) |
| `@opencode/cli` | 2.3.2 | MIT | OpenCode V2, the version `research/rivet.md` pins. The `opencode-ai` package on npm is the 1.x line, so V2 needs this package, as in spike 1. **An addition beyond the allowed list, named here** |
| `zod` | 4.6.7 | MIT | Validation at every boundary: the records, the key, the ratings, the proxy's request head |
| `typescript` | 7.0.2 | Apache-2.0 | `tsc --noEmit`, and the CI check on a run's result; the code runs on Node 24's type stripping |
| `@types/node` | 24.19.2 | MIT | Node types |
| `vitest` | 5.1.1 | MIT | The spike's unit tests |

The sample repo declares `typescript` 7.0.2 and `@types/node` 24.19.2 (same pins) as its own dev dependencies, so an agent that runs `npm install` in its workspace gets them. Nothing here installs them there. **The compiler differs from the root's**: the root workspace pins `typescript` 6.0.3 and `@types/node` 26.6.6, this spike's typecheck and its CI check run on 7.0.2 and 24.19.2 (the sample's pins), so a result that typechecks here has not been checked against the root's compiler. `pnpm lint` adds no dependency: it runs the root workspace's ESLint 10.15.0, typescript-eslint 8.73.0 and eslint-plugin-unicorn 80.0.0 (all MIT), so it needs the root's `pnpm install`; it lints the sample repo too, where the sample's `CalcError extends Error` is the one exempt class (a fixture the tickets and hidden tests are written against) and `node:test`'s `describe` and `it` are exempt from the floating-promise rule. The OpenCode wrapper's postinstall is denied (`allowBuilds`): the binary is resolved from the platform package. pnpm 11's minimum release age needed exclusions for the pinned OpenCode and vitest releases.
