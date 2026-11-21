# 38: The Linear agent-mode harness on real Linear

Status: ready-for-human
Builder: core
Blocked by: 13, 26; and ticket 40's step 1 (the maintainer's Authorize click) for the real run
Features: F-012
Packages: `e2e/m6-linear-agent-mode/` (new), `package.json` (`pnpm e2e:linear-agent-mode`)
Spec: `../spec.md`, section 3, step 10; ADR 0013 (amended)

## What to build

Spike 5's real-run harness, ported to run against ostra itself (core, Postgres, the outbox, the tunnel), never against the spike's server.

- **Before:** `linear.env` and `tunnel.env` loaded; with no `LINEAR_REFRESH_TOKEN` the harness prints "skipped: no app token" and exits 0 without touching Linear. With it, it seeds the connection with `credentialKind: app_oauth`, rotates the refresh token and writes the new one back to `linear.env` without printing it.
- **The install:** the connection's app user is the app's own (`viewer.app`), different from the admin, with the agent scopes.
- **50 delegations:** a project `agent-mode-load` with outside approval on and "Start from Linear" on its board; 50 tickets created with `delegateId` through the personal key, 250 ms apart; for each, the time from the create call's response to core's 200 (this machine's clock at both ends, so no skew) under 5 s, and from the 200 to the first thought's post under 10 s; no runner online; Linear reports every session active, none stale or in error. Then one bulk reject; every session ends with a final response.
- **Follow-up and stop:** a session's follow-up as a thread reply by the key's user (automated), and the stop by a person: the harness asks the maintainer to press "Send stop request" on a named ticket and waits up to 30 minutes, then checks that the `prompted` event carried `signal: "stop"`, the turn stopped, ostra posted one final response and nothing after, and the task is stopped. Without a person in 30 minutes the bullet is reported as not run, never as passed.
- **35 silent minutes:** a task on the stub model whose turn runs 35 minutes of tool calls with no post but the heartbeat; the session never stale (polled each minute, every 10 s from minute 28), one heartbeat posted, the session complete.
- **The record:** the run's log (no tokens, no ticket text) in `context/specs/m6-whole-team/demo/linear-agent-mode.log`, and the four bullets' results in ADR 0013's amendment.

## Port from

`spikes/linear-agent-mode/src/real-run.ts`, `src/thread-reply.ts`, `src/scenarios/`.

## Done when

- [ ] With the app token: the install, the 50 delegations, the follow-up and the 35 minutes pass, the stop passes with the maintainer's press, recorded under `## Comments`. *Changed 2026-11-21: the log was to be kept and cited in `context/proof/F-012.md`, gone with the proof files.*
- [x] Without it: the harness skips cleanly, and F-012's proof file says which conditions wait for the token.
- [ ] Committed as `✅ add the Linear agent-mode harness`, and the record as `📝 record the Linear agent-mode run`.

## Comments

- 2026-11-20, core: the harness built as `✅ add the Linear agent-mode harness` (9bf57b31); `📝 record the Linear agent-mode run` waits for the live run, which waits for the maintainer's Authorize click (ticket 40's step 1). So the first and third boxes stay open, and the second is ticked.
  - **What's there:** `e2e/m6-linear-agent-mode/` and `pnpm e2e:linear-agent-mode`. It reads `linear.env` and `tunnel.env` itself. Without `LINEAR_REFRESH_TOKEN` it prints `skipped: no app token` and ends 0 before anything touches Linear (run on this machine on 2026-11-20). With it, it refreshes the app's token and writes the rotated refresh token back to `linear.env` without printing it, starts its own stack (the failure suite's `startStack`, on 3231, 8831 and 54431), sets it up as milestone 1's demo does, renames the project `agent-mode-load`, seeds the app's connection (`credentialKind: app_oauth`, the agent scopes) and "Start from Linear" on OST's board with outside approval on, then runs the four bullets and keeps the log with `--record`.
  - **Proof:** `src/rehearsal.test.ts` runs every phase through the same code against core as its own process and the fake Linear (ticket 02), in CI; `src/harness.test.ts` holds the skip, the write-back and the judges fed spike 5's real-run figures. Rows in `context/proof/F-012.md` (row 6 `partial`, with the live run's plan). Break-its: no heartbeat (the silent session went stale), no write-back, and the skip not ending the run, each failing its test.
  - **Differences from the ticket, each noted in F-012.md:**
    - The follow-up's session starts from a mention of the app, not a delegation: a delegation's session hangs from no comment, so there's no thread to reply in (the fake says so; real Linear isn't checked).
    - A follow-up on a task still queued is dropped by core (`not-reopenable`, `linear.follow-up-refused`, nothing posted to the session). So the live run signs a runner in before bullet 3 and gives the follow-up's and the stop's tickets a turn on the stub model, and replies once the turn runs. The rehearsal has no runner and reports that one check "not run". The drop itself is ticket 13's path and isn't changed here.
    - "One heartbeat posted" is judged as at least one, nothing else posted: the rehearsal's sped-up clock can't place core's minute-grained heartbeat sweep to give exactly one, and the live run's 20 minutes give one in 35.
    - The live run needs `LINEAR_APP_CONNECTION_ID`, the ID at the end of the app's webhook URL, so Linear's events reach the harness's own connection; the ticket didn't name it.
    - The bulk reject answers each waiting task with `rejectOutsideTask` at once, as the panel's "Reject" does; there's no bulk reject API.
- 2026-11-21, lead: the rehearsal (`src/rehearsal.test.ts`, F-012/c6) moved out of CI to the launch gate's Proof run, on the maintainer's direction that load tests and live proofs run once at the gate and CI stays light. It's a load check, it took about 4.5 minutes of every CI run, and on CI's busy runner its timings sometimes missed (run 44881873721: first thoughts at a p95 of 13.2 s, a max of 13.5 s, against 10 s) and passed in other runs. It now skips itself unless `OSTRA_LINEAR_REHEARSAL=1` (so `pnpm test` skips it, and the package's tests start no Postgres), and `proof.yml`'s e2e job runs it as a step of its own, after the Playwright suite (`context/build-order.md`, the Proof workflow's paragraph). The harness's own tests (`src/harness.test.ts`: the skip, the write-back and the judges on spike 5's figures) still run in CI under F-012/c6.
