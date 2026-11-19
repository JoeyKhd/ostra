# 24: The egress baseline on `docker` and `kubernetes`

Status: done
Builder: adapters
Blocked by: 08, 09
Features: F-116
Packages: `packages/adapters/adapter-executor-docker` (`src/egress.ts`), `deploy/egress-baseline.sh`, `packages/adapters/adapter-executor-kubernetes` (`src/egress.ts`), `packages/adapter-sdk` (`src/testing/egress-probes.ts` (new)), `apps/runner` (the probe command in the base image)
Spec: `../spec.md`, section 11, item 10; ADR 0029 (amended), ADR 0031, ADR 0060

## What to build

- **One list of what's blocked:** the private ranges, link-local with the metadata address, carrier-grade NAT, loopback and the reserved ranges of spike 3's NetworkPolicy, in IPv4 and IPv6, as one constant both executors' rules and the chart's policy are built from.
- **`docker`:** `egressRules` builds the `DOCKER-USER` rules for the executor's own subnet pool from that list, with the server's address and `OSTRA_EGRESS_ALLOW` as the only accepts, and `deploy/egress-baseline.sh` applies exactly those rules. The agent's network stays `internal`.
- **`kubernetes`:** the chart's NetworkPolicy (ticket 23) from the same list, with DNS and the server's address; the executor's `health()` refuses a namespace without it (ticket 08).
- **The probes,** ported from spike 3's `checklist.ts` and `box-network.ts`, run from a shell in the agent's container: each blocked range, the metadata address, another box (on `docker`, its sidecar's proxy ports included), the box network's gateway; each with a positive control that must succeed first (a public host, the box's own sidecar), and a timeout counted as inconclusive, never as blocked. On `kubernetes`, a control pod without the box label that must be refused only where the policy is enforced, so a cluster whose network plugin ignores NetworkPolicy is told apart. The canary: a file outside the workspace read by a scripted shell call shows in the event log.
- The probes live in the executor suite's live part (ticket 02), run by ticket 35.

## Done when

- [x] Tests named for `F-116`: the rules and the policy are built from the one list and equal each other's ranges; the server's address is the only accept besides `OSTRA_EGRESS_ALLOW`; the probe runner's verdicts (blocked, reachable, inconclusive) from scripted results, the positive control's failure making the check inconclusive.
- [x] Break-it: dropping `169.254.0.0/16` from the list fails the rules' test; recorded in `context/proof/F-116.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ build the egress baseline from one list`.

## Comments

- 2026-11-20: built. The one list is `EGRESS_BLOCKED_V4` and `EGRESS_BLOCKED_V6` in `packages/adapter-sdk/src/executor/egress-baseline.ts` (spike 3's NetworkPolicy ranges), with `inCidr` ported from spike 3's `box-network.ts`. `docker`: `egressRuleSet` builds from it a reject per range in `DOCKER-USER` and closes the host itself in `INPUT` (the box network's gateway, and anything listening on the pool machine), for IPv4 and, given the egress network's IPv6 subnet, IPv6, with the server's address and `OSTRA_EGRESS_ALLOW` the only accepts; `egressRules` keeps milestone 1's shape as the IPv4 subset; `deploy/egress-baseline.sh` takes the server's address and the allowed addresses, refuses anything that isn't an address, and applies exactly those rules (its test runs it with stand-ins for `iptables` and `ip6tables`). `kubernetes`: ticket 08's `baselineEgressPolicy` now takes its carve-outs from the same list, and a test checks the two executors close the same ranges with the same exceptions. The probes (`packages/adapter-sdk/src/testing/egress-probes.ts`): the plan from the list (each routable range at its first host, the metadata address, the gateway, another box's sidecar ports), each with its positive control (the box's own sidecar on `docker`, a public host on `kubernetes`), a verdict that is blocked only on a network refusal after a control that connected (a timeout, or a failed control, is inconclusive; a refusal by the far end is reachable), the control pod's enforced or not-enforced, the probe script run with `node -e` in the agent's container (node is in the base image already: the box's init runs on it, so nothing was added to `apps/runner`), and the canary's read in the event log. The live case is in `docker.live.test.ts` for ticket 35. Choices: the rules reject (`icmp-admin-prohibited`) rather than drop, so a probe sees a block at once and a timeout can stay inconclusive; on `kubernetes` that needs the network plugin's deny set to reject (Calico's `iptablesFilterDenyAction`), which ticket 35's kind job must set. The docker rules have no DNS exception (ADR 0060 names DNS for `kubernetes` only), so a pool machine whose resolver is at a private address lists it in `OSTRA_EGRESS_ALLOW`; the docs say so. Proof: `context/proof/F-116.md`, four rows `partial` until ticket 35's runs; break-its there: `169.254.0.0/16` dropped from the list failed the rules, the script and the cross-executor tests, an extra DNS accept failed the rules and script tests, a timeout counted as blocked and a failed control ignored each failed the probe tests, and a canary search that found nothing failed its test. Commit: `37733243` (`✨ build the egress baseline from one list`).
