# 06: Domain: inputs, mapping, renderers, use cases, jobs and settings

Status: ready-for-agent
Builder: core (contracts)
Blocked by: 02, 05
Features: F-007, F-031, F-064, F-032, F-033, F-068, F-079, F-096 (their rules)
Packages: `packages/domain` (`lifecycles/`, `use-cases/`, `jobs.ts`, `settings.ts`, a new `tickets/`), `docs/configuration.md`
Spec: `../spec.md`, section 5.4

## What to build

- **Lifecycle inputs,** each with exhaustive tests and `satisfies never` in every default branch: the task's `work_saved` and `limit_reached` (a restore conflict is a needs-you item, not an input: decided below), and `reopen` from `in_review` and `needs_you` as well; the session's `idle → ended`; the box's `ready ⇄ idle → stopped → released` with a release reason. Refused transitions stay results, never throws.
- **The board's status mapping:** the strict schema (`open`, `started`, `inReview`, `done`, `doneBy`) and the pure function that drafts it from `listStatuses` and the integration check, as spec section 3, step 2 describes.
- **The ticket prompt renderer:** a small template language with named placeholders (`{{ticket.title}}`) and list sections (`{{#comments}}…{{/comments}}`), nothing else: no expressions, no code, no includes. Every value from the ticket goes inside a marked block that says it's the ticket's text. The built-in template, and a validator that refuses an unknown placeholder before an admin saves one.
- **The rebuild template,** exactly as ADR 0039 words it (Q128, spec section 5.4): pure, from the stored history: the ticket and the PRs' text, every member message and every agent message oldest first, an interrupted turn's text in its own labelled section, each branch's log with its file statistics, a line saying whether unfinished work was restored, no tool output, and the 100,000-character cap that cuts the oldest messages first and says how many. Its tests port spike 2's five questions as fixtures.
- **Use-case signatures** of spec section 5.4, each taking a transaction or the ports and returning a result union. Their bodies are written in the tickets that name them.
- **Jobs:** the new names of spec section 5.4 with their Zod payloads (IDs only) and key rules, such as `ticket:<TicketWriteId>:sync`, `board:<BoardId>:poll` and `session:<SessionId>:max-duration`.
- **Settings:** every new setting of spec section 5.4, each with its default and its line in `docs/configuration.md`.

## Port from

`spikes/can-a-session-move-to-a-fresh-box/src/lib/rebuild-template.ts` and `history.ts` (the questions).

## Decided 2026-11-19 (ticket 40)

The lead, on the maintainer's delegation, settled the open points the milestone 2 targets (`context/brand/app-targets/m2/`) and ticket 40 left. They're part of what to build:

- **A restore conflict isn't a task input.** The task keeps running from the branch's head, and `restore_conflict` is a needs-you item (audience `driver`) on that running task. ADR 0039 wants the driver told, without the task stalling on it. Drop `restore_conflict` from the task lifecycle's inputs, and keep it in `NeedsYouReason`.
- **The board's mapping** gains `magicWord: "Closes" | "Refs"`, default `Closes` (spec section 11, item 5).
- **`repoBranchRulesSchema`:** `{ protected, signedCommits }`, each `{ result: true | false | "unknown", reason?: string }`. It parses `Repo.branchRules`, and ticket 31 returns it.
- **`reopenCarryOnText`:** a constant, `Carry on from where you stopped.` It's the member's message for a one-click reopen from a limit or a crash. It is English agent input, not panel copy, so it lives in `packages/domain` and not in `messages/en.json` (ticket 18).
- **`retentionDaysInEffect(setting, env)`:** pure. When `retentionSetAt` is set, the saved `retentionDays` wins, and null means keep. Otherwise `OSTRA_RETENTION_DAYS` applies, or keep (spec section 11, item 11).

## Done when

- [ ] Tests: every new input from every state; the mapping drafted from Linear's and the Jira fake's statuses; the renderer escapes nothing it shouldn't and refuses unknown placeholders; ticket text can't close its marked block; the rebuild template holds every fact spike 2's questions need except the tool output, and stays under its cap.
- [ ] `jobPayloadSchemas` holds exactly `jobNames`, as the compiler checks.
- [ ] Committed as `✨ add the milestone 2 domain contracts`.

## Comments
