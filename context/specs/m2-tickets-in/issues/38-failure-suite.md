# 38: The failure suite

Status: ready-for-agent
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
- [ ] Committed as `✅ add the milestone 2 failure suite`.

## Comments
