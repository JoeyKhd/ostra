# 06: Domain: lifecycles, access, the gate, Insights, memory, several repos, the evaluator, mails

Status: ready-for-agent
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
  - the secret scan: the organization's secret values matched exactly, and the fixed shapes of ADR 0044's amendment, each with a negative control that must pass
  - the index builder: project first, then organization, then by last use, cut at the limits, with the "N more notes" line
  - the memory block's renderer (the "always" notes, the index and the standing instruction), which core puts in the spec and appends to the instructions for a minor-2 runner
  - "Remember this" from a diff comment or a PR comment
- **Several repos:** the project's repo limit, the "in use" rule, the folder name rule, the renderer of the repos list that core appends to the agent's instructions, and of a PR's "Related" section.
- **The evaluator:** ported from `spikes/github-app-and-git-proxy/src/github/independent-review.ts` with its cases, taking drivers as members and approvers through verified links (ADR 0040, amended).
- **Mail templates:** the invitation, verification, reset, budget warning and budget reached mails, on milestone 3's renderers, with no task content.
- **Use cases, jobs and settings:** the signatures, job names with their key rules, and the settings with their defaults of section 5.4, each setting's line in `docs/configuration.md`.
- **Test helpers:** `seedOrganization` in `@ostra/domain/testing`, beside milestone 3's `seedMember`.

## Done when

- [ ] Tests: every lifecycle's transitions, legal and illegal; the gate for every origin at 79%, 80%, 99% and 100%, and across a month's end; each Insights figure on a fixture with its expected value; each secret shape refused and its negative control saved; the index's order and cut; the evaluator's cases (approved, stale, dismissed, bot, driver, unlinked, changes requested after an approval); each mail renders with its link in both parts.
- [ ] Each test that proves a row's condition is named for the row, with its break-it check.
- [ ] Every new setting is in `docs/configuration.md`.
- [ ] Committed as `✨ add the milestone 4 domain`.

## Comments
