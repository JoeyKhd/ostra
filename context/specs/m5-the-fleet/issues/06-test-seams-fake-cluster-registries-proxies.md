# 06: Test seams: the fake Kubernetes API, the fake registries and the network proxies

Status: done
Builder: adapters
Blocked by: 02
Features: F-093, F-120, F-061, F-013 (their fakes)
Packages: `packages/adapters/adapter-executor-kubernetes` (new: `src/testing/fake-api.ts`, `src/testing/process-mode.ts`), `packages/adapter-sdk` (`src/testing/fake-oci-registry.ts`, `src/testing/fake-npm-registry.ts`, `src/testing/net-proxies.ts`)
Spec: `../spec.md`, section 8; section 10 (the ports from spike 6)

## What to build

- **The new package** `@ostra/adapter-executor-kubernetes`, Apache-2.0, with `@kubernetes/client-node` pinned exactly (confirmed in ADR 0007) and its lockfile change.
- **The fake Kubernetes API:** an in-process HTTP server that `@kubernetes/client-node` talks to unmodified. It holds namespaces, pods, secrets, service accounts, roles and role bindings, network policies, resource quotas and events, with `watch` for pods and events and `/version`, and it validates what the executor sets (init containers with `restartPolicy: Always`, owner references, labels). Switches: hold pods unschedulable with a `TriggeredScaleUp` event for a given time; fail an image pull; report a version under 1.29.
- **Its process mode:** each container's command runs as a local process with the container's environment, and its secret volumes are written as files under a folder of the pod's own. ostra's runner image maps to the built `ostra`, and the base image to the machine's shell and the agent the runner would launch. The pod's phase follows its processes. It has no isolation and no limits, and every log line it writes says so.
- **The fake OCI registry:** `/v2/` with Basic and bearer-token auth, blob uploads (monolithic and chunked), manifests by tag and digest, a push-only and a pull-only credential, a seeded image, and a record of every request for tests.
- **The fake npm registry:** a packument and tarballs of the CLI packed at two versions, with their integrity fields.
- **The network proxies,** ported from spike 6 (`src/harness/net-proxies.ts`, `certs.ts`): the CONNECT proxy with and without Basic auth, the TLS-inspecting proxy in its three modes, the cut (hold or reset), the nginx emulation, and per-run certificates made in memory.

## Done when

- [x] Tests: `@kubernetes/client-node` creates, watches and deletes a pod and a secret on the fake; the unschedulable switch emits its event; the process mode runs a pod of two containers that talk on loopback, and ends both on delete; a registry client pushes and pulls by digest on the fake registry with the right credential and is refused with the wrong one; `npm install --registry` installs the packed CLI from the fake npm registry; a WebSocket upgrade through each proxy mode behaves as spike 6 recorded.
- [x] `pnpm check:licenses` passes with the new package.
- [x] Committed as `✅ add the fleet's test seams`.

## Comments

- 2026-11-19: built. `@ostra/adapter-executor-kubernetes` (Apache-2.0, `@kubernetes/client-node` 2.0.2 pinned) holds the fake API (`src/testing/fake-api.ts`) and its process mode (`src/testing/process-mode.ts`), exported as `@ostra/adapter-executor-kubernetes/testing`. The fake serves HTTPS with a per-run CA that its `kubeconfig()` carries, since client-node refuses plain HTTP without `skipTLSVerify`; it also answers `SelfSubjectAccessReview` (with a `denyAccess` switch for ticket 07's health check), quotas (enforced, with `status.used`), the pod log, discovery, and collects an owned object with its owner. The process mode maps a command's first word through `commands` (`{ ostra: [node, apps/runner/src/main.ts] }`, `{ sh: [bash] }`), and reads a path under a volume's mount as the same path under the pod's folder. The registries and proxies live in `packages/adapter-sdk/src/testing/net/` and are exported as `@ostra/adapter-sdk/testing/net`, apart from `./testing` because that entry loads vitest and ticket 36's dev tools don't run under it; the certificates are made in memory (`certs.ts`), and a small client (`oci-client.ts`) answers the registry's Basic or bearer challenge. The npm registry serves a stand-in CLI (`packFakeCli`) until the CLI is published (ticket 22). Spike 6's real-nginx runner isn't ported: it needs a binary (ticket 35). `ws` 8.23.0 and `@types/ws` 8.18.2 join the SDK's dev dependencies, for the proxies' test; `eslint.config.js` turns off two prototype rules for the kubernetes package, whose client models are data-only classes. Proof: notes in `context/proof/F-093.md`, `F-120.md`, `F-061.md` and `F-013.md`, since seams prove no feature row. Commit: see the next line.
