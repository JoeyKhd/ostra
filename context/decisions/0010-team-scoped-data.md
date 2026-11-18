# Every piece of data belongs to a team, from day one

**Status:** superseded by ADR 0026 (2026-11-18). It was accepted at the plan's sign-off on 2026-11-17, and the text below is kept as the historical record. ADR 0026 replaces teams with organizations and projects: every record belongs to one organization, records inside a project also carry the project, and access is per project, with two roles at each level (Q28, Q30, Q35, Q102). Chosen on 2026-11-17 in grilling round 2.

Every record (task, board, runner, agent profile, credential, rule) belongs to exactly one team, and every query is scoped by it. A self-hosted install starts with one team and can hold more. The hosted version (ADR 0001) runs many teams on one install, on the same code.

## Consequences

- Teams map to better-auth organizations, and members belong to one or more teams.
- Every test that reads data also checks that another team's data stays invisible.
- Doing this later would mean rewriting the data model, which is why it's in v1.
