# Environments, snapshots and services

**Status:** accepted (2026-11-18, from the delegated answers in `context/history/answers-2026-11-18.md`). Settles Q33, Q39, Q40, Q95 and Q96.

**One environment per project** (Q33). It's the project's recipe for every box: "the computer every task starts from". It holds:
- a base image: ostra's default (the tools, the pinned agent and a small init program), or the organization's own
- a setup script
- services
- check commands, which ostra runs before it opens a PR (F-054)
- variables, secrets and files, each belonging to one repo of the project. A key two repos need is stored in each (F-050)
- network rules: the egress baseline in v1 (ADR 0031), allowlists later (F-052)

In v1, ostra drafts the environment from the project's repos: lockfiles, tool versions, `.env.example`, `devcontainer.json` and compose files (Q2, F-112). The onboarding task then checks the draft by running it (Q49, F-113).

**One snapshot per project** (Q39, Q95). A snapshot is the environment prepared ahead of time, so a box starts in seconds.
- It holds the base image, every repo's checkout and the result of the setup script. It never holds a secret.
- On `docker` and `kubernetes` it's an OCI image, built by a runner. On the `host` executor there's no image: a worktree and a dependency cache take its place.
- It's rebuilt when the environment changes, when a lockfile changes on a default branch, and nightly if a default branch moved.
- A secret marked "available during setup" is mounted for the build only. The build fails if the secret's value is found in the image.
- The server chooses which snapshot a box starts from. A runner never names one, and snapshots are kept apart per project (`research/elastic-sandboxes.md`, isolation rule 3).
- When a box starts, it fetches the task's branches, runs the incremental install, and receives its secrets from the server after the lease check.
- Its lifecycle is a discriminated union: queued, building, ready, then replaced, or failed.

**The registry.** A runner pushes the snapshot to the organization's own container registry, for example GHCR, ECR or Harbor (F-120).
- **`docker`:** the registry is optional. Without one, each host builds the snapshot and caches it.
- **`kubernetes`:** a registry is required, because a cluster can only pull images from one. A rootless BuildKit pod builds the image (round 14, problem 4).
- **`host`:** no registry.

**Services** (Q40, Q96). The environment has a typed list of services: an image, variables, a port and a health check. They start as sidecar containers of the box.
- **`docker`:** on the box's private network.
- **`kubernetes`:** as containers in the task's pod.
- **`host`:** none. That's one of the executor's two allowed differences (ADR 0029). The scheduler never sends it a task whose environment needs services.

## Considered options

- **One environment per repo** (F-050, the domain model). Rejected: a box holds every repo of a project (ADR 0027), so the project is the unit. Secrets still belong to one repo each, as the maintainer asked in Q16.
- **A snapshot per project and repo** (Q39 as first written). Rejected: one box starts from one image. If images for large projects pull too slowly, repos get layers of their own.
- **A prepared workspace cached on each runner** (F-051 as written). Rejected as the main path: in a pool, every new runner would start cold. It survives as the `docker` fallback without a registry.
- **A vendor's templates or snapshots.** Rejected with hosted sandboxes (Q36).
- **Memory snapshots** (gVisor checkpoints, GKE Pod Snapshots). Rejected: they work on few platforms, and on Kubernetes only on GKE (`research/elastic-sandboxes.md`).
- **The registry optional everywhere** (Q95). Rejected for `kubernetes`, which can't pull an image from anywhere else.
- **Secrets passed into the build as arguments or files.** Rejected: image layers keep them. A setup secret is mounted for the build only, and the image is checked for its value.
- **Services from a compose file** (round 9). Later: a typed list can be checked and shown in the panel. Docker inside the box was the E2B design, and went with it.

## Consequences

- A repo in two projects has two environments and two sets of secrets. If a repo needs one shared setup, environments gain an "inherit from" link.
- Snapshots (F-051) and services (F-094) are v1, built in milestone 3.
- Spike 3 checks that a snapshot builds from a generated Dockerfile on both executors, that a setup secret isn't found in any layer, and that a database service is reachable from the agent's container.
- If v1 runs long, building snapshots inside Kubernetes slips first among the runner work: a `docker` runner builds them for the cluster instead.
- An environment's variables and secrets are visible to the code under test (ADR 0030, ADR 0031).
- Importing a compose file (F-132), organization templates and bulk onboarding (F-126) come after v1.
- Ledger rows: F-050, F-051, F-054, F-094, F-112 and F-120.
