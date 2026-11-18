# 09: ACP driver and the ACP-to-event mapping

Status: resolved
Builder: adapters
Blocked by: 03
Features: F-019, F-023 (ADR 0018, ADR 0032)
Packages: `packages/adapter-sdk` (`src/agent/acp/`)
Spec: `../spec.md`, sections 5.2 and 10

## What to build

ostra's own ACP driver, which every `AgentAdapter` composes, on `@agentclientprotocol/sdk` 2.7.0 (exact pin) over stdio.

- `src/agent/acp/driver.ts`: start the agent from a launch description through the executor's `AgentHost` seam (the stdio streams and a process handle), `initialize` advertising `elicitation.form`, `session/new`, `session/prompt`, `session/cancel`, `session/load`, the `_session/steering` extension when the agent's `initialize` says it's supported, and close. Permission requests and elicitations go to injected deciders (milestone 1: the task host's, ticket 21). A cancel returns within 5 s and the process tree is reaped.
- `src/agent/acp/process-tree.ts`: reap the agent's process tree on Windows (`taskkill /T /F` through `execFile`, no shell) and on POSIX (process group).
- `src/agent/acp/map.ts`: ACP session updates to ostra events, by the table in `research/agent-ui-stream.md` (ADR 0036, Q124): `current_mode_update` and `config_option_update` become `session.config_changed`; an `in_progress` update of any tool with content becomes `tool.progress`; `usage_update` becomes `session.usage` once per turn; anything else it can't place becomes `agent.unknown`. Updates that `session/load` replays are marked and not emitted as new events. The driver emits `session.config_changed` itself when it sets the model or mode.
- The driver hands each event to an `AgentAdapter.mapUpdate` hook first, so agent quirks (OpenCode's `todowrite`) stay in their adapter.
- ACP payloads are vendor data: parse with loose schemas, and never let an ACP type escape into ostra's events.

## Port from

`spikes/how-should-the-runner-drive-opencode/src/lib/acp-driver.ts`, `process-tree.ts`, `deciders.ts`; `spikes/live-stream-and-task-view/src/producer/acp-map.ts`; the `AgentHost` seam from `spikes/what-is-inside-a-box/src/lib/agent-host.ts` once that spike is committed.

## Done when

- [x] Unit tests drive the driver against a scripted ACP peer in the same process (a minimal one here; ticket 10 builds the full fake) and cover: a turn, a cancel within 5 s, a permission request routed to the decider, an elicitation, a steer when supported and an error when not, `session/load` replays not re-emitted.
- [x] The mapper has a test per row of the table it implements, plus an unknown update.
- [x] No process survives a cancel or a close (checked in the test on this machine).
- [x] The whole-repo checks pass (spec section 9: this runs agent output).
- [x] Committed as `✨ add ostra's ACP driver`.

## Comments

- 2026-11-18, adapters: done in df09e04 (`✨ add ostra's ACP driver`). The driver is `createAcpDriver()` in `packages/adapter-sdk/src/agent/acp/` (`driver.ts`, `map.ts`, `process-tree.ts`), and it is the `DriverPort` every `AgentAdapter` takes. It speaks ACP over the stdio the executor hands it (the `AgentHost` seam), so it doesn't spawn: with the agent's PID (`AgentIo.pid`, additive) it ends the process tree on a cancel nobody answers and on close.
  - **A finding.** `@agentclientprotocol/sdk` 2.7.0's client app installs a session-update router that checks every `session/update` against its own schema and throws on a kind it doesn't know. That stops the message and every handler after it, so an unknown update was dropped silently. The driver takes `session/update` off the wire in a transform before the SDK sees it and reads it with a loose schema, so ADR 0018's "never a drop" holds (tested against the fake agent's `future_feature` update).
  - **The turn's own events.** `AgentAdapter.prompt` now emits `turn.started`, then what the mapping held back (the open text segment, `session.usage`), then `turn.ended` or `turn.failed`, through `onEvents`. The task host (ticket 21) writes `user.message` and numbers the events, and doesn't write these. Text is buffered into segments by the mapper and closes on a new message ID, a non-text update or the turn's end; live deltas go to `onLiveText`.
  - **Additive contract changes** (each a small commit): `DriverPort.finishTurn` and `closeSession`, `DriverConnection.setConfigOption` and `setMode` (they return the `session.config_changed` event), `AgentIo.pid`, `MappedUpdate`'s `update` (an adapter rewrites an update and keeps the shared ordering), and `PrepareLaunchInput.mcp.bearer`.
