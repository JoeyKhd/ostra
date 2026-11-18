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

Everything is built, and the pipeline is proven end to end on a dry-run against spike 1's stub model: 30 runs through the real ACP driver, the real key proxy and the real OpenCode 2.3.2, edited files, ran tests, got checked, and came out as records, a blind sheet and a score. **No real run has been made.** That needs the model endpoint, it spends tokens, and it lets a model's shell run as the member's own account, so only `pnpm runs --real --host-run` starts it (see [The real runs](#the-real-runs)). The rating needs a person. Those parts report SKIPPED, with the exact thing each needs (see [Status](#status-on-this-machine-2026-11-18)).

`~/.config/ostra-dev/model.env` is present on this machine. The harness reads it only to see whether the endpoint is configured: it never printed a value, and it made no request to the endpoint (the one function that could, `detectApiFormat`, runs only under `--real --host-run`). The dry-run and every check ran on stubs, and the one real-mode path that was driven end to end (`pnpm runs --real --host-run` for one ticket) went to a local stand-in server, never to an endpoint.

A pass can only be earned by the bar's own 30 runs: a trial of one run, a half-finished set, a rating sheet made before the set was whole, or a set with a rate-limited run in it reads SKIPPED, whatever the rating says (see [What counts as the bar's runs](#what-counts-as-the-bars-runs)).

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

## Status on this machine (2026-11-18)

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
5. **The proxy's count and OpenCode's agree.** On all 30 dry-run runs the proxy's token count over the calls that offered tools equalled OpenCode's turn usage exactly. The title call (about 800 tokens a run here) sits outside the turn's usage, so the proxy must meter it too (spike 1's finding 8). Both numbers come from the stub's report, so this is plumbing, not a measure of the proxy against a real endpoint.

## What's left

- **The real runs.** One run first (`pnpm runs --real --host-run --tickets=calc-1 --runs=1`) to see what a run costs, then the 30, on a throwaway machine or a low-privilege account (see [The real runs](#the-real-runs)). They need the endpoint in `model.env` and, for B3, prices.
- **The rating.** One reviewer at least, two if possible. It's the maintainer's call, or a teammate's.
- **Close the gap between this evidence and the bar** (see [Limits of this evidence](#limits-of-this-evidence)): run a ticket of each kind end to end through spike 3's box and spike 4's PR flow on a repo in the test GitHub org, or have the maintainer reword the bar in `context/build-order.md` to what this measures.
- **The finding** in `context/research/`, with real numbers and the limits section, once the runs and the rating are in. If the bar is missed: the second model.
- **Decide, or confirm,** the readings in "Rating blind" (all runs as the denominator, per model, the strictest rater) and the working values this spike added: two thirds of the seeded faults for an "add tests" ticket, $5 and 3,000,000 tokens per run, and `--retry-failed` redoing an `error` or `crash` (which can favour the agent if a model's refusals are retried: the manifest counts the retries, and the finding should quote the count).
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
