# 01: Protocol: minor 2

Status: ready-for-agent
Builder: core (contracts, first)
Blocked by: none
Features: F-021, F-024, F-026, F-063, F-054, F-051, F-094, F-072, F-053, F-066, F-103 (their wire shapes)
Packages: `packages/protocol`
Spec: `../spec.md`, section 5.1

## What to build

Every change is additive. The schema is written once, Zod first; the types are `z.infer`. If milestone 2's ticket 02 (minor 1) isn't in yet, this ticket waits for it.

- **Minor 2,** negotiated in `hello` and `welcome`, with minor 1's codecs kept. A minor-1 peer never receives `question-answer`, `plan-answer`, `snapshot-build` or the new spec sections, and a minor-2 runner talking to a minor-1 server sends none of the new events. A minor-0 runner is outside the window, as `version.ts` already says.
- **Events:** `plan.proposed`, `plan.answered` (server-only), `check.started`, `check.finished`, `snapshot.built`, `snapshot.failed`, `service.healthy`, `service.failed`, `diff.comments_sent` (server-only), `ticket.closed` (server-only) and `pr.comment_received` (server-only) as new union members. Add the server-only ones to `serverOnlyKinds`, so the gateway refuses a batch that holds one.
- **New optional fields:** `approval.requested` gains `rule` and `subject`; `approval.answered` gains `reason` and `taskRule`; `user.message` gains `intent`; `session.saved` gains `checks`; `turn.started` gains `mode`.
- **Commands:** `question-answer`, `plan-answer` and `snapshot-build` in `commandBodySchemas`, `commandKindSchema` and `commandSchema`; `approval-answer` gains optional `reason` and `taskRule`; `steer` gains optional `intent`.
- **The approval rule and the task rule** (`ApprovalRule`, `TaskRule`) as strict schemas in a new `src/agent/rules.ts`, exported from the package root, with the four tools and the four match kinds of section 5.1.
- **The task spec:** `agent` gains `skills`, `mcpServers`, `approvalRules`, `taskRules` and `planFirst`; the spec gains `firstTurnMode`, `checks`, `services` and `snapshot`; all optional, so milestone 2's spec parses. `taskSpecResponseSchemaFor(minor)` returns the shape for 0, 1 and 2.
- **The credentials response** gains `mcpServers: [{ name, url, headers }]`, described as never logged.
- **The CLI's HTTP** (`/api/cli/v1/`): request and response schemas for `POST /device`, `POST /device/token`, `GET /tasks/:ref/branches` and `DELETE /session`, in a new `src/cli/http.ts`, with the 401 body the CLI prints.
- **Named working values** in `limits.ts`: a check's timeout 600 s and the total 30 min, the output tail 16 KiB and blob 4 MiB, a plan message 64 KiB, a diff comment 4,000 characters, 50 comments a send, a deny reason 2,000 characters.
- The schemas' descriptions say what's never logged: a plan's text, a check's output, an MCP server's headers, a deny reason, a comment's text.

## Done when

- [ ] Tests: every new shape round-trips; a minor-1 spec and a minor-0 spec still parse, and a minor-1 peer's codec drops the new fields and commands; a strict object refuses an unknown field; the server-only set includes the new server-only kinds; the fixtures in `src/testing/` cover each new kind and command.
- [ ] Every caller in the repo still compiles, and no existing schema changed shape.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add protocol minor 2`.

## Decided 2026-11-19

Decided on the maintainer's delegation while preparing the build, from the open points of the milestone 3 targets (`context/brand/app-targets/m3/`) and the spec's gaps. If the maintainer disagrees with one, it goes back to `context/open-questions.md` and this section changes.

- **Where the shared rules and the runner's prompts live** (Q190). `apps/runner` and the adapters are Apache-2.0 and can't import `packages/domain` (ADR 0045, ADR 0048; `pnpm check:licenses` refuses it), yet the runner matches task rules, the `runner-only` adapters match profile rules, and the runner sends the plan-mode preamble, the approved plan, the revision request and the deny's re-prompt. So `src/agent/rules.ts` holds the pure matcher (path globs with `*` and `**` on normalized repo-relative paths, command prefixes on the first words split without a shell, "outside the allowlist", the MCP match below) and the "for this task" pattern rule beside the schemas, and a new `src/agent/prompts.ts` holds the marked-block helper and those four prompts. No new dependency. `packages/domain` re-exports them, and keeps the presets and the prompts only core sends (ticket 07). Tests: the table of rule cases and the marked blocks, with text that tries to close its block.
- **An MCP server's `readOnly`.** Each entry of the spec's `agent.mcpServers`, both transports, gains `readOnly: boolean`, false when absent. Plan mode may call only a read-only server's tools, and "Reaching the network" doesn't ask for them (ADR 0049; `agent-profile.md`, "Data").
- **A fifth match kind, `{ kind: "mcp-not-read-only" }`,** for the tool `mcp` only: it matches a call to a server whose `readOnly` is false, or one the spec doesn't list. The schema also refuses a match that doesn't fit its tool: `path-glob` only with `edit`; `command-prefix` and `command-outside` only with `execute`; `any` with every tool. The editor's pickers (`agent-profile.md`) follow the same table.
- **`ApprovalRule.preset`,** optional: `"dependency" | "migration" | "allowlist" | "network"`, the preset a rule came from. The editor draws its `preset` chip from it and disables a preset already in the profile.
- **`TaskRule.ruleId`:** the `TaskApprovalRule` row's ID. It's in the command's `taskRule`, `approval.answered.taskRule` and the spec's `agent.taskRules`, so `approval.auto_answered { ruleId }` names the task rule that answered, and the receipt shows its pattern (`task-approval.md`, "Answered by a task rule"). Core writes the row before it sends the command (ticket 17).
- **`plan.answered` gains optional `entries: PlanEntry[]` and `message`** on an approve: the plan as approved, structured. `text` stays the plan as the build prompt carries it. The receipt's `edited` marks come from comparing `entries` with `plan.proposed.entries` (`task-plan.md`, "Receipt").
- Tests for each: a server without `readOnly` parses as false; `mcp-not-read-only` with `edit` is refused; a rule without `preset` parses; a task rule without `ruleId` is refused; an approve without `entries` parses.

## Comments
