# 01: Protocol: minor 4

Status: ready-for-agent
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

- [ ] Tests: every new shape round-trips; minor-3 and minor-2 frames still parse at their minors; a minor-3 peer's codec drops each new field and refuses `resume`; a strict object refuses an unknown field; a `kubernetes` `hello` under minor 4 is refused; the server-only set includes the three new kinds; the fixtures in `src/testing/` cover each new kind, command and endpoint.
- [ ] Every caller in the repo still compiles, and no existing schema changed shape.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add protocol minor 4`.

## Comments
