# 06: Domain: inputs, mapping, renderers, use cases, jobs and settings

Status: done
Builder: core (contracts)
Blocked by: 02, 05
Features: F-007, F-031, F-064, F-032, F-033, F-068, F-079, F-096 (their rules)
Packages: `packages/domain` (`lifecycles/`, `use-cases/`, `jobs.ts`, `settings.ts`, a new `tickets/`), `docs/configuration.md`
Spec: `../spec.md`, section 5.4

## What to build

- **Lifecycle inputs,** each with exhaustive tests and `satisfies never` in every default branch: the task's `work_saved` and `limit_reached` (a restore conflict is a needs-you item, not an input: decided below), and `reopen` from `in_review` and `needs_you` as well; the session's `idle → ended`; the box's `ready ⇄ idle → stopped → released` with a release reason. Refused transitions stay results, never throws.
- **How a task's PRs end** (Q107, settled 2026-11-19; `context/domain-model.md`, "How it ends"): a pure function from a task's task repos to what the task is, which ticket 16 calls, so the answer never depends on the order of the events: in review while one PR is open, merged when none is open and at least one merged, stopped (`prs_closed`) when none is open and none merged. With it, the task repo's `pushed` from `closed_unmerged` (to `branch_pushed`, so a reopened task's next push there opens a new PR), and the task's `pr_reopened` (from `merged`, and from `stopped` with `prs_closed`, to in review at `waiting_for_reviewer`).
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

- [x] Tests: every new input from every state; the PR rule for every mix of open, merged and closed task repos, with the same answer in every order of events; the mapping drafted from Linear's and the Jira fake's statuses; the renderer escapes nothing it shouldn't and refuses unknown placeholders; ticket text can't close its marked block; the rebuild template holds every fact spike 2's questions need except the tool output, and stays under its cap.
- [x] `jobPayloadSchemas` holds exactly `jobNames`, as the compiler checks.
- [x] Committed as `✨ add the milestone 2 domain contracts`.

## Comments
- 2026-11-19, core (contracts): done in `1d070ae` (`✨ add the milestone 2 domain contracts`). For tickets 08 and 13 to 31:
  - **Lifecycles:** the task's `work_saved { withChanges, prOpen, rounds }` (from running: either one goes to review, neither to needs you `no_changes`) and `limit_reached { limit }` (`stalled` for the maximum duration and the stall, `spend_cap`; `limitReason` maps them); `reopen` also from `in_review` and `needs_you`. No restore-conflict input. The session's `limit_reached` stops it (the limit goes on `Session.limitReached`). The box's `release` takes a reason, and `released` keeps it (`null` for a box released before milestone 2); `boxToColumns` writes `releaseReason`.
  - **`src/tickets/`:** `boardMappingSchema` (strict; `open`, `started`, `inReview`, `done`, `doneBy`, `magicWord` defaulting to `Closes`), `draftBoardMapping(statuses, integration)`, `statusMappingOf` (the adapter's `StatusMapping`), `parseBoardMapping` (milestone 1's `{}` reads as `null`) and `unknownMappedStatuses`. The ticket prompt: `parseTicketTemplate` (the validator, with line numbers), `renderTicketPrompt`, `builtInTicketTemplate`, `ticketTemplateFor(saved)` (a saved template that no longer parses falls back to the built-in one), `ticketTemplateVocabulary` for the editor's help, and `markTicketInline`/`markTicketBlock`. The language has placeholders and three sections: `{{#x}}` (each item, or once with an object), `{{?x}}` (once when not empty) and `{{^x}}` (once when empty); a list inside a list is refused. `buildRebuildPrompt` answers `{ prompt, cutMessages }`, with every member and agent message oldest first, the interrupted turn's section, each branch's log, the unfinished work's outcome (`restored`, `none`, `conflict`), no tool output, and the 100,000-character cap.
  - **Small contracts** (`src/tickets/contracts.ts`): `repoBranchRulesSchema` with `repoIsUnsupported` and `repoNeedsProtectionWarning`, `BRANCH_RULES_CACHE_MS`, `reopenCarryOnText`, `retentionDaysInEffect` and `retentionInEffect` (which also says the source: saved, env or default, for ticket 31's storage page), `linearAppIdPlaceholders`, `ticketBranchNameFor`, `ticketPullRequestTitle`, `ticketMagicLine`, `ticketWritePayloadSchema` (what `TicketWrite.payload` holds) and `ticketWriteKey` (`ticket-write:<taskId>:<step>`).
  - **Use cases** (signatures, each answering a rejected promise that names its ticket until that ticket writes it): `startLinearConnection`, `connectLinear`, `authorizeLinear` and `skipSetupStep` (`use-cases/linear-connection.ts`; one more than the spec listed, since the connection has three steps), `attachBoard`, `saveBoardMapping`, `ingestTicketHint`, `startTicketTask`, `createTicketForTask`, `reopenTask`, `dismissNeedsYou`, `recordWorkSaved`, `recordLimitReached`, `recordPullRequestState`, `releaseBox`, `sweepCleanup`, `sweepRetention`. `chooseReopenStep` is written: the same box when its runner is online at minor 1 or above, else the archive when the same agent can import it, else the template, with the reason.
  - **Jobs:** the twelve names of spec section 5.4, with payloads (IDs only) and keys, such as `ticket:<TicketWriteId>:sync`, `board:<BoardId>:poll`, `session:<SessionId>:max-duration` and `webhook:<connectionId>:<deliveryId>`. `jobSending` says how each is sent (`event`, `schedule`, `timer`) and which are throttled per connection, for ticket 01. `packages/jobs` has a queue setting for each.
  - **Settings:** the seventeen of spec section 5.4 (`OSTRA_TASK_SPEND_CAP_USD` at most 2000, as `spentMicroUsd` is an `Int`; `OSTRA_BLOB_MAX_MIB` at most 64, the protocol's cap; S3's three required ones refused when missing with `OSTRA_BLOB_STORE=s3`), each in `docs/configuration.md`, plus the dev-only `OSTRA_DEV_BLOCK_WEBHOOKS`.
  - The glossary gains "Ticket template", "Ticket write" and "Restore conflict", and `release` in "Command".
