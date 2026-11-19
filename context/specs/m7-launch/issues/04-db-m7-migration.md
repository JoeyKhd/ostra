# 04: DB: the milestone 7 migration

Status: ready-for-agent
Builder: core
Blocked by: none
Features: F-018, F-082
Packages: `packages/db` (`prisma/schema.prisma`, `prisma/migrations/`, the isolation fixtures)
Spec: `../spec.md`, section 5.3

## What to build

One migration after milestone 6's, additive only, as spec section 5.3's table says: `AgentProfile.agentOptions`, the new `AgentImage` with its two unique keys, `Runner.agents` (only if milestone 5's `capabilities` doesn't already hold the agents; ticket 01's reading decides, and this ticket says which under `## Comments`), the account's `theme`, the enums `ThemePreference` and `AgentImageState`, and the three audit actions. Every new row carries `organizationId` with the composite key, as milestones 1 to 6's do.

## Done when

- [ ] The migration applies on an empty database and on one holding milestone 6's demo data, and changes no existing row.
- [ ] Milestone 4's generated isolation test has a fixture for `AgentImage` and passes; it fails without the fixture.
- [ ] A test shows a new account's theme is `dark` and a profile's options `{}`.
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✨ add the milestone 7 migration`.

## Comments
