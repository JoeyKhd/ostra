# A server and runners: the ostra runner is always on the box

**Status:** superseded by ADR 0029 (2026-11-18). It was accepted at the plan's sign-off on 2026-11-17, and the text below is kept as the historical record. ADR 0029 replaces the single runner binary with runner pools, executors and boxes: a runner joins a pool with a join token, and its executor gives each task a box of its own (Q32, Q38, Q48, Q93 to Q98). Chosen on 2026-11-17 in grilling round 2. The maintainer asked whether someone could "just setup a server somewhere with codex ohmypi or whatever harness and then connect it to our tool".

- **The server** is the control plane: the panel, accounts, boards, rules, task history and the integrations. It never needs to run an agent itself.
- **A runner** is the ostra runner binary on any machine: a member's laptop, or a server or VM.
  - It signs in once with a one-time code, connects out to the server (so it works behind NAT), and reports the agents installed on it.
  - Running agents, workspaces, push tokens, session history and permissions all go through it.
- **Connecting a server** means installing the ostra runner on it. ostra ships a runner Docker image with the v1 agents already installed, so a new remote runner is one `docker run` and a sign-in code.
- **A one-box install** can include a built-in runner in the server.

## Considered options

- **Connecting straight to an agent's own server mode** (e.g. `opencode serve`) with no ostra runner on the box. Rejected: it would skip workspace handling, push tokens, session history and every guarantee in ADR 0011.

## Consequences

- The runner protocol is ostra's own, versioned, and shared as types between server and runner (ADR 0008).
- A runner holds no long-lived secrets. The server hands it short-lived tokens per task (`research/platform-auth-github.md`, ADR 0014).
