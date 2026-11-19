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

- [x] From a clean clone on this machine: `pnpm install && pnpm dev` brings up Postgres and whatever servers exist, and Ctrl-C leaves no `node` or `postgres` process of the stack (checked with the process list).
- [x] With `DATABASE_URL` set, no embedded Postgres starts.
- [x] Root checks pass.
- [x] Committed as `🔧 add pnpm dev for the whole stack`.

## Comments

- 2026-11-18, core: done in the commit that carries this line (`🔧 add pnpm dev for the whole stack`). `scripts/dev.ts` with its pure helpers in `scripts/dev-stack.ts` (tested). Stopping: the servers' process trees first (`taskkill /T` on Windows, the process group elsewhere), then a `stop` message to the dev database over IPC, since Windows has no signal one process can send another; `packages/db/scripts/dev-postgres.ts` gained that listener and stops when `pnpm dev` goes away (additive). Checked on this machine by starting the script with an IPC channel and stopping it: every PID it started is gone, a second start works, and with `DATABASE_URL` set no embedded Postgres starts. Core and web aren't started yet (no `dev` script); core's comes with ticket 24. embedded-postgres leaves a stale `postmaster.pid` on Windows after its own stop; the process is gone and the next start is fine.
- 2026-11-19, review: the clean-clone box is checked, after two fixes the clone found. (1) `pnpm install && pnpm dev` on a fresh clone failed: core could not load `packages/db/src/generated/prisma/client.ts`, because Prisma's client is generated and gitignored, and `pnpm dev` never generated it (only Turborepo's typecheck, lint and test do). `scripts/dev.ts` now runs `packages/db/scripts/generate.ts` between the database and the migrations (6872519). (2) A clone under a 123-character path made initdb exit with 3221225734 (`STATUS_NAME_TOO_LONG`, Windows' 260-character limit inside `node_modules/.pnpm`); a 27-character path works. `docs/development.md` says to keep the path short. Then, on the clone (`C:/Users/santi/ostra-fresh`, a hidden console started with PowerShell): `pnpm install`, `pnpm dev` came up (Postgres, the migrations, core on 8787, the panel on 3000), `pnpm e2e:m1` ran against it, and a console Ctrl-C (`GenerateConsoleCtrlEvent` to that console, as a terminal sends it) left no process in the console's tree, no `node` or `postgres` process naming the clone, and nothing listening on 54329, 8787 or 3000. Done twice, from an empty `.ostra-dev` each time. The `DATABASE_URL` box rests on the earlier check and `scripts/dev-stack.test.ts`.
