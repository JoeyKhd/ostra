# 29: `pnpm dev`: one command for the whole dev stack

Status: resolved
Builder: core
Blocked by: 05
Features: F-001 (the dev path on this machine)
Packages: root `package.json`, `scripts/dev.ts` (new), `docs/development.md`
Spec: `../spec.md`, section 3, step 1

## What to build

- `pnpm dev`: start the dev database (ticket 05) unless `DATABASE_URL` is set, run the migrations, then start `apps/core` and `apps/web` in watch mode, with their output prefixed. Print the panel's and core's addresses, and the setup token line from the web server's log (ticket 30) when there's no account yet. Ctrl-C stops everything and leaves no process.
- Each piece starts when it exists: while `apps/web` or `apps/core` have no server yet, `pnpm dev` says so and starts the rest.
- `docs/development.md`: "Run it" with `pnpm dev`, `pnpm dev:reset`, and how to start a runner from source (`pnpm ostra runner --server http://localhost:8787`).

## Done when

- [ ] From a clean clone on this machine: `pnpm install && pnpm dev` brings up Postgres and whatever servers exist, and Ctrl-C leaves no `node` or `postgres` process of the stack (checked with the process list).
- [ ] With `DATABASE_URL` set, no embedded Postgres starts.
- [ ] Root checks pass.
- [ ] Committed as `🔧 add pnpm dev for the whole stack`.

## Comments

- 2026-11-18, core: done in the commit that carries this line (`🔧 add pnpm dev for the whole stack`). `scripts/dev.ts` with its pure helpers in `scripts/dev-stack.ts` (tested). Stopping: the servers' process trees first (`taskkill /T` on Windows, the process group elsewhere), then a `stop` message to the dev database over IPC, since Windows has no signal one process can send another; `packages/db/scripts/dev-postgres.ts` gained that listener and stops when `pnpm dev` goes away (additive). Checked on this machine by starting the script with an IPC channel and stopping it: every PID it started is gone, a second start works, and with `DATABASE_URL` set no embedded Postgres starts. Core and web aren't started yet (no `dev` script); core's comes with ticket 24. embedded-postgres leaves a stale `postmaster.pid` on Windows after its own stop; the process is gone and the next start is fine.
