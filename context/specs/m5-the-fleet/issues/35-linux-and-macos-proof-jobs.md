# 35: The Linux and macOS proof jobs

Status: ready-for-agent
Builder: core
Blocked by: 09, 10, 20, 21, 22, 23, 24
Features: F-017, F-015, F-014, F-093, F-120, F-095, F-116, F-118, F-039, F-013, F-001 (its compose run), F-051, F-094, F-096, F-045 (their `docker` and `kubernetes` halves)
Packages: `.github/workflows/proof.yml` (new jobs, `workflow_dispatch` only), `scripts/live/` (new: the job's steps as scripts a person can also run on their own Linux machine), `context/specs/m5-the-fleet/demo/linux/` and `demo/macos/` (the kept logs)
Spec: `../spec.md`, sections 1 ("On this machine") and 9.1; ADR 0061

## What to build

Jobs of the manual `Proof` workflow (the maintainer, 2026-11-19: by hand only, never on push or on a schedule; never in `ci.yml`). Each job uses only stub models, the fake git upstream and the fake GitHub, so it needs no secret; every action is pinned by SHA, and every tool it installs (kind, Helm, Calico's manifest, `runsc`) by version and SHA-256.

- **`live-docker` (`ubuntu-24.04`):** builds the three images (`pnpm images:build`), records their sizes, starts each (the server's `all` health check, `ostra --version`, OpenCode's version and checksum in the base); `docker compose up` with only the required settings (F-001); applies `deploy/egress-baseline.sh`; runs every `*.live.test.ts` of the `docker` executor and the executor suite's live part: a box ready in under 10 s with the image present, 50 boxes on one host, the sidecar's memory, the credential checks from a shell in the agent's container, limits from the cgroup, a stress held at them, a push to `registry:2` and a pull from a second runner, the egress probes with their controls, the canary, a sidecar that keeps its connection while the runner restarts, a box from a snapshot that sees its repos, a service by name, a stopped box kept; the `host` pool's separate OS user; the `host` executor's delegated cgroup; real nginx's defaults in front of core for the fallback. Optionally the same with `runsc`.
- **`live-kind` (`ubuntu-24.04`):** two kind clusters at Kubernetes 1.29 and at the newest kind supports, one with Calico and one with a network plugin that ignores NetworkPolicy; both Helm charts installed with only their required values (the server against a Postgres container); a runner joins with the chart's secret; a box as a pod with its services, ready in under 60 s on a warm node, measured; the kubelet's pull with the per-box secret from a local registry; the rootless BuildKit pod's build, scan and push; the egress probes and the control pod on both clusters (enforced on Calico, told apart on the other); a node cordoned so a pod is unschedulable, which shows the waiting path but isn't an autoscaler (that stays ticket 38's); the pod deleted on stop; nothing left in the namespace after release.
- **`live-macos` (`macos-15`):** the `host` executor's containment cases: the marker sweep finds a helper that left the group, and a helper that also cleared its environment is the recorded gap (ADR 0029); a `host` pool's separate OS user.
- **Evidence:** each job uploads its logs, which ticket 37 downloads into `demo/linux/` and `demo/macos/` (secrets aren't involved, and the logs are checked for none), and each proof file cites them as `live:` evidence.

## Done when

- [ ] The three jobs exist, run by `gh workflow run Proof`, and pass; their logs are in the repo; each condition they prove has its proof row citing the log.
- [ ] A job that can't do a step on a hosted runner says so in its log and in this ticket's `## Comments`, and the condition stays `partial`.
- [ ] Committed as `✅ add the Linux and macOS proof jobs`, and the kept logs as `📝 keep the fleet's live proof logs`.

## Comments
