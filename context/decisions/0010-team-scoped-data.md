# Every piece of data belongs to a team, from day one

**Status:** accepted (plan signed off 2026-11-17). Chosen on 2026-11-17 in grilling round 2.

Every record (task, board, runner, agent profile, credential, rule) belongs to exactly one team, and every query is scoped by it. A self-hosted install starts with one team and can hold more. The hosted version (ADR 0001) runs many teams on one install, on the same code.

## Consequences

- Teams map to better-auth organizations, and members belong to one or more teams.
- Every test that reads data also checks that another team's data stays invisible.
- Doing this later would mean rewriting the data model, which is why it's in v1.
