# 10: Core: the audit log for every action

Status: resolved
Builder: core
Blocked by: 06
Features: F-073
Packages: `packages/domain` (`recordAudit`, every use case that changes something), `apps/core`, `packages/api` (the writers milestone 1 to 3 put there)
Spec: `../spec.md`, section 4 ("The audit log"); ADR 0054

## What to build

- **One port:** every audit write goes through `recordAudit(tx, entry)`, which fills `actorName` from the actor's current name. The existing writers move onto it.
- **The action list** as a closed union in `packages/domain`, one dotted name per action of ADR 0054's list, so a writer can't invent a spelling. Each action names its entity kind.
- **Every action written** in the transaction of its change: task start, reopen, stop, takeover, driver change; approval and plan decisions; invitation created, revoked, accepted, membership verified, member removed, role changed, project access and project member changed; reset link created and used, password changed; model provider, model price, agent profile, budget, pool, join token, runner, connection, environment, project repos, email settings changed; memory note created, edited, archived; proposal approved, merged, rejected; organization created; instance admin granted.
- **Credential issuances:** `task.credentials-issued` per lease (milestone 1) and per refresh of a repo token, `mcp-secret.issued` when the sidecar gets an MCP server's headers (milestone 3), `cli-session.created`.
- **Append-only:** a test greps the repo's TypeScript for `auditEntry.update`, `updateMany`, `delete`, `deleteMany` and `upsert`, and fails on any hit outside `packages/db/prisma/migrations/`. Milestone 2's retention job leaves `audit_entry` alone, and a test says so.

## Done when

- [x] One test per action, named `it("F-073: <action> is recorded with who and when", ...)`, asserting the entry exists after the change and none after a rolled-back one.
- [x] Break-it: one writer's `recordAudit` call removed fails its test; recorded in `context/proof/F-073.md`.
- [x] No entry's `data` holds content: a test scans the fixture run's entries for prompts, note text and tokens by value.
- [x] Committed as `✨ record every action in the audit log`.

## Decided 2026-11-19

Settled by the target's recommendation, on the maintainer's delegation (ticket 42, step 5); the maintainer may reopen any.

- **The project access actions** (`project-access.md`, open point 2): `project.access-changed` (open or restricted), `project.member-set` (a grant added or its role changed) and `project.member-removed`, in the closed union.

## Comments

- 2026-11-19: `recordAudit` (`packages/domain/src/audit/record-audit.ts`) is the one port: `postgresAuditLog.recordInTx` calls it, it fills `actorName` (a member's account name, a runner's name, `ostra` for the system), and `AuditInput.action` is now `AuditAction`, the closed list in `packages/domain/src/audit/actions.ts` with each action's entity kind. Every existing writer already went through the port; two typed their action as `string` and now take `AuditAction`. The list holds every action written today plus the milestone 4 names the other tickets write (invitations, membership, reset links, project access, budgets, prices, project repos, memory notes and proposals, `mcp-secret.issued`, `cli-session.created`); a writer outside it fails typecheck, so a ticket that needs a new one adds it there. `packages/api/src/audit/every-action.test.ts` runs 17 actions through the panel's procedures, each once as it is and once on a database whose every transaction rolls back at its end (no entry may survive), plus the actor's kept name, a runner's and the system's names, the content scan by value, and milestone 2's retention sweep leaving entries alone. `append-only.test.ts` scans every TypeScript file for a change or delete of an entry (in Prisma or SQL) and for a create outside the port; the one hit, a test's `deleteMany` in `environment-services.test.ts`, is gone. The actions whose use cases other tickets build (22, 23, 27, 16, 29, 20) add their case to `every-action.test.ts` with them, so F-073's first row stays `partial`. Commit: 4e994d5.
