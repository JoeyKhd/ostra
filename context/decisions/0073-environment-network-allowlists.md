# Environment network allowlists, enforced by the sidecar's egress proxy

**Status:** proposed (2026-11-23). It needs the maintainer's word on the two questions under "Open questions" before F-052 is built; it amends ADR 0031's fourth safety line (an allowlist now ships, just not in v1) and extends the list of allowed differences in ADR 0029 with a fifth `host` difference. Ledger: F-052. Spec: `specs/post-v1-network-rules/`. Builds on ADR 0029 (boxes and executors), ADR 0030 (no credential in the agent's container), ADR 0031 (the safety minimum), ADR 0038 (environments, snapshots and services) and ADR 0060 (the chart applies the `kubernetes` policy; the runner may not write one).

## Context

F-052 has been on the ledger since before v1: "An environment limits which hosts its agents can reach, as an allowlist on top of the egress baseline (F-116)." ADR 0031 kept it out of v1 for a stated reason: "only an OS-level jail or a CNI that understands names makes them real, and each environment needs its own policy" (`research/credential-proxy.md`, summary and §15). The same research ranks the options: an OS-level jail (`@anthropic-ai/sandbox-runtime`), per-task containers on an `--internal` Docker network with a proxy sidecar, and Cilium `toFQDNs` on Kubernetes.

The box that shipped in v1 is the middle one. On `docker` the agent's container is on an `internal` network (`packages/adapters/adapter-executor-docker/src/boxes.ts`) whose only other member with a route out is the sidecar, which alone joins the `ostra-egress` network; the egress baseline is host rules on that network and on the host (`egress.ts`, `deploy/egress-baseline.sh`, F-116). On `kubernetes` the box is one pod: the containers share a network namespace and an IP, and the chart's NetworkPolicy selects the pod, so the agent has direct public egress — ADR 0029's fourth recorded difference. On `host` there is no box and the executor is labelled "not isolated".

So the missing part is not a second jail. It is a **door with a list**, and on the executor that already has only one door the list is exact.

## Decision

### A rule

A network rule is one of:
- a **host**: an exact DNS name (`registry.npmjs.org`), or `*.` and a suffix (`*.githubusercontent.com`), matched at a label boundary — never the bare suffix, never a bare `*`;
- a **CIDR**: an IPv4 or IPv6 network an endpoint is reached at by address;
and, in both cases, one or more **TCP ports** (1 to 65 535).

At most 100 rules per environment and 16 ports per rule *(working values)*. A rule's `(kind, value)` is unique in the environment.

**An environment narrows the baseline and never widens it.** A CIDR inside `EGRESS_BLOCKED_V4/V6` is refused when it is saved; a host whose DNS answer is inside those ranges is refused when the box connects to it. A private endpoint is opened by the runner administrator in `OSTRA_EGRESS_ALLOW` (ADR 0029, Q239, ADR 0060), which is an install-wide decision, not a project member's.

### Where it is stored and edited

A child table of `Environment`, beside `Service` and `Check`: `environment_network_rule` with the environment's composite keys (`organizationId`, `projectId`, `environmentId`), `kind` (`host`|`cidr`), `value`, `ports Int[]`, and the usual timestamps. The environment's own row is untouched, so the migration is one additive table and no backfill: an environment with no rules is exactly today's behaviour.

It is edited on the environment page's **Network** tab, by a project admin, one rule per transactional save with its audit entry and a change notice — the `servicesRouter` pattern, not the environment form — and read by anyone who can open the project. A rule does **not** enqueue a snapshot rebuild (the image doesn't hold a rule), and it takes effect at the **next dispatch**: a running box keeps the rules it started with, and the tab says so.

### How it is enforced

**One mechanism on every executor: an egress proxy in the sidecar.** `node:http` and `node:net`, no dependency, modelled on the existing key proxy and git proxy (`apps/runner/src/sidecar/`). It is a filtering forward proxy:
- it accepts `CONNECT host:port` and absolute-form HTTP requests, checks the destination against the environment's rules, and refuses anything else with a 403 and a one-line reason;
- TLS passes through untouched: the proxy terminates nothing, holds no CA and sees no plaintext; the audit is `{ host, port, decision }`, never a path, a query or a header;
- every resolved address is checked against the baseline too (and `OSTRA_EGRESS_ALLOW`, which the runner passes into the sidecar's environment from the setting it already validates), which is the wall on the executors whose box has other routes;
- a refusal is one `egress.blocked` event per (host, port) per task, folded as bookkeeping in the Event log.

The agent, its setup script, its checks and its app processes get `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` (both cases) pointing at the proxy, and a computed `NO_PROXY` that keeps the model, git and MCP proxies out of it. A repo variable can't override them. **When the environment has no rules, the proxy is not started and no variable is set**, so no install changes behaviour on upgrade.

What that buys, per executor — and what it does not:

| Executor | The box's other routes | What the rules are |
|---|---|---|
| `docker` | none: the agent's container is on an `internal` network ([Docker: internal networks "may communicate between each other, but not with any other network"](https://docs.docker.com/reference/cli/docker/network/create/)) and only the sidecar joins `ostra-egress` | **Enforcement.** A process that ignores the proxy variables reaches nothing |
| `kubernetes` | the pod's own; NetworkPolicy selects pods, not containers ([Kubernetes: NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/)) | **A filter.** A process that ignores the variables goes direct, as ADR 0029's fourth difference already records |
| `host` | whatever the account has | **Advisory.** ADR 0029's fifth `host` difference, recorded here |

**Services are not proxied.** A service's environment is its own and a third-party image with an injected `HTTP_PROXY` is a support problem. On `docker` a service reaches no public host (it is on the box's internal network only) and that is unchanged; on `kubernetes` it keeps the pod's direct egress. The tab's note says both.

**Snapshots are unchanged.** A snapshot builds with the build's own egress (BuildKit on `docker`, the build namespace's policy on `kubernetes`: ADR 0038), because the setup script is the admin's and a build that can't fetch a lockfile is useless. The **incremental install a box runs at start** happens in the agent's container, so with rules it goes through the proxy, and the package hosts belong in the rules. The panel says so; it does not guess hosts from the script.

**Protocol.** The rules travel in the task spec's environment section at **minor 10**, optional. A minor-9 peer is never sent a spec with rules (`encodeTaskSpecForMinor`) and is never offered such a task (`isTaskOfferable`, reason `network-rules`), so an old runner refuses the task instead of ignoring the list. The task stays queued, with the panel's sentence, and never fails.

## Considered options

- **`@anthropic-ai/sandbox-runtime` wrapping the whole agent process tree** ([the repo](https://github.com/anthropics/sandbox-runtime); `research/credential-proxy.md`'s first-ranked option: Apache-2.0, TypeScript, Seatbelt on macOS, bubblewrap on Linux, an alpha Windows mode). The only option that makes `host` real, and the only one that would also enclose a process that ignores proxies. Rejected for this feature: a new runtime dependency and install story (an elevated `windows-install`, a dedicated user, WFP), an 0.0.x research preview with its own published bypasses, and per-task policies that run one `srt` process each. It stays an open question for `host`.
- **A per-box NetworkPolicy on `kubernetes`.** Native, and real if the policy replaces the baseline's pod selection. Rejected: the chart deliberately applies the policy once per namespace and the runner's service account is not granted the right to write one, because that is the right to remove the baseline (ADR 0060, `kube-api.ts`); a standard NetworkPolicy can't name a host, so the addresses would be resolved at box creation and stale for a long task; and the pod shares one namespace with the sidecar, so the policy would have to carry the sidecar's own destinations (model providers and the code host) too. It also fails open twice: the baseline selects the pod by role, so a restricted box needs a different label and a missing policy leaves it with no restriction at all, and Kubernetes policies are additive — you cannot subtract a rule from the baseline's `0.0.0.0/0` without excluding the pod from it.
- **Cilium `toFQDNs` on `kubernetes`** ([Cilium's DNS-based policies](https://docs.cilium.io/en/stable/security/policy/language/#dns-based); `research/credential-proxy.md` §15: standard NetworkPolicy "only understands pods, namespaces and CIDRs"). The right answer for name-based enforcement on a cluster that runs it, and a CNI requirement for everyone else. Rejected as a requirement; kept as the maintainer's question.
- **Per-box host rules on `docker`.** The baseline is already host rules, but they are applied once, as root, by `deploy/egress-baseline.sh`; per-task rules would need the runner to write `iptables`, which means root or `CAP_NET_ADMIN` on the pool host, or an egress network the agent joins — a new privilege and a new exposure. Rejected: the box's topology already makes the proxy the only door, so the privilege buys nothing.
- **MITM proxies** (iron-proxy, Squid, `srt-proxy`). They would add method and path rules and credential injection, and they need a per-task certificate authority on the box. Rejected: the feature asks for hosts and ports, and ADR 0030 deliberately has no CA.
- **A JSON column on `Environment`.** Rejected: the services' pattern (a child table with a unique key and per-change audit) is already in the schema and the panel.
- **Empty list = deny everything.** Rejected: it would change every existing `kubernetes` environment on upgrade (its proxy-honouring clients would start being refused) with no member action. No rules means no proxy.

## Consequences

- **F-052 is weaker than its one-line ledger entry sounds on two of three executors**, and the panel says so in the same words as ADR 0029's difference. The feature is real where the box has one door; elsewhere it is a filter, and closing that needs a CNI decision or an OS jail (below).
- **The setup script's installs must be allowlisted** in an environment with rules, or the box's start-time install fails with a 403. The tab's note and the docs say it; a project that adds one rule and nothing else will see it.
- **Webhook forwarders can run on `docker`** (Q302 waited for this): their host goes in the rules, and their long-lived TLS connection rides a `CONNECT` tunnel.
- **The runner's protocol grows a minor** with one optional field and one event kind; older runners refuse the tasks that need it, as every minor before this one.
- **The isolation test and the schema's model list grow one entry** (Q196), and the audit log three actions.
- **An environment's rules are readable by every member who can open the project.** They are not secrets; they describe the project's own dependencies.
- **Unverified until the launch-gate Proof run**, and the spec says so: that the proxy is reachable from a shell in a real `docker` box and that a proxy-ignoring request then reaches nothing (the `docker` executor's live half has never run: spike 3 and milestone 5's ticket 35 wait for a Linux host with Docker); that the same proxy works from the pod's `localhost` on a real cluster; that the base image's package managers honour the variables; and that a proxy-ignoring request on `kind` really does reach the internet (the live job asserts that, rather than asserting the gap away). Until those run, F-052 stays `building` with a dated note.
- **No new dependency.** The proxy is Node's own HTTP and TCP; the table is Prisma; there is no CNI, no jail and no certificate authority.

## Open questions for the maintainer

1. **Closing `kubernetes`'s direct egress**: Cilium `toFQDNs`, a per-box NetworkPolicy (with the privilege and fail-open problems above), or leave it recorded. Recommended: leave it for now, and decide before any "strict" promise is made.
2. **An OS jail on `host`**: `@anthropic-ai/sandbox-runtime` is asked about before it is added, as the repo requires for a dependency. Recommended: not for this feature.
3. **Opening a baseline range per environment**: recommended no, permanently; `OSTRA_EGRESS_ALLOW` stays the runner admin's.
