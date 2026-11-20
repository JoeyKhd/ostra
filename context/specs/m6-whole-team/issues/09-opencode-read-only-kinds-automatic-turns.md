# 09: OpenCode adapter: read-only kinds, the new tools and automatic turns

Status: ready-for-agent
Builder: adapters
Blocked by: 04
Features: F-099, F-100, F-101, F-113
Packages: `packages/adapters/adapter-opencode`
Spec: `../spec.md`, sections 5.2 and 8

## What to build

- **The built-in Refine and Review profiles' permissions** map to OpenCode's own settings: edits denied for review; edits allowed inside the workspace for a refine profile that allows prototyping and denied for the built-in one; shell allowed (the box contains it, ADR 0031); `external_directory` denied as milestone 1's mapping does.
- **ostra's MCP server** in OpenCode's MCP list carries the tools the spec's `tools` names, and nothing else, so a code task never sees `submit_review`.
- **The question tool in an automatic turn:** OpenCode's `question` tool reaches the runner as an ACP elicitation; the adapter declares it does (capability `elicitation: true`), so the runner's fixed reply (ticket 23) answers it. Spike 10's case, through the agent suite (ticket 04), on the real OpenCode with the stub model.
- **`commitPaths`:** nothing in the adapter; the agent suite's case runs on OpenCode to show its own commits don't escape the runner's filter.

## Done when

- [ ] Ticket 04's new agent suite cases pass on OpenCode, with the stub model scripted for each.
- [ ] A test shows a code task's MCP list has no `submit_draft`, `submit_review` or `propose_environment`, and a review task's has `submit_review` only of the three.
- [ ] Break-it: the tool filter dropped fails its test; recorded in `context/proof/F-100.md`.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ give OpenCode the read-only kinds`.

## Comments
- 2026-11-20 (from ticket 04): OpenCode's suite fixture (`opencode-adapter.contract.test.ts`) runs the new cases once it passes a `team` probe set (`AgentTeamProbes` in `packages/adapter-sdk/src/testing/agent-team-cases.ts`; the fakes' are in `fake-agent.test.ts`'s `teamProbes`). Then switch OpenCode's three milestone 6 rows in `packages/adapter-sdk/src/testing/parity.ts` (`milestone6Waits`) from `waits` to the cases, as `milestone6WithTools` names them for the fakes. The capability the spec calls `elicitation` is the existing `elicitationForm`.
