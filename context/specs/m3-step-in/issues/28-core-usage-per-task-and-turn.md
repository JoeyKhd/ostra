# 28: Core: usage per task and per turn

Status: ready-for-agent
Builder: core
Blocked by: 06
Features: F-084
Packages: `apps/core` (`src/ingest/`), `packages/domain`
Spec: `../spec.md`, section 2 (F-084)

## What to build

- **Per turn:** the four token kinds and the spend from the turn's `usage.recorded` events (milestone 2 prices them, ADR 0042, Q163), and the turn's agent time from `turn.started` to its end, kept on the turn (`Turn`'s new columns, ticket 06).
- **Per task:** the sums over every session, and the agent time as the sum of turns. An estimated count (`estimated: true`) marks the figure as estimated wherever it's summed.
- **Read paths** for ticket 39: a task's totals and its turns' figures in one query, without reading every event.
- A model with no price shows tokens and no spend, as milestone 2's token cap does.

## Done when

- [ ] Tests: the totals equal the sum of the task's `usage.recorded` events across two sessions; an estimated event marks the turn and the task; agent time excludes the time a turn waited for nobody (between turns); another organization's usage is invisible.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `core` and `domain`.
- [ ] Committed as `✨ add usage per task and turn`.

## Comments
