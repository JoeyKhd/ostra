# Proofs on machines the plan isn't built on, and the load test

**Status:** accepted (2026-11-19, on the maintainer's delegation for milestone 5's spec). Settles Q230 and Q245. Covers how F-014, F-015, F-017, F-039, F-093, F-095, F-116, F-117, F-118 and F-120 get proved, and builds on `AGENTS.md`'s proof rule, `context/proof/README.md`, the maintainer's CI scope of 2026-11-19 (`proof.yml` by hand only, never in `ci.yml`) and ADR 0034 (spike 6's load bars).

The plan is built on a Windows machine with no Docker, no Kubernetes, no Linux and no Mac (`build-order.md`). Milestone 5's rows are mostly about those. A row is `done` only when every condition of its "done when" is proved (`context/proof/README.md`), and a test that runs only on another machine is live evidence, cited by its run's log. This ADR says where those runs happen, so a row never waits on "later" with no plan, and is never set `done` on a fake.

## Where the runs happen

- **GitHub's hosted runners, from the manual `Proof` workflow.** New jobs in `proof.yml`, started only with `gh workflow run Proof` (never on push, never on a schedule, never in `ci.yml`):
  - **`ubuntu-24.04`** for Docker (the three images, the compose file, the `docker` executor's live tests, the egress probes, 50 boxes, limits, a local `registry:2`, real nginx, a `host` pool's OS user, a delegated cgroup, gVisor optionally) and for kind (both charts, a box as a pod, the kubelet's pull, the BuildKit pod, NetworkPolicy enforced by Calico and ignored by a second cluster, so the control pod tells them apart).
  - **`macos-15`** for the `host` executor's macOS containment cases and a `host` pool's OS user.
- **They need no secret.** The jobs use the stub models, the fake git upstream and the fake GitHub, so nothing from `~/.config/ostra-dev/` goes to GitHub. Every action is pinned by SHA and every tool by version and SHA-256.
- **Their logs are kept in the repo** under the milestone's `demo/` folder, checked for secrets, and cited as `live:` evidence. A step a hosted runner can't do is said in its log, and its condition stays `partial`.
- **The maintainer's own machine and cluster** do what a hosted runner can't: an autoscaler that really adds a node (F-093), and the load test at full scale (F-117), which needs more than a hosted runner's 4 vCPUs. The scripts the jobs run are in `scripts/live/`, so the same steps run on any Linux machine.

## The load test

- **Product code end to end:** simulated runners are `apps/runner`'s real peer and spool with a scripted event source in place of an agent; tasks go through the real API, queue, dispatcher and gateway; three core replicas and one Postgres.
- **The rates are spike 10's** (a median of 259 and at most 415 driver events a minute a run, 793 bytes a message, before coalescing), with partial text on for 1 task in 4, a reconnect storm, the generator as several processes, Postgres's CPU recorded, and a sample of real browsers (ADR 0035, F-117).
- **On the plan's machine, a ramp:** 100, 250, 500 and 1,000 tasks, with embedded Postgres. The record says the largest step that held every bar and how the next failed. It proves the harness and gives a number; it doesn't prove F-117's bar, which is about three replicas and one Postgres on a server.
- **On Linux, the run that counts:** 1,000 tasks against a real Postgres on its own disk, on a machine of at least 16 vCPUs and 32 GB. F-117 stays `building` until it passes, and it's the launch gate in milestone 7 either way.

## Considered options

- **Waiting for the maintainer's Linux machine** for everything, as milestones 1 to 4 did. Rejected: most of milestone 5 would sit unproved, and a hosted runner already runs the panel's e2e suite in `proof.yml`.
- **The Linux proofs in `ci.yml`.** Rejected by the maintainer's CI scope: heavy jobs run by hand.
- **Docker inside WSL on the plan's machine.** Not chosen: it would need the maintainer to install and configure it, and the result would be one more machine's quirks; the hosted runner is a clean Linux every time. WSL stays possible for anyone who wants it, with the same `scripts/live/`.
- **Self-hosted GitHub runners.** Not needed: a public repo's hosted runners cost nothing, and a self-hosted runner on a public repo runs strangers' pull requests.
- **The load test with fake peers** as spike 6 did. Rejected for the product: the bar is about ostra's own gateway, ingest and dispatch, so the peers are ostra's own too.

## Consequences

- `proof.yml` gains three jobs; `ci.yml` doesn't change.
- A row whose conditions need another machine says, in its proof file, which job's log proves each one, and stays `building` until the log is in the repo.
- The plan's machine stays the one the demos run on; milestone 5's demo links the jobs' runs.
- If GitHub's hosted runners stop allowing kind, nested containers or the macOS runner, the scripts run on the maintainer's machines instead.
