# Milestone 10: The compact thread

**Status:** spec, 2026-11-22. Tickets in `issues/`, one file each (`docs/agents/issue-tracker.md`).
**Milestone:** 10 (`context/build-order.md`). It lands before milestone 7's held launch gate, as milestones 8 and 9 do, so the gate's load test, security review, measure and demo run once, on a product whose task page reads as it will at launch.
**Features:** F-151 (a calm thread). It restyles what F-023, F-024, F-026, F-063, F-084, F-121 and F-137 show, changes the words of F-035, F-054, F-062 and F-102, and what a repeat hand-in of F-100's review answers; section 2 lists the rows that get a note.
**The maintainer, 2026-11-22:** "our chatbox is soooo verbose and ugly compared to claude code on claude.ai".
**Approved the same day:** the design targets in `context/brand/app-targets/m10-thread/` ("yes to all"): every picture, `parts.md`, the scenes' build specs, and the README's fifteen choices, each settled as recommended (section 12). The README's sixteen content fixes are this spec's contract too: each is a ticket's "Done when" below.
**Decisions it builds on:** ADR 0034 (the runner protocol), 0035 (the event log), 0036 (the task page: the fold and assistant-ui), 0041 (rounds), 0049 (approval rules and questions), 0052 (checks before the PR), 0058 (the review loop), 0066 (reasoning effort), 0067 (subagents), 0068 (attachments), 0070 (files for the agent). **No new ADR:** nothing here is hard to reverse. The thread's items are a view over the same fold, and every protocol change is an optional field. Ticket 02 adds a dated amendment to ADR 0036 (the turn's items, and the bookkeeping that leaves the parts), and ticket 01 adds minor 9's paragraph to the protocol's version comment.
**Builds on milestones 1 to 9 as they were built,** not only as they were specified. Where their code ends up different from their specs, this spec follows the code, and the ticket that meets the difference says so in its `## Comments`.

Terms follow `context/GLOSSARY.md`. A **run** (a turn's steps between two pieces of its prose), the **live step**, a **result line** and a **receipt** are the targets' words (`parts.md`); ticket 04 adds them to the glossary.

---

## 1. What milestone 10 ends with

A member opening a task reads it like a conversation: what people said, what the agent said, what it made, and what waits on them. Everything else is one press or one hover away.

In more words. A member's message is a right-aligned bubble with their name over it; what ostra sent by itself, or what came from GitHub or Linear, is the same bubble, outlined. The agent's prose is the page, full width, with no avatar and no header. Its steps between two pieces of prose fold into one quiet line, `Edited 2 files, ran 2 commands, took a screenshot · 1 failed, then passed`, which opens in place to its steps, one row each with its exit, its duration and its size, and a footer with the turn's numbers and a link to the Event log. While a turn runs, one line says what the agent does this second, how many steps are done and how long it has run. A failure the agent fixed is one red word; one it didn't is its own red line. What a turn made (a push, the PR and its CI, a posted review, a draft, a preview, a memory) is one line with an icon. What waits on a member is the amber block, a pill brings it back when it's scrolled away, and an answer becomes a one-line receipt. Bookkeeping (a runner connecting, a box idling out, work saved, a session ending without changes, the token line under every turn) leaves the column for the footer, the time's tooltip, the properties panel and the Event log. A review task's page speaks only of what a review does. ostra's checks and the code host's CI keep their own words, everywhere.

### What milestones 1 to 9 leave that milestone 10 starts from

Read from the code on `main` on 2026-11-22 (`5d457b6c`), so builders don't rebuild what exists:

- **The fold** (`packages/task-view/src/fold.ts`, `foldTaskEvents`) makes one assistant `TaskUIMessage` per turn, its parts in order: text, reasoning, the typed tool parts (`tool-read`, `tool-edit`, `tool-execute`) and every other kind as a `dynamic-tool` whose `toolName` is the tool's kind, so a generic or MCP tool reads `other` (its name is the part's `title`). It puts as **rows outside any turn**: `git.pushed` (the hidden ref's push too, as `data-pushed` with `hidden: true`), `pr.text_set`, `pr.opened`, `session.ended` (`data-session-end`), `session.saved` (`data-saved`), `session.limit_reached`, `driver.changed`, `effort.changed`, `turn.held` and `turn.released`, `memory.proposed`, `pr.comment_received`, `ticket.files_ready`, and a `system` row for each of `runner.connected`, `runner.lost`, `session.restored`, `session.crashed`, `session.config_changed` and `turn.cancel_requested`. `review.submitted`, `review.posted`, `draft.submitted`, `check.*`, `ci.updated` and `round.*` draw nothing in the fold.
- **A turn's meta** (`TaskMessageMeta`, `ui-types.ts`) holds `at`, `endedAt`, `turnState`, `turnMode`, `effort`, `adjustedFrom`, `usage` (the key proxy's four kinds and reasoning; no spend), `context` and `subagents`. There's no turn number across sessions: `Turn.ordinal` is per session in the schema (`@@unique([sessionId, ordinal])`), and `session.saved`'s `turnOrdinal` too. A tool record keeps no time, though every stored event has its `at`, the peer's clock when it recorded it (`storedEventSchema`).
- **The thread** (`apps/web/src/task/task-thread.tsx`) draws each message with `MessageHeader` and a 28px avatar column (`MessageView`), and a `TurnUsage` line under every ended turn (`effort-marks.tsx`). `renderers.tsx` draws each tool part as a `Line` row with `Show the output` / `Show the diff`, and each data part as a row (`DataRow`); a generic tool's verb is `part.toolName`, so `other`. The composer is `Composer` in the same file. Milestone 9's tray, the strip and "What the agent got" are in `components/tasks/attachments/`.
- **The task page** (`apps/web/src/components/tasks/task-view.tsx`, 1,112 lines) holds the key line, the title, the status line (`data-testid="task-doing"`: the state, the activity, `Started {age} ago on {runner}`), the tabs (a refine task gets Activity, Draft and Event log; every other kind, a review task included, gets Activity, Changes, Checks and Event log), the top bar's actions (`TakeItLocal`, Review, `PrButtons`, Stop) and `Properties`, one group of rows.
- **`tasks.get`** (`packages/api/src/routers/tasks.ts`) already gives: `usage.turns` with each turn's tokens, `spentMicroUsd`, `estimated`, `startedAt`, `endedAt`, effort and its per-session `ordinal` (`task-usage.ts`); `box` with its state, when its idle stop is due and when it was released (`task-extras.ts`); each repo's `ci` as `running | passed | failed | none` with the first failing check's name, from `CiRun.checks` (the code host's check runs); `reviewOf`; `capabilities` (`send`, `interrupt`, `answerQuestions`, `steersMidTurn`, …); `needsYou`.
- **A question's answer** must be one of a select field's options: `checkQuestionAnswers` (`packages/domain/src/use-cases/plans-questions.ts`) refuses anything else ("Pick one of the choices"). The ACP driver relays a form's enum or `oneOf` as a select (`toQuestionFields`) and sends each answer as a string, coerced only for a boolean or a number field (`coerceAnswer`, `packages/adapter-sdk/src/agent/acp/driver.ts`).
- **A second `submit_review`** in a round is refused: `submitReview` (`packages/domain/src/review-loop/review.ts`) answers `not-in-review` once the run isn't `running`, and the sidecar answers every refusal as an error (`answer(…, true)`, `apps/runner/src/sidecar/mcp-tools.ts`). OpenCode then reports the call failed, and the thread draws `other ostra_submit_review … failed` in red.
- **A refine or review task's save** after a turn (`apps/runner/src/task-host/task-run.ts`) pushes nothing and lists each repo with `hiddenRefSha: null` in `session.saved`, which the thread reads as "unfinished work not saved".
- **The protocol is at minor 8** (`packages/protocol/src/runner/version.ts`). The runner's HTTP answers (`src/runner/http.ts`) carry no version; core knows a runner's minor from its last `hello` (`Runner.minor`).
- **The words:** `apps/web/messages/en.json` has the running verbs under the top-level `doing.*`, the tool rows under `task.tool.*` (`Show the output`, `Show the diff`), and CI counted in checks: `review.*.ciPassed` `Passed · {n} checks`, the round's `CI failed: {n} checks`.
- **The launch gate is held:** milestone 7's tickets 25 to 28, 32 and 33, milestone 8's demo (33) and milestone 9's (18) wait for the maintainer's word (`build-order.md`). Milestone 10's own demo joins them.

### What is in, and what is not

**In:**
- the thread's column, a member's and ostra's bubbles, the agent's prose, runs' lines that open in place, the live step, failures, result lines, the PR card, receipts and dividers, as the targets draw them;
- the turn's numbers in the opened run's footer, the time's tooltip, the properties panel's groups and the Event log, and nowhere else;
- the needs-you blocks restyled, `Something else…` on every enum question, and the pill;
- the composer as one box;
- a review task's page with only its tabs and links;
- one vocabulary for checks (ostra's, in the box) and CI (the code host's, in jobs), everywhere the panel says either;
- the content fixes: runs, timings, spend and turn numbers in the fold; bookkeeping out of the parts; relative paths; tool names; a repeat review that isn't a failure; a read-only kind's save; a capture's own route; the box in the status line;
- phone and light theme for all of it, the keyboard and screen readers;
- the docs that describe the thread.

**Not in** (and when it comes):
- A new capability of any agent or tracker: none. `Something else…` asks an agent only to take words for an enum field, which ACP forms already carry.
- Changing what the Event log shows: it keeps every event as it is (milestone 4).
- The subagents window (F-138), the preview pane (F-141), the Changes and Checks tabs' insides, the review screen's layout: as their milestones built them, but for the words section 5.4 changes.
- A setting to bring back the old rows: not planned. The Event log holds them.

### On this machine

The same adjustment as milestones 1 to 9: everything here runs on this Windows machine on the `host` executor, with the recorded OpenCode sessions of `packages/task-view/src/testing/` and the pinned OpenCode for the adapter's live case. Nothing needs Linux, macOS or kind, except the relative paths' `docker` and `kubernetes` shapes, which are proved on the executors' own path conventions (section 6). What needs more:
- **The browser specs** run once, at the milestone's end (ticket 19).
- **A real model and OpenCode asking a question with choices:** the live run at the gate, once (ticket 19).
- **People:** the maintainer agreeing F-151's "done when" and looking at the build against the targets (ticket 20).

---

## 2. The features, and where each one lives

"At M10's end" is the ledger status ticket 19 sets at the launch gate, if and only if every condition in the row's "done when" holds.

| F-ID | What milestone 10 builds | Packages | Tickets | At M10's end |
|---|---|---|---|---|
| F-151 A calm thread | The column, bubbles, prose, runs' lines and the opened run, the live step, failures, results and the PR card, receipts, dividers, the needs-you blocks and the pill, `Something else…`, the composer, the turn's numbers in the footer, the tooltip and the panel, a review task's page, checks and CI in their own words, the status line's box, phone, light, keyboard | `packages/protocol`, `adapter-sdk`, `adapter-opencode`, `packages/task-view`, `packages/domain`, `apps/core`, `apps/runner`, `packages/api`, `apps/web`, `apps/docs` | 01 to 18 | done |

**Rows this milestone touches without finishing** (each gets a dated note in `features.md`, no new status):
- **F-023 (live activity):** shown compactly; nothing an agent did leaves the page, and the Event log keeps every event.
- **F-084 (usage):** a turn's tokens and spend move from a line under every turn to the opened run's footer, the time's tooltip and the panel; the task's totals stay in the panel.
- **F-137 (reasoning effort):** "each turn shows" its level and reasoning tokens in the footer and the tooltip; the clamp's line becomes the footer's level fact (`Max, asked Extra high`), its sentence that fact's tooltip.
- **F-035 (fix failing CI):** the panel counts the code host's checks as **CI jobs**; "checks" means only ostra's (F-054). The round's bubble names each failing job.
- **F-054 (checks before the PR):** the only thing the panel calls checks, counted `in the box`.
- **F-102 (review screen):** its CI row reads `Passed · 3 jobs`, not `Passed · 3 checks`.
- **F-100 (AI review):** a second hand-in for a round already in answers the agent with success and changes nothing.
- **F-121 (seeing the running app):** a capture shows under its run's line, its caption reading its own route.
- **F-062 (Home):** the board's sub-state counts CI in jobs.

**Built in from the first milestone** (`build-order.md`), checked again by ticket 19:
- **Organization-scoped data:** no new table. `questions.answer`'s free text and the repeat review go through the use cases that already lock and scope (05, 08).
- **The event log:** nothing is dropped. Every event the fold drew before still reaches the page, as a part, a turn's field or the Event log; the fold's coverage test (`packages/task-view/src/coverage.ts`) keeps proving no kind is lost (02).
- **ACP as the only way to talk to an agent:** the free-text answer is an ACP form's `accept` content (07).
- **Strict typing, dark first, responsive, English text in message files,** and milestone 7's keyboard walk and contrast check on every new part (09 to 17).

---

## 3. The end-to-end demo

Ticket 19 runs it **at the launch gate**, with milestone 7's ticket 32 and milestones 8's and 9's demos, and records the result under its `## Comments` and in `demo.md` next to this spec. It runs against the GitHub org `ostra-test`, repo `test1`, whose test workflow gives CI with several jobs ("Outside the code", `build-order.md`). Secrets come from `~/.config/ostra-dev/` with `set -a; . ~/.config/ostra-dev/<file>; set +a`, and are never printed, logged or committed.

**Two runs.** The scripted run is the browser specs of tickets 09 to 17 (`apps/web/e2e/27-thread-*.spec.ts`), once, on the seeded world `apps/web/e2e/seed-thread-world.ts` (ticket 09), which replays the recorded OpenCode sessions through the real panel and core. The live run, once, in a real browser, on the `host` executor with the pinned OpenCode and a real model, with `OSTRA_BOX_IDLE_MINUTES=2`.

**Before:** a fresh clone, `pnpm install`, `pnpm dev:reset`, `pnpm dev`, and milestones 1 to 9's helpers: a model provider, the test App on `test1`, a project `test1`, a personal runner on `host`, a profile `Careful` with plan first. The panel signs in as `demo@demo.com` / `demo`. Sam joins as a member of `test1`.

1. **A run, live.** Demo asks for a small change with a test that fails first. While it works, the live step reads what the agent does now (`Running pnpm test …`), the steps done, `1 failed` in red while it's unrecovered, and the time, ticking; `Interrupt and send` is labelled in the box. A screen reader hears the step at most once every 10 seconds.
2. **A run, closed.** When the agent writes, the run closes into one line above its prose: its counts in order, `1 failed, then passed`, the turn's time on the turn's first line. The capture sits under its run's line, captioned with its own route. No `Work saved`, no token line, no `The runner connected.`
3. **A run, opened.** Demo presses the line: each step on its row, paths relative to the repo, each command with its exit and duration, each edit with `+a −d`, a thought's first sentence; `output ›`, `diff ›` and `show ›` open one more level. The footer's tokens, reasoning and spend equal the panel's Usage for that turn and `tasks.get`'s `usage.turns`; `Event log ›` lands on the turn's first event.
4. **The numbers, elsewhere.** Hovering the turn's time, and focusing it by keyboard, shows the tooltip with the same numbers; Escape closes it. On a phone (390 px) there's no tooltip: the footer holds them.
5. **A question.** OpenCode asks with choices. The block shows them and `Something else…`; Demo types words there and sends. The agent's next words show it got them. The block becomes `Demo answered "…"` with its time. Sam, not driving, sees the quiet block with `Take over to answer`. Scrolled up, the pill on its band says `Needs you · question ↓` and brings the block back.
6. **An approval.** A rule asks before a command: the asking step stands where the live step was, with `needs approval`, and the block under it. Answered, the run's tail says `1 approved by Demo`.
7. **The PR.** The push line says the project's checks passed `in the box`; the PR card shows once under it, with `CI on GitHub: running, k of n jobs done`, updating in place to `passed · n jobs`. The panel's Code group, the Checks tab's marker and the status line say the same two facts in the same words. A second push is one line, `Pushed {sha7} · CI passed`.
8. **The AI review.** The review task's page has only Activity and Event log, `Open the code task` and `PR #n`; ostra's first message is outlined; its outcome is prose and `Review posted on PR #n · {verdict}`. Sam asks it to check again and confirm: its second `submit_review` answers the agent with success, the thread says `Review on PR #n confirmed · already posted this round, unchanged`, nothing is red, and no review is posted twice. No push, archive, PR or "ended without changes" line.
9. **Plan first.** On `Careful`, the plan is a numbered list inside the amber rule; Demo edits and approves; the block becomes `Plan approved by Demo, with edits · Show the plan ›`, and the live step names `Plan step 1 of n`.
10. **The box.** With no turn running, the status line says `box idle, stops in {n} min`, then `box released` after the idle minutes; the panel's Session group says the same, and the Event log holds the runner's connection, the save and the release.
11. **Light, phone, keyboard.** The thread at 1440 and 390 px in both themes, compared with the targets; the keyboard walk and the contrast check pass on the task page; `j` and `k` move between runs' lines and needs-you blocks.

**The checks after the run** (ticket 19 scripts what it can):
- **Nothing lost.** Every event kind the run wrote appears in the Event log, and the fold's coverage test passes.
- **No content in a log line:** no prompt, answer, tool output or path a member typed in any log line of the run (searched by value, never printed).
- **Parity.** The agent contract suite's free-text case passes for the pinned OpenCode and the fakes (with and without the capability); the relative paths' tests pass for each executor's shape.
- **Clean-up:** the demo's PRs closed and branches deleted, in `test1` only.

---

## 4. How it fits together in milestone 10

```
 Postgres events ──▶ packages/task-view
   foldTaskEvents(events, liveText, { turnSpend, removedFiles, … })   ticket 02
     └─ TaskUIMessage[]: a turn's parts, its meta { ordinal, saved, ended, spend, … },
        each step's startedAt / endedAt, results as the turn's own parts
   turnItemsOf(message, { taskId, checkoutDirs, mcpServers })            ticket 03
     └─ TurnItem[]: run | prose | captures | failure | notice | result | needs
   liveStepOf(message, now)                                              ticket 03
 apps/web
   messages/en.json + src/task/thread/words.ts: every word, pure         ticket 04
   task-thread.tsx MessageView ─▶ src/task/thread/<part>.tsx, one file a part   tickets 09 to 16
   task-view.tsx ─▶ task-top-bar.tsx, task-status-line.tsx, task-properties.tsx  tickets 09, 15, 16
 packages/api   tasks.get: CI jobs, the review's figures, questionFreeText;
                questions.answer { other }                               ticket 08
 core / domain  a repeat submit_review; a free-text answer; read-only kinds   ticket 05
 runner         the repeat's words; a read-only kind's save              ticket 06
 adapters       an enum question answered in words                       ticket 07
```

**The flows:**
- **Drawing a turn.** The fold stays the one pure function from events to messages (ADR 0036). Ticket 02 gives each turn its number across the task, its spend (from `tasks.get`'s `usage.turns`, passed in as `turnSpend`, since prices live in core), what it saved and how its session ended, and gives each step its start and end. The results a turn made after its last event (the push, the PR, a review, a draft) join that turn's message instead of standing as rows between turns. `turnItemsOf` (03) then groups the message's parts into the column's items. The panel renders items, never raw parts, so every viewer and every test sees the same grouping.
- **The live step.** `liveStepOf` reads the running part (a tool part in `input-available` or `preliminary`, a streaming `reasoning` or `text`), the turn's finished steps, its unrecovered failures, the turn's plan (`data-plan`, the entry `in_progress`), and `meta.at` for the clock. The panel re-renders it each second for the time only.
- **Something else….** The question block offers it on every select field when the agent declares `questionFreeText` (07). Sent, `questions.answer` carries `answers` and `other` (the field IDs answered in words); `answerQuestion` (05) checks a field in `other` only for length and words, writes `question.answered` with `other`, and sends `question-answer` with the words as the field's answer, which the driver puts in the form's `accept` content as they are.
- **A repeat review.** The sidecar's `submit_review` reaches core's endpoint; when the round's review is already in and the PR hasn't moved, `submitReview` (05) changes nothing, writes `review.submitted` with `repeat: true` in the review task's log, and answers `{ reviewRunId, already: true }` to a minor-9 runner (`{ reviewRunId }` to a minor-8 one). The sidecar (06) answers the agent with success; the fold (02, 03) draws the confirmed result.

---

## 5. The contracts

Every contract change is **additive**: a new optional field, a new union member, a new export. Nothing is renamed or dropped (`AGENTS.md`). Tickets 01 to 04 and 07 make them first, each with the fakes and fixtures its callers test against.

### 5.1 `packages/protocol`: minor 9 (ticket 01)

- **The version.** Minor 9 (or the next free minor when ticket 01 lands: another milestone's work may take 9 first, and then this is 10, with the same window rule), negotiated in `hello` and `welcome`, with minor 8's codecs kept. Window 8 to 10.
- **The review's answer** (`src/runner/http.ts`): `reviewSavedSchema` gains `already: z.literal(true).optional()`: the round's review was handed in before and stands as it was. Core sends it only to a runner whose `Runner.minor` is 9 or later (`reviewAnswerFor(minor, saved)`); a minor-8 runner gets `{ reviewRunId }`, which it already reads as saved.
- **The tool's words** (`src/mcp/tools.ts`): `reviewResultText` answers `already` with "This round's review is already handed in, and it stands as it was. Nothing more is needed." (a success, not a refusal).
- **ostra's own tools by name** (`src/mcp/tools.ts`): `ostraToolOf(title)` → `"submit_review" | "submit_draft" | "show_preview" | "take_screenshot" | "record_app" | "propose_environment" | "memory" | null`, matching a title with any agent's prefix (`ostra_`, `ostra.`, `ostra/`) as the fold's `isPictureTool` does today, which it replaces.
- **Events (the server's), optional fields:**
  - `question.answered` gains `other`: the field IDs whose answer is the member's own words (`Something else…`), at most the question's fields, each once.
  - `review.submitted` gains `repeat: true`: a second hand-in for a round already in; `blocking` and `nits` are the round's as first handed in.
  - `draft.submitted` gains `acceptanceCriteria` and `subTickets`, the draft's counts, for its result line (`Handed in draft v2 · 4 acceptance criteria, 2 sub-tickets`); an event without them shows the version alone.
- **Unchanged:** `question-answer`'s body (each answer is already any string within `steerTextMaxChars`), every runner event, every command.
- **Never logged:** an answer's words, as before; `other` holds field IDs only.

### 5.2 `packages/task-view`: a turn's fields, its steps' times, and bookkeeping out of the parts (ticket 02)

`TaskMessageMeta` gains, each optional so a stored message without them reads as before:
- `ordinal`: the task's turn number, from 1, in the order of `turn.started` across all its sessions (a reopen's turn continues the count).
- `spend`: `{ microUsd, estimated }`, from `FoldOptions.turnSpend: ReadonlyMap<TurnId, { microUsd: number; estimated: boolean }>`; missing while `tasks.get` hasn't priced the turn.
- `saved`: the turn's `session.saved`, matched to its session's last turn when it comes: `{ archiveBytes: number | null, hiddenRefs: string[], unsaved: number, checks: { passed, failed, total } | null }`. *Amended 2026-11-22 (ticket 02's review): this said "matched by its session and its per-session `turnOrdinal`". The runner saves after a turn's end and before the next turn starts (ADR 0039's order), so in a whole log the two pick the same turn; but `tasks.history` pages by 20 turns, and a page that starts mid-session can't count the session's turns, so the ordinal would pick the wrong one there. ADR 0036's amendment says the same.*
- `ended`: on the session's last turn, its `session.ended`: `{ outcome, repos }`.
- `stepTimes`: `Readonly<Record<string, { startedAt: number; endedAt: number | null }>>`, keyed by a tool part's `toolCallId` (its `tool.called`'s `at`, then its `tool.completed` or `tool.failed`'s), and by `thought:<n>` for the turn's n-th reasoning part (its start is the `at` of the turn's event just before it, its end its own `agent.thought`'s `at`). *Amended 2026-11-22 (ticket 02's second review): a call its turn left open ends with the turn however it ended (ended, cancelled, failed, or its session ended or crashed), never before its start; a thought's start is the turn's last event from its runner, so a core event mid-turn, on core's clock, can't make it negative or too long.*

**Parts that leave the column** (each still drawn somewhere, never dropped; the coverage test proves it): `data-saved` and the hidden ref's `data-pushed` (into `meta.saved`), `data-session-end` (into `meta.ended`), and the `system` rows for `runner.connected` and `session.config_changed` (the Event log; the effort divider and the plan markers say what a reader needs). `runner.lost`, `session.crashed` and `session.restored` stay: the first two as failure lines, the last as a divider.

**Results join their turn:** `git.pushed` to a task branch, `pr.text_set`, `pr.opened`, `memory.proposed`, and the new parts below become parts of the session's last turn, after its text, instead of rows between turns. A push before any turn (none happens today) stays a row.
- `data-review`: from `review.submitted` and each `review.posted`: `{ reviewRunId, blocking, nits, repeat, posted: [{ repoId, prNumber, url }] }`. Only in a review task's thread (`FoldOptions.taskKind`, `tasks.get`'s `kind`): core writes the first hand-in and each post into the code task's log too, where none of its turns made the review, so there both are the Event log's. *(Added 2026-11-22, ticket 02's review.)*
- `data-draft`: from `draft.submitted`: `{ draftId, version, acceptanceCriteria | null, subTickets | null }` (the counts `null` on an event written before minor 9).
- `data-pushed` gains `checks` (the turn's `session.saved` checks counted) and `firstPr` (the PR this push opened, when `pr.opened` follows it in the turn). *Amended 2026-11-22 (ticket 02's second review): `pr.opened` joins the turn of its repo's latest task-branch push, not the session's last turn, and sets that push's `firstPr`. Core opens the PR from a job the save started, and the runner can start the next turn first (a queued message, the closing turn). With no such push in the log, it joins the session's last turn.*

### 5.3 `packages/task-view`: a turn's items (ticket 03)

New files under `src/thread/`, exported from the package's index:
- **`turnItemsOf(message, context)`** → `TurnItem[]`, `context: { taskId, checkoutDirs: readonly string[], mcpServers: readonly string[] }`. A discriminated union, each with a stable `id`:
  - `run`: `{ steps: RunStep[], counts: { kind: RunCountKind, n }[]` (in the order each kind's first step happened), `thought: { ms } | null` (a reasoning part that starts the run), `failures: { recovered: number, unrecovered: RunStep[] }`, `approvals: { approved: { by }[], denied: { by, withReason }[] }`, `subagents: SubagentTree["counts"] | null`, `total`, `firstInTurn: boolean }`;
  - `prose`: a text part;
  - `captures`: milestone 8's attachments item, under the run that took it;
  - `failure`: an unrecovered step (`{ step, words }`), a failed turn (`meta.error`), a crashed session, a lost box;
  - `notice`: a limit, a budget hold, an approval nobody answered in time;
  - `result`: `push` | `pr` | `review` | `draft` | `preview` | `memory`;
  - `needs`: an open question, plan or approval, with the asking step for an approval.
  Order is the turn's: runs, then prose, never moved after it; a result or a `needs` item ends the run before it.
- **`RunStep`,** discriminated by `kind`: `read` (every read of the run as one step: its distinct paths), `edit` (`path`, `added`, `removed`), `command` (`line`, `exit | "killed" | null`, `ms`), `thought` (`excerpt`: its first sentence, 120 characters at most), `search` (`query`, `folder`, `matches`), `web-search`, `fetch` (`host`, `path`, `status`), `capture` (`route`, `count`, `preview`), `subagent` (its `SubagentNode`), `setup` (`ms`, `cache`), `pr-text` (`title`), `ostra` (`tool` from `ostraToolOf`, `outcome`), `tool` (`name`, `server | null`), `compaction`, `info` (milestone 8's app process, a skipped capture, no browser). Each has `toolCallId | null`, `startedAt`, `endedAt`, `state: "running" | "done" | "failed" | "cancelled"`, its full subject for `title`, and its approval's receipt when one asked.
- **Recovered** (the README's choice 4): a failed step (a command's exit other than 0, `killed`, or any tool's `output-error`) is recovered when a later step in the same turn, of the same kind and the same subject (the same command line, path or URL), succeeded. A cancelled step isn't a failure. `pnpm test a` failing and `pnpm test b` passing is not recovered.
- **A tool's name:** a `dynamic-tool` part's `title`, split into `server` and `name` when it starts with one of `context.mcpServers` and `_` (OpenCode's naming), and never the kind word `other`. ostra's own tools are `ostra` steps.
- **`liveStepOf(message)`** → `null | { doing, done, failed, planStep, startedAt, waiting }`: `doing` discriminated (`thinking`, `writing`, `reading` with a path or a count, `editing`, `running`, `searching-code`, `searching-web`, `fetching`, `capturing`, `subagent`, `setting-up`, `compacting`, `tool` with its title); `done` the turn's finished steps; `failed` the turn's failures not yet recovered; `planStep` `{ index, of, entry }` from the turn's plan entry `in_progress`; `waiting`: the step whose approval is pending, which stands in the live step's place.
- **`workspacePath(raw, context)`** and **`workspaceCommand(line, context)`**: a path, or each path in a command line, relative to the workspace: everything up to and including `tasks/{taskId}/agent/` (either separator, the `host` executor's folder) or `/workspace/` (`docker` and `kubernetes`) taken off, then the one repo's checkout folder when the task has one repo, and a home folder (`/home/<user>/`, `/Users/<user>/`, `C:\Users\<user>\`, `/root/`) written `~/`. The full value stays for `title` and the Event log.

*Amended 2026-11-22 (ticket 03, as built; its `## Comments` say why):* a step's full value is `fullSubject` (so the PR's text step keeps `title` for the PR's title), and a failed step's own error words are its `error`, so a `failure` is `{ cause: "step", step }`. A run also says whether it's `open` (the turn is in it: the live step takes its line's place, and its failures wait for the live step's count rather than their own line). A question keeps its `needs` item once answered or closed (`open: false`), the place of its receipt; the plan block isn't a turn's item, since a turn's parts don't hold a proposal (it's `tasks.get`'s `plan`, as today). `liveStepOf(message, context)` takes the same context as `turnItemsOf`, for relative paths and tool names; `done` and `failed` are counts, and `planStep.index` counts from 1. The counts keep `web-search` and `fetch` apart, and count ostra's own tools and the PR's text as `tool`. `meta.stepTimes` gains `answeredAt` (an approved call's duration leaves out the wait), and an answered approval's receipt `withReason` (a deny gave a reason: only that it did).

### 5.4 The words (ticket 04)

Every string the targets name, in `apps/web/messages/en.json`, with ICU plurals, and the pure functions that pick them in `apps/web/src/task/thread/words.ts`, so the part tickets render words and never build them:
- `task.run.*` (a run's line: `Thought for {n}s`, `read {n} file(s)`, `searched the code {n} time(s)` with `twice`, `took a screenshot`, `used {n} tool(s)`, `{n} steps:`, the shared-noun rule `Read 2 files, edited 2`, the tail `{n} failed, then passed`, `{n} approved by {name}`, `{n} denied by {name}, with a reason`);
- `task.step.*` (the opened run's verbs and links: `Read`, `Edited`, `Ran`, `Thought`, `Used`, `output ›`, `hide output ›`, `diff ›`, `hide diff ›`, `show ›`, `results ›`, `input ›`, `log ›`, `body ›`, ostra's tools' own words);
- `task.doing.*` (the live step: `Thinking`, `Writing`, `Reading {path}`, `Reading {n} files`, `Running {command}`, `Wants to run {command}`, `needs approval`, `{n} steps done`, `Plan step {i} of {n}: {entry}`);
- `task.result.*` (push, `{n} checks passed in the box`, `{k} of {n} checks failed in the box, so the PR is a draft`, review posted and confirmed, draft, preview, memory);
- `task.ci.*` (`CI on GitHub: running, {k} of {n} jobs done`, `CI on GitHub passed · {n} jobs`, `CI on GitHub failed: {job}`, `No CI on GitHub`, `then the AI review`);
- `task.footer.*` and `task.tooltip.*` (`Turn {n}`, `{in} in`, `{out} out`, `{r} reasoning`, `so far`, `≈`, the saved facts, `ended without changes`, `subagents {tokens} tokens`, `Event log ›`);
- `task.receipt.*`, `task.divider.*`, `task.needs.*` (`Something else…`, the pill's `Needs you · {what}`), `task.status.box.*` (`box idle, stops in {n} min`, `box stopped`, `box released`);
- **changed strings:** the review screen's `Passed · {n} checks` → `Passed · {n} jobs`, the CI round's `CI failed: {n} checks` → `CI failed: {n} jobs`, milestone 6's stage words and Home's board sub-state where they count CI. Milestone 1's `task.tool.showOutput` and kin stay until ticket 17 removes what nothing reads.

*Amended 2026-11-23 (ticket 04, as built and as its review fixed; its `## Comments` say why):* plurals are the panel's `one`/`other` key pairs, with `two` for `twice`, not ICU, since `t` fills `{name}` and nothing more. A link's `›` is parts.md part 6's `chevron-right` icon, which the part draws, so no key holds one (`output`, `hide output`, `Event log`, `Show the plan`). A failure's red line and a notice's quiet line have their own namespaces, `task.failure.*` and `task.notice.*`. A time limit reads `Stopped at the session's {n}-minute limit.`, not the target's `turn's`, since core's `session.max-duration` counts from the session's start. `Rebuilt from the template · {reason}` takes its reason from `session.restored`'s `fallbackReason` (minor 2), and reads `Rebuilt from the template` when the runner gave none. **`subagents {tokens} tokens` has no key:** nothing counts a subagent's tokens apart from its turn's, so the footer's fifth fact waits on Q347, and ticket 16 builds the footer without it.

### 5.5 The API (ticket 08)

- **`questions.answer`** takes `other: string[]` (default `[]`) beside `answers`.
- **`tasks.get`:** each repo's `ci` gains `jobs: { done, total }` and `failing: string[]` (every failing job's name, not only the first), counted from `CiRun.checks` (a check run with no conclusion is running); a review task's `review: { round, limit, blocking, nits, url | null, codeTask: { id, key }, prNumber }` for the page's status line, its Result group and its top bar (from the review run and `reviewOf`); `capabilities.questionFreeText` (the task's agent's declaration, as `steersMidTurn` is read). *Amended 2026-11-22 (ticket 08, as built): the list of failing jobs is `failingJobs`, since `failing` stays the first failing name for milestone 6's Code group until ticket 14 moves it; `review` also gives `state` (the run's) and `codeTask.title`, and its `round` and `limit` are the round's as ostra's first message names them; `questionFreeText` reads the adapter's own declaration (`@ostra/adapter-opencode/question-free-text`).*
- **Home's board:** a task in CI carries its jobs' `{ done, total }` (*as built: the in-review card's `status.ciJobs`, `null` outside `ci_running`*).
- Nothing else: the turn's spend is `usage.turns`' (the panel passes it to the fold), the box's idle stop is `box`'s, the PR's size is the Changes tab's `diff` query (summed in the panel, no new code-host call).

---

## 6. Parity

### Adapter parity

| Feature | What it asks | OpenCode | The fakes |
|---|---|---|---|
| `Something else…` | the agent takes a form's enum field answered in words: the agent capability `questionFreeText` (07) | expected `true`, proved by its live contract case against the pinned binary; if the binary refuses a value outside its enum, it declares `false` and ticket 07's `## Comments` and the maintainer's ticket 20 say so | a scripted fake with it and one without; without it, the panel offers no `Something else…` for that agent's questions, and milestone 3's form is unchanged |
| A tool's name, ostra's own tools | nothing of the agent: the title the agent reports, with its prefix | `{server}_{tool}`, `ostra_submit_review` | each fake's own naming, in the suite's recorded sessions |
| Step times, runs, the live step | nothing of the agent: events' `at` | yes | every fake |
| CI in jobs | the code host's CI read (`CodeHostAdapter`), which already lists check runs | GitHub (a check run is a job) | the fake GitHub's check runs |

The parity test (`packages/adapter-sdk/src/testing/parity.test.ts`) gains a row for `questionFreeText`.

### Runner parity

| | `docker` | `kubernetes` | `host` |
|---|---|---|---|
| The workspace prefix `workspacePath` takes off | `/workspace/` | `/workspace/` | `<runner data>/tasks/<taskId>/agent/` |
| A read-only kind's `session.saved` | no repos | no repos | no repos |
| The repeat review's answer | by the runner's minor | the same | the same |

None of this is a new allowed difference (ADR 0029). A personal runner and a pool runner behave the same.

---

## 7. Packages, licenses and owners

| Package | License | New in M10 | Built by |
|---|---|---|---|
| `packages/protocol` | Apache-2.0 | minor 9: the review's `already`, the events' optional fields, `ostraToolOf`, the tool's words | core (01) |
| `packages/adapter-sdk` | Apache-2.0 | `questionFreeText`, the driver's free text, the suite's case and the fakes | adapters (07) |
| `packages/adapters/adapter-opencode` | Apache-2.0 | declares `questionFreeText`; its live case | adapters (07) |
| `apps/runner` | Apache-2.0 | the repeat review's success; a read-only kind's save | runner (06) |
| `packages/task-view` | Sustainable Use | the turn's fields and times, results in their turn, the items, the live step, relative paths | web (02, 03) |
| `packages/domain` | Sustainable Use | the repeat review; the free-text answer; a draft's counts; a read-only kind's session end | core (05) |
| `apps/core` | Sustainable Use | the review endpoint's answer by minor | core (05) |
| `packages/api` | Sustainable Use | `questions.answer`'s `other`; CI jobs, the review's figures, `questionFreeText` | api (08) |
| `apps/web` | Sustainable Use | the words; the thread's parts; the task page's top bar, status line, tabs and properties; the CI words everywhere | web (04, 09 to 17) |
| `apps/docs` | Apache-2.0 | the thread's page and the words it changes | core (18) |

The license line holds (ADR 0045, ADR 0048): no Apache-2.0 package depends on a Sustainable Use one. `packages/task-view` imports only `packages/protocol` and `ai`'s types. `pnpm check:licenses` runs on every commit.

---

## 8. The builders and their tickets

Five builders, as before: **core**, **runner**, **web**, **api** and **adapters**. The contracts come first (01 to 04, 07). Ticket 09 then lays the thread's frame and **splits the files**: it moves the composer, the properties panel, the status line and the top bar out of `task-view.tsx` and `task-thread.tsx` into their own files, and makes one file per part under `apps/web/src/task/thread/`, each a stub with its final props. From then on tickets 10 to 16 each own their files and run in parallel; none edits another's. Ticket 17 comes last over all of them, for the phone, the light theme and the keyboard.

| # | Ticket | Builder | Blocked by |
|---|---|---|---|
| 01 | Protocol: minor 9 | core | none |
| 02 | Task view: a turn's fields, its steps' times, and bookkeeping out of the parts | web | 01 |
| 03 | Task view: a turn's items, the live step and relative paths | web | 01, 02 |
| 04 | Web: the compact thread's words | web | 03 |
| 05 | Core: a repeat review, a free-text answer, and read-only kinds | core | 01 |
| 06 | Runner: a repeat review's success and a read-only kind's save | runner | 01 |
| 07 | Adapters: an enum question answered in words | adapters | none |
| 08 | API: the thread's data | api | 01, 05, 07 |
| 09 | Web: the thread's frame, and a file for each part | web | 02, 03, 04 |
| 10 | Web: runs' lines, the opened run and failures | web | 09 |
| 11 | Web: the live step and the composer | web | 09 |
| 12 | Web: bubbles, receipts and dividers | web | 09 |
| 13 | Web: the needs-you blocks, `Something else…` and the pill | web | 08, 09 |
| 14 | Web: result lines, the PR card, and CI in jobs | web | 08, 09 |
| 15 | Web: a review task's page and the status line | web | 08, 09 |
| 16 | Web: the turn's numbers: footer, tooltip and the properties panel | web | 08, 09 |
| 17 | Web: phone, light theme and the keyboard | web | 10 to 16 |
| 18 | Docs: reading a task's thread | core | 04, 10 to 16 |
| 19 | The end-to-end demo and the ledger (at the launch gate) | core (lead) | 01 to 18; the maintainer's word for the launch gate |
| 20 | The maintainer's steps outside the code | maintainer | none for agreeing F-151; 17 for looking at the build; 19 for the review of the run |

**Who starts when.**
- **core** takes 01 at once, then 05; later 18.
- **adapters** take 07 at once.
- **runner** takes 06 after 01.
- **web** takes 02 after 01, then 03 and 04, then 09; then 10 to 12 at once, and 13 to 16 as 08 lands; then 17. Several web agents can hold 10 to 16 together.
- **api** starts 08 once 05 and 07 are in.

Milestone 9's remaining tickets (its demo, 18, and the maintainer's, 19) touch no file of these. A ticket that meets an open one on the same package waits for it, and says so in its `## Comments`. The launch gate's tickets stay held, and run after milestone 10.

---

## 9. Test seams

Agreed here so builders don't each invent one.

- **Recorded sessions:** `packages/task-view/src/testing/` (`opencode-session.ts`, `recorded-subagents.ts`) gains the targets' scenes as event lists: S1 (a run with a recovered failure, a capture and a question), S2 (four turns over two sessions, a push with checks, a PR, CI), S3 (a review task with 23 steps, an unrecovered fetch and a repeat `submit_review`), S5 (a plan turn and its build turn), and the states sheets' cells. Ticket 02 makes them; every later ticket's tests read them, so a part's test and the demo draw the same data.
- **The seeded world:** `apps/web/e2e/seed-thread-world.ts` (ticket 09) writes those sessions into a real database for the browser specs, as milestone 9's `seed-files-world.ts` does.
- **Postgres:** milestone 1's helper, a database per test file. A test that reads data checks another organization's rows and a restricted project's rows stay invisible.
- **The agent:** the scripted fake agents of `@ostra/adapter-sdk/testing`, with and without `questionFreeText`; OpenCode's live contract tests run the pinned binary, as milestones 3 and 4 did.
- **Time:** the live step's clock and the tooltip's delay read an injected `now` and fake timers, never the wall clock.
- **Text that is data:** a test of an answer's words, a command line or a path holds shell syntax, prompt-like text and `..`, and asserts none reaches a log line.

---

## 10. Every ticket's checks and commit

As milestones 1 to 9 (`../m9-attachments/spec.md`, section 10), and the lead's rules (`C:/Users/santi/ow/_lead/AGENT-RULES.md`). In short:
- **Checks once, then push.** `pnpm typecheck`, `pnpm lint` and `pnpm test` for the touched packages (and their direct consumers when a shared type changes), with `--cache-dir=C:/Users/santi/ow/.turbo-cache`, once before each push. `pnpm check:licenses` passes. GitHub CI runs the rest; a failure from the change is fixed forward.
- **The whole-repo checks** run for the tickets that touch the runner protocol or what a runner answers an agent: 01, 05, 06 and 07.
- **Browser specs run once,** at the milestone's end (ticket 19). Each web ticket writes its own spec file (`apps/web/e2e/27-thread-<part>.spec.ts`), and runs only that file locally when it needs browser proof.
- **Each visual ticket** is checked by eye against its pictures at their viewports, both themes, with screenshots under `## Comments` (`_lead/ui-check/m10/`).
- **Proof:** each condition of F-151's "done when" has a test named with its key (`it("F-151/c1: ...")`) through the real code path, and CI runs it. No proof file. No break-it pass (the maintainer, 2026-11-21: "keep tests, drop extras"); a ticket's "(break-it: …)" names what its test must catch, and nothing more.
- **No new setting, no new dependency.** A fresh install with only the required settings shows the compact thread.
- **No content in a log line:** no answer, command line, path or tool output.
- **Stage only the ticket's own paths,** no `git add -A`, no stash. A gitmoji message of at most 50 characters, no AI attribution. Rebase onto `origin/main`, then push to `origin main`.
- **Work in a worktree** under `C:/Users/santi/ow/<name>` from `origin/main`, never in `c:/Users/santi/ostra`. Kill every process started with its whole tree, and remove the worktree at the end.
- The ticket file gets its `Status:` updated and a line under `## Comments` with the commit's hash.

### 10.1 How the row gets proved

A condition's key is its sentence's place in F-151's "done when" (`features.md`).

- c1: the column holds only what a member reads, bubbles filled or outlined and named, prose bare, no bookkeeping row and no token line, the Event log unchanged (02, 03, 09, 12)
- c2: a run's line, its counts in order, its tail, the recovered rule, an unrecovered failure's own line, a cancelled step no failure (03, 04, 10)
- c3: the opened run's rows, relative paths, results and links; the footer's facts; the same numbers in the tooltip and the panel's Usage and Session groups; the turn's number across sessions (02, 03, 10, 16)
- c4: the live step's words, progress, plan step and clock; an approval in its place; prose closing the run; announced at most every 10 s (03, 11)
- c5: `Something else…` reaching the agent as the answer; receipts in the blocks' place, never a member's bubble; the pill (05, 07, 08, 12, 13)
- c6: checks and CI in their own words everywhere, CI in jobs; the PR card once under its push (04, 08, 14)
- c7: a review task's page; the repeat `submit_review` a success, nothing changed, confirmed in the thread; a refine task's Draft tab and no push or PR line (01, 02, 05, 06, 14, 15)
- c8: `Used {tool}` with its server, ostra's tools' own words, a capture's own route (01, 03, 10)
- c9: the status line names the box (08, 15)
- c10: the targets at their sizes, both themes, phone with the footer as the way in; the keyboard walk, the contrast check, `j`/`k`, reduced motion (17, with each part ticket's own checks)

---

## 11. Dependencies

None. Every part is built with what the panel already has: Tailwind tokens, Lucide icons, assistant-ui's runtime, Radix (`RadioGroup`, `Tooltip`) through shadcn/ui.

---

## 12. Choices this spec makes

The fifteen choices in the targets' README, settled by the maintainer on 2026-11-22 ("yes to all"), each as recommended. They were never open in `context/open-questions.md`, so they get no question numbers; they live in the targets' README, here, and in F-151.

1. **Where a turn's numbers go:** the opened run's footer (with `Event log ›`), a tooltip on the turn's time, the panel's Usage and Session groups, and the Event log; never a line under every turn.
2. **The time anchor:** on each turn's first line, mono `--faint`; no turn header.
3. **A recovered failure:** `1 failed, then passed` on the run's line, red only on `failed`; its own red line only when not recovered.
4. **"Recovered", exactly:** a later step of the same kind and subject (command line, path, URL) in the same turn succeeded.
5. **`Something else…`:** an optional free-text choice on every enum question ostra relays; the agent gets the words as the answer (section 6 for an agent that can't).
6. **ostra's own messages and GitHub's:** right-aligned, outlined (`ostra · automatic`, `{login} on GitHub`).
7. **Checks and CI:** two words, checks (ostra's, in the box) and CI (the code host's, counted in jobs), in the line, the card, the panel and the tab.
8. **The PR card:** once, under the push that opened it: title, size, the live CI line; later pushes are one line.
9. **A pending approval during a run:** its step leaves the run and stands where the live step was, the block under it.
10. **A review task's page:** tabs `Activity` and `Event log`; the top bar's `Open the code task` and `PR #n`; no `Take it local`, `Changes`, `Checks`, `Code` group, saved-work or PR lines.
11. **Names over bubbles:** always.
12. **The needs-you pill:** on a solid 46px band above the composer, only while the block is out of view.
13. **Captures:** visible under their run's line.
14. **The composer:** one box with an icon Send, the hint and the model under it; `Interrupt and send` labelled while a turn runs.
15. **The status line when no turn runs:** names the box (`box idle, stops in 11 min`, `box released`).

---

## 13. Screens and their targets

The targets are approved (2026-11-22), in `context/brand/app-targets/m10-thread/`, each with its picture, its build spec and its HTML source, against `context/brand/brief.md`, `context/brand/app-design.md` and milestone 8's double-sidebar shell. `parts.md` holds every part's sizes, tokens, copy, data and keyboard once; the scenes say which parts show in what state. The build spec wins on copy, states and behaviour; the picture wins on size, spacing and contrast, in exact CSS px.

| Target | What it shows | Ticket |
|---|---|---|
| `parts.md` 1 and 3, "The rule of the column" | the column, its rhythm, the agent's prose | 09 |
| `parts.md` 4, 6 and 7; `s4`; `states-steps` 2 to 6 | a run's line, the opened run and its footer's place, outputs and diffs, subagents, effort marks, failures and notices | 10 |
| `parts.md` 5 and 14; `s1-working`; `s5-approved`'s live step; `states-steps` 1 | the live step, an approval in its place, the composer | 11 |
| `parts.md` 2 and 12; `states-messages` 1 to 5; `s3`'s and `s5`'s first bubbles | a member's, ostra's and GitHub's bubbles, "What the agent got", receipts, dividers | 12 |
| `parts.md` 11; `s1`'s question; `s5-plan`; `states-asks`; `s4`'s pill | the question with `Something else…`, the plan, the approval, other needs, the pill | 13 |
| `parts.md` 8, 10 and 13; `s2`; `states-messages` 6 | result lines, the PR card, the CI line, the Checks tab's marker, CI words elsewhere | 14 |
| `parts.md` 15 (header, tabs); `s3`; `s7-s3-light` | a review task's top bar, key line, tabs and status line; the box in the status line | 15 |
| `parts.md` 6 (footer), 9 and 15 (panel); `s2`'s tooltip; every scene's Properties | the footer, the tooltip, the properties panel's groups | 16 |
| `s6-phone`, `s6-phone-open`, `s7-s1-light`, `s7-s3-light`; "Keyboard and screen readers", "Reduced motion" | phone, light, keyboard | 17 |
