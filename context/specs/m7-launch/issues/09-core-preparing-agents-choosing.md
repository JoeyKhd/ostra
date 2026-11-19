# 09: Core: preparing agents, agent images and choosing a runner by agent

Status: wontfix
Note: Won't do now (2026-11-19): Claude Code (F-018) moved after v1 (the maintainer: "perhaps we can just skip Claude Code with its ACP for now"), and milestone 7 is the launch alone, on OpenCode. Preparing agents, agent images, choosing a runner by agent and `agent.options` in the dispatch existed for Claude Code; with one agent in the base image, none applies. This ticket waits for F-018 after v1; its text stays as written for then (ADR 0062, postponed).
Builder: core
Blocked by: 05, 08
Features: F-018
Packages: `apps/core` (`src/gateway/`, `src/dispatch/`, `src/runners/`)
Spec: `../spec.md`, section 4

## What to build

- **The gateway** stores a runner's `agents` and records `agent.*` events on the runner's row and in the audit log, before acting on them.
- **Admission** uses `chooseRunner`'s agent filter and prepare outcome: it sends `agent.prepare` to the chosen runner once (keyed by runner, agent and version), and the task waits with "Preparing Claude Code on this runner" until `agent.ready`, then is offered there first. `agent.failed` puts the reason on every task waiting for it and tries the next runner that can prepare the agent.
- **`AgentImage` rows** from `agent.ready` with a digest; a project's snapshot build on `docker` and `kubernetes` uses the agent image as its base when the project's profiles use Claude Code.
- **The dispatch** carries `agent.options`, validated by the adapter's schema.

## Done when

- [ ] Tests named for `F-018`: a Claude Code task with no runner having it sends one `agent.prepare` and waits with its reason; `agent.ready` offers it; `agent.failed` moves to the next runner and names the reason; a replayed `agent.ready` writes one `AgentImage`; a minor-5 runner is never offered it; a snapshot's base is the agent image when a profile needs it.
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✨ choose runners by agent`.

## Comments

- 2026-11-19, lead: set `wontfix`. Claude Code (F-018) moved after v1 on the maintainer's word, and this ticket waits for it.
