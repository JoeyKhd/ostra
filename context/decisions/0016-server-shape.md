# The server: Next.js and a core service in one image

**Status:** accepted (plan signed off 2026-11-17). Chosen on 2026-11-17 in grilling round 3. Amended 2026-11-18: the one image has three roles, `web`, `core` and `all`, and any number of replicas of each can run (Q82, Q18).

One Docker image holds the server. Its one entrypoint, `ostra-server`, starts one of three roles, which share the database and the domain packages:

- **`ostra-server web`:** Next.js: the panel, better-auth and tRPC.
- **`ostra-server core`:** the core service: runner connections, webhooks, and the durable queue and timers that ADR 0011 needs (pg-boss, ADR 0037).
- **`ostra-server all`:** both roles together, for a one-machine install and for development.

Any number of replicas of each role can run. Every server process is stateless, and Postgres does the routing (Q18).

Both roles run on Node LTS. Two more images ship beside the server image: the runner and the base image for boxes. How they ship is ADR 0046 (it replaces ADR 0023).

## Considered options

- **A Next.js custom server doing everything in one process.** Rejected: long-lived runner connections and background work would be tied to the web server's lifecycle.
- **Dropping Next.js for a plain server and a single-page app.** Rejected: it loses the stack in ADR 0007.

## Consequences

- Domain logic lives in packages that every role imports. No role holds logic another needs.
- Only the core service talks to runners. The panel reaches them through it.
- One server image keeps a `docker compose` install and a Kubernetes install on the same build (Q82).
