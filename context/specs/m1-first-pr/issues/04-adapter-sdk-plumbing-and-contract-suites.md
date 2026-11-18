# 04: Adapter SDK: shared plumbing and contract-test helpers

Status: ready-for-agent
Builder: contracts
Blocked by: 03
Features: ADR 0025 (plumbing, contract suites), ADR 0045 (injected stores)
Packages: `packages/adapter-sdk`
Spec: `../spec.md`, sections 5.2 and 8

## What to build

- `src/plumbing/stores.ts`: `RateBudgetStore`, `IdempotencyStore`, `SecretRowStore` as small interfaces, plus in-memory implementations under `src/testing/`. `adapter-sdk` never imports `db` (ADR 0045).
- `src/plumbing/retry.ts`: retry with exponential backoff and full jitter, honouring a `Retry-After` it's given, cancellable by an `AbortSignal`.
- `src/plumbing/rate-budget.ts`: a budget per credential, fed by response headers, that tells the caller to wait until a reset instead of overspending.
- `src/plumbing/idempotency.ts`: record a key before a call, or check first whether it already happened.
- `src/plumbing/vendor.ts`: `parseVendor(schema, data)` for vendor formats (loose objects), returning a result.
- `src/plumbing/logger.ts`: a structured logger interface that takes a message and a record of IDs and fields. A guard refuses a `TaskCredentials` value by type and redacts any string field that looks like a token (prefixes such as `ghs_`, `sk-`, `ostra-fake-`, long base64 runs). Tests prove both.
- `src/testing/` exported as `@ostra/adapter-sdk/testing` (a subpath in `package.json` `exports`):
  - `defineCodeHostContractSuite`, `defineAgentContractSuite`, `defineExecutorContractSuite`, `defineModelProviderContractSuite`, `defineSecretStoreContractSuite` with the cases spec section 8 names. Each takes a factory and its fakes and registers Vitest cases.
  - `defineTrackerContractSuite`, `defineNotificationContractSuite`, `defineBlobStoreContractSuite` with their first cases (health, capabilities declared).
  - The executor suite includes the case ADR 0029 asks for: start a detached helper, stop the task, check nothing is left. It can be marked expected-to-fail per platform by the adapter, with a reason.

## Done when

- [ ] The plumbing has unit tests, including the logger guard.
- [ ] Each `define*ContractSuite` runs against a tiny test adapter in this package and passes.
- [ ] Package checks and `pnpm check:licenses` pass.
- [ ] Committed as `✨ add adapter plumbing and contract suites`.

## Comments
