# 13: Core: Linear agent mode

Status: done
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

- [x] Tests named `it("F-012: ...")` against the fake Linear server: the ack under 5 s and the first thought under 10 s with no runner online, over 50 delegations; the claim committed before the 200 (an insert that fails answers 500); a replayed `created` starts one task; a stop delivered to a replica that doesn't hold the turn stops it, with one final response and nothing after; a follow-up from a matched member reaches the next turn, from an unmatched user it doesn't; the heartbeat after 20 silent minutes and none while posts flow; the kind switch; the install route refused without an admin session; no activity ever posted with a personal key; the panel's stop posting with the app's token; the token's refresh and its retry.
- [x] Break-it: enqueueing before the claim's insert commits, and the heartbeat timer not reset on a post, each fail their test; recorded in `context/proof/F-012.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add Linear agent mode`.

## Comments

- 2026-11-20: built in `✨ add Linear agent mode`. The inbox sends an `AgentSessionEvent` to `linear.agent-event` inside the claim's transaction (`apps/core/src/webhooks/inbox.ts`), and the other deliveries to `webhook.process` as before. `apps/core/src/linear/agent-mode/events.ts` handles `created` (the session row, unique per connection; the agent-mode board for the team, else an `error` and the session ends; the creator matched by `matchStarterInTx`; the start through ticket 14's `startFromTrackerInTx`; the first thought in the same transaction) and `prompted` (a stop through milestone 2's stop path with the Linear user named in the audit entry, then one final response; a follow-up through `sendMemberMessageInTx` with `linear-follow-up`, or the "only members" thought). `outbox.ts` has `linear.activity.send` (the app's token only: a connection with `api_key` posts nothing; each post moves `heartbeatDueAt`), `linear.heartbeat` (a minute's sweep; `OSTRA_LINEAR_HEARTBEAT_KIND`; a failing heartbeat is given up after 5 minutes). The task's moments go through `packages/domain/src/linear/agent-session-moments.ts`, called from `moveTaskInTx`, `openPullRequests` and `stopTask` (the panel's stop is the final response). "Turn on agent mode" is `createLinearAuthorizeUrl(..., { agentMode: true })` plus `authorizeLinear`, which keeps the granted scopes, sets `agentModeAt`, and refuses a token without the scopes (`missing-scopes`); `enableAgentMode` and `setBoardAgentMode` are in `packages/domain/src/use-cases/agent-mode.ts`. Proof: `context/proof/F-012.md`.
- Differences from the ticket, each on purpose: (1) a claim whose insert fails answers 503 (milestone 2's inbox), not 500; any non-2xx makes Linear retry. (2) The job posts the session's first activity itself, right after its transaction commits, so the first thought doesn't wait for the queue's next poll (2 s in production); the outbox's job then finds it sent. (3) The posts use `agentSessionCopy`'s words (ADR 0057), which name no member: "A member approved the task…", "A member stopped the task in ostra…". (4) A new moment, `not-started`, tells the session when the board's project couldn't start a task (no profile, no repo, no provider).
- Ticket 07 landed while this was built: the tests run on the shipped `LinearAdapter` against the fake Linear, and the panel's kit (`packages/api/src/services/linear-app.ts`) now hands the token answer's `scopes` to `authorizeLinear` and the domain's `updateExistingToken` to the adapter's `authorizeUrl`. What's left for ticket 26 is the router: `linear.enableAgentMode` (the consent URL, from `createLinearAuthorizeUrl(..., { agentMode: true })`) and `linear.setBoardAgentMode`.
- The live run (spike 5's four real-Linear bullets) needs the maintainer's Authorize click (ticket 40); its plan is in `context/proof/F-012.md`, and F-012 stays `building`.
- Checks: whole-repo typecheck through turbo; lint and tests of `@ostra/domain`, `@ostra/core` and `@ostra/api`; `check:licenses`; `check:proof`. The break-its (the job enqueued before the claim's insert commits; the heartbeat not moved by a post; and four more) each failed their case and were restored.
