# 01: The rule, the table and the runner protocol's minor 10

Status: done
Builder: core (contracts, first)
Blocked by: none
Features: F-052 (c1, c6; c7's event shape)
Packages: `packages/protocol` (`src/config/network-rule.ts` (new), `src/ids.ts`, `src/task/spec.ts`, `src/runner/messages.ts`, `src/runner/version.ts`, `src/testing/fixtures.ts`), `packages/db` (`prisma/schema.prisma`, the migration, `src/testing/isolation-models.ts`), `packages/domain` (`src/environment/network-rules.ts` (new), `src/audit/actions.ts`, `src/index.ts`)
Spec: `../spec.md`, sections 5.1 and 5.2; ADR 0073

## What to build

- **The rule, in `packages/protocol/src/config/network-rule.ts`:**
  - `networkRulePortSchema` (an integer 1 to 65 535) and `networkRuleHostSchema` (lowercase ASCII, an exact name or `*.` and a suffix of at least two labels; no scheme, path, port, underscore, trailing dot or IP literal);
  - `cidrSchema` (new): an IPv4 or IPv6 address with a written prefix, the bit count in range, parsed by splitting the octets or groups — no `netmask` dependency;
  - `networkRuleSchema` as the spec's discriminated union over `kind` (`host`|`cidr`) with `ports` of 1 to 16 entries, and `networkRulesSchema` (at most 100, each `(kind, value)` once);
  - exported from the package's index; its type `z.infer`'d.
- **The table:** `EnvironmentNetworkRule` and the `EnvironmentNetworkRuleKind` enum in `schema.prisma`, with `organizationId`, `projectId`, `environmentId`, the composite relation `[environmentId, projectId]` on delete cascade, `kind`, `value`, `ports Int[]`, timestamps, `@@unique([environmentId, kind, value])`, `@@index([environmentId])`, `@@map("environment_network_rule")`; and `networkRules EnvironmentNetworkRule[]` on `Environment`. One additive migration, no backfill, nothing dropped or renamed.
- **The isolation list:** `EnvironmentNetworkRule` in `packages/db/src/testing/isolation-models.ts` with its fixture builder in a project (its parents: organization, project, environment), so the generated isolation suite is green and the guard doesn't fail on the new model (Q196).
- **The task spec at minor 10:** the environment schema's newest version is minor 7's (`taskSpecEnvironmentSchemaV6` extended with `appProcesses` and `screenshots`), so the current `taskSpecEnvironmentSchema` gains `networkRules: networkRulesSchema.optional()` (missing means none), and no new versioned alias is made. `encodeTaskSpecForMinor(9)` strips it; `taskSpecResponseSchemaFor(9)` returns nothing; `taskSpecMinMinor` and the fixtures gain the field. `PROTOCOL_MINOR` becomes 10 with a line in its comment, and a `minor-10.test.ts` following `minor-9.test.ts`.
- **Offerability:** a new `taskNotOfferableReasonSchema` member `network-rules` and its sentence in `taskNotOfferableWords`; `isTaskOfferable` refuses a spec whose environment's list is non-empty and whose peer is below minor 10. A spec with an empty or missing list is offerable to a minor-9 peer as before.
- **The event:** an `egress.blocked` runner event `{ host, port, reason: "not-listed" | "baseline" | "unresolvable" }` in the event union, with no code at minor 9.
- **The domain, in `packages/domain/src/environment/network-rules.ts`:**
  - `normalizeNetworkRule` (lowercase the host, drop a trailing dot, canonicalise an IPv6 prefix's address case, sort and de-duplicate ports);
  - `networkRuleProblem` with the spec's messages, including the baseline refusal built from `EGRESS_BLOCKED_V4/V6` and `inCidr` (`@ostra/adapter-sdk`) — a CIDR inside a range is refused, not only a single address — and the "localhost and private names" refusal for a host rule;
  - `networkRulesView` for the API;
  - the three audit actions in `audit/actions.ts`: `environment.network-rule-added`, `-changed`, `-removed`, all kind `environment`.

## Done when

- [x] Tests named for `F-052/c1`: the rule schema accepts an exact host, a `*.suffix`, a `/32` and an IPv6 CIDR with ports, and refuses a bare `*`, an IP in a `host`, a scheme or path, `localhost`, an empty port list, a repeated port, a private CIDR and a duplicate `(kind, value)`; the message for the private CIDR is the spec's sentence.
- [x] Tests named for `F-052/c6`: a spec with rules round-trips at minor 10 and is stripped at minor 9, `isTaskOfferable` refuses it for a minor-9 peer with `network-rules` and its words, and an empty list changes nothing at minor 9.
- [x] The migration applies on a fresh database and on the milestone 11 schema; `environment_network_rule` is on the isolation list and the generated suite builds it in two organizations.
- [x] The event's shape is in the protocol, has no code at minor 9, and `packages/task-view/src/coverage.ts` gains its row (`"egress.blocked": eventLog("post-v1, F-052")`) with `derive-state.ts` treating it as a non-state event, so the repo is green without the panel's words (ticket 04 owns those).
- [x] The whole repo's checks pass (schema and protocol: typecheck, lint, tests) and `pnpm install`/the lockfile are unchanged (no new dependency).
- [x] Committed as `✨ add network rules to the environment`.

## Comments

### 2026-11-23: done, in `6c78257c`

Every box has a named test, and the checks below ran on the committed tree:

- `F-052/c1` — `packages/protocol/src/config/network-rule.test.ts` (schema acceptance and refusals, duplicate `(kind, value)`, unknown fields); `packages/domain/src/environment/network-rules.test.ts` (private CIDR with the spec's sentence, `localhost`/single-label hosts, normalisation, the API view, the three audit actions); `packages/db/src/schema-network-rules.test.ts` (additive SQL, fresh database + `prisma migrate diff`, milestone-11 upgrade, cascade and unique key, isolation row in two organizations); `packages/protocol/src/runner/minor-10.test.ts` (the event's strict shape).
- `F-052/c6` — `packages/protocol/src/runner/minor-10.test.ts`: round-trip at minor 10, strip at minor 9, `taskSpecSchemaV9` refusal, `taskSpecResponseSchemaFor(9)`, `network-rules` at a minor-9 peer with its words, and an empty or missing list offerable as before.
- Migration: `schema-network-rules.test.ts` applies all migrations on a fresh database (and the diff has nothing of this table left), then applies this migration over the milestone-11 head and reads an existing environment back unchanged; deleting the environment deletes its rules; a duplicate `(environmentId, kind, value)` is refused. The generated isolation suite (`packages/api/src/isolation/every-record.test.ts`) stays green with the new row.
- Event and task view: `minor-10.test.ts` proves a minor-9 frame refuses `egress.blocked` and a minor-10 one reads it; `coverage.ts` has the row, `derive-state.ts` and `fold.ts` treat it as bookkeeping, and `fold.test.ts` proves it moves no thread.

Results on `6c78257c`:

```
pnpm install --frozen-lockfile   Done in 14.4s; lockfile unchanged
prisma generate / validate       Generated (7.10.1); schema is valid
@ostra/protocol test             29 files, 1188 tests passed
@ostra/domain test               47 files, 985 tests passed
@ostra/db test                   22 files, 124 tests passed
@ostra/task-view test            10 files, 218 tests passed
api every-record.test.ts          1 file, 17 tests passed
turbo run typecheck              40 successful, 40 total
lint (protocol, domain, db, task-view, api)  exit 0, --max-warnings 0
```

Decisions settled in the build:

- **Refusal words:** `This environment limits which hosts its agent may reach, and this runner needs upgrading.` (the spec's sentence, capitalised as a full sentence).
- **Private-CIDR message:** verbatim from the spec, markdown backticks dropped: `this address is inside the egress baseline (F-116). A runner admin allows a private endpoint with OSTRA_EGRESS_ALLOW, not an environment`.
- **Overlap refusal:** `networkRuleProblem` refuses a CIDR that overlaps any baseline range, not only one wholly inside it, so `0.0.0.0/0` and `0.0.0.0/1` are refused as widenings.
- **`taskSpecSchemaV9`:** a minor-9 response shape without `networkRules` (the environment schema is `.omit`ted from the current one; no new versioned environment alias was made), so `taskSpecResponseSchemaFor(9)` genuinely has no code for the field.
- **Two consumer files** outside the listed packages, both required for green CI: `packages/api/src/isolation/every-record.test.ts` gained `EnvironmentNetworkRule: []` in its exhaustive `readers` record, and `apps/runner/src/task-host/repeat-review.test.ts` moved its exact `PROTOCOL_MINOR` assertion from 9 to 10.
