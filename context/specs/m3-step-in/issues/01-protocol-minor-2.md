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

## Comments
