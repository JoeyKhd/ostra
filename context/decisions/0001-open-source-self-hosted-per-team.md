# Source-available, self-hosted on each organization's own stack

**Status:** accepted (plan signed off 2026-11-17). Amended 2026-11-18: "team" becomes organization, and each organization registers its own GitHub App and Linear app (Q30, Q102, ADR 0026). Amended 2026-11-18: ostra is source-available, not open source. The code is public and anyone can self-host it for their own team, but nobody else may sell or distribute it (ADR 0048, which replaces ADR 0009). The file keeps its original name so that links to it hold. First answered on 2026-11-17. The maintainer: "It's for any team. Anyone should be able to deploy this piece of software and hook it up to their own stack", and "Open source". He said that before he asked that nobody else may sell or distribute ostra, which open source can't offer.

ostra is source-available: the code is public, and anyone can run their own install for their own team. There is no central ostra service that an install depends on, and no ostra-owned OAuth app for Linear, Jira or GitHub. Each organization on an install registers its own credentials with each integration: its own GitHub App and its own Linear app. Webhooks are routed by connection, not by one install-wide address (Q102).

A paid hosted version comes later. The maintainer chose "open source, plus a paid hosted version later" over a community-only project and over open core. The hosted version runs the same public code, and only the maintainer may offer it (ADR 0048).

## Consequences

- Each integration needs setup that an organization's admin can finish alone, from the panel (F-005, F-006).
- Upgrades happen on each install's own schedule, so migrations add first and drop later (`AGENTS.md`).
- The license protects the hosted version. The Sustainable Use License lets a team self-host ostra for its own use and bars everyone else from selling or distributing it. Outside contributions need a CLA (Q-02, ADR 0048).
- One install holds many organizations, and keeps them apart, from the first migration. That is what the hosted version needs (Q-03, Q102, ADR 0026).
