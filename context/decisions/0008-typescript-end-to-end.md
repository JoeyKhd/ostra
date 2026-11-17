# TypeScript end to end

**Status:** accepted (plan signed off 2026-11-17). First answered on 2026-11-17, and supersedes ADR 0002. The maintainer asked "should we even build in Rust? Do you recommend it for speed?", then chose "typescript fully".

The server, the web app, the adapters and the runner are all TypeScript. Rust wouldn't buy speed here. ostra's work is mostly waiting, on models, git, trackers and code hosts, and its own work is passing events from agents to browsers. TypeScript gives:

- the official SDK of nearly everything ostra integrates with: the Claude Agent SDK, OpenCode's SDK, `@linear/sdk`, Octokit and better-auth itself
- one language and one type system from the database to the browser
- better-auth running inside the server, with no separate auth process

Research: `research/agent-harnesses.md`, `research/trackers.md`, `research/platform-auth-github.md`.

## Consequences

- The runner ships as an npm package and in a Docker image first, and as signed binaries compiled with Bun before launch (ADR 0023). The server runs on Node LTS (ADR 0016).
- The server and the runner share the types of the protocol between them, in one package, with Zod checking messages at both ends.
- Agents run as child processes of the runner, never inside it, so a crashing agent can't take the runner down.
- Rust stays an option for a single hot spot if one ever shows up, and that would need its own ADR.
