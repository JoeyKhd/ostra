# 03: Adapter SDK: the eight base classes and capabilities

Status: ready-for-agent
Builder: contracts
Blocked by: 01, 02
Features: ADR 0025 (every kind); F-006, F-019, F-088, F-017, F-016 depend on it
Packages: `packages/adapter-sdk`
Spec: `../spec.md`, section 5.2

## What to build

One abstract class per kind (ADR 0025): `TrackerAdapter`, `CodeHostAdapter`, `AgentAdapter`, `ExecutorAdapter`, `ModelProviderAdapter`, `NotificationAdapter`, `SecretStoreAdapter`, `BlobStoreAdapter`. `AGENTS.md` still names `RunnerProviderAdapter`; ADR 0025 as amended replaces it with `ExecutorAdapter`.

- `src/<kind>/base.ts` per kind, each with `abstract readonly name`, `abstract readonly capabilities`, `abstract health()` and the operations in the spec's table. Inputs and outputs use branded IDs and Zod-inferred types from `@ostra/protocol` or from schemas in this package.
- `src/<kind>/capabilities.ts`: a typed capabilities object per kind. Optional abilities are declared, never assumed. `CodeHostAdapter.capabilities.lfsActionHosts` is a list (ADR 0030, Q119). `ExecutorAdapter.capabilities.isolation` is `"container" | "none"`.
- `AgentAdapter` leaves the driver to a protected composed member that ticket 09 provides. Here, declare the operations and a `DriverPort` type the base class calls, so 09 only fills it in.
- `ExecutorAdapter.startAgent` returns the agent's stdio streams and a process handle: spike 3's `AgentHost` seam, so the same driver runs a local child (`host`) or a process in another container (`docker`).
- `src/registry.ts`: register and look up adapters by kind and name, typed so a lookup by kind returns that kind's base class.
- Errors: each operation's expected failures are a result union. Throw only for bugs.

## Done when

- [ ] All eight classes exist. The four kinds milestone 1 doesn't implement (tracker, notification, blob store, and the parts of the others marked "declared" in the spec) carry their operations with doc comments naming their milestone.
- [ ] A test per kind defines a minimal subclass in the test file and checks that the registry returns it typed, and that a missing operation is a type error (`@ts-expect-error` with a reason).
- [ ] `pnpm check:licenses` shows `adapter-sdk` depends on nothing restricted.
- [ ] Package checks pass.
- [ ] Committed as `✨ add the adapter base classes`.

## Comments
