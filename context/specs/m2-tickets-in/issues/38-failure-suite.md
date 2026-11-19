# 38: The failure suite

Status: in-progress (built and pushed; the passing runs are still owed, see Comments)
Builder: core (lead), with runner and adapters on call for their parts
Blocked by: 01, 14, 16, 18, 19, 21, 23, 24, 25
Features: F-048, and the proof of F-043, F-044, F-045, F-046, F-047, F-068
Packages: `e2e/m2-failure-suite/` (new), `package.json` (a `pnpm e2e:m2:failures` script)
Spec: `../spec.md`, section 3 (the failure suite)

## What to build

- **`e2e/m2-failure-suite/`:** every case of spec section 3's table, against a fresh dev stack, the test workspaces (`ostra-test` team `OST`, `ostra-test/test1`) and, for the limits, the scripted fake agent with its timers in seconds. Each case states what it does, does it, and checks: every event the server received stored exactly once; no doubled PR, comment, link or status change on the fakes and on the real services (read back from Linear's issue history and GitHub's PR list); the task's end state.
- **The tools it needs:** the loopback cut proxy ported from spike 6 (`hold` and `reset`), between the runner and core; a fault-injecting HTTP proxy for the adapters' calls (apply the write, then answer 500); the kill helpers (`taskkill /T /F` on Windows, `SIGKILL` elsewhere); webhook blocking with `OSTRA_DEV_BLOCK_WEBHOOKS`; and a replay of every stored `WebhookDelivery` through the inbox.
- **Spike 8's three kill points** (F-048): a replica killed before a job's side effect, after it and before the job completes, and after it completes, for `task.open-pull-requests` and `ticket.sync`, on a fake GitHub and the fake Linear that count idempotency keys: one effect per key. F-048's schedule hunt needs F-106's scheduler tick (milestone 6), so the row stays `building` and says so.
- **`--long`** adds the 11-minute cut. Without it the suite runs in under 20 minutes *(working value)*.
- It reads secrets from the environment only, prints none, and cleans up its tickets, PRs, branches and hidden refs in `OST` and `test1` only.

## Port from

`spikes/runner-transport/src/harness/net-proxies.ts`, `procs.ts`, and the `kill9`, `cuts` and `acks` scenarios.

## Done when

- [ ] `pnpm e2e:m2:failures` passes on this machine twice in a row, and once with `--long`.
- [ ] Each case's result and timing is recorded under `## Comments`, with what waits for Linux (spec section 3).
- [ ] The whole-repo checks pass.
- [x] Committed as `✅ add the milestone 2 failure suite`.

## Comments

**2026-11-19, milestone 2's wrap-up.** The suite is committed and pushed (`e2caacb`). The lead stopped the second full run midway, since the 5-minute cuts run one at a time and the suite took hours. The last full run passed 13 of 14 cases in 38.7 min:

| Case (spec section 3) | Suite case | Result |
|---|---|---|
| Kill a replica mid-job, and a retry on the fakes | `core-on-fakes` (`apps/core/src/failure-suite.test.ts`, 8 tests) | PASS, 153.8 s |
| Kill the runner mid-turn | `kill-runner` | PASS, 51.6 s |
| Kill the agent mid-turn | `kill-agent` | PASS, 63.9 s |
| Lose the box | `lose-box` | PASS, 67.3 s |
| A batch the server can't store | `unstorable` | PASS, 36.1 s |
| Retry after a write committed, live | `retry-after-commit` | PASS, 23.5 s |
| Cut the network, 30 s | `cut-hold-30s`, `cut-reset-30s` | PASS, 92.7 s and 98.2 s |
| Cut the network, 5 min | `cut-hold-5m`, `cut-reset-5m` | PASS, 650.6 s and 663.8 s |
| Restart the server mid-turn | `restart-server` | PASS, 70.4 s |
| Drop webhooks | `drop-webhooks` | PASS, 82.9 s |
| Stall, maximum duration, spend cap | `limits` | PASS, 159.5 s |
| Replay webhooks | `replay-webhooks` | FAIL, 61.6 s: the inbox held 149 deliveries after the replay and 148 before. Nothing changed on Linear or GitHub (the same comments, links, writes and PRs) |
| Cut for longer than the grace | `cut-hold-11m` (`--long`) | not run |

The second run passed its first nine cases again, through `cut-hold-5m`, before it was stopped.

What's missing, per unticked row:
- **Two passing runs in a row, and one with `--long`:** `replay-webhooks` fails, the 11-minute cut has never run, and a run takes 38.7 min against the 20-minute bar.
- **Each case's result and timing:** recorded above for one run, but the 11-minute cut has no result, and what waits for Linux isn't written in yet (spec section 3: the cases on `docker`, and `kill -9` with POSIX semantics).
- **The whole-repo checks:** not run in this wrap-up. Only the four packages the commit touches were checked (`@ostra/core`, `@ostra/e2e-m2`, `@ostra/adapter-github`, `@ostra/e2e-m2-failures`); one `@ostra/core` test, `plans-questions.test.ts`, timed out starting a transaction under load and passed when run again alone.
