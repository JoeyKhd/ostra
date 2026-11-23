# 01: The rule, the table and the runner protocol's minor 10

Status: ready-for-agent
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

- [ ] Tests named for `F-052/c1`: the rule schema accepts an exact host, a `*.suffix`, a `/32` and an IPv6 CIDR with ports, and refuses a bare `*`, an IP in a `host`, a scheme or path, `localhost`, an empty port list, a repeated port, a private CIDR and a duplicate `(kind, value)`; the message for the private CIDR is the spec's sentence.
- [ ] Tests named for `F-052/c6`: a spec with rules round-trips at minor 10 and is stripped at minor 9, `isTaskOfferable` refuses it for a minor-9 peer with `network-rules` and its words, and an empty list changes nothing at minor 9.
- [ ] The migration applies on a fresh database and on the milestone 11 schema; `environment_network_rule` is on the isolation list and the generated suite builds it in two organizations.
- [ ] The event's shape is in the protocol, has no code at minor 9, and `packages/task-view/src/coverage.ts` gains its row (`"egress.blocked": eventLog("post-v1, F-052")`) with `derive-state.ts` treating it as a non-state event, so the repo is green without the panel's words (ticket 04 owns those).
- [ ] The whole repo's checks pass (schema and protocol: typecheck, lint, tests) and `pnpm install`/the lockfile are unchanged (no new dependency).
- [ ] Committed as `✨ add network rules to the environment`.

## Comments
