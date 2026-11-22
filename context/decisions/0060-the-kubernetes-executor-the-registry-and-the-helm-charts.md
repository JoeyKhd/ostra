# The `kubernetes` executor, the snapshot registry and the Helm charts

**Status:** accepted (2026-11-19, on the maintainer's delegation for milestone 5's spec). Settles Q237 to Q241. Covers F-093, F-118 and F-120, and builds on ADR 0029 (a box as one pod, Kubernetes 1.29, "waiting for a node", the recorded egress difference), ADR 0030 (no credential in the agent's container), ADR 0034 (the task token), ADR 0038 (snapshots, the registry, BuildKit's namespace) and ADR 0039 (a pod is deleted when its box stops).

## The pod

- **One pod per box**, in the runner's namespace. The agent is the pod's container. The sidecar is the first init container with `restartPolicy: Always` (a native sidecar), so it starts before the agent and stops after it, and the environment's services follow it as native sidecars, in order, each with its health check as a readiness probe.
- **The task token** is in a `Secret` the runner makes for that box, mounted as a file into the sidecar's container only, never an environment variable (ADR 0034). The bridge's nonce is in the same secret. A snapshot's pull credential, when there is one, is a second, per-box `dockerconfigjson` secret that only the kubelet reads.
- **No service account token in the pod** (`automountServiceAccountToken: false`), no service links, no host namespaces, `RuntimeDefault` seccomp and the capabilities spike 3 dropped. An optional runtime class carries gVisor.
- **The pod's objects are built as typed values,** never from string templates, and labelled with the box, the task and the organization, so release can find and delete everything by label.
- **Stopping a box deletes its pod and its secrets.** A pod is never kept stopped (ADR 0039).
- **Services by name:** a pod shares one network namespace, so a service listens on `localhost`, and the pod's `hostAliases` map each service's name to it, so an environment written for `docker` works unchanged.

## Waiting for a node

- The runner accepts the dispatch at once (ADR 0029) and watches the pod. `Unschedulable` with a scale-up under way (the autoscaler's `TriggeredScaleUp` event) is `box.waiting { reason: "node" }`, and the task page says "Waiting for a node". A slow pull is `image-pull`.
- **After 15 minutes** *(working value)* without a node, the box fails as "no node" and the task goes back to its pool's queue with its first queued time. It isn't counted as a crash. `Unschedulable` with no scale-up under way fails at once as "no room": the runner reported room it didn't have, and its next `status` corrects it.
- **A box that doesn't start is lost, as on `docker`** (amended 2026-11-22, F-047, ADR 0029's parity). The runner waited for the sidecar's readiness for ever: a sidecar that died first is started again by the kubelet (a native sidecar always is), so a crash loop never ended the wait, and when the wait did fail the runner told core nothing, so the task sat in `preparing`. Now, once placed: a sidecar that ends, or that the kubelet started again, before it's ready fails the box at once, with its exit code; one that runs and isn't ready within 120 s of its start fails it then (`BOX_START_WITHIN_MS`, the time a `docker` box's sidecar gives the box's init before it exits); an image that won't pull and a pod that can't be made fail it as before. The runner then reports `box.lost`, with the sidecar's exit code or none, as `docker`'s runner does when a sidecar exits before it connects, and core records the session crashed: the task needs its driver, and a reopen starts a fresh box. `docker`'s runner had the same gap when its box's create failed (an image's pull, a container refused), and reports it the same way now. A sidecar the kubelet started again after the box ran counts as ended too, lost unless its last run exited 0. "No node" and "no room" still aren't a crash, and aren't reported: the requeue above needs a runner event core doesn't have yet.

## The server's address under the egress baseline

- **A box's sidecar has to reach the ostra server,** which on a cluster is usually at a private address. So the baseline's NetworkPolicy has one exception: the server's address (a CIDR, or the server's namespace and pods when it runs in the same cluster) on its port, with DNS to the cluster's resolver. `OSTRA_EGRESS_ALLOW` adds a private model endpoint an admin names. `docker`'s host rules have had the same exception since milestone 1's script.
- **On `kubernetes` the agent shares the pod's network,** so it can reach the server's address too, as it can reach public hosts (ADR 0029's fourth difference). It holds no token the server accepts, and the runner page's line for `kubernetes` pools says it.
- The policy is the runner chart's, applied once per namespace. The executor checks that it's there and refuses to start boxes without it; it never writes it itself, so a runner's service account needs no right to change policies.

## The snapshot registry

- **One registry per organization,** set by an admin: an address, a repository prefix, and credentials kept in the secret store. **Basic credentials** cover GHCR, Harbor, Docker Hub, GitLab, Quay and ACR's tokens. A **push credential** and a **pull credential** may differ, and the docs recommend a pull-only one. On `kubernetes`, pulls may use **the cluster's own identity** instead, with no credential in ostra.
- **ECR** issues 12-hour tokens from an AWS credential, which needs AWS's SDK. ECR pulls work through the node's identity; ECR pushes wait for the maintainer's yes to `@aws-sdk/client-ecr`.
- **Names:** `<address>/<prefix>/<projectId>:<snapshotId>`, and boxes use the image by digest. A project's snapshots never share a repository with another's (ADR 0038).
- **Who gets which credential.** The push credential goes to the one runner a build was given to, while it builds. The pull credential goes to the runner holding a task's current lease, for that task's image. Each issuance is an audit entry. Neither is written to a runner's disk; on `kubernetes` the pull credential lives only in the box's pull secret.
- **The check** is core's own calls to the registry's API: authentication, a push scope (an upload started and cancelled) and a pull scope. It pushes no image.
- **`docker` without a registry** keeps milestone 3's path. **A `kubernetes` pool without one** builds nothing and its tasks wait, saying so (ADR 0038).
- **Builds on `kubernetes`** run as a rootless BuildKit pod in the build namespace, with its own egress policy (the registry and the environment's package hosts). The scan runs on the exported image before the push. The BuildKit settings spike 3 couldn't justify are each a named switch, off unless a live run needs it, and on milestone 7's security review's list.

## The Helm charts

- **Two charts,** in `deploy/helm/`, versioned with the release. `ostra-server` runs the server image as `web` and `core` deployments with their replicas, against a Postgres the admin provides, with one secret for the secrets key, better-auth's secret and the runner-token key, made once on install (`lookup`, kept on upgrade) or named with `existingSecret`, so every replica shares them. `ostra-runner` makes the box and build namespaces, a service account with a role in those namespaces only, the runner's deployment, the join token from a secret, and the two egress policies. Both state `kubeVersion: ">=1.29.0-0"`.
- **Values schemas are written in Zod** and generated to each chart's `values.schema.json`, so Helm checks values at install and ostra's tests check the defaults and the examples without Helm. Only required values lack a default, and every value has its line in the configuration reference.
- **How they're checked:** always the schema check, in CI. Where Helm is installed, `helm lint` and `helm template` with only the required values and with every example, and the rendered manifests checked (a namespaced role only, one shared secret, the baseline's ranges). Installed on kind in the manual proof jobs (ADR 0061).

## Considered options

- **The sidecar as an ordinary container,** as spike 3's pod had it. Rejected: it could start after the agent and stop before it, and a native sidecar's order is what the box needs.
- **The task token in an environment variable,** or in a projected service account token. Rejected: ADR 0034 keeps it in a file only the sidecar mounts; a service account token would be one more credential in the pod.
- **One pod per service.** Rejected: the services would leave the pod's network, and the egress policy and the names would need a service each.
- **An egress exception by pod label for the sidecar alone.** Not possible: a NetworkPolicy selects pods, not containers (ADR 0029).
- **The executor writing its own NetworkPolicy.** Rejected: the runner's service account would need the right to change policies in its namespace, which is the right to remove the baseline.
- **A registry adapter kind** beside ADR 0025's eight. Rejected for v1: every supported registry speaks the same distribution API, and ECR's token is one call. If registries need different code later, the client becomes an adapter.
- **One chart with both the server and the runner.** Rejected: they're often in different clusters, and the runner's chart must be installable by someone who can't touch the server.

## Consequences

- A new Apache-2.0 package, `@ostra/adapter-executor-kubernetes`, with `@kubernetes/client-node` (confirmed in ADR 0007), whose `loadAllYaml` also reads the charts' rendered output, so no YAML library is added.
- `Registry` is a new table; `Box` and `Snapshot` gain their image columns (milestone 5's migration).
- Everything on this ADR runs on a fake Kubernetes API and a fake registry on the plan's Windows machine, and on kind with a local registry in the manual proof jobs. An autoscaler that really adds a node needs a real cluster, which is the maintainer's (milestone 5's ticket 38); until it has run, F-093 stays `building`.
- Ledger rows: F-093, F-118, F-120, F-116 (the server's exception), F-094 and F-051 (their `kubernetes` halves).
