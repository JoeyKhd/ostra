# 36: Dev tools: the fake cluster, the registries and the proxies

Status: ready-for-agent
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

- [ ] Tests: each tool starts, answers its health check and stops cleanly; each refuses with `NODE_ENV=production`.
- [ ] Committed as `🔧 add the fleet's dev tools`.

## Comments
