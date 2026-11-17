# Open source, self-hosted by each team on its own stack

**Status:** accepted (plan signed off 2026-11-17). First answered on 2026-11-17. The maintainer: "It's for any team. Anyone should be able to deploy this piece of software and hook it up to their own stack", and "Open source".

ostra is open source, and every team can run its own install. There is no central ostra service that an install depends on, and no ostra-owned OAuth app for Linear, Jira or GitHub. Each install registers its own credentials with each integration.

A paid hosted version comes later. The maintainer chose "open source, plus a paid hosted version later" over a community-only project and over open core. The hosted version runs the same open code.

## Consequences

- Each integration needs setup that a team's admin can finish alone, from the panel (F-005, F-006).
- Upgrades happen on each team's own schedule, so migrations add first and drop later (`AGENTS.md`).
- The license has to protect the hosted version without putting off self-hosters or contributors (Q-02).
- Whether one install keeps several teams apart, as the hosted version will need, is Q-03.
