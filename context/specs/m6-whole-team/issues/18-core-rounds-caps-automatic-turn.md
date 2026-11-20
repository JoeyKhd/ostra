# 18: Core: rounds, caps and the automatic turn

Status: done
Builder: core
Blocked by: 06, 16, 17
Features: F-101, F-035
Packages: `apps/core` (`src/review-loop/rounds.ts`), `packages/domain` (`startRound`, `roundAllowed`)
Spec: `../spec.md`, section 4 ("A round"); ADR 0041, ADR 0058

## What to build

- **`round.start`,** keyed by task, kind and cause, inside the task's lock: `roundAllowed` against `OSTRA_CI_ROUNDS`, `OSTRA_REVIEW_ROUNDS` and `OSTRA_AUTOMATIC_TURNS`, counted since `lastPersonActionAt`; then milestone 4's `budgetGate` with `automatic-round` (a closed gate holds it as `HeldTurn`, the `TaskRound` as `held`); then the spend cap (milestone 2); then the turn: on the warm box when the session is idle and its runner speaks minor 5, else a reopen on a fresh box (milestone 2's path).
- **The prompts:** `fix-ci` names each failing check and its log file under `ci/` (the blobs as `contextFiles`, ticket 23 writes them); `fix-findings` holds the blocking findings, each with its repo, file and line, and lists the nits as "not required"; both wrap the text as data with `@ostra/protocol`'s framing lines. `automatic: true` on the turn.
- **The counters:** `ciRounds`, `reviewRounds` and `automaticTurns` rise when a round's turn starts; a person's action on the task (a message, a reopen, an answer, "Keep working", "Fix this" sent, a "changes requested" turn) sets `lastPersonActionAt` and zeroes them.
- **A cap reached:** the task goes to needs you (`round_cap`) for its driver, with which cap and "Keep working" (a person's action, so the counters reset); `round.capped` in the thread.
- **Sub-states:** `fixing_ci` and `fixing_findings` while a round's session runs; back to "CI running" on its push.

## Done when

- [x] Tests named `it("F-101: ...")`: blocking findings as one prompt and nits listed only; 2 review rounds then needs you; CI, review, CI, review as 4 automatic turns then needs you; a member's message resets the count; every automatic turn stops at the spend cap and waits at 100% of the budget, released in order; a round on an old runner goes to a fresh box.
- [x] Tests named `it("F-035: ...")`: the failing checks and their log files reach the agent; 2 CI rounds then needs you.
- [x] Break-it: the counters not reset by a person's action, and the automatic-turn cap removed, each fail their test; recorded in `context/proof/F-101.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add review and CI rounds`.

## Comments

- 2026-11-20, core: built as `✨ add review and CI rounds`. Readings and differences:
  - **`round.start`** (`apps/core/src/review-loop/rounds.ts`, the domain's `startRound` in `packages/domain/src/review-loop/start-round.ts`) as the ticket says. `TaskRound.turnId` holds the session the round's turn runs in; a fresh-box session that is an automatic round gets `automatic: true` on its dispatch and its spec, its CI logs as `ci` files, and goes only to a runner at minor 5 (`TEAM_MINOR` in `dispatch-task.ts`, also for refine and review tasks). A kept box on an older runner isn't resumed for it.
  - **A CI round with log files goes to a fresh box**: only a dispatch carries files, so the warm box's steer is for a round without logs. A fresh-box round is milestone 2's reopen: the task is queued, then running, rather than in "fixing CI", and its push takes it back to "CI running" as the warm round's does.
  - **A held round** saves its message and holds the turn; `budget.release` starts held rounds oldest first, and the counters rise then, not when it was held.
  - **The counters reset** in one place, `recordPersonActionInTx`, called by a member's message, a reopen, a question's answer, a plan's answer and an approval's answer. "Keep working" is milestone 3's `keepWorking`, a member message, so it resets them too; the needs-you item's button for a cap is the API's (ticket 28). A "changes requested" turn is ticket 20's.
  - **Proof:** `apps/core/src/review-loop/rounds.test.ts`. Break-its: `recordPersonActionInTx` a no-op failed the member's-message test; the automatic-turn cap removed failed the 4-turn test; each kind's cap removed failed its 2-round test; the spend cap skipped and the gate's hold ignored each failed its test; the warm box without its minor check failed the old-runner test. Recorded in `context/proof/F-101.md` and `context/proof/F-035.md`.
  - **Checks:** as ticket 16's.
