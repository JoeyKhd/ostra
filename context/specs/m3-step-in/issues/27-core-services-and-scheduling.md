# 27: Core: services and where a task may run

Status: ready-for-agent
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

- [ ] Tests: a task with a service is never offered to a `host` runner and waits with the note; it's offered to a `docker` runner; a failed service raises `setup_failed`; a service's secret is in the credentials response and nowhere else.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `core` and `domain`.
- [ ] Committed as `✨ schedule tasks whose environment has services`.

## Comments
