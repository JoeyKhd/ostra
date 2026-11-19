# 29: Runner: the profile at launch, and the sidecar's MCP proxy

Status: ready-for-agent
Builder: runner
Blocked by: 01, 08
Features: F-021
Packages: `apps/runner` (`src/task-host/`, `src/sidecar/mcp-proxy.ts` (new))
Spec: `../spec.md`, section 4 ("A task starts with its profile"); ADR 0049, ADR 0030

## What to build

- **Skills:** download each skill's files (milestone 2's bulk path), write them into the task's agent folder where the adapter says, and pass the paths to `prepareLaunch`.
- **The MCP proxy** in the sidecar, beside the key proxy: a reverse proxy at `/<random>/mcp/<name>` on the sidecar's address, which forwards streamable HTTP (POST, and SSE for the replies) to the server's real URL with the headers from the credentials response, and refuses any other path. The agent sees only the sidecar's URL (ADR 0030). Requests and replies are passed through, never logged; the proxy logs the server's name, the status and the bytes.
- **Stdio servers** start as the agent's children with the spec's command and variables; the runner refuses one whose command isn't on the box's `PATH`.
- **The repo's agent config:** when the adapter declares `projectConfigOverride: false`, the runner hides the repo's own agent config files from the agent for the task (by the adapter's list of paths), and restores them before the commit so they're never deleted from the branch.
- **On `host`** the sidecar is the runner's own process (ADR 0029), and the proxy runs there.

## Done when

- [ ] Tests: the fake MCP server refuses a call without its token and accepts one through the proxy; the token is absent from the agent's environment, files and the event log; a stdio server starts and stops with the agent; a skill reaches the agent; a hidden repo config is back in the working tree before the commit.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ launch agents with their profile`.

## Comments
