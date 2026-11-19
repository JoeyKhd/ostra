# 04: DB: the milestone 7 migration

Status: ready-for-agent
Builder: core
Blocked by: none
Features: F-082
Note: changed 2026-11-19. Claude Code (F-018) moved after v1, so this migration holds the theme alone. `AgentProfile.agentOptions`, `AgentImage`, `Runner.agents`, `AgentImageState` and the audit actions `agent.prepared` and `agent.prepare_failed` wait with F-018; they're in this file's history.
Packages: `packages/db` (`prisma/schema.prisma`, `prisma/migrations/`)
Spec: `../spec.md`, section 5.3

## What to build

One migration after milestone 6's, additive only, as spec section 5.3's table says: the account's `theme`, the enum `ThemePreference`, and the audit action `account.theme_changed`.

## Done when

- [ ] The migration applies on an empty database and on one holding milestone 6's demo data, and changes no existing row.
- [ ] A test named for `F-082` shows a new account's theme is `dark`.
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✨ add the milestone 7 migration`.

## Comments
