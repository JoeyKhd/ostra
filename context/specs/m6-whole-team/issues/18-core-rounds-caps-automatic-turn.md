# 18: Core: rounds, caps and the automatic turn

Status: ready-for-agent
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

- [ ] Tests named `it("F-101: ...")`: blocking findings as one prompt and nits listed only; 2 review rounds then needs you; CI, review, CI, review as 4 automatic turns then needs you; a member's message resets the count; every automatic turn stops at the spend cap and waits at 100% of the budget, released in order; a round on an old runner goes to a fresh box.
- [ ] Tests named `it("F-035: ...")`: the failing checks and their log files reach the agent; 2 CI rounds then needs you.
- [ ] Break-it: the counters not reset by a person's action, and the automatic-turn cap removed, each fail their test; recorded in `context/proof/F-101.md`.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add review and CI rounds`.

## Comments
