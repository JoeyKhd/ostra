# 04: DB: the milestone 7 migration

Status: resolved
Builder: core
Blocked by: none
Features: F-082
Note: changed 2026-11-19. Claude Code (F-018) moved after v1, so this migration holds the theme alone. `AgentProfile.agentOptions`, `AgentImage`, `Runner.agents`, `AgentImageState` and the audit actions `agent.prepared` and `agent.prepare_failed` wait with F-018; they're in this file's history.
Packages: `packages/db` (`prisma/schema.prisma`, `prisma/migrations/`)
Spec: `../spec.md`, section 5.3

## What to build

One migration after milestone 6's, additive only, as spec section 5.3's table says: the account's `theme`, the enum `ThemePreference`, and the audit action `account.theme_changed`.

## Done when

- [x] The migration applies on an empty database and on one holding milestone 6's demo data, and changes no existing row.
- [x] A test named for `F-082` shows a new account's theme is `dark`.
- [x] The whole-repo checks pass (spec section 10).
- [x] Committed as `✨ add the milestone 7 migration`.

## Comments

- 2026-11-20, core: committed as dad5c1e9 (migration `20261127000000_milestone_7`, after milestone 6's `20261126000000_milestone_6`). Built. The migration adds the enum `ThemePreference` (`dark`, `light`, `system`) and `user.theme`, not null, default `dark`: additive, no backfill by hand, every account dark. It was made after milestone 6's migration landed, and stamped after it. `account.theme_changed` is the domain's closed list (ticket 36), not a database enum: `audit_entry.action` is text. `setTheme`'s body (`packages/domain/src/use-cases/theme.ts`) lands here with the column it writes: the caller's own row, an audit entry with `from` and `to` when it changed, nothing when it didn't, and `themeCookie` for the procedure. Tests in `packages/db/src/schema-m7.test.ts`: additive SQL only; applies on an empty database; applies at the head before it over rows of the user, organization, member, audit, project and task tables and changes no value of any row but the new column, dark (break-it: the default as `light`, the upgrade test failed); a new account is dark and only the three themes are taken. Checks: whole-repo typecheck and lint through turbo; tests of `packages/db`, `packages/domain`, `packages/api` and `apps/web`; `check:licenses`; `check:proof`.
