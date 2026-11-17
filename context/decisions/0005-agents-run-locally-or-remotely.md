# Agents run on a member's own machine or remotely

**Status:** accepted (plan signed off 2026-11-17). First answered on 2026-11-17. The maintainer: "the user should be able to connect to a local instance of claude code, opencode, ohmypi, or remotely."

A task's agent can run on a member's own machine, with that member's own agent logins, or on a remote machine the team shares. ostra treats both the same (runner parity in `AGENTS.md`).

## Consequences

- Running agents is separate from the server, on runners that connect out to it (ADR 0012).
- Agent credentials live where the agent runs, and who may use which is in ADR 0014.
- Agent sessions are stored on the machine that ran them, so reopening a task elsewhere needs ostra's own copy of its history (ADR 0006).
