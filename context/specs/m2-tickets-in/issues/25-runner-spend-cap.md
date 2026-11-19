# 25: Runner: the spend cap at the key proxy

Status: ready-for-agent
Builder: runner
Blocked by: 02
Features: F-068
Packages: `apps/runner` (`src/sidecar/key-proxy.ts`, `src/task-host/`)
Spec: `../spec.md`, sections 5.1 (`limits`) and 11 (item 8)

## What to build

The maximum duration and the stall are core's (ticket 19, ADR 0037). The runner enforces the cap, because only the key proxy sees each call.

- **The cap:** the proxy prices each call's usage with the spec's four prices (fresh input, output, cache reads, cache writes: Q163), or counts tokens in the token form, adds it to what the task had spent, and once the cap is reached refuses the next call with an error in the model API's own shape ("ostra: this task reached its spend cap"), in both API formats, so the agent stops cleanly. A call already streaming finishes and is counted.
- **Then** the runner ends the turn, runs ticket 22's after-turn work, sends `session.limit_reached { limit: "spend-cap", observed }`, and ends the session.
- **A `stop` with reason `runaway`** from core (the maximum duration or the stall) is handled as milestone 1's stop: cancel the turn, push the hidden ref, end.
- A spec without `spendCap` (minor 0) keeps milestone 1's behaviour.

## Done when

- [ ] Tests with the stub models and the fake agent: the cap fires once at its value in both API formats; a refused call counts as nothing spent; the token form works; a `runaway` stop ends the session with the hidden ref pushed.
- [ ] Committed as `✨ add the spend cap to the key proxy`.

## Comments
