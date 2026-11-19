# 25: Runner: the spend cap at the key proxy

Status: done
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

- [x] Tests with the stub models and the fake agent: the cap fires once at its value in both API formats; a refused call counts as nothing spent; the token form works; a `runaway` stop ends the session with the hidden ref pushed.
- [x] Committed as `✨ add the spend cap to the key proxy`.

## Comments
- 2026-11-20, runner: done in `49c649e` (`✨ add the spend cap to the key proxy`). Runner typecheck, lint and test green, check:licenses green. For tickets 19, 36 and 38:
  - **The meter** (`apps/runner/src/sidecar/spend-cap.ts`) starts from the spec's `spentMicroUsd` or `spentTokens` and adds each call's usage as the key proxy reads it: in micro-USD on the four kinds (`input` is the meter's fresh input, so a cache read is never priced twice), kept exact in millionths so many small calls don't drift, or in tokens (input + output + cache reads + cache writes) for the token form. `observed` is the total then, rounded to a whole micro-USD, earlier sessions included.
  - **The refusal:** once the total reaches the cap, the next model call (a POST; the model list still answers) gets a 400 in the API's own shape, `invalid_request_error` with "ostra: this task reached its spend cap" (`code: "spend_cap_reached"` in the OpenAI shape), because an agent's SDK retries a 429 or a 5xx but not a 400. It never reaches the provider and records no usage. A call already streaming finishes and is counted. A session whose earlier sessions had already spent the cap refuses its first call and reports the cap then.
  - **The runner's side:** the cap fires `onSpendCapReached` once; the task run ends with the new `limit` ending, cancels the turn, runs ticket 22's after-turn work (the commit message says "spend cap reached: unfinished work"), sends `session.limit_reached { limit: "spend-cap", observed }`, and ends as a stop does: no `session.ended`, the box kept. Only a session across turns (a minor-1 spec) gets the cap; a spec without `spendCap` has none.
  - **A `runaway` stop** goes milestone 1's stop path with ticket 22's saving: the turn cancelled, `session.saved` with the hidden ref, no `session.ended`, and no `session.limit_reached` from the runner, since core records the maximum duration and the stall as its own events.
