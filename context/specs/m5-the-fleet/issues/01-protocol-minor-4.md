# 01: Protocol: minor 4

Status: done
Builder: core (contracts, first)
Blocked by: none (milestone 4's ticket 01, minor 3, lands first)
Features: F-013, F-061, F-092, F-093, F-095, F-120 (their wire shapes)
Packages: `packages/protocol`
Spec: `../spec.md`, section 5.1; ADR 0034 (amended)

## What to build

Every change is additive. The schema is written once, Zod first; the types are `z.infer`. If milestone 4's minor 3 isn't in yet, this ticket waits for it.

- **Minor 4,** negotiated in `hello` and `welcome`, with minor 3's codecs kept. A minor-3 peer never receives `resume`, the dispatch's `box` section or `snapshot-build`'s `push` and `builder`, and a minor-4 runner talking to a minor-3 server sends no `box.waiting`, `box.scheduled`, `resources`, `capabilities.registry`, `capabilities.nodeWait` or `install`. A minor-2 peer is outside the window. A `hello` whose executor is `kubernetes` at a minor under 4 is refused with its own reason.
- **`hello` and `status`:** the optional `resources`, `capabilities` (the four that milestones 2 or 3 may have added, plus `registry` and `nodeWait`) and `install`.
- **Commands:** `resume {}`, at minor 4 in `commandKindMinMinor`; the dispatch body's optional `box { size, image }`; `snapshot-build`'s optional `push` and `builder`.
- **Events:** `box.waiting` and `box.scheduled` as runner events; `task.cancelled`, `runner.drained` and `runner.resumed` as server-only kinds, added to `serverOnlyKinds`.
- **The HTTP carrier** in `src/runner/http.ts`: the request and response schemas of `POST /hello`, `POST /up` and `GET /down?after=`, the `x-ostra-epoch` and `x-ostra-minor` headers as named constants, and the `409 { code: "superseded" }` and `204` answers.
- **Runner HTTP:** `POST /tasks/:taskId/pull-credential` and `POST /snapshots/:snapshotId/push-credential`, both answering `{ registry, username, token, expiresAt }`, with their refusals (`no-image`, `not-the-builder`, `stale-lease`).
- **`/runner/v1/info`:** `version`, `minorWindow` and `npm { package, registry } | null`.
- **Labels:** the reserved prefixes `executor:`, `os:` and `arch:` as a named list, and `isReservedLabel`.
- The schemas' descriptions say what's never logged: tokens and credentials.

## Done when

- [x] Tests: every new shape round-trips; minor-3 and minor-2 frames still parse at their minors; a minor-3 peer's codec drops each new field and refuses `resume`; a strict object refuses an unknown field; a `kubernetes` `hello` under minor 4 is refused; the server-only set includes the three new kinds; the fixtures in `src/testing/` cover each new kind, command and endpoint.
- [x] Every caller in the repo still compiles, and no existing schema changed shape.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add protocol minor 4`.

## Comments

- 2026-11-19: built. Minor 4 in `packages/protocol` (`version.ts`, `runner/messages.ts`, `runner/commands.ts`, `runner/http.ts`, `events/agent-events.ts`, `common.ts`), minor 3's codecs kept (`commandSchemaV3`, `taskEventSchemaV3`, `infoResponseSchemaV3`), and the fixtures in `src/testing/fixtures.ts` (`minor4CommandFixtures`, `minor4StatusFixture`, `minor4HelloFixture`, `minor4HttpFixtures`, `registryCredentialRefusalFixtures`); the tests are `src/runner/minor-4.test.ts`, with break-its (the minor-3 encode keeping `box`, and `refuseHelloExecutor` never refusing) each failing its test. Differences from the ticket, each additive: `hello` also names its `executor` (optional), so core refuses a `kubernetes` runner under minor 4 at `hello` (`refuseHelloExecutor`), falling back to the executor the runner registered with when a minor-3 `hello` names none; `runnerLabelSchema` now allows `:` and `/`, as spec section 5.1 writes it, and a status sent to a minor-3 server keeps only the labels minor 3 reads; `resources` is the runner's whole offer, and core subtracts the boxes it placed from its own rows (ADR 0059); the connection epoch header's value is `x-ostra-epoch`, as the spec names it (no carrier sent the old name); `GET /runner/v1/info` sends `minorWindow` and `npm` only to a request whose `x-ostra-minor` is 4 or more, and the runner sends it. Callers updated in the same commit: core refuses the `kubernetes` `hello` and answers `info` by minor (`apps/core/src/gateway/`), the runner and the box dispatcher lift a drain on `resume`, ingest stores the five new kinds without a reaction yet (ticket 20 gives `box.waiting` and `box.scheduled` theirs), the task view draws no row for them yet (ticket 33), and the database's `CommandKind` gains `resume` in its own migration, `20261123000000_command_resume` (ticket 04's migration has the rest). Whole-repo typecheck, lint, test, `check:licenses` and `check:proof` green. Commit: `201b71a` (`✨ add protocol minor 4`).
