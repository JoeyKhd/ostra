# 38: The maintainer's steps outside the code

Status: ready-for-human
Builder: maintainer
Blocked by: none for the decisions; 35 and 37 for the reviews of the runs
Features: F-093, F-117, F-118, F-120, and the screens of ticket 29
Packages: none (decisions, machines and settings outside the repo, recorded here)
Spec: `../spec.md`, sections 1 ("On this machine"), 9.1, 11 and 12

## Why a person

Each step needs a machine, an account, a click or a yes that an agent doesn't have.

1. **Review spec section 11's nineteen choices** (Q230 to Q248 in `context/open-questions.md`), all settled on the delegation of 2026-11-19, and move back to the open list any you disagree with. Q230 in particular: the Linux and macOS proofs run on GitHub's hosted runners from the manual `Proof` workflow.
2. **Helm on this machine:** say yes or no to installing Helm's official release (pinned, SHA-256 checked) into `~/.local/bin` for ticket 23's render. With a no, the render runs only in ticket 35's job, and this machine runs the schema check.
3. **A cluster whose autoscaler really adds a node,** for F-093's "waiting for a node": any managed cluster (GKE, EKS, AKS) or a cluster with the Cluster Autoscaler, with a node pool that scales from its minimum, Kubernetes 1.29 or later, a NetworkPolicy-enforcing network plugin, a registry it can pull from, and a namespace for ostra. Run the runner chart there once, start a task with the pool at its minimum, and keep the log. Until then F-093 stays `building`.
4. **A Linux machine for the full load test** (F-117): at least 16 vCPUs and 32 GB, with Docker and Postgres 18 on its own disk, to run `pnpm load:run --tasks 1000` against three core replicas. A hosted runner's 4 vCPUs can't. Keep the summary in `context/specs/m5-the-fleet/demo/load-linux.md`.
5. **ECR:** say whether `@aws-sdk/client-ecr` may be added so an ECR registry can take pushes (ADR 0060). Without it, ECR works for pulls through the node's identity, and GHCR, Harbor and the others work in full.
6. **The registry for the live runs:** the hosted jobs use a local `registry:2`; say whether a real one (GHCR under the test org, for example) should be tried once too, and add its push and pull tokens to `~/.config/ostra-dev/registry.env` if so; `docs/development.md` gets the names, never the values.
7. **Approve the milestone 5 screen targets** (ticket 29), recorded there with the date.

## Done when

- [ ] Each step is done or answered, with the date, under `## Comments`.

## Comments
