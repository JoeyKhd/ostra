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
- `@linear/sdk` stays, wrapped in the Linear adapter (spike 5, bullet 5). It typechecks under all eight strict flags and adds about 0.8 s to `tsc` with library checking on, against a budget of 20 s. Under the repo's `skipLibCheck: true` it is clean with no shim and adds about 0.25 s. **Turning `skipLibCheck` off needs a four-line shim for two errors in the SDK's own declarations, or the `dom` lib in the server packages**, and the root `tsconfig.base.json` says so in a comment. The hot path (the viewer, the session status) uses ostra's own GraphQL documents, and the SDK serves mutations and webhook verification. The SDK is pinned exactly, and a bump reruns the spike's `sdk-strict` check (ADR 0007). The editor's language-server cost wasn't measured.
