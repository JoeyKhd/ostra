# 05: DB: dev Postgres, Prisma 7 and the test helper

Status: ready-for-agent
Builder: contracts
Blocked by: none
Features: F-001 (the dev path on this machine)
Packages: `packages/db`, root `package.json`, `.gitignore`, `docs/development.md`
Spec: `../spec.md`, section 5.3

## What to build

- Add `prisma`, `@prisma/client` and `@prisma/adapter-pg` at 7.10.1, `pg` 8.23.1 and `@types/pg` 8.23.1, exact pins. `embedded-postgres` 18.6.0-beta.19 as a **dev dependency only** (approved in ADR 0007).
- `packages/db/prisma.config.ts` and an empty `schema.prisma` with the generator and datasource (ticket 06 fills the models).
- `packages/db/scripts/dev-postgres.ts`: starts `embedded-postgres` in `.ostra-dev/pg` at the repo root on a port from `OSTRA_DEV_PG_PORT` (default 54329) and prints the `DATABASE_URL` it serves. When `DATABASE_URL` is set, it does nothing and says so. It stops cleanly on Ctrl-C and on SIGTERM, and leaves no `postgres` process behind.
- Root scripts: `pnpm db:dev`, `pnpm db:migrate`, `pnpm db:generate`, `pnpm dev:reset` (stops the dev database and deletes `.ostra-dev/`, after a confirmation flag `--yes`).
- `.gitignore`: `.ostra-dev/`.
- `src/client.ts`: `createDb(databaseUrl)` on `@prisma/adapter-pg`, and the exported transaction type.
- `src/testing/test-database.ts`: one embedded instance per Vitest run (global setup), and a fresh database per test file, migrated, dropped afterwards. With `DATABASE_URL` set, it creates databases on that server instead.
- `docs/development.md`: a "Database" section: the embedded default, the override, the reset.

## Port from

`spikes/auth-foundation/src/db/` (bootstrap, migrate, provision-database) and `spikes/durable-queue-choice/src/cluster.ts` for starting and stopping.

## Done when

- [ ] On this machine, from a clean clone: `pnpm db:dev` starts Postgres, `pnpm db:migrate` runs against it, Ctrl-C leaves no process (checked with the process list).
- [ ] With `DATABASE_URL` set to another server, the dev script doesn't start one.
- [ ] A sample test in `packages/db` gets its own database and sees it empty.
- [ ] `.ostra-dev/` is ignored and nothing under it is staged.
- [ ] The whole-repo checks pass (spec section 9: the schema's tooling).
- [ ] Committed as `🔧 add the dev database and Prisma setup`.

## Comments
