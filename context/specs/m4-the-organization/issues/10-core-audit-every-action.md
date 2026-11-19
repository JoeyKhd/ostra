# 10: Core: the audit log for every action

Status: ready-for-agent
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

- [ ] One test per action, named `it("F-073: <action> is recorded with who and when", ...)`, asserting the entry exists after the change and none after a rolled-back one.
- [ ] Break-it: one writer's `recordAudit` call removed fails its test; recorded in `context/proof/F-073.md`.
- [ ] No entry's `data` holds content: a test scans the fixture run's entries for prompts, note text and tokens by value.
- [ ] Committed as `✨ record every action in the audit log`.

## Comments
