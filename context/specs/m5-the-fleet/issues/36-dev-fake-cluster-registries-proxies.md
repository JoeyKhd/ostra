# 36: Dev tools: the fake cluster, the registries and the proxies

Status: done
Builder: core
Blocked by: 06
Features: F-093, F-120, F-061, F-013 (the demo's tools)
Packages: `e2e/m5-the-fleet/` (new: `src/dev/`), `package.json` (`dev:fake-kube`, `dev:registry`, `dev:npm-registry`, `dev:net-proxies`), `scripts/dev.ts` (`OSTRA_DEV_CORE_REPLICAS`), `docs/development.md`
Spec: `../spec.md`, section 3 ("Before")

## What to build

- **`pnpm dev:fake-kube [--process]`:** ticket 06's fake Kubernetes API on a local port, with a kubeconfig written to `.data/fake-kube/kubeconfig` for the runner and for `kubectl`-free scripts, the scale-up switch on a command (`pnpm dev:fake-kube hold 40s`), and the process mode.
- **`pnpm dev:registry`:** the fake OCI registry with a push and a pull credential printed once to the terminal, and a seeded image.
- **`pnpm dev:npm-registry`:** the fake npm registry serving the CLI packed at the current version and one patch above.
- **`pnpm dev:net-proxies`:** the CONNECT proxy, the TLS-inspecting proxy with its mode switchable at runtime, and the nginx emulation, with the CA written for `NODE_EXTRA_CA_CERTS`.
- **`OSTRA_DEV_CORE_REPLICAS`** in `pnpm dev`: N core replicas and one `web`, for the demo and the load test.
- Each refuses to start outside development and test, binds to loopback only, and is listed in `docs/development.md`.

## Done when

- [x] Tests: each tool starts, answers its health check and stops cleanly; each refuses with `NODE_ENV=production`.
- [x] Committed as `🔧 add the fleet's dev tools`.

## Comments

- 2026-11-19: built in `e2e/m5-the-fleet/src/dev/` (`@ostra/e2e-m5`), with `pnpm dev:fake-kube`, `dev:registry`, `dev:npm-registry` and `dev:net-proxies` at the root and `OSTRA_DEV_CORE_REPLICAS` in `scripts/dev-stack.ts` and `scripts/dev.ts` (each replica on the next port after `OSTRA_CORE_PORT`, told it; runners get the first one's address). Each tool binds to loopback, says it's ready over IPC for its test, stops on Ctrl-C, SIGTERM or `{ type: "stop" }`, and refuses unless `NODE_ENV` is `development` or `test` (unset counts as development, as for `pnpm dev:seed-member`). Two differences from the ticket: the kubeconfig is in `.ostra-dev/fake-kube/kubeconfig`, the repo's gitignored dev data folder, not `.data/`; and `hold 40s` reaches the running fake through a token-guarded `POST /_fake/hold` that ticket 06's fake gained, with `fail-pull`, `clear-pull-failures` and `minor` beside it. The proxies reach the dev core over plain HTTP, so ticket 06's proxies take `upstreamCa: null`. The npm registry serves ticket 06's stand-in CLI at the checkout's version and one patch above until the CLI is published (ticket 22). The settings are in `docs/configuration.md`, the tools in `docs/development.md`. Tests: `e2e/m5-the-fleet/src/dev/dev-tools.test.ts` and `scripts/dev-stack.test.ts`; they failed when the guard let production through, when the hold switch did nothing, when the inspecting proxy's mode didn't switch and when the replicas shared a port. Commit: see the next line.
