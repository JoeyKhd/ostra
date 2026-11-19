# 20: ostra's MCP tools in the sidecar

Status: resolved
Builder: runner
Blocked by: 02
Features: F-030 (the PR text), F-078 (the template)
Packages: `apps/runner` (`src/sidecar/mcp-tools.ts`)
Spec: `../spec.md`, sections 2 and 5.1

## What to build

An MCP server per task on `@modelcontextprotocol/sdk` (exact pin; confirm its license on npm before pinning, answers section 4.6), over Streamable HTTP, which the agent's config points at (ticket 11).

- Listens on loopback (`host`) or the box network (`docker`), and checks a random per-task bearer it put in the agent's config. That bearer grants only this task's tools. The runner's own server credentials never leave the runner.
- Milestone 1's tool: `set_pull_request_text { repo, title, body }`. It validates the repo against the task's repos, caps the sizes, and emits `pr.text_set`. Its description tells the agent to follow the repo's PR template when the task spec carries one, and that the title should stay close to the prompt.
- Tool input is untrusted: parse it with a strict schema and never pass it to a shell.

## Done when

- [x] An MCP client in the test lists the tool, calls it, and the event comes out; a wrong bearer gets 401; an unknown repo and an oversized body are refused.
- [x] The whole-repo checks pass (spec section 9: agent output).
- [x] Committed as `✨ add ostra's MCP tools for agents`.

## Comments

- 2026-11-18, runner: done in c6d932b (`✨ add ostra's MCP tools for agents`). `src/sidecar/mcp-tools.ts` on `@modelcontextprotocol/sdk` 1.32.2 (MIT, checked on npm): Streamable HTTP, stateless, a random per-task bearer checked in constant time, and one tool, `set_pull_request_text`. Its input is a strict schema, checked against the task's repos and size caps, and emitted as `pr.text_set`. The tool's description carries each repo's PR template and the title rule. Tested with the SDK's own client. Whole-repo checks green.
