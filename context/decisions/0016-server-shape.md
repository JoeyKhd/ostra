# The server: Next.js and a core service in one image

**Status:** accepted (plan signed off 2026-11-17). Chosen on 2026-11-17 in grilling round 3.

One Docker image runs two processes, which share the database and the domain packages:

- **Next.js:** the panel, better-auth and tRPC.
- **The core service:** runner connections, webhooks, and the durable queue and timers that ADR 0011 needs.

Both run on Node LTS. How the runner ships is ADR 0023.

## Considered options

- **A Next.js custom server doing everything in one process.** Rejected: long-lived runner connections and background work would be tied to the web server's lifecycle.
- **Dropping Next.js for a plain server and a single-page app.** Rejected: it loses the stack in ADR 0007.

## Consequences

- Domain logic lives in packages that both processes import. Neither process holds logic the other needs.
- Only the core service talks to runners. The panel reaches them through it.
