# 01: Protocol: minor 9

Status: done
Builder: core
Blocked by: none
Features: F-151
Packages: `packages/protocol`
Spec: `../spec.md`, sections 4 and 5.1

## What to build

Minor 9 of the runner protocol, additive only, with minor 8's codecs kept (`src/runner/version.ts`'s comment gains milestone 10's paragraph). If another milestone took minor 9 before this lands, this is the next free minor, and the ticket's `## Comments` says which.

- **The version:** `PROTOCOL_MINOR` 9, the window 8 to 10, `minor-9.test.ts` and the version matrix's lines; recorded traffic (`src/testing/recorded.ts`) gains a minor-9 `hello`.
- **The review's answer** (`src/runner/http.ts`): `reviewSavedSchema` gains `already: z.literal(true).optional()`. `reviewAnswerFor(peerMinor, saved)` drops `already` for a peer below 9, so core never sends a minor-8 sidecar a field its strict schema refuses.
- **The tool's words** (`src/mcp/tools.ts`): `reviewResultText` answers `{ reviewRunId, already: true }` with "This round's review is already handed in, and it stands as it was. Nothing more is needed."; the saved and refused answers keep their words.
- **ostra's tools by name** (`src/mcp/tools.ts`): `ostraToolOf(title)` → `"submit_review" | "submit_draft" | "show_preview" | "take_screenshot" | "record_app" | "propose_environment" | "memory" | null`, for a title with no prefix or with any agent's (`ostra_`, `ostra.`, `ostra/`, and the `_`/`.`/`/` suffix forms `isPictureTool` matches today); the memory tools are one kind. A tool whose name merely contains one of these (`my_submit_review_helper`) is `null`.
- **Server events, optional fields** (`src/events/agent-events.ts`), each described as never logged where it holds words:
  - `question.answered` gains `other: string[]` (field IDs, each once, at most 100: the fields answered in the member's own words);
  - `review.submitted` gains `repeat: z.literal(true).optional()`;
  - `draft.submitted` gains `acceptanceCriteria` and `subTickets`, optional counts (non-negative integers within the draft's limits), for the draft's result line.
- **Unchanged,** and its test says so: `question-answer`'s body, every runner event, every command.

## Done when

- [x] Tests named for `F-151/c7`: `reviewAnswerFor(8, { reviewRunId, already: true })` has no `already`, and minor 8's `reviewSavedSchema` parses it; minor 9's keeps it; `reviewResultText` gives the already words for it (break-it: send `already` to minor 8, and the parse test fails).
- [x] Tests named for `F-151/c8`: `ostraToolOf` over `submit_review`, `ostra_submit_review`, `ostra.show_preview`, `ostra/submit_draft`, a memory tool, `take_screenshot`, and `null` for `bash`, `github_create_issue` and `my_submit_review_helper`.
- [x] Tests named for `F-151/c5`: `question.answered` with `other` parses, and refuses a repeated ID; an event without it still parses.
- [x] The version matrix and `minor-9.test.ts` pass; every caller of the protocol's minor (core's, the runner's and the fold's pinned minors) moves with it in this commit.
- [x] Checks for the whole repo pass (spec section 10: the runner protocol).
- [x] Committed as `✨ add protocol minor 9: the compact thread`.

## Comments

- 2026-11-22, core: built as `✨ add protocol minor 9: the compact thread`. `origin/main` was at minor 8, so this is minor 9 (window 8 to 10). Readings and differences:
  - **Recorded traffic:** a minor-9 `hello` was already recorded (milestone 8's synthetic build two ahead of minor 7), and it now speaks 9 with today's server. What's new is a synthetic minor 11 (`recorded/minor-11.json`), two ahead of minor 9, with its rows in the protocol's matrix and core's (refused on both carriers). Minor 7's build is now one behind the window.
  - **No frame of its own:** the three codec sets gain a minor-9 entry with minor 8's schemas, so their `minors` read 0 to 9, and minor 8's codecs are kept as they were. The test proves every runner event fixture and every command fixture encodes for a minor-8 peer exactly as for a minor-9 one, and parses back at 8; `question-answer`'s body keeps its three keys and refuses an `other`.
  - **The review's answer:** minor 8's shapes are kept as `reviewSavedSchemaV8` and `reviewResponseSchemaV8`; today's `reviewSavedSchema` extends the first with `already`. `ReviewSaved` and `REVIEW_ALREADY_MINOR` (9) are new exports. `reviewAnswerFor(peerMinor, saved)` takes a saved answer only: a refusal goes as it is, at every minor.
  - **`question.answered`'s `other`:** beyond the ticket, the event also refuses an ID that isn't one of `answers`' keys, since the words are that field's answer (`QUESTION_OTHER_MAX` is 100; a field ID is the question field's own schema, 1 to 200 characters). The three kinds are server-only, so their new fields went on the shapes every minor's union shares: no runner sends one, and a runner's frame refuses every server kind. There's no minor-8 copy of the three kinds.
  - **`draft.submitted`'s counts** are capped by the draft's own limits: 30 acceptance criteria, 20 sub-tickets.
  - **`ostraToolOf`** matches as `isPictureTool` did: the bare name, or any title ending in `_`, `.` or `/` and the name, so `mcp__ostra__take_screenshot` is ostra's too. The trade-off, as before: a member's own MCP server with a tool of the same name (`acme_submit_review`) reads as ostra's. `start_app` and `set_pull_request_text` are `null`, as the ticket's list has them. `ostraToolKinds` lists the seven kinds. The memory tools' names (`MEMORY_SEARCH_TOOL`, `MEMORY_READ_TOOL`, `MEMORY_PROPOSE_TOOL`, `memoryToolNames`) moved into the protocol, and the runner's sidecar re-exports them, so the thread and the sidecar read one name.
  - **Callers moved in this commit:** the protocol's minor-4 to minor-8 tests (today's server is 9; a minor-7 runner is now refused), core's version matrix (minor 11's rows), core's preview test (its below-minor-7 runner connects at 8 and its presence says 6), core's HTTP carrier test (the minor-7 runner's `superseded` case runs on two minor-8 replicas, since a minor-9 server refuses that runner at hello), and the runner's CLI refusal test (a fake server at 11, window 10 to 12). The fold pins no minor: no new kind, and `coverage.ts` is unchanged. Every other caller reads `PROTOCOL_MINOR`.
  - **Checks:** the whole repo's typecheck, lint, tests (67 of 67 turbo tasks, and the root's) and `check:licenses`, before the push.
  - **For later tickets:** 05's endpoint (`apps/core/src/runner-http/review.ts`) answers through `reviewAnswerFor`, with the minor of the request's `x-ostra-minor` header as `endpoints.ts` reads it. 06: the sidecar already answers every `reviewRunId` answer as a success through `reviewResultText`, so a minor-9 runner gives the agent the already words without a code change; its log line may want to say so. 02 and 03 replace `isPictureTool` with `ostraToolOf`. The browser seeds `seed-app-world.ts`, `seed-preview-world.ts` and `seed-files-world.ts` give runners a presence at minor 7, which a minor-9 server's fleet view reads as `outside`; no spec asserts it today, and ticket 19's browser run is where it shows.
