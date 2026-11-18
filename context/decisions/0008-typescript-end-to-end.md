# TypeScript end to end

**Status:** accepted (plan signed off 2026-11-17). Amended 2026-11-18: the runner ships as the `ostra` npm CLI and in images, with no Bun in v1 (ADR 0046, F-085), and agents run in a box's agent container, or as a child process on the `host` executor (ADR 0029). First answered on 2026-11-17, and supersedes ADR 0002. The maintainer asked "should we even build in Rust? Do you recommend it for speed?", then chose "typescript fully".

The server, the web app, the adapters and the runner are all TypeScript. Rust wouldn't buy speed here. ostra's work is mostly waiting, on models, git, trackers and code hosts, and its own work is passing events from agents to browsers. TypeScript gives:

- the official SDK of nearly everything ostra integrates with: the Claude Agent SDK, OpenCode's SDK, `@linear/sdk`, Octokit and better-auth itself
- one language and one type system from the database to the browser
- better-auth running inside the server, with no separate auth process

Research: `research/agent-harnesses.md`, `research/trackers.md`, `research/platform-auth-github.md`.

## Consequences

- The runner ships as the `ostra` CLI, an npm package, and in the runner image (ADR 0046, which supersedes ADR 0023). Bun isn't required in v1. Signed binaries compiled with Bun come after v1 (F-085). The server runs on Node LTS (ADR 0016).
- The server and the runner share the types of the protocol between them, in one package, with Zod checking messages at both ends.
- Agents run as separate processes, never inside the runner's own process, so a crashing agent can't take the runner down. On the `docker` and `kubernetes` executors that's the agent's container in its box. On the `host` executor it's a child process of the runner (ADR 0029).
- Rust stays an option for a single hot spot if one ever shows up, and that would need its own ADR.
