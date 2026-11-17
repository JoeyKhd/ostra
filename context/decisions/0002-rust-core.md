# The core is written in Rust

**Status:** superseded by ADR 0008 (TypeScript end to end) on 2026-11-17. First answered on 2026-11-17. The maintainer: "I think we should build in Rust."

The orchestrator, the API, the adapters and the runner are Rust. Its strengths fit the job: long-running daemons that manage many child processes and streams, a single static binary for the runner that members install on their own machines, and types strong enough to model task and session lifecycles exactly.

## Consequences

- None of the agents ships an official Rust SDK as far as we know (the Claude Agent SDK is TypeScript/Python). ostra drives each agent through its command line or its own protocol (`research/agent-harnesses.md`).
- Team accounts use better-auth, a TypeScript library (ADR 0003), so the server isn't Rust alone. How the two sit together is Q-04.
