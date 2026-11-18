# 20: ostra's MCP tools in the sidecar

Status: ready-for-agent
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

- [ ] An MCP client in the test lists the tool, calls it, and the event comes out; a wrong bearer gets 401; an unknown repo and an oversized body are refused.
- [ ] The whole-repo checks pass (spec section 9: agent output).
- [ ] Committed as `✨ add ostra's MCP tools for agents`.

## Comments
