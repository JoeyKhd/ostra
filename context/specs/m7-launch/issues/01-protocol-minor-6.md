# 01: Protocol: minor 6

Status: ready-for-agent
Builder: core (contracts, first)
Blocked by: none (milestone 6's minor lands first)
Features: F-018 (its wire shapes)
Packages: `packages/protocol`
Spec: `../spec.md`, section 5.1

## What to build

Every change is additive. The schema is written once, Zod first; the types are `z.infer`. If milestone 6's minor isn't on `main` yet, this ticket waits for it, then takes the next number and writes it under `## Comments` (the spec calls it "minor 6").

- **The minor,** negotiated in `hello` and `welcome`, with the previous minor's codecs kept. A minor-5 peer never receives `agent.prepare`, `agent.options` or `parentToolCallId`, and `isTaskOfferable(spec, peer)` refuses it any task whose agent isn't `opencode`, with the reason the dispatch note shows.
- **What a runner reports:** `agents: [{ name, version, state: "ready" | "preparing" | "failed" | "available", image: { digest } | null }]` on `hello` and `status`, strict.
- **Runner events:** `agent.preparing`, `agent.ready` and `agent.failed` with the reasons `checksum`, `install`, `build`, `registry` and `unsupported`, and a `detail` capped at 2 KiB. They share the `agent.` prefix with the task events `agent.message`, `agent.thought`, `agent.content` and `agent.unknown`, so they go in the runner events' union only.
- **The command** `agent.prepare { agent, version }`, numbered like every command.
- **Subagent events:** the optional `parentToolCallId` on `tool.called`, `agent.message`, `agent.thought` and `plan.updated` (`src/events/agent-events.ts`; there is no `tool.started` or `tool.updated`). `tool.progress`, `tool.completed` and `tool.failed` name their call already.
- **Offers:** the decline reason `agent-missing`.
- **The task spec:** `agent.options`, an optional record, validated by the adapter's own schema where it's read (ticket 02).
- Each schema's description says what's never logged: an install's path outside the runner's data folder, an agent's environment.

## Done when

- [ ] Tests: every new shape round-trips; the previous minor's messages still parse; a minor-5 peer's codec drops the new fields; no union the gateway parses holds both a runner `agent.*` event and a task `agent.*` event; `isTaskOfferable` refuses a `claude-code` task for a minor-5 peer and allows it for minor 6; a strict object refuses an unknown field; the fixtures in `src/testing/` cover each new event, command and field.
- [ ] Every caller in the repo still compiles, and no existing schema changed shape.
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✨ add protocol minor 6`.

## Comments
