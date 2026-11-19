# 13: Core: Linear agent mode

Status: ready-for-agent
Builder: core
Blocked by: 06, 07
Features: F-012
Packages: `apps/core` (`src/linear/agent-mode/`), `packages/domain`
Spec: `../spec.md`, section 4 ("Linear agent mode"); ADR 0013 (amended), ADR 0057

## What to build

- **Turning it on:** `enableAgentMode` sends the admin, from an admin session, through the re-authorization with the agent scopes (ticket 07), with milestone 2's `OAuthState` and PKCE; the callback stores the new tokens and scopes, sets `agentModeAt`, and refuses a token without the scopes. `setBoardAgentMode` sets one board per team per organization (the unique index).
- **The fast lane** on milestone 2's webhook route for the connection: verify, claim the delivery ID and signature hash in one insert with its own deadline (answer non-2xx when the insert fails, so Linear retries), answer 200, and only then enqueue `linear.agent-event`. Nothing in front of the 200 but the verify and the insert. The handler records each webhook's transit time from its signed timestamp and warns when the skew is far from zero.
- **`linear.agent-event` for `created`:** the `AgentSession` row; the board with agent mode for the ticket's team (none: an `error` activity that says so, and the session ends); the creator through `getUser` and the matching rule (ticket 14 owns what an unmatched creator gets); `startTask` with the origin `linear` and the project's default code profile; and, in the same transaction, the first activity (a thought) in the outbox. No runner is waited for.
- **`prompted`:** with `signal: "stop"`, the stop is written to the task in Postgres and the lease holder stops the turn, whichever replica it is (milestone 2's stop path), then one final `response`; the audit entry names the Linear user. A follow-up from a matched member with access is saved as their message (`linear-follow-up`) and sent after the running turn; from anyone else, a thought saying only members of the project can steer it, and nothing reaches the agent.
- **The outbox:** `linear.activity.send` posts each `AgentActivity` with the app's token, idempotent by its key, retried with backoff; every post moves the session's `heartbeatDueAt`. The task's moments write activities through the domain's copy (ADR 0057): a turn started, a PR opened, a needs-you item with its link, stopped, done, failed.
- **The heartbeat:** `linear.heartbeat`, a sweep once a minute, posts an ephemeral thought (or a plain one when `OSTRA_LINEAR_HEARTBEAT_KIND=thought`) for each open session due; a failed one retries for at most 5 minutes.
- **A stop in ostra's panel** on a task with a session posts the final response "Stopped in ostra by …" with the app's token.
- **The token** is refreshed before its day ends with the rotating refresh token (milestone 2's), and a lost refresh is retried within its window.

## Port from

`spikes/linear-agent-mode/src/server.ts`, `webhook-verify.ts`, `agent-sessions.ts`, `turn-driver.ts`; its fake scenarios as tests.

## Done when

- [ ] Tests named `it("F-012: ...")` against the fake Linear server: the ack under 5 s and the first thought under 10 s with no runner online, over 50 delegations; the claim committed before the 200 (an insert that fails answers 500); a replayed `created` starts one task; a stop delivered to a replica that doesn't hold the turn stops it, with one final response and nothing after; a follow-up from a matched member reaches the next turn, from an unmatched user it doesn't; the heartbeat after 20 silent minutes and none while posts flow; the kind switch; the install route refused without an admin session; no activity ever posted with a personal key; the panel's stop posting with the app's token; the token's refresh and its retry.
- [ ] Break-it: enqueueing before the claim's insert commits, and the heartbeat timer not reset on a post, each fail their test; recorded in `context/proof/F-012.md`.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add Linear agent mode`.

## Comments
