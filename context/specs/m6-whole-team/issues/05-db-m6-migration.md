# 05: DB: the milestone 6 migration

Status: done
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

- [x] The migration applies on an empty database and on milestone 5's, and `prisma migrate diff` shows nothing left over.
- [x] Milestone 4's generated isolation test passes with every new model in it.
- [x] Tests of each partial unique index: a second occurrence row for the same automation and time, a second match for the same rule and ticket, and a second agent-mode board for the same team are refused.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add the milestone 6 migration`.

## Comments

- 2026-11-20, core: built as `✨ add the milestone 6 migration`, migration `20261126000000_milestone_6` (re-timestamped after the profile's provider took `20261125000000`, so the folders sort in landing order). Readings and differences:
  - **Every model of section 5.3,** each with `organizationId`, and the project's records with the composite key to the project. `AgentSession.projectId` is nullable (a delegation arrives before ostra knows its board), so its ticket, task and board links carry checks that keep `projectId` set while any is (`agent_session_*_carries_project`, held by milestone 4's F-086 scope test).
  - **The partial indexes** as raw SQL: `automation_run_one_per_occurrence`, `automation_run_one_match_per_ticket`, `board_one_agent_mode_board_per_team`, `automation_due_schedules` and `agent_session_heartbeat_due`. **Checks** at the end (`ostra:`): an occurrence's time only on an occurrence and a ticket only on a match, a skip reason only when skipped, a positive line, `approvedAt` only with its member, a pause with its reason, a reviewer a user or a team, and the counters non-negative. **Comments** on the untrusted or private text: never logged; `AgentActivity.body` ostra's own words only.
  - **Enum values used by no statement here:** `HeldTurnOrigin` gains `changes_requested` and `linear_follow_up`, with the protocol's `turnOriginSchema` and the budget gate's origins in the same commit (ticket 06's line), since the enum mappers are checked both ways. `NeedsYouReason` gains `awaiting_approval`, so the panel's reason words, Home's list and the needs-you view gain it; `ai_finding` reaches memory's source words.
  - **Isolation:** a fixture builder for each of the 13 new models in `isolation-models.ts`; the api's every-record test lists them with no reader yet (tickets 24 to 29 add theirs).
  - **Proof of the boxes:** `packages/db/src/schema-m6.test.ts` (an upgrade from milestone 5's head with rows in every altered table; the three partial unique indexes refused twice; the checks; the indexes used). `prisma migrate diff` from a fresh database with every migration to the schema shows only the three partial indexes earlier milestones already show (`event_turn_boundary`, `session_one_active_per_task`, `task_one_active_code_task_per_ticket`: Prisma's spelling of `IN`), none of milestone 6's. Break-it: dropped the three partial unique indexes and one agent-session check from the migration, and the three index tests and the F-086 scope test failed. Whole-repo typecheck, lint, test, `check:licenses` and `check:proof` green.
