# 05: DB: the milestone 6 migration

Status: ready-for-agent
Builder: core (contracts, first)
Blocked by: none (milestone 5's migration lands first)
Features: every F-ID of the spec's section 2 (their tables)
Packages: `packages/db` (`prisma/schema.prisma`, a new migration, `src/testing/isolation-models.ts`)
Spec: `../spec.md`, section 5.3

## What to build

- One migration after milestone 5's, with every change of spec section 5.3's table, additive only. Every new row carries `organizationId`; every project record carries `projectId` with the composite foreign key to the project, as every earlier model does.
- The partial unique indexes as raw SQL in the migration: `AutomationRun`'s two (per occurrence, per ticket match), `Board`'s one agent-mode board per team per organization, and the scheduler's index on due automations.
- Checks in the migration, where earlier milestones put theirs: `AutomationRun.occurrenceAt` set only for occurrences and `ticketId` only for matches, `Finding.line` positive, `Task.approvedAt` only with `approvedByMemberId`.
- Column comments on the text that is untrusted or private (`Automation.prompt`, the draft's fields, `Finding.body`, `EnvironmentProposal.body`): never logged. `AgentActivity.body` holds only ostra's own words.
- **The isolation fixtures** (milestone 4's ticket 09): a fixture builder for each new model in `isolation-models.ts`, so the generated test covers them; none goes on the allowlist.

## Done when

- [ ] The migration applies on an empty database and on milestone 5's, and `prisma migrate diff` shows nothing left over.
- [ ] Milestone 4's generated isolation test passes with every new model in it.
- [ ] Tests of each partial unique index: a second occurrence row for the same automation and time, a second match for the same rule and ticket, and a second agent-mode board for the same team are refused.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add the milestone 6 migration`.

## Comments
