# 02: Task view: a turn's fields, its steps' times, and bookkeeping out of the parts

Status: ready-for-agent
Builder: web
Blocked by: 01
Features: F-151
Packages: `packages/task-view` (`src/fold.ts`, `src/ui-types.ts`, `src/coverage.ts`, `src/testing/`), `context/decisions/0036-*.md` (a dated amendment)
Spec: `../spec.md`, sections 4, 5.2 and 9; the targets' README, content fixes 2, 3, 4, 13

## What to build

The fold stays the one pure function from events to messages (ADR 0036). This ticket gives a turn the fields the footer, the tooltip and the panel read, gives each step its times, moves bookkeeping out of the parts, and puts each result in the turn that made it.

- **The turn's fields** (`TaskMessageMeta`, each optional): `ordinal` (the task's turn number across sessions, in `turn.started` order); `spend` from `FoldOptions.turnSpend` (a map by `TurnId` the panel builds from `tasks.get`'s `usage.turns`; prices live in core); `saved` from the turn's `session.saved` (its session and per-session `turnOrdinal`: the archive's size or `null`, the hidden refs, the repos not saved, the checks counted); `ended` on the session's last turn from `session.ended`.
- **Step times:** `meta.stepTimes`, by `toolCallId` (`tool.called`'s `at`, then `tool.completed`'s or `tool.failed`'s) and by `thought:<n>` for the turn's n-th reasoning part (from the `at` of the turn's event just before it to its own `agent.thought`'s). A subagent's calls keep theirs in its window's tree too.
- **Out of the column:** `data-saved`, the hidden ref's `data-pushed`, `data-session-end`, and the `system` rows of `runner.connected` and `session.config_changed` are no longer parts; their facts are the turn's fields above, and the Event log keeps every event. `runner.lost`, `session.crashed` and `session.restored` stay parts.
- **Results in their turn:** a task branch's `git.pushed`, `pr.text_set`, `pr.opened` and `memory.proposed`, which arrive after `turn.ended`, become parts of the session's last turn, after its text. New parts `data-review` (from `review.submitted`, with `repeat`, and each `review.posted`) and `data-draft` (from `draft.submitted`). `data-pushed` gains `checks` and `firstPr` (the spec's section 5.2).
- **The recorded scenes** (`src/testing/`): S1, S2 (two sessions), S3 (with a repeat `submit_review`), S5, and the states sheets' cells as event lists, exported for every later ticket and the seeded world (spec section 9).
- **Coverage:** `coverage.ts`'s check that no event kind is dropped learns where each moved kind now goes (a part, a turn field, or the Event log only), and fails for a kind with none.
- **ADR 0036** gains a dated amendment: the turn's fields, results in their turn, and the bookkeeping that leaves the parts, with this ticket's commit.
- Object identity of unchanged messages is kept, as now (the render bar, ADR 0036).

## Done when

- [ ] Tests named for `F-151/c1`: folding S2 gives no `data-saved`, `data-session-end`, hidden `data-pushed`, `runner.connected` or `session.config_changed` part in any message, and each turn's `saved` and `ended` hold their facts; the coverage test passes with every kind placed (break-it: drop `session.saved` from the fold, and the coverage test fails).
- [ ] Tests named for `F-151/c3`: S2's four turns over two sessions are numbered 1 to 4; a turn's `spend` comes from `turnSpend`, marked estimated when it is; `stepTimes` give a command its duration from its two events and a thought its own; a running tool has `endedAt: null`.
- [ ] Tests named for `F-151/c7`: S3's review result is a `data-review` part in the turn that handed it in, and the repeat one has `repeat: true`; a push and the PR it opened are parts of the turn that pushed, not rows between turns.
- [ ] Every existing `fold.test.ts`, `every-agent.test.ts`, `subagents.test.ts` and `attachments.test.ts` case passes, updated only where a row became a field (each such change listed under `## Comments`).
- [ ] Checks for `packages/task-view` and its consumers (`apps/web`, `packages/api`) pass.
- [ ] Committed as `✨ give a turn its numbers and its results`.

## Comments
