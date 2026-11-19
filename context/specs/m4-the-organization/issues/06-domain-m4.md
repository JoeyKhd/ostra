# 06: Domain: lifecycles, access, the gate, Insights, memory, several repos, the evaluator, mails

Status: done
Builder: core (contracts, first)
Blocked by: 01, 05
Features: every F-ID of the spec's section 2 (their rules)
Packages: `packages/domain` (`src/lifecycles/`, `src/access.ts`, `src/budget/`, `src/insights/`, `src/memory/`, `src/repos/`, `src/review/`, `src/mail/`, `src/use-cases/`, `src/jobs.ts`, `src/settings.ts`, `src/testing/`)
Spec: `../spec.md`, section 5.4; ADRs 0053, 0054, 0055, and 0027, 0040, 0044 as amended

## What to build

Pure code first, each piece with exhaustive tests; use-case signatures with their ports, whose bodies the core and api tickets write.

- **Lifecycles:** the membership, the invitation, the proposal, a budget's month and the review check, as discriminated unions with `satisfies never` in every switch.
- **Access:** `requireInstanceAdmin`, `canWriteNote`, `canArchiveNote`, `canReadAudit`; a removed or pending membership makes no `MemberScope`.
- **The budget gate:** `budgetGate(budgets, spend, origin)` over the closed union of origins in section 5.4, the month and threshold arithmetic in UTC, and the overshoot.
- **Insights:** the six figures of ADR 0055 as functions over rows: the reference that ticket 14's job and its test both use.
- **Memory:**
  - the secret scan: the organization's secret values matched exactly, the fixed credential shapes of ADR 0044's amendment, and the model-control tokens of its Q91 section (chat-template and role markers such as `<|im_start|>`, `<|endoftext|>`, `<|start_header_id|>` and `</system>`, found as `a model-control token`), each with a negative control that must pass (a note that talks about system prompts in plain words is saved)
  - the index builder: project first, then organization, then by last read (`lastUsedAt`, which only a read moves, ADR 0044, Q91), newest first, then by last edit for notes never read, cut at the limits, with the "N more notes" line
  - the memory block's renderer (the "always" notes, the index and the standing instruction), which core puts in the spec and appends to the instructions for a minor-2 runner. The block says these are the organization's and the project's approved notes and gives each note's source. Its standing instruction tells the agent to search memory before it guesses a convention, to propose a note when it learns something the next task should know, and, when the code disagrees with a note, to propose with `relation: "contradicts"` instead of following it (ADR 0044, Q91)
  - the version check that `saveNote` and a merge share: an expected version that isn't the note's current one is a conflict, carrying who saved and which version (ADR 0044, Q91)
  - "Remember this" from a diff comment or a PR comment
- **Several repos:** the project's repo limit, the "in use" rule, the folder name rule, the renderer of the repos list that core appends to the agent's instructions, and of a PR's "Related" section.
- **The evaluator:** ported from `spikes/github-app-and-git-proxy/src/github/independent-review.ts` with its cases, taking drivers as members and approvers through verified links (ADR 0040, amended).
- **Mail templates:** the invitation, verification, reset, budget warning and budget reached mails, on milestone 3's renderers, with no task content.
- **Use cases, jobs and settings:** the signatures, job names with their key rules, and the settings with their defaults of section 5.4, each setting's line in `docs/configuration.md`.
- **Test helpers:** `seedOrganization` in `@ostra/domain/testing`, beside milestone 3's `seedMember`.

## Done when

- [x] Tests: every lifecycle's transitions, legal and illegal; the gate for every origin at 79%, 80%, 99% and 100%, and across a month's end; each Insights figure on a fixture with its expected value; each secret shape and each model-control token refused, and their negative controls saved; the index's order and cut, with a note that sessions only saw in the index ranked by its last edit, below a note a session read; the block's framing, with each note's source; a stale expected version refused; the evaluator's cases (approved, stale, dismissed, bot, driver, unlinked, changes requested after an approval); each mail renders with its link in both parts.
- [x] Each test that proves a row's condition is named for the row, with its break-it check.
- [x] Every new setting is in `docs/configuration.md`.
- [x] Committed as `✨ add the milestone 4 domain`.

## Comments

- 2026-11-19: built in `packages/domain`: `src/lifecycles/m4.ts` (membership, invitation, proposal, a budget's month, the review check), `access.ts` (`scopeForMembership`, `requireInstanceAdmin`, `canWriteNote`, `canArchiveNote`, `canReadAudit`), `src/budget/gate.ts`, `src/insights/figures.ts`, `src/memory/` (secret scan, index builder, block renderer, version check, "Remember this"), `src/repos/several-repos.ts`, `src/review/independent-review.ts` (spike 4's evaluator, ported, with drivers as members and approvers through verified links), `src/mail/account-mails.ts`, `src/use-cases/m4-signatures.ts`, the eight jobs with their keys (and their queues in `packages/jobs`), the ten settings with their lines in `docs/configuration.md`, and `seedOrganization` in `@ostra/domain/testing`. Tests in `src/milestone-4.test.ts`, each F-named one with a break-it (20 breaks, each failing its test); partial proof rows in `context/proof/F-037.md`, `F-104.md`, `F-108.md`, `F-109.md` and `F-110.md`, since the core and api tickets wire these. Whole-repo typecheck, lint and test, and check:proof green. Commit: `✨ add the milestone 4 domain`.
