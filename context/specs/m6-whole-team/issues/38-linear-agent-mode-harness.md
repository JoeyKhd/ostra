# 38: The Linear agent-mode harness on real Linear

Status: ready-for-agent
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

- [ ] With the app token: the install, the 50 delegations, the follow-up and the 35 minutes pass, the stop passes with the maintainer's press, and the log is kept and cited in `context/proof/F-012.md`.
- [ ] Without it: the harness skips cleanly, and F-012's proof file says which conditions wait for the token.
- [ ] Committed as `✅ add the Linear agent-mode harness`, and the record as `📝 record the Linear agent-mode run`.

## Comments
