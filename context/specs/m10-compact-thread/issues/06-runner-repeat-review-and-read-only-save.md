# 06: Runner: a repeat review's success and a read-only kind's save

Status: done
Builder: runner
Blocked by: 01
Features: F-151
Packages: `apps/runner` (`src/sidecar/mcp-tools.ts`, `src/task-host/task-run.ts`)
Spec: `../spec.md`, sections 4, 5.1 and 6; the targets' README, content fixes 5 and 6

## What to build

- **Minor 9:** the runner speaks minor 9 in `hello` (ticket 01's version), with minor 8's codecs for an older core.
- **The repeat review's answer:** the sidecar's `submit_review` answers `{ reviewRunId, already: true }` as a success (`answer(…, false)`), with `reviewResultText`'s words, so the agent reports the call done and the thread never draws it failed. Its log line is `review submitted` with `already: true` and the run's ID, no content. A refusal is still an error, as now.
- **A read-only kind's save** (content fix 5): after a turn of a refine or review task (`pushesWork` false), `session.saved` lists no repos (`repos: []`): nothing of a repo is ever saved for those kinds, so nothing reads as "unfinished work not saved". The session archive still goes up, so a reopen restores the conversation, as milestone 6 built it.
- **Parity:** the same on `docker`, `kubernetes` and `host`, and for a personal and a pool runner: neither change reads the executor.

## Done when

- [x] Tests named for `F-151/c7`: the sidecar's `submit_review` against a fake core answering `already` returns a result that isn't an error, with the already words; a refusal still returns an error (break-it: answer `already` as an error, and the test fails).
- [x] Tests named for `F-151/c1`: a review task's after-turn save emits `session.saved` with no repos and an archive; a code task's still lists each repo with its hidden ref.
- [x] The runner's version tests pass at minor 9 against a minor-8 and a minor-9 core.
- [x] Checks for the whole repo pass (spec section 10: what a runner answers an agent).
- [x] Committed as `✨ answer a repeat review as done`.

## Comments

- 2026-11-22, runner: built as `✨ answer a repeat review as done` (`388abbf6`). Readings and decisions:
  - **Minor 9 needed no code:** ticket 01 moved the runner with `PROTOCOL_MINOR`, so `hello` says 9 and the connection speaks the lower minor with minor 8's codecs. The team link sends the build's minor in `x-ostra-minor` and parses with minor 9's `reviewResponseSchema`, which reads a minor-8 core's `{ reviewRunId }` too. `repeat-review.test.ts` proves it against both: a minor-9 core answers the repeat `already` and the agent's call completes in the already words, with one review recorded; a minor-8 core (it knows no `already`) refuses a repeat `not-in-review` as cores did before, and the agent hears that as an error. Both say 9 in `hello`, raise no protocol error, and store saves with no repos.
  - **The repeat's answer:** the sidecar already answered every `reviewRunId` answer as a success through `reviewResultText`, as ticket 01's comment said. What's new is the log line: `review submitted` gains `already: true` beside the run's ID and the counts, never a finding's or the summary's text. A refusal stays an error.
  - **A read-only kind's save:** `saveTurnWork` emits `session.saved` with `repos: []` when `pushesWork` is false, even when the turn changed files in every repo; the archive still goes up. `session.ended` is unchanged (each repo with `ahead: false`): ticket 05 makes core read a read-only kind's "ended without changes" as nothing to raise. Core's `recordWorkSaved` loops over no repos, and the fold's `unsaved` counts 0, so nothing reads as unfinished work.
  - **The fake core** (`testing/fake-server.ts`) gains `team.reviewIn`, which answers a review as minor 9's core answers a repeat (the run before, `already`, by the caller's `x-ostra-minor` through `reviewAnswerFor`, nothing recorded), and each team call records its `x-ostra-minor`.
  - **Parity:** the new F-151/c1 case (`savesNoRepos`) runs on `host`, `docker` and `kubernetes` (new `read-only-kinds.kubernetes.test.ts`, that one case only: ticket 22's other cases stay on `host` and `docker`). `docker` and `kubernetes` are the pool runner's sidecar path, `host` the personal runner's. Ticket 22's `refinePushesNothing` and `reviewAtHeads` now expect `repos: []`.
  - **Break-it, once:** answering `already` with `isError` and listing a read-only kind's repos failed all six affected tests together (the three F-151/c7 tests, F-151/c1, and ticket 22's two save tests); restored.
  - **Checks:** the whole repo's typecheck and lint (76 turbo tasks, and the root's), `check:licenses`, and the runner's full test suite, before the push. The runner is the only package touched; CI runs the rest.
  - **For later tickets:** 05's endpoint answers through `reviewAnswerFor` with the request's `x-ostra-minor`, which this sidecar sets to 9. 02 and 03 can read a refine or review turn's `session.saved` as having no repos, so `meta.saved.hiddenRefs` is `[]` and `unsaved` is 0 for those kinds, and the thread shows no saved-work line for them.
