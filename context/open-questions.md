# Open questions

**Who answers:** 👤 = the maintainer's call · 🔬 = research informs it, then we decide together.

A settled question leaves this file. Its answer lives on in the ADR (`decisions/`) or ledger row (`features.md`) that settles it. IDs are permanent.

## Settled

| Question | Settled in |
|---|---|
| Q-01 name | "ostra" |
| Q-02 | ADR 0009 |
| Q-03 | ADR 0010 |
| Q-04, Q-18 | ADR 0008 |
| Q-05 | ADR 0012 |
| Q-06 | ADR 0014 |
| Q-07, Q-08 | ADR 0006 |
| Q-09 | F-007 |
| Q-10 | ADR 0019 |
| Q-11, Q-19 | ADR 0013 |
| Q-12 | F-053 and ADR 0013 now; F-034 later |
| Q-13 | F-026 |
| Q-14 | ADR 0020 |
| Q-15 | ADR 0017 |
| Q-16 | F-041 in v1; F-029 later |
| Q-17 | F-054 |
| Q-21 | F-055 in v1; F-056 later |
| Q-22 | ADR 0018 |
| Q-23 | ADR 0016 |
| Q-24 | F-021 |
| Q-25 | ADR 0004: Claude Code only in v1, then the researched tiers |
| Q-26 | F-050 to F-052 |
| Q-27 | F-058 in v1 |
| Q-28 | ADR 0018: Claude Code through ACP |

## Open

**Q-20 🔬 Jira's sign-in model** (F-008, ADR 0001). Atlassian says integrations that have each customer create their own OAuth app don't comply with its rules. How that applies to self-hosted tools is unverified. The safer route is a service account the team owns, plus webhooks an admin registers. Settle before Jira work starts.
