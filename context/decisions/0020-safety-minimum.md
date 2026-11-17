# The minimum safety bar for v1

**Status:** accepted (plan signed off 2026-11-17). Chosen on 2026-11-17 in grilling round 3.

Ticket text comes from anyone with access to the tracker and goes into an agent that can run commands. v1 holds these lines:

1. **The runner's container is the boundary** on remote runners. Agents run inside the runner image, never directly on the host. Separate containers per task come later (F-017).
2. **Short, narrow credentials.** GitHub tokens last one hour, cover one repo and can only push. Agent keys and environment secrets are handed over per task and never saved on the runner (ADR 0014).
3. **Tasks from outside ostra wait for a member's approval** (F-040).
4. **Protected default branches.** ostra won't start a task on a repo whose default branch isn't protected, unless an admin overrides that for the repo (F-060). GitHub tokens can't be limited to one branch.
5. **Explicit permissions.** ostra sets every agent's permissions from its profile and never relies on an agent's defaults (F-026, ADR 0018).

## Consequences

- An environment's secrets are readable by the agent, and so by anything that tricks it. The panel says environments are for dev and test credentials, not production ones (F-050).
