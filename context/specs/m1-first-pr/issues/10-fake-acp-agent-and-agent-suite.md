# 10: Scripted fake ACP agent and the agent contract suite

Status: resolved
Builder: adapters
Blocked by: 04, 09
Features: F-019 (the contract suite), adapter parity (`AGENTS.md`)
Packages: `packages/adapter-sdk` (`src/testing/fake-acp-agent/`, `src/testing/agent-suite.ts`)
Spec: `../spec.md`, section 8

## What to build

- A scripted fake ACP agent: a small Node program that speaks ACP over stdio and plays a script (messages, thoughts, tool calls of each ACP kind, a plan, a permission request, an elicitation, a long silent step, a crash). Two profiles, as ADR 0032 asks:
  - one that declares what OpenCode lacks: native plan updates and reject-and-continue, with steering
  - one with no steering, so both composer paths stay tested
- `defineAgentContractSuite` filled in: a turn ends with `turn.ended`; tool calls render by ACP kind; a cancel returns in under 5 s and leaves no process; the agent's environment holds only the allowlist (the fake prints its own environment's names on request); the model base URL and the fake key are what reach the agent; a deny is followed by the runner's re-prompt (ADR 0032); steering is used only when declared; an unknown update becomes `agent.unknown`, never a drop.
- A `FakeAgentAdapter` that runs the fake through the driver, and the suite green for both profiles.

## Done when

- [x] Both fake profiles pass the suite on this machine.
- [x] The suite's cases are named after the ADR line or ledger row each one checks.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✅ add the fake ACP agent and agent suite`.

## Comments

- 2026-11-18, adapters: done in df09e04 and a9c6027 (`✅ add the fake ACP agent and agent suite`). The fake is `packages/adapter-sdk/src/testing/fake-acp-agent/`: `agent.ts` (the scripts: say, tools of every ACP kind, plan, permission, elicit, silent, silent-deaf, steerable, spawn, crash, env, endpoint, unknown, config, usage, compaction, content), `main.ts` (a program, `node main.ts --profile=rich|plain`) and `FakeAgentAdapter`. `rich` has native plan updates, reject-and-continue and steering; `plain` has none. `defineAgentContractSuite` has 15 cases named after their ADR line or ledger row, and `probes` (optional prompts) let an adapter whose agent can't be scripted skip a case; `spawnAgentProcess` starts a launch as an executor would.
  - Both profiles pass as real child processes through the driver on this machine (Windows 11), including "a cancel leaves no process of the agent's behind" (the fake leaves a grandchild, and the driver reaps it).
  - The environment case lists the names Windows adds to every process it starts (`HOMEDRIVE`, `USERNAME`, ...) beside the allowlist.
