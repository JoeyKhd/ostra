# 22: Runner: refine and review tasks, and their tools

Status: ready-for-agent
Builder: runner
Blocked by: 01, 09
Features: F-099, F-100
Packages: `apps/runner` (`src/task-host/`, `src/sidecar/mcp-tools.ts`, `src/sidecar/git-proxy/`)
Spec: `../spec.md`, sections 4 ("A refine task", "The AI review") and 5.1

## What to build

- **Read-only kinds:** a spec of kind `refine` or `review` starts the git proxy in its read-only mode (milestone 1's), and the runner itself pushes nothing after a turn: no branch, no hidden ref (Q221). The session archive is still uploaded, so a reopen restores the conversation; the panel says prototypes in the box aren't kept.
- **The review checkout:** with `review` in the spec, each repo is fetched and checked out at its `headSha`, detached, with `baseSha` fetched too so the agent can diff; the agent starts at the workspace root when there are several.
- **The tools:** the sidecar's MCP server serves exactly the tools `tools` names. `submit_draft` and `submit_review` check their input against `@ostra/protocol`'s schemas, forward to `/runner/v1/tasks/:taskId/draft` and `/review` with the task's token, and return the protocol's result text, refusals included.
- **On `docker`** the proxy and the tools run in the sidecar on the box network, as milestone 4's memory tools do; unit-tested against the fake engine, live with F-017 on Linux.

## Done when

- [ ] Tests: a refine task's push and hidden-ref push from the agent's shell are refused before anything reaches the fake upstream; the runner pushes nothing after a refine or review turn; a review task's repos sit at the given heads; the tools listed per kind; each tool's round trip through the fake core, with each refusal.
- [ ] Break-it: the read-only mode not set for refine fails its test; recorded in `context/proof/F-099.md`.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ run refine and review tasks`.

## Comments
