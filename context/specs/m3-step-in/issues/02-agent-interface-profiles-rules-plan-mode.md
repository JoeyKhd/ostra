# 02: Adapter SDK: the agent interface for profiles, rules and plan mode

Status: ready-for-agent
Builder: adapters (contracts, first)
Blocked by: 01
Features: F-021, F-024, F-026, F-063
Packages: `packages/adapter-sdk` (`src/agent/`, `src/test-adapters/`, `src/testing/`)
Spec: `../spec.md`, section 5.2 ("`AgentAdapter`"); ADR 0049

## What to build

- **Capabilities** (`src/agent/capabilities.ts`), new fields, declared by every adapter in the same commit (OpenCode, the fake agents, `tiny-adapters.ts`): `permissionRules`, `planMode`, `skills`, `mcp`, `projectConfigOverride`.
- **`prepareLaunch` inputs:** the profile's approval rules, the task rules, the skills (paths of files the runner has written), the MCP servers (an HTTP server as a sidecar URL with no credential; a stdio server as a command) and the turn mode. Its result's files hold what the agent reads.
- **`setMode(session, mode)`** for `session-mode` agents (ACP `session/set_mode`), and the base class's relaunch path for `relaunch` agents: stop the agent, start it again with the new mode's launch, `session/load`, and mark the replayed updates as milestone 2 does.
- **The permission request's subject:** the base class turns an ACP `session/request_permission` into ostra's subject (`path`, `command`, `url` or `tool`) from the tool call's kind, raw input and locations, through a per-adapter hook (`describePermission`) with a default for ACP's standard kinds. This is what the runner matches rules against.
- **The fake agents:** the existing scripted agent gains session modes (`plan`, `build`), native plans, reject-and-continue, a permission request on a path and on a command, a question, and a write attempted during a plan turn; a second scripted agent declares no `steerMidTurn` and no modes (`planMode: "relaunch"`).
- **The agent contract suite** gains the cases of section 5.2: a rule that asks; a task rule that answers; a deny with a reason that re-prompts; the session's other open requests closing as cancelled; an expired request; a question answered; a plan turn that changes no file and whose write is refused; the switch to build mode, by `setMode` and by relaunch; a steer mid-turn and a queued one; skills and MCP servers reaching the agent; a repo config that allows everything changing nothing. The suite runs against both fake agents and against OpenCode on the stub models (ticket 08).
- Port spike 1's steer probe (`spikes/how-should-the-runner-drive-opencode/src/cases/steer-probe.ts`) and its permission and question cases (`t7-permissions.ts`, `t8-questions.ts`) into the suite, with the provenance comment.

## Done when

- [ ] Tests: the suite passes against both fake agents; each new capability is read by the base class and never assumed; a capability set to false takes the other path (relaunch, the runner's check, hidden repo config).
- [ ] Every adapter declares every new capability; nothing that compiled before fails.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add the agent interface for profiles`.

## Comments
