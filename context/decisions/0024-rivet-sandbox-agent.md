# Rivet Sandbox Agent drives the agents

**Status:** accepted on 2026-11-18, to be validated by spike 1. It supersedes the "ostra's own generic ACP driver" part of ADR 0018. The maintainer: "I think we were going for Rivet ... something that I really liked."

In every box, ostra's runner drives the coding agent through **Rivet Sandbox Agent** (`rivet-dev/agents`, `sandbox-agent/`).

Checked on 2026-11-18 on npm and GitHub:
- Apache-2.0
- npm `sandbox-agent` 0.5.6, released 2026-11-05, with 51 releases since 2026-01-28 and about 55k downloads a week
- binaries for Linux (x64 and arm64), macOS (x64 and arm64) and Windows (x64)

What it does:
- It drives OpenCode, Codex, Pi, Claude Code, Cursor and Amp through one API, and gives back one event schema covering tool calls, permission requests, file edits and questions (`research/landscape.md`, addendum).
- It's **built on ACP**: it depends on `acp-http-client`, which uses the official `@agentclientprotocol/sdk`. So ACP stays the protocol underneath, as the maintainer wanted for extensibility.
- The runner runs it locally inside the box and keeps dialing out to the server, so there are no inbound ports (ADR 0012).
- It doesn't save sessions itself. The runner spools every event and ships it to Postgres (ADR 0011, `research/runner-transport.md`).

## Considered options

- **ostra's own ACP driver** (ADR 0018 as first written). Rejected: Rivet already gives us that driver, plus the HTTP transport, running in sandboxes, and a normalized event schema, on the same protocol.
- **Building on Omnara.** Rejected: it's a whole platform with its own agent loop, not a component (ADR 0015).

## Consequences

- **Pre-1.0.** The runner image pins the exact version, contract tests run per agent, and upgrades are deliberate.
- **One vendor.** It's Apache-2.0, so it can be forked. Every Rivet import lives in one runner package. ostra maps Rivet's schema into its own typed event model (ADR 0018's principle stays), so swapping it out stays possible.
- **Spike 1 validates it** for OpenCode, the proposed default agent (Q45):
  - any base URL and model
  - steering mid-turn and interrupting
  - resume and restore
  - permission requests mapped onto ostra's approvals
  - a complete event schema
  - running inside E2B and Docker, and on a Windows laptop

  If a must-have fails, the runner drives that capability over ACP directly.
