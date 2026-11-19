# 23: Core: checks before the PR, and drafts

Status: ready-for-agent
Builder: core
Blocked by: 07, 09
Features: F-054
Packages: `apps/core` (`src/ingest/`, `src/reactions/`, milestone 1's PR opener), `packages/domain` (`recordChecksRun`)
Spec: `../spec.md`, section 4 ("Checks"); ADR 0052

## What to build

- **The spec's checks** from the environment's `Check` rows, in their order, with their timeouts (`OSTRA_CHECK_TIMEOUT_SECONDS` when a check has none), and the repo each runs in.
- **`check.started` and `check.finished`** (ingest): a `CheckRun` per check and turn, with the output's blob (milestone 2's bulk path, purpose `check-output`).
- **The PR body:** milestone 1's opener writes a "Checks" section (each check's name and status, and the failing ones' last lines inside a code block) between the agent's text and the trailers, and edits it on every later turn. Check output is untrusted: it's escaped, cut to 40 lines, and never interpreted.
- **Drafts:** a turn with a failing check opens its PR as a draft, or converts an open PR to draft and records `draftByOstra`. A later turn whose checks all pass marks a PR that ostra made a draft ready for review; a PR a person made a draft stays one. The task stays in review either way.
- **"Ask the agent to fix":** a message (`intent: "fix-checks"`) rendered by the domain's prompt with each failing check's command and output tail inside marked blocks, sent as the composer does.
- **No checks:** an environment with none behaves as milestone 2's.

## Done when

- [ ] Tests: a passing turn opens a ready PR with the section; a failing one opens a draft; a later pass marks it ready; a person's draft stays a draft; the section is edited, not appended; check output with markdown and HTML is escaped; "Ask the agent to fix" sends one message; another organization's runs are invisible.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `core` and `domain`.
- [ ] Committed as `✨ add checks before the PR`.

## Comments
