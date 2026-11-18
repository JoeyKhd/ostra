# 10: Scripted fake ACP agent and the agent contract suite

Status: ready-for-agent
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

- [ ] Both fake profiles pass the suite on this machine.
- [ ] The suite's cases are named after the ADR line or ledger row each one checks.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✅ add the fake ACP agent and agent suite`.

## Comments
