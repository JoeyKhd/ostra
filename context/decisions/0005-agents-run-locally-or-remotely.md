# Agents run on a member's own machine or remotely

**Status:** accepted (plan signed off 2026-11-17). Amended 2026-11-18: still true of runners, but "with that member's own agent logins" is removed, because every runner runs its agent on provider keys through the key proxy (Q47). First answered on 2026-11-17. The maintainer: "the user should be able to connect to a local instance of claude code, opencode, ohmypi, or remotely."

A task's agent can run on a member's own machine (a personal runner) or on a machine that an organization's runner pool shares (a pool runner). ostra treats both the same (runner parity in `AGENTS.md`). Both run the agent on provider keys, through the key proxy. No subscription login is used, stored or passed on anywhere.

## Consequences

- Running agents is separate from the server, on runners that connect out to it (ADR 0029, which supersedes ADR 0012).
- No credential enters the agent's container on `docker` and `kubernetes`. The `host` executor has no box. There the key proxy keeps keys out of the agent's environment and files, and a pool runs the agent as a separate OS user. On a personal runner the member controls the machine and can read the key (ADR 0030, which supersedes ADR 0014).
- An organization's model provider is usable on a personal runner only when an admin allows it for that provider. It's off by default, because the key then sits on a machine its owner controls (Q47).
- The two differences the `host` executor is allowed are recorded in ADR 0029.
- Agent sessions are stored on the machine that ran them, so reopening a task elsewhere needs ostra's own copy of its history and the agent's session archive (ADR 0006, ADR 0039).
