# Open source, self-hosted on each organization's own stack

**Status:** accepted (plan signed off 2026-11-17). Amended 2026-11-18: "team" becomes organization, and each organization registers its own GitHub App and Linear app (Q30, Q102, ADR 0026). First answered on 2026-11-17. The maintainer: "It's for any team. Anyone should be able to deploy this piece of software and hook it up to their own stack", and "Open source".

ostra is open source, and anyone can run their own install. There is no central ostra service that an install depends on, and no ostra-owned OAuth app for Linear, Jira or GitHub. Each organization on an install registers its own credentials with each integration: its own GitHub App and its own Linear app. Webhooks are routed by connection, not by one install-wide address (Q102).

A paid hosted version comes later. The maintainer chose "open source, plus a paid hosted version later" over a community-only project and over open core. The hosted version runs the same open code.

## Consequences

- Each integration needs setup that an organization's admin can finish alone, from the panel (F-005, F-006).
- Upgrades happen on each install's own schedule, so migrations add first and drop later (`AGENTS.md`).
- The license has to protect the hosted version without putting off self-hosters or contributors (Q-02).
- One install holds many organizations, and keeps them apart, from the first migration. That is what the hosted version needs (Q-03, Q102, ADR 0026).
