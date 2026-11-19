# 27: Core: services and where a task may run

Status: done
Builder: core
Blocked by: 07
Features: F-094
Packages: `apps/core` (`src/dispatch/`), `packages/domain` (milestone 1's scheduler)
Spec: `../spec.md`, section 4 ("Services"); ADR 0038 (amended), ADR 0029

## What to build

- **The spec's services** from the environment's `Service` rows, their secret variables delivered through the credentials endpoint after the lease check, never in the spec.
- **Where it may run:** a task whose environment has a service is offered only to a runner whose executor declares `services`. A runner's executor and capabilities come from its `hello` (milestone 1). With no such runner online in the project's pools, or the member's own personal runner on `host`, the task stays queued and its dispatch note says "needs a runner that can start services (the `docker` executor); only `host` runners are online" (Q132's offered-to note is the same field).
- **Health:** `service.healthy` and `service.failed` are stored on the box's session; a failed service makes the setup fail (`setup_failed`), with the service's name and reason, as F-050's setup failure does.

## Done when

- [x] Tests: a task with a service is never offered to a `host` runner and waits with the note; it's offered to a `docker` runner; a failed service raises `setup_failed`; a service's secret is in the credentials response and nowhere else.
- [x] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `core` and `domain`.
- [x] Committed as `✨ schedule tasks whose environment has services`.

## Comments

- 2026-11-19, core: done in `✨ schedule tasks whose environment has services`. **Where it may run:** `dispatchTask` counts the project's `Service` rows, and with any it offers the task only to a runner that `runnerStartsServices` (`packages/domain/src/environment/services.ts`): the `docker` executor at protocol minor 2, since a runner's `hello` carries its executor and minor but not its capabilities, and services are a minor-2 spec section; `kubernetes` gets them with F-093. Every path filters: the kept box's runner, the picked personal runner, the owner's other personal runners on a reopen, and the project's pools. **The wait:** a new `DispatchWait` code, `needs-services-runner { online: [{ name, executor }] }`, when the runners online in that scope can't start services; when one that can is online but busy, the task waits for a slot as any task does (`no-runner-online`). Its milestone-1 `dispatchNote` reads "Needs a runner that can start services (the docker executor); only host runners are online." **The spec** carries each service with its plain variables only (`apps/core/src/dispatch/environment-spec.ts`); `Service.variables` holds `{ kind: "plain", name, value }` or `{ kind: "secret", name, secretRef }` (`serviceVariablesSchema`). **The credentials** gain an optional minor-2 field, `services: [{ name, variables }]`, with the secret values (protocol commit `✨ carry services' secrets in the credentials`); the audit entry counts them, never names a value. **Health:** `service.healthy` and `service.failed` are stored on the box's session; `service.failed` while the task is `preparing` moves it to `needs_you` (`setup_failed`) with a needs-you item whose summary names the service and the runner's reason, fails the box and releases the lease, as a crash does; one after the box was ready is stored only. Tests: `apps/core/src/dispatch/services.test.ts`, seven cases. Break-it checks: six (no services counted, no secrets in the credentials, a secret in the spec, the `preparing` guard, the minor-2 rule, a busy `docker` runner read as missing), each failing its case. Proof: `context/proof/F-094.md` (the scheduler's row `partial`; the `host` refusal is the executor suite's case). F-094 is `building`.
