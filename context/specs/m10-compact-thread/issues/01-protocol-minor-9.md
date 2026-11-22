# 01: Protocol: minor 9

Status: ready-for-agent
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

- [ ] Tests named for `F-151/c7`: `reviewAnswerFor(8, { reviewRunId, already: true })` has no `already`, and minor 8's `reviewSavedSchema` parses it; minor 9's keeps it; `reviewResultText` gives the already words for it (break-it: send `already` to minor 8, and the parse test fails).
- [ ] Tests named for `F-151/c8`: `ostraToolOf` over `submit_review`, `ostra_submit_review`, `ostra.show_preview`, `ostra/submit_draft`, a memory tool, `take_screenshot`, and `null` for `bash`, `github_create_issue` and `my_submit_review_helper`.
- [ ] Tests named for `F-151/c5`: `question.answered` with `other` parses, and refuses a repeated ID; an event without it still parses.
- [ ] The version matrix and `minor-9.test.ts` pass; every caller of the protocol's minor (core's, the runner's and the fold's pinned minors) moves with it in this commit.
- [ ] Checks for the whole repo pass (spec section 10: the runner protocol).
- [ ] Committed as `✨ add protocol minor 9: the compact thread`.

## Comments
