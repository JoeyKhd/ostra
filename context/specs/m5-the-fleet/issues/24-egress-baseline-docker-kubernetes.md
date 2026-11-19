# 24: The egress baseline on `docker` and `kubernetes`

Status: ready-for-agent
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

- [ ] Tests named for `F-116`: the rules and the policy are built from the one list and equal each other's ranges; the server's address is the only accept besides `OSTRA_EGRESS_ALLOW`; the probe runner's verdicts (blocked, reachable, inconclusive) from scripted results, the positive control's failure making the check inconclusive.
- [ ] Break-it: dropping `169.254.0.0/16` from the list fails the rules' test; recorded in `context/proof/F-116.md`.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ build the egress baseline from one list`.

## Comments
