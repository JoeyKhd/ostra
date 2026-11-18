# 21: The task host: the sidecar's work, end to end

Status: ready-for-agent
Builder: runner
Blocked by: 11, 15, 16, 17, 19, 20
Features: F-013, F-016, F-019, F-023, F-025, F-089, F-090 (on this machine)
Packages: `apps/runner` (`src/task-host/`)
Spec: `../spec.md`, sections 3 and 4

## What to build

The code that runs one task, the same in every executor (ADR 0029). On `host` the runner process runs it; on `docker` the sidecar does (ticket 22). It talks to the server through a `ServerLink` interface: the runner's own connection on `host`, the sidecar's own on `docker`.

- **On `dispatch`:** accept within the offer timeout, or reject when full. Fetch the task spec, then the task's credentials with the lease epoch. Hold the credentials in memory only, never in an environment variable, argument or file of the runner.
- **Prepare:** start the key proxy (17), the git proxy (18) and the MCP tools (20); have the executor (19) create and prepare the workspace; send `environment.setup_*` events.
- **Run:** have the agent adapter (11) build the launch with the proxies' URLs and the fake key, start it through the executor, open a session, send the prompt as `user.message` and the turn. Stream the driver's events through the spool (16). Milestone 1 has no approval rules: permission requests within the worktree are allowed by OpenCode's config, and any request that still reaches the decider is answered "once" and recorded as `approval.auto_answered` with the reason "no rules until F-026". An elicitation waits, shown read-only in the panel, until the turn's maximum minutes, then the turn is cancelled.
- **End of the turn:** commit and push (19), then send `git.pushed` per repo and `session.ended` with or without changes. Close the agent, revoke the fake key, stop the proxies, release the workspace.
- **Commands:** `stop` cancels the turn, pushes the hidden ref, ends the session as stopped; `interrupt` cancels the turn; `steer` follows the agent's capability (queued for after the turn when it lacks `steerMidTurn`; milestone 1's panel doesn't send it yet).
- **Crash:** the agent exits mid-turn → push the hidden ref, `session.crashed`.
- **The environment check:** before starting the agent, assert the launch's environment holds only the allowlist, the fake key and the proxy URLs, and fail the task if it holds a value equal to any real credential.

## Done when

- [ ] An in-process integration test, with the fake gateway, the scripted fake agent (10), the stub models (12) and the git upstream stub, runs dispatch → PR-ready branch, and stop → hidden ref, and crash → hidden ref, with every event stored once.
- [ ] With `model.env` loaded, the same test with OpenCode instead of the fake agent completes a real turn (gated).
- [ ] A test searches the task root, the event stream and the logs for the real credential values and finds none.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add the task host`.

## Comments
