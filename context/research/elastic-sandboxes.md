# Research: elastic sandboxes for runners

**Status:** Research v1 · **Checked:** 2026-11-18 (every source was read on this date unless marked) · **Informs:** round-7 Q8 (elastic runners), Q9 (runner pools), Q11 (the Rivet spike), Q17 (keys the agent can't see), Q18 (scale target); F-017, F-039, F-050, F-051, F-052, F-069; ADR 0006, 0012, 0014, 0020

**Method.**
- **Sources:** vendor docs, pricing pages, READMEs and source, the npm registry (`registry.npmjs.org/<pkg>`) and GitHub repo pages.
- **GitHub facts:** the GitHub REST API's unauthenticated quota ran out during the session, so star counts and release dates come from repo pages and release feeds.
- **Prices:** list prices, with free credits left out.
- **Markers:** **unverified** marks a claim I couldn't confirm from a primary source, and "secondary" marks a third-party page. Recommendations are marked as such and are not decisions.
- **Approvals:** under `AGENTS.md`, every provider SDK is a new dependency and every hosted provider a vendor, so each needs the maintainer's yes.

**Words used here.** These are proposed terms, not yet in `GLOSSARY.md`.
- **Sandbox:** a provider's isolated machine, a microVM or a hardened container. It is not a workspace or an environment; the glossary keeps those apart.
- **Elastic runner:** an ordinary ostra runner whose machine is a sandbox, created for one task and destroyed afterwards.
- **Runner pool:** a named set of runners that tasks are dispatched to.
- **Environment artifact:** a project's prepared checkout with dependencies installed, stored in the form a provider can boot from: an E2B template, a Vercel snapshot or an OCI image.

**The standard workload for every price:** 100 tasks at once, each running 1 hour, at 2 vCPU / 4 GiB RAM / 20 GiB disk.

**The maintainer's framing (2026-11-18), which sets the weights:**
- ostra is an enterprise platform. Admins create **Projects** (for example "calculator") in a dashboard. Each has its tracker connection, its repos and a pre-configured environment: checkout, dependency install and variables, like Claude Code on the web's cloud environment.
- **Runners are install-level infrastructure, configured once,** and they run every project's jobs.

So this study weighs three things most:
1. how an option backs one shared, install-level pool that serves many projects
2. per-project prepared environments that are ready in seconds
3. isolation between projects

---

## Summary

- **The market churned in 2026, so ostra's provider interface should stay thin.**
  - Runloop is winding down; customer support ended on 2026-11-13 ([Runloop](https://docs.runloop.ai/docs/transitions/overview)).
  - Daytona closed its source on 2026-06-11, and the public repo is frozen ([Daytona](https://www.daytona.io/dotfiles/updates/daytona-is-going-closed-source)).
  - Baseten bought Blaxel on 2026-09-10 ([Baseten](https://www.baseten.co/blog/blaxel-is-joining-baseten-to-build-the-future-of-agentic-cloud)).
  - AWS deprecated `firecracker-containerd` and the Firecracker Go SDK on 2026-11-10 ([repo](https://github.com/firecracker-microvm/firecracker-containerd)).
- **No sandbox lives as long as a task.**
  - Continuous runs are capped: 24 h on E2B Pro, 24 h per session on Vercel, 24 h on Modal, 24 or 48 h on Daytona 2.0, and 8 h on AWS AgentCore.
  - Pausing or snapshotting drops open connections on E2B ([snapshots](https://docs.e2b.dev/sandbox/snapshots.md)), on Sprites, and with Modal's memory snapshots.
  - Idle timers count inbound traffic or API calls. No provider documents that a runner's *outbound* WebSocket counts as activity.
  - So ostra's server must drive every sandbox's lifecycle itself and treat a sandbox as disposable. ADR 0006 already allows that: "A workspace can be cleaned up at any time".
- **Per-project prepared environments.**
  - Hosted microVM providers serve these well:
    - E2B templates boot from a memory snapshot in about 80 ms ([E2B](https://docs.e2b.dev/template/how-it-works.md)).
    - Vercel restores a snapshot in 250 ms at p50 and can fork it ([Vercel](https://vercel.com/changelog/vercel-sandbox-snapshot-creation-is-now-up-to-10x-faster)).
    - Modal turns filesystem snapshots into images.
  - Self-hosted Kubernetes has no snapshots outside GKE, so the prepared checkout has to be baked into a per-project image.
- **Isolation between projects** comes from five rules (my recommendation):
  - a fresh sandbox per task, never reused for another task
  - a gVisor or microVM boundary, never plain `runc`
  - the provider's API key stays on the server
  - environment artifacts are namespaced per project and hold no secrets
  - an egress policy for every sandbox
- **Cost is small next to model tokens.**
  - List prices for the standard workload run from about $6.70 to $34 an hour; most land between $14 and $24.
  - That's about $0.07 to $0.34 per task-hour.
  - My estimate, not sourced: an hour of Claude Code on an API key costs well more than that in tokens.
- **Self-hosting without a paid vendor:**
  - **Daytona self-hosted is out.** The repo is archived, its own Compose README calls it "not safe to use in production", and its BYOC still runs on Daytona's control plane.
  - **E2B self-hosted ("E2B Embed")** is Apache-2.0 and complete, but it is "one machine, by design", at up to 200 sandboxes a node. Multi-node E2B is Enterprise BYOC, run by E2B ([embed](https://github.com/e2b-dev/runtime/tree/main/embed)).
  - **Kubernetes `agent-sandbox`** (kubernetes-sigs, Apache-2.0, v1.0.11) with a gVisor or Kata RuntimeClass is the only maintained, multi-node, vendor-free path to 1,000 tasks.
  - **CubeSandbox** (Tencent, Apache-2.0) speaks E2B's API across several nodes. It's promising but young.
- **Rivet Sandbox Agent** ships providers for E2B, Daytona, Modal, Vercel, Cloudflare, Docker, Sprites, ComputeSDK, agentcomputer and local (npm `sandbox-agent` 0.5.6 exports). But its providers start a server inside the sandbox and connect to it *inbound*, with the model key in the sandbox's environment ([E2B guide](https://rivet.dev/sandbox-agent/docs/deploy/e2b.md), [Docker guide](https://rivet.dev/sandbox-agent/docs/deploy/docker.md)). ostra's runner connects out (ADR 0012) and keeps keys away from the agent (`research/credential-proxy.md`). So Rivet's provider list is evidence, not a gate.
- **Recommendation in brief** (details below):
  - **First hosted provider: E2B.** Its one adapter also covers E2B Embed and CubeSandbox when they're self-hosted.
  - **Self-hosting path: Kubernetes `agent-sandbox` with gVisor** (Kata on KVM nodes), plus a Docker-and-gVisor provider for small installs.
  - **Runner pools:** `fixed` or `elastic`, both behind one scheduler. Elastic runners are ordinary runners, so runner parity holds by construction.

---

## Comparison

### Fit

| Option | Runs where | License: platform / TS SDK | Isolation | Per-project prepared environment | Pause; longest continuous run | Egress controls | Docker inside | Rivet |
|---|---|---|---|---|---|---|---|---|
| **E2B Cloud** | Hosted; BYOC on Enterprise | Proprietary cloud on an Apache-2.0 runtime / `e2b` 2.64.0 (MIT on npm) | Firecracker | Template from an image or Dockerfile, as a memory snapshot, ~80 ms; fork up to 100 per request | Pause kept indefinitely and not counted against concurrency; 24 h on Pro | Domains (SNI) and CIDRs, allow or deny; block-all; your own SOCKS5 | Yes | Yes |
| **E2B Embed** (self-hosted) | One KVM node | Apache-2.0 / same `e2b` | Firecracker | As the cloud, on that node | Same API; 1 h by default, editable | As the cloud | Yes | Through its E2B provider (**unverified** against Embed) |
| **Vercel Sandbox** | Hosted | Proprietary / `@vercel/sandbox` 4.0.0, Apache-2.0 | Firecracker | Snapshots, 250 ms p50 restore, fork; tied to one region; expire 30 days after last use | Stop keeps the filesystem, not processes; 24 h per session | Domains (SNI) and CIDRs; deny-all; live updates; credentials injected into headers | Yes | Yes |
| **Modal** | Hosted | Proprietary / `modal` 0.11.2 (beta), Apache-2.0 | gVisor, or a VM runtime | Filesystem snapshots become images; memory snapshots are alpha | No pause; 24 h | CIDRs; domains (beta); block-all | VM runtime only | Yes |
| **Daytona** (cloud) | Hosted; BYOC on Daytona's control plane | Proprietary since 2026-06 / `@daytona/sdk` 0.232.0 (v0); 2.0 is alpha | v0: containers (VMs optional); 2.0: Firecracker | Snapshots are images | v0: stop and start; 2.0: no pause, 24 or 48 h | CIDRs and domains; v0 tiers 1–2 reach only an "essential services" list | Yes | Yes (v0, through the deprecated `@daytonaio/sdk`) |
| **Daytona self-hosted** | Archived Compose stack | AGPL-3.0, frozen at v0.190.0 | Containers | n/a | n/a | n/a | n/a | n/a |
| **Cloudflare Containers / Sandbox** | Hosted; a Worker per install | Proprietary / `@cloudflare/sandbox` 1.0.3, Apache-2.0 | Firecracker | Filesystem snapshots (beta), up to 20 GB, kept 30 days | No suspend; runs while its Durable Object is active, then at most 6 h, "no guarantee" | Internet off, plus an HTTP(S) intercept allowlist | Yes (dind) | Yes |
| **Northflank** | Hosted; BYOC with a paid control plane | Proprietary / `@northflank/js-client` 0.12.0, MIT | Kata with Cloud Hypervisor; gVisor | None: bake an image or use a volume | Pause scales to zero and ends processes; no cap | FQDN and CIDR policies, documented on BYOC only | **unverified** | No |
| **Fly Machines** | Hosted | Proprietary / no official SDK | Firecracker | Volume snapshots only | Suspend (≤2 GB RAM advised); no cap | Ports and protocols only (L4) | **unverified** | No |
| **Fly Sprites** | Hosted | Proprietary / `@fly/sprites` 0.2.4, MIT | Firecracker | No custom image; checkpoints; fork takes ~90 s | Auto-pauses after ~30 s idle, dropping TCP | DNS domain allowlist | Yes | Yes |
| **Runloop** | Shutting down | — | — | — | — | — | — | No |
| **K8s `agent-sandbox`** | Any Kubernetes, 1.29+ recommended | Apache-2.0 / no npm client; use `@kubernetes/client-node` 2.0.2 | Its RuntimeClass: gVisor or Kata (`runc` gives none) | A per-project image; warm pools per template; memory snapshots on GKE only | Suspend keeps the PVC (filesystem only); no cap | NetworkPolicy (L3/L4), default blocks private ranges and metadata; FQDN rules need Cilium | gVisor and Kata: yes | No |
| **CubeSandbox** | Self-hosted, KVM or PVM, multi-node | Apache-2.0 / `e2b`, or `@cubesandbox/sdk` 0.8.0 | Its own RustVMM microVM | Templates with a memory snapshot; across nodes in preview | Auto pause and resume; idle timeout can be "never" | eBPF egress filter plus an L7 proxy | **unverified** | Through its E2B provider (**unverified**) |
| **OpenSandbox** | Self-hosted on Docker or Kubernetes | Apache-2.0 / `@alibaba-group/opensandbox` 1.2.1 | runc, gVisor, Kata or Firecracker | Snapshot, fork and restore | Pause and resume (Firecracker) | Per-sandbox FQDN sidecar (not under gVisor) | **unverified** | No |
| **Docker + gVisor** | Any Linux host | Apache-2.0 / `dockerode` 5.0.1 | gVisor (no KVM needed), or Kata | A per-project image; `runsc checkpoint` | No cap | Docker networks plus iptables or a proxy | Yes | Its Docker provider (`runc`) |
| **microsandbox** | A library on each KVM host | Apache-2.0 / `microsandbox` 0.7.15 | libkrun microVM | Disk and full snapshots, fork, on one host only | Pause, local only | Default deny plus rules | Yes | No |

npm versions were read from the registry on 2026-11-18. Every other cell is cited in its section below.

### Scale and cost

The standard workload is 100 tasks at once for 1 hour, at 2 vCPU / 4 GiB / 20 GiB.

| Option | List price | Plan fee | Concurrency | EU | Backing, status |
|---|---|---|---|---|---|
| **E2B** | **$16.56** | Pro $150/mo; +$500/mo per extra 500 slots | Pro 100, up to 1,100 with add-ons; Enterprise higher. Pro creates 5 a second | europe-west1, through support | $21M Series A (2025); SOC 2 Type II; GA |
| **Vercel Sandbox** | **$13.60–34.08** in iad1 at 20–100% CPU; $19.52–48.96 in fra1 | Pro $20/mo, plus seats | 10,000 on Pro; vCPU allocation starts at 150/min and ramps to 5,000/min | fra1, cdg1, dub1, lhr1, arn1 | Vercel; GA 2026-01-30 |
| **Modal** | **$23.80**; $27.37 pinned to EU | Starter $0 (100 containers); Team $250/mo (5,000) | 100 or 5,000 | `eu` at 1.15×; the control plane is in us-east | $355M Series C (2026-05), then a $750M Series D |
| **Daytona v0** | **$16.72** | None, but needs Tier 3 | By tier; Tier 3 is 200 vCPU | EU | $60M Series B (2026-10-20) |
| **Daytona 2.0** | **$16.58** | Team $250/mo | Starter 100; Team 5,000 | None listed | Same company |
| **Cloudflare** | **$6.98–18.50**, plus ~$0.58 of Durable Object time | Workers Paid $5/mo | 15,000 vCPU by default | `jurisdiction: "eu"` | GA 2026-04-13; snapshots still in beta |
| **Northflank** | **$6.67–6.99** | None | 500 services by default; raised through support | London, Netherlands, Frankfurt, Zurich | $22M (2024) |
| **Fly Machines** | **~$9.59** in iad; ~$11.00 in fra | None | Per-org quota, not published | Several EU regions | $70M Series C (2023) |
| **Fly Sprites** | **$11.66–17.82** | Plan pages conflict | "Epic" plan: 1,000 (**unverified**) | **unverified** | Launched 2026-01 |
| **Runloop** | Was $32.37 | — | — | — | Winding down |
| **Others (hosted)** | Blaxel $16.56; Tensorlake $9.20–20.40; Freestyle $13.40; Beam $14.00; AWS AgentCore $9.31–32.28 | See their sections | See their sections | See their sections | See their sections |
| **K8s `agent-sandbox`** | Your own hardware | None | Bound by the cluster; ~300 warm claims a second per cluster | Wherever you run it | kubernetes-sigs, v1.0.11 |
| **E2B Embed** | Your own hardware | None | Up to 200 sandboxes and 3 starting at once, per node | Wherever you run it | Apache-2.0 |
| **CubeSandbox** | Your own hardware | None | Vendor claims "thousands per server" (**unverified**) | Wherever you run it | Tencent, v0.8.0 |

---

## Install-level pools, per-project environments and isolation

This section applies the maintainer's framing across the options. The per-candidate sections follow it.

### One pool serving every project

- **Credentials.** A hosted provider means one provider account, and one API key, per install. The server keeps it encrypted, as it does team API keys (ADR 0014). It never enters a sandbox.
  - Daytona's April 2026 advisory shows why: API credentials could be read from sandbox memory through the default passwordless `sudo` ([advisory](https://www.daytona.io/dotfiles/updates/security-advisory-api-credential-exposure-in-sandboxes)).
- **Shared quota.** Concurrency is set per provider account, so every project shares it.
  - E2B Pro allows 100, or up to 1,100 with add-ons ([E2B](https://docs.e2b.dev/faq/increase-concurrency.md)). Vercel Pro allows 10,000 ([Vercel](https://vercel.com/docs/vercel-sandbox/pricing)).
  - A pool needs caps per project and fair queueing between projects, so that one project's burst can't take the whole pool. That's a proposal; the domain model already orders the queue by ticket priority (`domain-model.md`).
- **Creation rates** matter when many tickets land at once:
  - E2B Pro creates 5 sandboxes a second.
  - Vercel starts at 150 vCPU a minute and ramps up to 5,000.
  - Fly allows 1 request a second per action.
  - AgentCore allows 25 new sessions a second.
  - The pool must queue its creates and back off on 429s. E2B's SDK retries 429s itself from 2.49.1 ([npm](https://registry.npmjs.org/e2b)).
- **Tagging.** Every sandbox should carry the install, pool, project, task and request IDs. That lets the server list sandboxes, attribute cost to a project and sweep orphans. Which providers support metadata tags, and whether they can be filtered when listing, is **unverified** for each one.
- **Kubernetes** serves every project from one cluster. A namespace per project gets a ResourceQuota and NetworkPolicy per project from Kubernetes itself. That's a proposal built on standard features.

### A per-project environment, ready in seconds

- **Proposal: an environment build.** ostra turns a project's environment into an environment artifact:
  - **Inputs:** the runner image (F-039), a checkout of the default branch, and the setup script's dependency install (F-050).
  - **Output:** an E2B template, a Vercel snapshot, a Modal image or an OCI image in a registry.
  - **Key:** (project, environment version, runner image digest, lockfile hash).
  - **Rebuilt** when any of those changes, and on a schedule so the checkout doesn't drift far behind.
- **At task start:**
  1. Boot from the artifact.
  2. `git fetch` the task's branch.
  3. Run the incremental install.
  4. Fetch secrets and `.env` files through `rpc`, after the lease check (`research/runner-transport.md`).
  5. Start the agent.
- **How fast each option boots a prepared environment:**
  - **E2B:** about 80 ms from a template ([how it works](https://docs.e2b.dev/template/how-it-works.md)). E2B says templates start faster than snapshots, and many templates per account are supported ([snapshots](https://docs.e2b.dev/sandbox/snapshots.md)).
  - **Vercel:** a 250 ms p50 restore. A Vercel guide measured 0.41 s from a snapshot against 16.5 s of setup from scratch ([guide](https://vercel.com/kb/guide/how-to-use-snapshots-for-faster-sandbox-startup)).
  - **Modal:** a median cold start under 0.5 s ([blog](https://modal.com/blog/scaling-to-1-million-concurrent-sandboxes-in-seconds)).
  - **Kubernetes `agent-sandbox`:**
    - A warm claim takes milliseconds, but warm pools are per template, so a warm pool per project holds idle capacity for each one.
    - A cold Pod took 42–50 s at p50 on the project's own 20-node GKE test cluster ([performance tuning](https://github.com/kubernetes-sigs/agent-sandbox/blob/main/docs/performance-tuning.md)).
    - So on Kubernetes, "seconds" means warm pools for busy projects, or images pre-pulled onto the nodes.
- **This changes F-051.** For elastic pools, the cache lives with the pool, as the provider's template, snapshot or registry image. The ledger row's "cached on each runner" still describes fixed runners.

### Isolation between projects

These are recommendations for a pool that serves many projects:

1. **Never reuse a sandbox for another task.** Within one task, reuse it only through pause and resume.
2. **Require a kernel boundary.**
   - microVMs: E2B, Vercel, Cloudflare, Fly, Daytona 2.0, CubeSandbox, Kata.
   - Or gVisor: Modal's default, or `agent-sandbox` with gVisor.
   - Plain containers share the host kernel. That covers `runc`, Daytona v0's default, and the Docker provider without `runsc`. GKE's docs warn that without a sandbox runtime "your Pods run without kernel isolation" ([GKE](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/machine-learning/agent-sandbox)).
3. **The server chooses which artifact a sandbox boots.** The runner never names one, and artifacts are namespaced per project.
4. **Artifacts never hold secrets.**
   - The prepare step runs without the project's secrets, and secrets arrive by `rpc` after boot (F-050: "Nothing in a secret is shared across repos").
   - Setup scripts that need a secret, such as a private registry token, are an open problem (see Unknowns).
5. **Each sandbox gets its own egress policy.** It blocks private ranges, the cloud metadata endpoint and other sandboxes. `agent-sandbox`'s managed policy already blocks "internal RFC1918 networks and cloud metadata endpoints" ([threat model](https://github.com/kubernetes-sigs/agent-sandbox/blob/main/docs/security/threat_model.md)). F-052's per-environment rules sit on top.
6. **Fixed runners need F-017 sooner.** On a fixed remote runner, tasks from different projects share one container today (ADR 0020, line 1). Install-level runners that serve every project make F-017 (a container per task) more pressing. An elastic pool with the Docker + gVisor provider *is* F-017 on a fixed host.

---

## Hosted candidates

### E2B (e2b.dev): cloud, BYOC and self-hosted "Embed"

- **What it is:** one Firecracker microVM per sandbox, with its own kernel, 6.1 LTS ([security FAQ](https://docs.e2b.dev/faq/security-and-compliance.md)).
- **The runtime.** The infrastructure repo is now `e2b-dev/runtime`, Apache-2.0 ([LICENSE](https://raw.githubusercontent.com/e2b-dev/runtime/main/LICENSE)). Its parts ([README](https://github.com/e2b-dev/runtime)):
  - an API backed by Postgres, Redis and ClickHouse
  - an orchestrator on each node that drives Firecracker
  - a client proxy
  - `envd` inside each VM
  - a template builder
- **Self-hosting with Embed** ([embed](https://github.com/e2b-dev/runtime/tree/main/embed); confirmed 2026-11-18):
  - "E2B Embed runs the whole E2B stack, every feature included, on a single machine". It installs with Docker Compose, Terraform for GCP, AWS or Azure, or as one node in a Kubernetes cluster. It needs no account and no license key.
  - "Embed is one machine, by design. When you need more, E2B runs three other ways": its cloud, Enterprise BYOC, or a private cloud "in development" ([BYOC](https://docs.e2b.dev/byoc.md)).
  - **Host:** Linux with KVM, so bare metal or nested virtualization. Ubuntu 24.04 is recommended, with 12 GiB RAM and 20 GiB free disk ([compose README](https://raw.githubusercontent.com/e2b-dev/runtime/main/embed/compose/README.md)).
  - **Limits:** up to 200 sandboxes per node, 3 starting at once, and a hugepage pool of 8 `base` sandboxes by default. Team defaults are 10 concurrent sandboxes and a 1 h lifetime, which an operator changes by editing rows in Postgres. It serves plain HTTP, so TLS is the operator's job (same README).
  - **For ostra:** reaching 1,000 tasks would take 5 or more independent Embed nodes. ostra would spread sandboxes across them and build each project's template on every node. That's my proposal; whether templates can be shared across nodes is **unverified**.
- **Images and templates:**
  - A template starts from any registry image (`fromImage`, private registries included) or a Dockerfile (`fromDockerfile`). Multi-stage Dockerfiles are not supported ([base image](https://docs.e2b.dev/template/base-image.md)).
  - A build may take up to 1 h, 20 builds can run at once, and the number of templates is unlimited ([build limits](https://docs.e2b.dev/faq/build-limits.md)).
- **Start time:** a template is a memory snapshot and loads in about 80 ms. So there's no warm-pool feature, and none is needed ([how it works](https://docs.e2b.dev/template/how-it-works.md)).
- **Snapshots** ([snapshots](https://docs.e2b.dev/sandbox/snapshots.md)):
  - A snapshot holds the filesystem plus memory, or the filesystem alone, which reboots on resume.
  - One snapshot can start many sandboxes, and a fork starts up to 100 per request ([runtime README](https://github.com/e2b-dev/runtime)).
  - Taking a snapshot briefly pauses the sandbox and **drops every WebSocket and PTY connection.**
- **Pause and lifetime** ([persistence](https://docs.e2b.dev/sandbox/persistence.md), [lifetime FAQ](https://docs.e2b.dev/faq/sandbox-lifetime.md); confirmed 2026-11-18):
  - Pausing takes about 4 s per GiB of RAM, and resuming about 1 s.
  - Continuous runtime is capped at 1 h on Hobby and 24 h on Pro, and custom on Enterprise. "Pausing and resuming resets it". A paused sandbox "is kept indefinitely" and doesn't count toward concurrency.
  - The default timeout is 5 minutes, and the default action when it expires is to kill the sandbox. ostra must override both.
- **Resources:** Hobby allows 8 vCPU / 8 GiB / 10 GiB disk. Pro allows "8+ / 8+ / 20+ GiB" through support. There are no GPUs ([billing](https://docs.e2b.dev/billing.md), [GPU FAQ](https://docs.e2b.dev/faq/gpu-support.md)).
- **Egress** ([internet access](https://docs.e2b.dev/network/internet-access.md), [BYOP](https://docs.e2b.dev/network/byop.md), [egress IPs](https://docs.e2b.dev/faq/egress-ip-ranges.md)):
  - Open by default. `allowInternetAccess: false` blocks everything, and `allowOut` / `denyOut` take CIDRs and domains.
  - Domain rules match SNI or the Host header, on ports 443 and 80 only.
  - A SOCKS5 proxy of your own can carry all egress, and it fails closed.
  - There are **no static egress IPs on any plan.** That matters to enterprises that allowlist runner IPs for private registries.
- **Docker inside:** yes, installed in the template, with at least 2 CPU / 2 GB recommended ([Docker example](https://docs.e2b.dev/template/examples/docker.md)).
- **Long-running work:** yes, up to 24 h on Pro, and longer by pausing and resuming. SDK streams send keepalive pings and "normally stay open for more than an hour" ([lifetime FAQ](https://docs.e2b.dev/faq/sandbox-lifetime.md)).
  - The runner's own outbound WebSocket has no documented limit (**unverified**).
  - Auto-resume is triggered by an SDK call or inbound HTTP, so the ostra server resumes sandboxes through the API.
- **TypeScript SDK:** `e2b` 2.64.0, published 2026-11-13. It needs Node 22.19 or newer, ships `.d.ts` types and is async. The repo's LICENSE file says Apache-2.0, but npm lists MIT ([npm](https://registry.npmjs.org/e2b)).
- **Pricing** ([pricing](https://e2b.dev/pricing)):
  - Billed per second: $0.000014 per vCPU and $0.0000045 per GiB of RAM. Disk is free up to the plan's size.
  - Hobby is $0 with a one-time $100 credit. Pro is $150/mo. Enterprise starts at a $2,000/mo commitment.
  - **Standard workload:** 2 × $0.0504 + 4 × $0.0162 = $0.1656 per sandbox-hour, so **$16.56 an hour** for 100 sandboxes, plus Pro.
  - **Keeping a waiting sandbox alive** costs about $0.17 an hour per task at this size.
- **Concurrency** ([increase concurrency](https://docs.e2b.dev/faq/increase-concurrency.md); confirmed 2026-11-18):
  - Hobby allows 10 and Pro 100. Each add-on adds 500 slots for $500/mo, up to 1,100 on Pro. Enterprise goes higher.
  - 1,000 concurrent tasks would cost $1,150/mo in fixed fees.
- **Regions:** GCP us-west1 (the default), AWS us-west-2 and us-east-1, GCP europe-west1 and asia-southeast1. Non-default regions are switched on through support ([EU FAQ](https://docs.e2b.dev/faq/eu-region.md)). BYOC runs on AWS, GCP or Azure.
- **Rivet:** supported. Sandboxes pause by default, and reconnecting with the same `sandboxId` resumes them ([Rivet E2B](https://rivet.dev/sandbox-agent/docs/deploy/e2b.md)).
- **Backing:**
  - A $21M Series A in July 2025, led by Insight Partners ([E2B](https://e2b.dev/resources/series-a)).
  - Customers include Perplexity, Hugging Face, Groq and Manus ([Insight](https://www.insightpartners.com/ideas/e2b-raises-a-21m-series-a-to-offer-cloud-for-ai-agents-to-fortune-100)).
  - About 14.9k stars on `e2b-dev/E2B` and 1.9k on `e2b-dev/runtime` (repo pages). SOC 2 Type II.
- **Fit for ostra:**
  - **Strongest:** per-project templates, pause for long waits, and one API across cloud, BYOC, Embed and CubeSandbox (see below).
  - **Weakest:** the 24 h cap, dropped connections on pause and snapshot, and no static egress IPs.

### Vercel Sandbox

- **Runs where:** hosted only. The SDK works from anywhere with an access token or OIDC ([docs](https://vercel.com/docs/vercel-sandbox)).
  - The SDK and CLI were open-sourced at GA on 2026-01-30 ([blog](https://vercel.com/blog/vercel-sandbox-is-now-generally-available)).
  - `@vercel/sandbox` 4.0.0, Apache-2.0, was published 2026-11-12. It has had 123 versions since 2025-05, and v2 changed the IDs from `sandboxId` to `name` ([persistent sandboxes](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes)). It's well built, but it moves fast.
- **Isolation:** a Firecracker microVM with its own kernel ([security](https://vercel.com/docs/sandbox/concepts/security)).
- **Images:**
  - OCI images must sit in **Vercel Container Registry** and be `linux/amd64`.
  - `ENTRYPOINT` and `CMD` don't run; processes start through `runCommand()` ([images](https://vercel.com/docs/sandbox/concepts/images)).
  - So every install pushes ostra's runner image into its own Vercel registry.
- **Snapshots** ([snapshots](https://vercel.com/docs/sandbox/concepts/snapshots), [changelog](https://vercel.com/changelog/vercel-sandbox-snapshot-creation-is-now-up-to-10x-faster)):
  - Filesystem only, with no memory snapshot.
  - Any number of sandboxes can be created from one snapshot, or made with `Sandbox.fork()`.
  - Restore takes 250 ms at p50, and creating a snapshot takes under 0.4 s at the median.
  - Snapshots are tied to one region and expire 30 days after their last use by default.
- **Lifetime** ([pricing and limits](https://vercel.com/docs/vercel-sandbox/pricing); confirmed 2026-11-18):
  - The filesystem persists across a stop, but processes don't.
  - A session lasts at most 24 h on Pro and Enterprise, or 45 min on Hobby. "The limit resets every time a sandbox stops and resumes".
  - The default timeout is 5 minutes; `extendTimeout()` lengthens it.
- **Resources:** Pro allows up to 8 vCPU and 16 GB, Enterprise up to 32 vCPU and 64 GB. Memory is fixed at 2 GB per vCPU, and every sandbox gets 64 GB of NVMe. No GPUs.
- **Egress** ([firewall](https://vercel.com/docs/sandbox/concepts/firewall)):
  - Allow-all, deny-all, or allowlists by domain (matched on SNI) or CIDR, which can be changed while the sandbox runs.
  - The firewall can inject credentials into request headers, forward requests to your own proxy with an OIDC token, or answer requests itself. That overlaps Q17 (`research/credential-proxy.md`).
  - A long-lived outbound WSS connection to an allowlisted host should pass, since the match is on SNI, but that isn't stated (**unverified**).
- **Docker inside:** yes, through `sudo` (security page).
- **Pricing** (Pro; rates from [pricing](https://vercel.com/docs/vercel-sandbox/pricing)):
  - In iad1: Active CPU at $0.128 per vCPU-hour, with I/O wait not billed. Provisioned memory at $0.0212 per GB-hour.
  - In fra1: $0.184 and $0.0304.
  - The Pro plan is $20/mo, plus $20 per extra deploying seat ([Pro plan](https://vercel.com/docs/plans/pro-plan)).
  - **Standard workload, iad1:** memory $8.48, plus CPU from $5.12 (20% busy) to $25.60 (100% busy), so **$13.60–34.08 an hour.** In fra1, $19.52–48.96.
  - Coding agents spend much of their time waiting on the model, so Active CPU billing favours them.
- **Concurrency:** 10,000 on Pro. vCPU allocation starts at 150 a minute and ramps by 500 a minute up to 5,000 a minute. Deletes are limited to 20 a second per team (pricing page).
- **Regions:** 19, including arn1, cdg1, dub1, fra1 and lhr1 ([regions](https://vercel.com/docs/sandbox/concepts/regions)). For data residency, the docs say to "consult your plan details".
- **Rivet:** supported ([Rivet Vercel](https://rivet.dev/sandbox-agent/docs/deploy/vercel)).
- **Fit for ostra:** the best hosted alternative to E2B. It has the highest concurrency, cheap billing for idle CPU, and a credential-injecting firewall. Against it: it can't be self-hosted, images must live in Vercel's registry, snapshots stay in one region, and sessions stop at 24 h.

### Modal

- **Runs where:** hosted only. I found no self-hosted or BYOC offer; Enterprise can buy through the AWS and GCP marketplaces ([pricing](https://modal.com/pricing)).
- **License:** the client (`modal-labs/modal-client`) is Apache-2.0; the backend is proprietary.
- **Isolation:** gVisor by default, or `runtime="vm"` with its own kernel; the hypervisor isn't named (**unverified**) ([sandboxes](https://modal.com/docs/guide/sandboxes.md)).
- **Images:** any registry image, plus Dockerfile commands. Whether the JS SDK has `fromDockerfile` is **unverified**.
- **Start time:** a median cold start under 0.5 s ([blog](https://modal.com/blog/scaling-to-1-million-concurrent-sandboxes-in-seconds)). Warm pools are a pattern you build yourself ([example](https://modal.com/docs/examples/sandbox_pool.md)).
- **Snapshots** ([snapshots](https://modal.com/docs/guide/sandbox-snapshots.md)):
  - Filesystem snapshots become images that many sandboxes can start from. They expire after 30 days by default, which can be made indefinite.
  - Memory snapshots are alpha. Taking one ends the sandbox and closes TCP connections, and the snapshot expires after 7 days.
- **Lifetime:** no pause. 5 minutes by default, **24 h at most**; past that, Modal says to snapshot and start a new sandbox.
- **Resources:** billed at the greater of what you request and what you use, with bursting. The disk quota is 512 GiB. GPUs are available. The largest CPU and memory per sandbox is **unverified** ([resources](https://modal.com/docs/guide/sandbox-resources.md)).
- **Egress** ([networking](https://modal.com/docs/guide/sandbox-networking.md)):
  - Open by default. `block_network` blocks everything, and there's a CIDR allowlist.
  - A domain allowlist is in beta and covers TLS on port 443 only.
  - DNS isn't restricted unless everything is blocked.
  - A static-IP proxy is available on Team and Enterprise, in beta ([proxies](https://modal.com/docs/guide/proxy-ips.md)).
- **Docker inside:** on the VM runtime only.
- **TypeScript SDK:** `modal` 0.11.2, published 2026-11-17, Node 22 or newer, with types. It's labelled **Beta**, "approaching feature parity" with Python ([JS and Go SDKs](https://modal.com/docs/guide/sdk-javascript-go.md)).
- **Pricing** ([pricing](https://modal.com/pricing)):
  - Sandboxes are billed at the non-preemptible rate: $0.00003942 per core-second (1 core is 2 vCPU) and $0.00000667 per GiB-second.
  - **Standard workload:** $0.23796 per sandbox-hour, so **$23.80 an hour**; $27.37 when pinned to `eu`.
- **Concurrency:** Starter allows 100 containers and Team 5,000. Whether sandboxes count against that container limit is **unverified**.
- **Regions:** us, eu, uk, ap and others. Lifecycle calls still go through the control plane in us-east ([data residency](https://modal.com/docs/guide/data-residency.md)).
- **Rivet:** supported, with gVisor by default ([Rivet Modal](https://rivet.dev/sandbox-agent/docs/deploy/modal.md)).
- **Backing:** a $355M Series C on 2026-05-21 ([blog](https://modal.com/blog/modal-series-c)), then a $750M Series D, with about $1B in annualized revenue ([blog](https://modal.com/blog/1-billion-annualized-run-rate-series-d)).
- **Fit for ostra:** strong infrastructure and backing. Against it: no pause, a 24 h cap, a beta TS SDK and a higher price.

### Daytona: hosted, and the self-hosted version

- **No longer open source.** On 2026-06-11 Daytona moved its production code to a private repo. The public repo "will stay public… We will no longer maintain or update it" ([announcement](https://www.daytona.io/dotfiles/updates/daytona-is-going-closed-source); confirmed 2026-11-18).
  - The last public release is v0.190.0 (2026-06-23, AGPL-3.0), and the repo was archived on 2026-10-03 ([repo](https://github.com/daytonaio/daytona)).
  - The SDKs live on in `daytona/clients`, Apache-2.0 except `cli/`, which is AGPL-3.0 ([LICENSE](https://raw.githubusercontent.com/daytona/clients/main/LICENSE)).
- **Self-hosting is not a real option.**
  - The archived Compose stack runs eleven services: an API, a proxy, a privileged runner, an SSH gateway, Dex, Postgres, Redis, a registry, MinIO, Jaeger and an OpenTelemetry collector.
  - Its README says it is "not safe to use in production" ([docker README](https://raw.githubusercontent.com/daytonaio/daytona/v0.190.0/docker/README.md)).
  - v0's BYOC puts your runner nodes in a "custom region", but Daytona's cloud control plane still runs them ([v0 BYOC](https://www.daytona.io/docs/en/bring-your-own-compute.md)).
  - 2.0's BYOC is Enterprise only, and runs Firecracker VMs in your Kubernetes cluster on KVM nodes ([2.0 BYOC](https://www.daytona.com/docs/bring-your-own-compute.md)).
- **Two platforms side by side:** the original "v0" at daytona.io and "2.0" at daytona.com.
  - **v0:**
    - Linux containers by default, with optional VMs. Snapshots are images built from a registry image or a Dockerfile.
    - Containers start in "under 90ms" ([llms.txt](https://www.daytona.io/docs/llms.txt)). Warm pools must be switched on by support ([warm pools](https://www.daytona.io/docs/en/warm-pools.md)).
    - Auto-stop defaults to 15 minutes and counts only SDK calls as activity, so ostra would set it to `0` ([v0 sandboxes](https://www.daytona.io/docs/en/sandboxes.md)).
    - Each sandbox gets 4 vCPU / 8 GiB / 10 GiB by default.
  - **2.0:**
    - Every Linux sandbox is a Firecracker microVM. Filesystem snapshots become images, and memory snapshots restore only on the same CPU model.
    - **There's no stop, start or pause; sandboxes can only be deleted.** Sessions last 24 h on Starter and 48 h on Team ([2.0 sandboxes](https://www.daytona.com/docs/sandboxes.md), [2.0 pricing](https://www.daytona.com/pricing.md)).
- **Egress:**
  - On v0, organizations on tiers 1 and 2 reach only an "essential services" allowlist, so **ostra's own server would be blocked** until Tier 3, which takes a $500 top-up ([v0 network](https://www.daytona.io/docs/en/network-limits.md)). Rivet's guide gives the same warning ([Rivet Daytona](https://rivet.dev/sandbox-agent/docs/deploy/daytona.md)).
  - 2.0 is open by default and offers block-all plus allowlists ([2.0 network](https://www.daytona.com/docs/network-limits.md)).
- **Docker inside:** yes on both platforms.
- **TypeScript SDK:** `@daytona/sdk` 0.232.0 is the v0 SDK, published 2026-11-16. 2.0 is `2.0.0-alpha.13`. The older `@daytonaio/sdk` is deprecated, but Rivet's Daytona provider still lists it as a peer dependency (npm `sandbox-agent` 0.5.6).
- **Pricing and concurrency:**
  - **v0:** $0.0504 per vCPU-hour and $0.0162 per GiB-hour, with storage past 5 GiB at $0.000108 per GiB-hour. **Standard workload: $16.72 an hour**, which needs Tier 3: 200 vCPU, exactly this workload ([limits](https://www.daytona.io/docs/en/limits.md)).
  - **2.0:** **$16.58 an hour.** Starter allows 100 sandboxes, Team ($250/mo) 5,000.
- **Regions:** v0 has US and EU. 2.0 lists only US regions ([2.0 regions](https://www.daytona.com/docs/regions.md)).
- **Backing:** a $60M Series B on 2026-10-20 at a $1B valuation, $91M raised in total ([Daytona](https://www.daytona.io/dotfiles/daytona-raises-60m-series-b-to-build-the-agent-cloud)).
- **Fit for ostra:** well funded, but the platform split, the alpha 2.0 SDK, egress gated by tier on v0 and the closed source make it a later adapter at best. **Daytona self-hosted should not be recommended.**

### Cloudflare Containers and the Sandbox SDK

- **Runs where:** hosted only, and it needs Workers Paid ([Sandbox](https://developers.cloudflare.com/sandbox/)).
  - Each install would deploy a Worker and a Durable Object class into its own Cloudflare account, and ostra would call that Worker over HTTP.
  - I found no REST API that creates containers directly (**unverified** that none exists).
- **Isolation:** "Each container instance runs in a Firecracker microVM" ([architecture](https://developers.cloudflare.com/containers/platform-details/architecture)).
  - A cross-tenant disk-residue bug was fixed and disclosed ([blog](https://blog.cloudflare.com/containers-cross-tenant-vulnerability)).
- **Images:** pushed to Cloudflare Registry, at most 20 GB, with 50 GB of image storage per account ([limits](https://developers.cloudflare.com/containers/platform-details/limits/)).
- **Start time:** a median of 648 ms and p99 of 1,129 ms in a 100-start benchmark ([blog](https://blog.cloudflare.com/faster-agent-sandboxes), 2026-09-30).
- **Snapshots:** in public beta. They hold the root filesystem only, up to 20 GB, are kept 30 days, and many containers can start from one ([lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/)).
- **Lifetime, the deciding gotcha** (same page):
  - An instance runs only while its Durable Object is active. "Code that runs inside the instance does not count as activity."
  - `setInactivityTimeout()` keeps it up for at most 6 h after that, and "Cloudflare does not guarantee that an instance runs for a set time."
  - So a runner waiting hours for an approval would need Durable Object alarms or traffic routed through the Durable Object. That's a design consequence, and **unverified** in practice.
- **Resources:** up to 4 vCPU, 12 GiB and 20 GB per instance. No GPUs.
- **Egress** ([outbound traffic](https://developers.cloudflare.com/containers/configuration/outbound-traffic/)):
  - `enableInternet: false`, plus per-host HTTP or HTTPS intercepts that terminate TLS and can inject credentials.
  - Traffic other than HTTP or HTTPS is denied when internet access is off.
- **Docker inside:** `docker:dind` with `--iptables=false` ([FAQ](https://developers.cloudflare.com/containers/faq)).
- **TypeScript SDK:** `@cloudflare/sandbox` 1.0.3, published 2026-10-22, with 298 versions. The legacy classes are maintained only until 2026-12-31. Rivet's guide still calls the SDK "beta" ([Rivet Cloudflare](https://rivet.dev/sandbox-agent/docs/deploy/cloudflare)).
- **Pricing** ([pricing](https://developers.cloudflare.com/containers/pricing/)):
  - Memory at $0.0000025 per GiB-second and disk at $0.00000007 per GB-second, both on what's provisioned. CPU at $0.000020 per vCPU-second, on active use.
  - **Standard workload: $6.98–18.50 an hour**, plus about $0.58 of Durable Object time.
- **Concurrency:** 15,000 vCPU per account by default.
- **Regions:** placement by region, and `jurisdiction: "eu"` ([placement](https://developers.cloudflare.com/containers/platform-details/placement)).
- **Status:** GA on 2026-04-13 ([changelog](https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga)). Snapshots and the `durable_object` scheduling policy are still in beta.
- **Fit for ostra:** poor. Its lifetime model fights hours-long sessions, and it needs a Worker deployed in each install's own account.

### Northflank (Sandboxes, Cloud Harness, BYOC)

- **Runs where:** Northflank's cloud, or BYOC, where the data plane runs in your AWS, GCP, Azure, Oracle or other cloud account and Northflank keeps the control plane ([vs Daytona](https://northflank.com/blog/northflank-vs-daytona)).
  - BYOC still costs $0.02083 per managed-node vCPU-hour ([pricing](https://northflank.com/pricing)), so it doesn't meet the "no paid vendor" goal.
- **Isolation:** "microVMs for CPU workloads and gVisor for GPU workloads" ([sandboxes](https://northflank.com/docs/v1/application/sandboxes)). It is mostly Kata with Cloud Hypervisor ([blog](https://northflank.com/blog/what-is-container-isolation)).
- **Images and start time:** any container image. Boots "in under a second", not counting the image pull.
- **No snapshots.** Environments are reused through images and volumes only ([blog](https://northflank.com/blog/modal-vs-railway-sandboxes)).
- **Pause:** pausing scales the sandbox to zero and ends its processes. There's no cap on lifetime ([configure](https://northflank.com/docs/v1/application/sandboxes/configure-and-manage-sandboxes)).
- **Resources:** the default quota per instance is 8 vCPU, 16 GiB and **2 GiB of ephemeral disk**. GPUs are available ([quotas](https://northflank.com/docs/v1/application/billing/resource-plans-and-quotas)).
- **Egress:** policies with FQDN and CIDR allowlists are documented "on your BYOC cluster" only ([network policies](https://northflank.com/docs/v1/application/network/configure-network-policies)).
- **TypeScript SDK:** `@northflank/js-client` 0.12.0, MIT. It's a general API client, and commands run through `exec` ([execute](https://northflank.com/docs/v1/api/execute-command)).
- **Pricing:** $0.01667 per vCPU-hour and $0.00833 per GB-hour, wall-clock. **Standard workload: $6.67–6.99 an hour**, the cheapest hosted figure here.
- **Concurrency:** 500 services by default, raised through support.
- **Regions:** EU regions in London, the Netherlands, Frankfurt and Zurich ([regions](https://northflank.com/docs/v1/application/run/deploy-to-a-region)).
- **Rivet:** not supported.
- **Backing:** $22M raised in 2024 ([blog](https://northflank.com/blog/northflank-raises-22m-to-make-kubernetes-work-for-your-developers-ship-workloads-not-infrastructure)).
- **Cloud Harness:** an interactive coding-workspace product ([quickstart](https://northflank.com/docs/v1/application/cloud-harness/quickstart)). It overlaps ostra rather than serving as a runner API.
- **Fit for ostra:** cheap and stable. Against it: no snapshots, egress policy apparently on BYOC only, and a small default disk.

### Fly Machines and Fly Sprites

**Fly Machines:**
- **Isolation:** Firecracker. "Suspend uses Firecracker snapshots" ([suspend](https://docs.fly.io/reference/suspend-resume/)).
- **Images:** any OCI image.
- **Start time:** subsecond starts and stops ([Machines](https://docs.fly.io/machines)).
- **Snapshots:** only volumes have them ([volumes](https://docs.fly.io/volumes/overview)). Suspend is advised for 2 GB of RAM or less, and its snapshots "aren't guaranteed to persist".
- **GPUs** were deprecated as of 2026-07-31 ([community](https://community.fly.io/t/gpu-migration-fly-io-gpus-will-be-deprecated-as-of-july-31-2026/27110)).
- **Egress:** network policies filter by port and protocol only, with no domain allowlist ([network policies](https://docs.fly.io/machines/guides-examples/network-policies)).
- **TypeScript:** there's no official SDK. The API allows 1 request a second per action, with bursts of 3 ([Machines API](https://fly.io/docs/machines/api/working-with-machines-api)).
- **Pricing:** **~$9.59 an hour** in iad for the standard workload ([pricing](https://docs.fly.io/about/pricing)).
- **Rivet:** not supported.

**Fly Sprites:**
- **What it is:** Firecracker, built on Machines ([design](https://fly.io/blog/design-and-implementation)).
- **Images:** **no custom images.** Every Sprite boots one Ubuntu image ([community](https://community.fly.io/t/sprites-base-image/26789)).
- **Pause:** a Sprite auto-pauses after about 30 s idle, and "Open TCP connections drop on any pause" ([lifecycle](https://docs.fly.io/sprites/concepts/lifecycle)).
- **Forks:** forking from another Sprite takes about 90 s ([release notes](https://fly.io/sprites/release-notes)).
- **TypeScript SDK:** `@fly/sprites` 0.2.4.
- **Pricing:** **$11.66–17.82 an hour** for the standard workload ([pricing](https://sprites.dev/pricing)).
- **Rivet:** supported.

**Fit for ostra:** Machines lack a TS SDK, rootfs snapshots and domain egress rules. Sprites can't take ostra's runner image or a per-project image. Neither fits.

### Runloop (shutting down)

- **Status:** "Runloop is winding down its services. Support for existing customers continues through November 13, 2026" ([transitions](https://docs.runloop.ai/docs/transitions/overview); confirmed 2026-11-18). Its migration guides point to Tensorlake, Modal and Freestyle.
- **Its model is still worth borrowing:**
  - Blueprints built from a Dockerfile ([blueprints](https://docs.runloop.ai/docs/devboxes/blueprints/overview)).
  - Disk snapshots that fan out into several devboxes ([snapshots](https://docs.runloop.ai/docs/devboxes/snapshots)).
  - Suspend and resume built for "wait for PR feedback" workflows ([tutorial](https://docs.runloop.ai/docs/tutorials/running-agents-on-sandboxes/suspend-resume-workflow)).
- **Fit for ostra:** don't build an adapter.

### Other hosted providers (shorter)

- **Blaxel** (now part of Baseten):
  - **Isolation and BYOC:** lightweight VMs, plus "bring-your-own-metal" BYOC with Blaxel's control plane ([docs](https://docs.blaxel.ai/Sandboxes/Overview), [pricing](https://blaxel.ai/pricing)).
  - **Standby:** a sandbox goes to standby about 15 s after its last "active connection" and resumes in under 25 ms with its processes. WebSockets time out after 15 minutes idle unless they ping.
  - **Disk:** about half of memory backs an in-memory filesystem, so a big repo needs volumes.
  - **Pricing and concurrency:** $0.0000115 per GB-second with CPU included, so **$16.56 an hour** for the standard workload. Concurrency goes by tier.
  - **Regions:** include eu-lon-1 and eu-fra-1 ([regions](https://docs.blaxel.ai/Infrastructure/Regions)).
  - **TypeScript and Rivet:** `@blaxel/core` 0.3.40. Rivet reaches it through ComputeSDK.
- **Tensorlake:**
  - **BYOC:** "a data plane binary" runs on your own compute. "Control signals are outbound only", for a fee of 30% of compute, falling to 10% at scale ([BYOC](https://www.tensorlake.ai/blog/introducing-tensorlake-byoc)).
  - **Isolation and images:** Firecracker or Cloud Hypervisor, and any OCI image.
  - **Snapshots:** hold the "filesystem, memory, and running processes" and restore into new sandboxes ([lifecycle](https://docs.tensorlake.ai/sandboxes/lifecycle)).
  - **Idle:** counts proxied traffic, SSH and SDK calls.
  - **Lifetime and concurrency:** unlimited lifetime on Pro, which allows 1,000 concurrent sandboxes.
  - **Pricing:** **$9.20–20.40 an hour** for the standard workload ([pricing](https://www.tensorlake.ai/pricing)).
  - **Regions and TypeScript:** EU data residency. `@tensorlakeai/tensorlake` 0.5.165 is still before 1.0.
- **Freestyle:**
  - **Isolation:** full VMs with nested virtualization ([YC](https://www.ycombinator.com/companies/freestyle)).
  - **Images:** no Dockerfile base. You boot a base snapshot and set it up, or run your image *inside* the VM ([llms-full](https://www.freestyle.sh/docs/llms-full.txt)).
  - **Snapshots:** memory and disk, with "sub 50ms to snapshot ready".
  - **Egress:** denied by default ([VMs](https://www.freestyle.sh/docs/vms)).
  - **Pricing and concurrency:** **$13.40 an hour** for the standard workload. Pro costs $500/mo and allows 400 concurrent VMs ([pricing](https://www.freestyle.sh/pricing)).
  - **TypeScript:** `freestyle` 0.2.23.
- **Beam / beta9:**
  - **Self-hosting:** the runtime is open source, AGPL-3.0 ([repo](https://github.com/beam-cloud/beta9)), and self-hosts with Helm.
  - **Isolation:** gVisor by default, with an optional microVM.
  - **Snapshots and Docker:** memory and filesystem snapshots fork into many sandboxes, and Docker and Compose run inside ([docs](https://docs.beam.cloud/v2/sandbox/overview)).
  - **Pricing:** **$14.00 an hour** for the standard workload on the Performance tier ([pricing](https://www.beam.cloud/pricing)).
  - **TypeScript:** `@beamcloud/beam-js` 1.1.6.
  - Its AGPL license and Python-first tooling make it a weak self-hosted base for ostra.
- **AWS Bedrock AgentCore Runtime:**
  - **Isolation:** a microVM per session.
  - **Images:** must be `linux/arm64` and expose `/invocations` and `/ping` on port 8080 ([custom](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/getting-started-custom.html)).
  - **Lifetime:** **sessions are capped at 8 h.** The idle timeout resets only on *invocations* ([lifecycle](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-lifecycle-settings.html)).
  - **Storage:** persistent storage is capped at 1 GB.
  - **Pricing and concurrency:** **$9.31–32.28 an hour** for the standard workload ([pricing](https://aws.amazon.com/bedrock/agentcore/pricing/)). Up to 5,000 sessions in us-east-1.
  - It doesn't fit long sessions.
- **Namespace:** traction with Claude Managed Agents and Devin ([integration](https://namespace.so/docs/integrations/claude)). Not self-hostable, with a 24 h cap and about $18 an hour for the standard workload ([pricing](https://namespace.so/pricing)).
- **Skipped**, each with a one-line reason:
  - **Morph Cloud:** its TS SDK was last published 2025-10-06.
  - **CodeSandbox SDK:** replaced by Together's allowlist-only sandbox ([changelog](https://docs.together.ai/docs/changelog)).
  - **Koyeb:** hosted only.
  - **Unikraft Cloud:** hosted only; whether it runs on-premises is **unverified**.
  - **Hopx:** its SDK was last published 2026-01.
  - **Azure dynamic sessions:** destroyed when idle ([Microsoft](https://learn.microsoft.com/en-us/azure/container-apps/sessions-custom-container)).
  - **Depot:** a managed-agents product, not a sandbox API.
  - **Superserve:** only its SDK is public.
  - **boxd and Tenki:** young.
  - **Sandbox0:** archived.
  - **Agent37, CreateOS and Arker:** not confirmed as sandbox providers.

---

## Self-hosted candidates

### Kubernetes `agent-sandbox` (kubernetes-sigs), with gVisor or Kata

- **What it is:** a controller and four CRDs: `Sandbox`, `SandboxTemplate`, `SandboxClaim` and `SandboxWarmPool`. It's a "sandbox orchestrator" that leaves isolation to a RuntimeClass ([README](https://github.com/kubernetes-sigs/agent-sandbox), [docs](https://agent-sandbox.sigs.k8s.io/docs)).
- **Status:**
  - Apache-2.0, under SIG Apps. About 4.6k stars and 186 contributors.
  - v1.0.11 released 2026-11-12. The last 20 commits span 2026-11-12 to 11-17.
  - `v1beta1` is the only API version served ([roadmap](https://github.com/kubernetes-sigs/agent-sandbox/blob/main/roadmap.md)).
- **How heavy:**
  - One `kubectl apply` installs the controller, on Kubernetes 1.29 or newer (recommended).
  - The optional Sandbox Router isn't needed, because ostra's runner dials out. That's just as well: the router's default authorizer is `AllowAll` ([threat model](https://github.com/kubernetes-sigs/agent-sandbox/blob/main/docs/security/threat_model.md)).
  - Kubernetes itself is the heavy part for small installs.
- **Isolation:**
  - gVisor needs no KVM, so it runs on any managed Kubernetes or cloud VM.
  - Kata needs nodes with nested virtualization or bare metal ([Kata guide](https://agent-sandbox.sigs.k8s.io/docs/use-cases/kata-containers-isolation/)).
  - Without a RuntimeClass, pods are plain containers.
  - A real small deployment exists: netclode runs it on a VPS with k3s, Kata and Cloud Hypervisor, a warm pool, and Claude Code inside ([netclode](https://github.com/angristan/netclode)).
- **Warm pools** ([performance tuning](https://github.com/kubernetes-sigs/agent-sandbox/blob/main/docs/performance-tuning.md), [configuration](https://github.com/kubernetes-sigs/agent-sandbox/blob/main/docs/configuration.md)):
  - Bursts reach "~300 claims/s per cluster at p90 ≤ 200 ms", and refills sustain about 70–85 sandboxes a second per pool.
  - A cold Pod took 42–50 s at p50 on the project's 20-node test cluster.
  - Pools should be sharded above about 500–1,000 replicas.
- **The gotcha for ostra:** "Options that need Pod changes, such as `env` and `volumeClaimTemplates`, force a cold start" ([TS client README](https://github.com/kubernetes-sigs/agent-sandbox/blob/main/clients/typescript/agentic-sandbox-client/README.md)).
  - So a runner in a warm pod must boot generic, dial ostra, and get its task and registration token *after* the claim.
  - ostra's outbound design suits that; how the token gets delivered needs a spike.
- **Snapshots:**
  - Memory and filesystem snapshots are **GKE only**. They use GKE Pod Snapshots, need gVisor, and the client is "Python-only for now" ([snapshots](https://agent-sandbox.sigs.k8s.io/docs/sandbox/snapshots/)).
  - On other Kubernetes, suspend keeps the PVC, which preserves the filesystem only (roadmap).
  - A per-project prepared checkout is therefore a per-project image, or a PVC cloned from a CSI VolumeSnapshot ([Kubernetes](https://kubernetes.io/docs/concepts/storage/volume-snapshots/)). Whether `agent-sandbox` integrates with VolumeSnapshots is **unverified**.
- **Lifetime:** no cap. `shutdownAfterSeconds` sets an expiry.
- **Egress:**
  - The managed NetworkPolicy allows ingress only from the router, and egress only to the public internet, blocking private ranges and cloud metadata (threat model).
  - NetworkPolicy works at L3 and L4 ([Kubernetes](https://kubernetes.io/docs/concepts/services-networking/network-policies/)). FQDN allowlists for F-052 need a CNI like Cilium (`toFQDNs`, [Cilium](https://docs.cilium.io/en/latest/security/dns)).
  - L7 and FQDN policies attached at claim time are only planned (roadmap).
- **Docker inside:** under gVisor, through a documented setup ([gVisor](https://gvisor.dev/docs/tutorials/docker-in-gke-sandbox)). Under Kata too, as netclode does.
- **TypeScript:**
  - The in-repo client is "not currently distributed in any form — there is no npm package" ([TS client](https://agent-sandbox.sigs.k8s.io/docs/typescript-client/); confirmed 2026-11-18).
  - The planned npm scope was taken by an unrelated project ([issue #977](https://github.com/kubernetes-sigs/agent-sandbox/issues/977)).
  - ostra would create `SandboxClaim` objects through `@kubernetes/client-node` 2.0.2 (Apache-2.0) and validate them with its own Zod schemas.
- **GKE:** offers this controller as a managed add-on "at no extra charge" ([GKE install](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/how-install-agent-sandbox), [GCP blog](https://cloud.google.com/blog/products/containers-kubernetes/bringing-you-agent-sandbox-on-gke-and-agent-substrate)).
- **Cost and density:** your own nodes.
  - My estimate, not sourced: memory dominates. 1,000 tasks at 2–4 GiB each need about 2–4 TiB of RAM, or 8–16 nodes of 256 GiB.
  - CPU can be overcommitted, since agents mostly wait on the model, but builds and tests come in bursts.
- **Rivet:** not supported. ostra would bake its runner, plus Sandbox Agent if Q11 adopts it, into the image.
- **Fit for ostra:** the self-hosted path that scales to 1,000 tasks with no vendor. Per-project isolation maps onto namespaces, quotas and policies. Against it: Kubernetes itself, snapshots that need GKE, and an unpublished TS client.

### gVisor, Kata and Firecracker as runtimes

- **gVisor (`runsc`):**
  - Apache-2.0, about 20k stars, released 2026-11-17.
  - Its default `systrap` platform suits running "inside a VM, or on a machine without virtualization support" ([platforms](https://gvisor.dev/docs/architecture_guide/platforms/)). So it runs on any cloud VM, including Hetzner Cloud and EC2 without nested virtualization.
  - `runsc checkpoint` and `restore` save memory ([checkpoint](https://gvisor.dev/docs/user_guide/checkpoint_restore/)).
  - Docker can run inside it ([Docker in gVisor](https://gvisor.dev/docs/tutorials/docker-in-gvisor)).
  - Rootless Docker with gVisor is fragile ([issue #12575](https://github.com/google/gvisor/issues/12575)).
- **Kata Containers:**
  - Apache-2.0, released 2026-11-17 (4.4.0).
  - A VM per pod, on QEMU, Cloud Hypervisor, Firecracker or others; GPUs only with QEMU ([hypervisors](https://github.com/kata-containers/kata-containers/blob/main/docs/hypervisors.md)).
  - It doesn't support checkpoint and restore ([limitations](https://github.com/kata-containers/kata-containers/blob/main/docs/Limitations.md)). It needs KVM.
- **Hosts for KVM:**
  - EC2 added nested virtualization on C8i, M8i and R8i instances in February 2026 ([AWS](https://aws.amazon.com/about-aws/whats-new/2026/02/amazon-ec2-nested-virtualization-on-virtual)).
  - Hetzner Cloud doesn't offer it ("No, this is not possible on cloud server", [Hetzner](https://docs.hetzner.com/cloud/servers/faq)); its dedicated servers are the option there.
- **Firecracker on its own:**
  - Apache-2.0, v1.18.0.
  - Boots in 125 ms or less, with at most 5 MiB of VMM overhead ([spec](https://github.com/firecracker-microvm/firecracker/blob/main/SPECIFICATION.md)).
  - It has no OCI support and no networking or scheduling, and its containerd shim and Go SDK were **deprecated on 2026-11-10** ([firecracker-containerd](https://github.com/firecracker-microvm/firecracker-containerd), [Go SDK](https://github.com/firecracker-microvm/firecracker-go-sdk)).
  - Use it only through a higher layer.

### CubeSandbox (TencentCloud/CubeSandbox)

- **Status:** Apache-2.0, about 13.3k stars, v0.8.0 released 2026-11-13. Its first open-source release came in 2026.
- **What it is:** its own RustVMM/KVM microVM. "Compatible with E2B SDK… changing one environment variable" ([repo](https://github.com/TencentCloud/CubeSandbox)).
- **Claims, from the vendor:** cold starts under 60 ms on bare metal, under 5 MB of overhead per sandbox, and "thousands of instances per server" (**unverified**).
- **Features:**
  - eBPF egress filtering, and an L7 proxy with rules per domain and path plus credential injection.
  - Templates built from OCI images, each holding a memory snapshot taken once a readiness probe passes ([templates](https://github.com/TencentCloud/CubeSandbox/blob/master/docs/guide/templates.md)).
  - Auto pause and resume, and an idle timeout that can be "never" ([v0.5.1](https://github.com/TencentCloud/CubeSandbox/blob/master/docs/changelog/v0.5.1.md)).
  - Pause, resume and snapshot boot across nodes, through S3 or JuiceFS, in preview.
- **Hosts:**
  - Single node or several. Kubernetes deployment is in preview.
  - **PVM** runs it on cloud servers without `/dev/kvm`, but only on x86, with a custom host kernel ([PVM](https://github.com/TencentCloud/CubeSandbox/blob/master/docs/guide/pvm-deploy.md)).
  - It needs XFS and at least 50 GB ([quickstart](https://github.com/TencentCloud/CubeSandbox/blob/master/docs/guide/quickstart.md)).
- **Open bugs:** networking after a restore, and copying templates to new nodes ([issues](https://github.com/TencentCloud/CubeSandbox/issues?q=is%3Aissue+snapshot+node)).
- **Fit for ostra:** if its E2B compatibility holds, ostra's E2B adapter would drive it unchanged. That would give self-hosters microVM templates across several nodes. It's worth a spike, not a default.

### OpenSandbox (opensandbox-group/OpenSandbox)

- **Status:** Apache-2.0, of Alibaba origin, an AAIF/LF project. About 17.5k stars; 1.3.0-rc.1 released 2026-11-16.
- **Architecture:** a Python FastAPI server, running sandboxes on Docker (one host) or Kubernetes. On Kubernetes it can use BatchSandbox or `agent-sandbox` ([configuration](https://github.com/opensandbox-group/OpenSandbox/blob/main/server/configuration.md)).
- **Isolation runtimes:** runc, gVisor, Kata, or Firecracker. One runtime per server process, and Firecracker runs on Kubernetes only, through Kata ([secure container](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/guides/secure-container.md)).
- **Egress:** a per-sandbox FQDN egress sidecar that fails closed, but "does not work" under gVisor ([egress](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/architecture/network/egress.md)).
- **Credentials:** a Credential Vault keeps real credentials out of sandboxes.
- **Lifecycle:** pause, resume, snapshot, fork and restore.
- **TypeScript:** `@alibaba-group/opensandbox` 1.2.1.
- **Unverified:** lifetime caps and fan-out from one snapshot.
- **Fit for ostra:** could save ostra building its own egress and credential layer on top of Docker or `agent-sandbox`. Against it: another server process to run (Python) beside ostra's TypeScript stack, and egress that clashes with gVisor.

### microsandbox and BoxLite

- **microsandbox** (`superradcompany/microsandbox`; Apache-2.0, about 9.1k stars, v0.7.15 released 2026-11-12):
  - **What it is:** a library and CLI that boots libkrun microVMs as child processes, with "No setup server. No long-running daemon" ([README](https://github.com/superradcompany/microsandbox)).
  - **Hosts:** Linux needs KVM; inside a cloud VM, nested virtualization ([troubleshooting](https://docs.microsandbox.dev/troubleshooting/linux.md)).
  - **Snapshots:** disk and full snapshots, forks, and many children restored from one snapshot, all on one host ([snapshots](https://docs.microsandbox.dev/sandboxes/snapshots)).
  - **Egress:** rules that deny by default, and secrets injected from the host ([networking](https://docs.microsandbox.dev/networking/overview.md)).
  - **Maturity:** still "beta software. Expect breaking changes."
  - **Hosted option:** its cloud is in private beta.
  - ostra would have to build the scheduler across hosts itself.
- **BoxLite** (`boxlite-ai/boxlite`; Apache-2.0, about 2.7k stars, v0.13.1):
  - An embeddable KVM/HVF microVM with an optional REST server, OCI images, an egress allowlist and copy-on-write clones ([repo](https://github.com/boxlite-ai/boxlite)).
  - Rivet has a guide for it ([Rivet BoxLite](https://rivet.dev/sandbox-agent/docs/deploy/boxlite.md)).
- **Fit for ostra:** both are interesting for isolating tasks on a single host, or on a member's laptop. Neither is a pool for a whole install.

### Docker Sandboxes (`sbx`)

- **What it is:** a CLI that runs coding agents in microVMs "on your machine or on Docker-managed cloud infrastructure" ([docs](https://docs.docker.com/ai/sandboxes/)).
- **Hosts:** macOS 14 or newer on Apple silicon, Windows 11 with WHP, or Ubuntu 24.04 or newer with KVM. It requires `sbx login` ([install](https://docs.docker.com/ai/sandboxes/install/)).
- **License:** proprietary ("Copyright © 2026 Docker Inc. All rights reserved", [sbx-releases](https://github.com/docker/sbx-releases)). Free to use, including commercially, with telemetry on by default ([FAQ](https://docs.docker.com/ai/sandboxes/faq/)).
- **Egress:** a host proxy that denies by default, but whose "default allowed domains include broad wildcards" ([security](https://docs.docker.com/ai/sandboxes/security/)).
- **TypeScript:** `@docker/sandboxes` 0.53.0 targets Docker's *cloud* sandboxes only, and needs a subscription ([API](https://docs.docker.com/ai/sandboxes-api/)).
- **Fit for ostra:** **not a server-side pool.** At most it's a place a member's local runner could live.

### The small-install path: Docker + gVisor, plus Sysbox and Coder

- **Docker + gVisor:**
  - One Linux host runs Docker with `runsc` installed ([quick start](https://gvisor.dev/docs/user_guide/quick_start/docker)).
  - ostra drives it with `dockerode` (`HostConfig.Runtime: "runsc"`). Prepared environments are per-project image layers.
  - Hosts with KVM can switch to Kata (`--runtime io.containerd.kata.v2`) with no code change.
  - This is F-017 (a container per task) on the server that hosts the runner image. Rivet's own Docker guide warns that plain Docker "is not recommended for production isolation" ([Rivet Docker](https://rivet.dev/sandbox-agent/docs/deploy/docker.md)), which is why `runsc` is the default here.
- **Sysbox** (`nestybox/sysbox`, Apache-2.0):
  - A `runc` variant using user namespaces, which runs Docker inside containers without `--privileged` ([repo](https://github.com/nestybox/sysbox)).
  - It shares the host kernel, so it's weaker than gVisor, and it isn't officially supported by Docker.
- **Coder** (`coder/coder`, AGPL-3.0):
  - Terraform-templated workspaces on Docker, Kubernetes or VMs.
  - Possibly a runner backend later. It's too heavy to be a core dependency.

---

## Rivet Sandbox Agent and the providers

- **Providers it ships:** `sandbox-agent` 0.5.6 (npm, 2026-11-05, Apache-2.0) exports `agentcomputer`, `cloudflare`, `computesdk`, `daytona`, `docker`, `e2b`, `local`, `modal`, `sprites` and `vercel`.
  - ComputeSDK adds Blaxel and CodeSandbox, among others ([ComputeSDK](https://rivet.dev/sandbox-agent/docs/deploy/computesdk)).
  - It has no provider for `agent-sandbox`, Northflank, Fly Machines, microsandbox, OpenSandbox or CubeSandbox.
- **How its providers work:** they create the sandbox, start `sandbox-agent server` inside it, and then the client connects to the sandbox's URL (`SandboxAgent.connect({ baseUrl })`). The model key goes into the sandbox's environment (`ANTHROPIC_API_KEY`) ([E2B guide](https://rivet.dev/sandbox-agent/docs/deploy/e2b.md), [Docker guide](https://rivet.dev/sandbox-agent/docs/deploy/docker.md); confirmed 2026-11-18).
- **What that means for ostra:**
  - Rivet's provider layer contradicts two of ostra's choices:
    - The runner connects *out* to the server (ADR 0012), so it works behind NAT, and the provider needs no public port.
    - Model keys are added by a proxy the agent can't see (Q17, `research/credential-proxy.md`).
  - So ostra creates sandboxes itself, with its own runner inside. If Q11 adopts Sandbox Agent, it runs *inside* the runner's sandbox as the agent layer, beside the runner.
  - Rivet's provider list shows where Claude Code is known to run, and its provider code is worth reading. It doesn't decide which provider ostra ships.

---

## Recommendation

These are recommendations, not decisions. Each provider and SDK needs the maintainer's approval (`AGENTS.md`).

### 1. The first hosted provider: E2B

**Why E2B:**
- **Per-project environments, ready in seconds.** Templates are built from ostra's runner image plus a project's setup, and boot from a memory snapshot in about 80 ms. Templates are unlimited, so one per project, rebuilt when the environment changes, is the documented pattern.
- **Long waits and reopening.** Pausing keeps a sandbox indefinitely, outside the concurrency count. That covers an approval that waits for hours, and ADR 0006's "same runner" reopen.
- **F-052 already has a home.** Domain and CIDR egress rules, set per sandbox.
- **Docker inside**, and a mature TS SDK (`e2b` 2.64.0).
- **Isolation between projects**, with a Firecracker VM per sandbox.
- **One adapter covers four deployments** with the same API:
  - E2B Cloud
  - E2B BYOC (Enterprise)
  - E2B Embed, self-hosted on one node, Apache-2.0
  - CubeSandbox, self-hosted on several nodes, if its compatibility holds
  No other hosted provider gives self-hosters the same code path.
- **Cost:** about $16.56 an hour for 100 tasks, plus Pro at $150/mo. 1,000 tasks at once need $1,000/mo of add-ons, or Enterprise.

**Its weaknesses, and how ostra handles them:**
- **The 24 h continuous cap.** Pause and resume reset it, and the server drives that.
- **A snapshot or pause drops the runner's WebSocket.** The runner already reconnects with an unacked spool (`research/runner-transport.md`).
- **A default 5-minute timeout that kills.** ostra overrides it on every create.
- **No static egress IPs.** Document it for enterprises that allowlist IPs.

**Second hosted adapter, when a team asks: Vercel Sandbox.** It allows 10,000 at once, bills CPU only when busy, has a credential-injecting firewall, and restores snapshots in 250 ms.

**Don't start with:**
- **Daytona:** closed source and split across two platforms.
- **Modal:** no pause, and a beta TS SDK.
- **Cloudflare:** its lifetime model.
- **Northflank:** no snapshots.
- **Fly:** no TS SDK, and no custom images on Sprites.
- **Runloop:** shutting down.

### 2. The path for self-hosters, with no paid vendor

| Install size | Provider | Isolation | Per-project environment |
|---|---|---|---|
| One box, the default | The built-in or Docker runner as a **fixed** pool (unchanged) | The runner's container (ADR 0020) | On-disk cache (F-051 as written) |
| One or a few hosts | **Docker + gVisor** elastic provider (`dockerode`, `runsc`; Kata on KVM hosts) | gVisor, or a Kata VM | A per-project image built by ostra |
| Hundreds to 1,000 tasks | **Kubernetes `agent-sandbox`** + gVisor RuntimeClass (Kata on KVM nodes) + Cilium for FQDN egress | gVisor, or a Kata VM; a namespace per project | A per-project image; warm pools for busy projects; Pod Snapshots on GKE |
| MicroVM snapshots without Kubernetes (spike first) | **E2B Embed** (one node, ≤200 sandboxes; spread across nodes) or **CubeSandbox** (several nodes), both through the E2B adapter | Firecracker / RustVMM | Templates with memory snapshots |

- **On the maintainer's two named candidates:**
  - **E2B self-hosted is viable** for up to about 200 tasks per node. Above that, ostra spreads sandboxes across several Embed nodes, or the team moves to E2B BYOC, which is paid.
  - **Daytona self-hosted is not viable.** It's archived, unmaintained, and its own README calls it unsafe for production. Its BYOC still needs Daytona's control plane.
- **Why Kubernetes `agent-sandbox` is the main scale path:**
  - It's Apache-2.0 and governed by a Kubernetes SIG.
  - Its benchmarks are far beyond 1,000 tasks.
  - gVisor runs on any cloud VM.
  - Namespaces give per-project quotas and policies.
  - Its "no per-claim env on warm pods" rule matches ostra's runner, which dials out and fetches its work.
  - The price: no snapshots off GKE. Per-project environments are images that ostra builds and pushes to the team's registry.

### 3. The runner pool abstraction

**Proposal:** one scheduler and one runner protocol, with two kinds of pool.

```ts
// Sketch only. Names and fields are proposals; Zod schemas would define them.
type RunnerPool =
  | { kind: "fixed"; id: PoolId; labels: readonly RunnerLabel[] } // runners join with a sign-in code
  | {
      kind: "elastic";
      id: PoolId;
      labels: readonly RunnerLabel[];
      provider: ProviderConfigId;     // E2B, agent-sandbox, Docker+gVisor, …
      size: SandboxSize;              // vCPU, memory, disk
      maxConcurrent: number;
      perProjectMax: number;          // fairness between projects
      warm: number;                   // only where the provider has warm pools
      whileWaiting: "keep" | "pause" | "release";
      keepFor: Duration;              // then pause, or release
      maxSandboxLife: Duration;       // a hard stop, under the provider's cap
    };

type ProviderCapabilities = {
  pause: boolean;                                              // E2B yes; Modal no
  environmentArtifact: "memory-snapshot" | "filesystem-snapshot" | "image";
  egress: "domains-and-cidrs" | "cidrs" | "ports" | "none";
  maxContinuousRun: Duration | "none";                         // E2B Pro 24 h; agent-sandbox none
  dockerInside: boolean;
  warmPool: boolean;
};

// The server's record of each sandbox: one discriminated union per lifecycle.
type ElasticRunner =
  | { state: "requested"; request: SandboxRequestId; task: TaskId }
  | { state: "creating"; request: SandboxRequestId; task: TaskId }
  | { state: "booting"; request: SandboxRequestId; sandbox: ProviderSandboxId }
  | { state: "leased"; sandbox: ProviderSandboxId; runner: RunnerId; task: TaskId; epoch: LeaseEpoch }
  | { state: "paused"; sandbox: ProviderSandboxId; task: TaskId }
  | { state: "releasing"; sandbox: ProviderSandboxId }
  | { state: "gone"; reason: "finished" | "released" | "expired" | "orphan" }
  | { state: "failed"; reason: ProviderError };
```

**The rules:**
1. **Dispatch doesn't care what kind of pool it uses.** A task matches a pool by labels (F-069), then gets a runner. A fixed pool has runners already; an elastic pool can add one.
   - Once the runner inside a sandbox registers, it's an ordinary runner: the same image (F-039), protocol, leases and per-task tokens.
   - That makes runner parity hold by construction (`AGENTS.md`).
2. **Pools are install-level; projects ask for labels.**
   - An admin configures pools once.
   - Projects and intake rules require labels (`linux`, `docker`, `gpu`), never a provider.
   - A fresh install still works with the built-in fixed runner alone, so elastic pools are optional (the self-hosting rule).
3. **An elastic runner is created for exactly one task.**
   - The server mints a one-time registration token, bound to the sandbox request and short-lived, and passes it with the server's URL in the sandbox's environment (`research/runner-transport.md`, auth).
   - On registration, that runner is offered only that task.
   - Where warm pods can't take per-claim env (`agent-sandbox`), the token arrives after the claim. How is a spike.
4. **The server owns each sandbox's lifecycle and never trusts a provider's idle timer.**
   - Creates are idempotent on the request ID.
   - The server extends timeouts, pauses, resumes and destroys sandboxes through the provider API.
   - A reconcile loop lists the provider's sandboxes by tag and destroys any without a live lease. That's the orphan sweep, which protects cost.
   - `maxSandboxLife` is a hard stop.
   - The loop runs as a durable job, so that only one server replica acts on each sandbox (`research/durable-execution.md`).
5. **Waiting on a person (`needs you`):**
   - `keep` the sandbox for `keepFor`; on E2B that's cheap at about $0.17 an hour.
   - Then `pause` if the provider can, or `release`: the runner saves work in progress, history is already on the server, and the sandbox is destroyed.
   - Reopening then follows ADR 0006 step 2 on a fresh sandbox, booted from the project's environment artifact.
6. **Environment artifacts belong to the pool.** They're built per project, per provider (see the section above), and hold no secrets. Fixed runners keep their on-disk cache. That splits F-051 into a fixed-runner half and an elastic-pool half.
7. **Capabilities are declared per provider adapter** (`AGENTS.md`, adapter parity). Without a capability, features degrade:
   - no snapshot: run the full setup
   - no pause: `keep`, then `release`
   - no egress rules: F-052 falls back to a proxy inside the runner image (`research/credential-proxy.md`)
8. **Credentials and licences:**
   - Provider credentials live on the server only.
   - The pool controller is server code (AGPL).
   - Provider adapters sit behind the Apache-2.0 adapter SDK (ADR 0009), so teams can write their own.

---

## Unknowns / spike

**Spikes, in priority order:**

1. **E2B end to end (spike).**
   - Build a template from the runner image (F-039) and a per-project template on top.
   - Time from create to a registered runner.
   - Check that the runner's outbound WebSocket lasts for hours, and that it reconnects cleanly after pause and resume.
   - Check how the 24 h cap behaves.
   - Test an egress allowlist covering the ostra server, the model API and GitHub.
   - Check whether sandbox metadata tags work for the orphan sweep (**unverified**).
2. **Kubernetes `agent-sandbox` on k3s with gVisor (spike).**
   - Claim from a warm pool, then deliver the one-time token after the claim.
   - Time a cold start from a per-project image.
   - Test Cilium FQDN egress.
   - Check that Docker works inside, for repos whose tests use Compose.
3. **Claude Code inside gVisor and Firecracker guests.** Claude Code's own sandboxing and `sandbox-runtime` use bubblewrap and user namespaces (`research/credential-proxy.md`). Whether they nest inside gVisor or a microVM is **unverified**.
4. **E2B Embed and CubeSandbox through the same adapter.**
   - Does the E2B SDK drive CubeSandbox unchanged?
   - Can ostra spread sandboxes across several Embed nodes, building templates on each?

**Design problems:**

5. **Secrets in the prepare step.** A setup script that needs a secret, such as a private registry token, could leave it in an environment artifact. Options: run the prepare step with short-lived tokens only, scrub known paths before the snapshot, or skip the artifact for that project.
6. **Work in progress on release.** Releasing a waiting sandbox loses uncommitted edits. Options: keep or pause instead, or have the runner push a hidden ref (`refs/ostra/wip/<task>`) with its push token. ostra stores only Postgres (ADR 0017), so there's no blob store for a tarball.
7. **Activity semantics.** No provider documents whether a sandbox's outbound connection counts as activity. The design above doesn't depend on it, because the server drives lifecycle, but each adapter's defaults must be checked.
8. **Static egress IPs.** E2B has none, Modal has them in beta on Team, and Daytona 2.0 in beta on Team. Enterprises that allowlist IPs for private registries or databases may need a proxy with a fixed IP.
9. **Creation bursts.** 1,000 tickets dispatched at once hit E2B's 5 creates a second, Vercel's ramp, and the warm-pool refill rate (~70–85 a second per pool). The pool queues creates; whether that's fast enough is a spike question.

**Questions for the maintainer:**

10. **Install-level pools against team scoping.** The domain model scopes a runner to a team (`domain-model.md`, ADR 0010, F-049: "a member of one team never sees another team's … runners"). The maintainer now calls runners install-level. If one pool serves several teams, rules 1–5 under "Isolation between projects" become security requirements between teams, not just projects. 👤
11. **"Project" is a new term.** `GLOSSARY.md` has Board and repo, and lists "project" under *Avoid* for Board. The maintainer's Projects (a tracker connection, repos and an environment) need a glossary entry and a check against Board and Environment. 👤
12. **The provider market moves fast** (Runloop, Daytona, Blaxel, firecracker-containerd). Keep the adapter interface to create, destroy, list, pause, resume and build-artifact. Never depend on a provider-only feature, such as memory snapshots, for correctness.
