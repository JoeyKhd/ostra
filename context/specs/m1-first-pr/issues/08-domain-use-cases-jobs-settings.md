# 08: Domain: use-case signatures, jobs catalogue, settings

Status: resolved
Builder: contracts
Blocked by: 07
Features: the seams core and api build against; the self-hosting rule (`AGENTS.md`)
Packages: `packages/domain`, `docs/configuration.md` (new)
Spec: `../spec.md`, section 5.4

## What to build

- `src/ports.ts`: `JobQueue` (`enqueueInTx(tx, job, payload, options)`), `CommandOutbox` (`enqueueInTx(tx, runnerId, command)`, taking the runner's counter under its lock and sending the `NOTIFY` on commit), `ChangeNotices` (`emitInTx(tx, notice)`), `Clock`, and `ServerAdapters` (the code host, model provider and secret store instances).
- `src/jobs.ts`: the job catalogue: each job's name and Zod payload, carrying IDs only, with its key rule (`task:<TaskId>:<transition>:<seq>`, ADR 0037). Milestone 1's jobs: `task.dispatch`, `task.offer-timeout`, `task.grace`, `task.session-ended`, `task.open-pull-requests`, `provider.refresh-models`, `catalog.refresh`.
- `src/use-cases/*.ts`: one file per use case in the spec, each exporting its input schema, its result union and a function signature whose body throws `new Error("not implemented: ticket NN")`, naming the ticket that writes it. Tests for each body come with that ticket.
- `src/access.ts`: `requireOrganizationMember`, `requireOrganizationAdmin`, `requireProjectAccess` (open or restricted, ADR 0026), as pure checks over a member scope.
- `src/settings.ts`: the server's settings as one strict Zod schema over `process.env`, with a working default for each. Milestone 1's: `DATABASE_URL` (default: the dev database's URL in development, required in production), `OSTRA_WEB_PORT` (3000), `OSTRA_CORE_PORT` (8787), `OSTRA_PUBLIC_URL` (the panel's address, default `http://localhost:3000`), `OSTRA_CORE_PUBLIC_URL` (default `http://localhost:8787`), `OSTRA_DATA_DIR` (default `.ostra-dev/server` in development), `OSTRA_SECRETS_KEY` (generated on first start when unset, spec section 11), `OSTRA_CATALOG_FETCH` (on), `OSTRA_OPEN_SIGNUP_ACCOUNTS` and `OSTRA_OPEN_SIGNUP_ORGANIZATIONS` (both off), `BETTER_AUTH_SECRET` (generated into the data folder when unset), `OSTRA_SETUP_TOKEN` (generated and printed in the server's log at first start when unset; it stops working once the first account exists: F-001, Q117).
- `docs/configuration.md`: the configuration reference. One line per setting: name, default, what it does. A section for the runner's settings, from ticket 02's config schema. A note at the top that every new setting adds its line here.

## Done when

- [x] Every use case the spec lists has its file, schema, result union and signature, and the "not implemented" body names its ticket.
- [x] The settings schema parses an empty environment in development with every default, and refuses an unknown `OSTRA_*` variable with the list of known ones.
- [x] `docs/configuration.md` lists every setting the schema knows. A test reads both and fails when one is missing.
- [x] Package checks pass.
- [x] Committed as `✨ add use-case seams and server settings`.

## Comments

- 2026-11-18, contracts: done in 0933c51 (`✨ add use-case seams and server settings`). `ports.ts` (`JobQueue`, `CommandOutbox`, `ChangeNotices`, `AuditLog`, `Clock`, `ServerAdapters`), `jobs.ts` (seven jobs, keys like `task:<TaskId>:dispatch:<epoch>`), `access.ts` (another organization and a restricted project read as `not-found`), `settings.ts` and `docs/configuration.md`, kept in step by a test. The 14 use cases each have an input schema (where they take a request), a result union and a signature whose body throws `not implemented: ticket NN`. The settings let the runner's and the dev setup's `OSTRA_*` variables through, and refuse any other unknown one.
