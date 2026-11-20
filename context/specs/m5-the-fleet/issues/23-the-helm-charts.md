# 23: The Helm charts

Status: done
Builder: core
Blocked by: 07, 22
Features: F-118, F-093, F-116
Packages: `deploy/helm/ostra-server/` (new), `deploy/helm/ostra-runner/` (new), `packages/deploy-checks` (`src/helm/`), `docs/configuration.md`, `docs/self-hosting.md` (or where the install docs live), `package.json` (`check:helm`)
Spec: `../spec.md`, section 11, item 12; ADR 0060

## What to build

- **`ostra-server`:** `web` and `core` deployments of the server image with their replica counts, a service and an optional ingress for `web` that passes WebSocket upgrades with a raised idle timeout (ADR 0034), an external Postgres (`database.url` or `database.existingSecret`, required), and one secret holding `OSTRA_SECRETS_KEY`, `BETTER_AUTH_SECRET` and the runner-token key, made once on install with `lookup` and kept on upgrade, or named with `existingSecret`. Every server process gets the same three.
- **`ostra-runner`:** the namespace for boxes, its build namespace, a service account with a `Role` and `RoleBinding` in those namespaces only (pods, secrets, events, quotas; no cluster role), the runner's deployment with `--executor kubernetes`, its join token from a secret (`joinToken.existingSecret`, required), the baseline NetworkPolicy for pods labelled `ostra.dev/role: box` with the server's address and DNS as its only exceptions (`server.egress`), the build namespace's own policy, and the minimum Kubernetes version as `kubeVersion: ">=1.29.0-0"`.
- **Values schemas in Zod** in `packages/deploy-checks/src/helm/`, generated to each chart's `values.schema.json` with `z.toJSONSchema`, and a test that the committed file equals the generated one. Only the required values have no default.
- **`pnpm check:helm`:** where `helm` is on the PATH, `helm lint` and `helm template` of both charts with only the required values and with every file in `examples/`; the rendered manifests read with `@kubernetes/client-node`'s `loadAllYaml` and checked (namespaced role, one shared secret, the policy's ranges, the native-sidecar version). Where it isn't, the schema check alone, and the command says that the render didn't run.
- **Every value** has its line in `docs/configuration.md`, and the docs say the cluster needs 1.29 or later and a NetworkPolicy-enforcing network plugin.

## Done when

- [x] Tests in `packages/deploy-checks`, named for `F-118`: `values.yaml` and each example parse against the Zod schema; the generated schema matches the committed one; every value is in the configuration reference. They run in CI with no Helm.
- [x] `pnpm check:helm`'s render, where Helm is installed (ticket 38's yes), with its log kept as live evidence in `context/specs/m5-the-fleet/demo/`.
- [x] Break-it: a cluster role in the runner chart fails the rendered check; recorded in `context/proof/F-118.md`.
- [x] Committed as `✨ add the server and runner Helm charts`.

## Comments

- 2026-11-20: built. `deploy/helm/ostra-server` (web and core deployments with their replicas and services, an optional ingress with ingress-nginx's raised idle timeout and an optional rule for core, an external Postgres by `database.url` or `database.existingSecret`, and one secret with the three keys made once with `lookup`, kept with `helm.sh/resource-policy: keep`, or named by `secrets.existingSecret`) and `deploy/helm/ostra-runner` (the box and build namespaces, a service account with a Role and RoleBinding in those two only, holding the executor's `NEEDED_ACCESS` plus `pods/log` and its own namespace's `get`, the runner as `ostra runner --executor kubernetes` with its join token mounted from `joinToken.existingSecret`, the baseline and build policies, `kubeVersion: ">=1.29.0-0"`). Values are Zod schemas in `packages/deploy-checks/src/helm/values.ts`, generated to `values.schema.json` (draft-07, strict). Required values: `database` for the server; `server.url`, `server.egress` and `joinToken.existingSecret` for the runner. `pnpm check:helm` ran here with Helm v4.3.2: lint, template and the rendered checks pass for every example, and both charts are refused on 1.28 (`context/specs/m5-the-fleet/demo/helm/check-helm.log`). Break-it: a ClusterRole template in the runner chart failed every example (`demo/helm/break-it-cluster-role.log`), recorded in `context/proof/F-118.md`. Departures: the rendered checks run in CI on the renders `pnpm check:helm --keep` keeps in `demo/helm/<chart>/` (the generated keys' values replaced), and `pnpm check:helm` fails when a kept render is stale, so the CI tests read Helm's real output without Helm; the reference is a "The Helm charts" section of `docs/configuration.md` (the docs site's group list grew by it); and `buildEgressPolicy` (ticket 08) no longer writes a registry rule with no peers when no address is set, since an empty peer list allows every destination (F-116's notes). Commit: 2731e95b.
