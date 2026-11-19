# Developing ostra

## Local secrets

This repo is public, so secrets never go in it, nor in its folder on disk. Keep them outside the repo, one file per service:

```
~/.config/ostra-dev/
├── linear.env       LINEAR_API_KEY (personal, for the test Linear workspace), LINEAR_TEST_TEAM_KEY and
│                    LINEAR_TEST_TEAM_ID; the Linear app's LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET and
│                    LINEAR_WEBHOOK_SECRET; LINEAR_REFRESH_TOKEN once the app is authorized; and
│                    LINEAR_APP_TOKEN only if the app's client-credentials grant is switched on
├── github.env       the test GitHub App's ID, private key path and webhook secret
├── github-test.env  the test org and repos, the App's installation ID, and GITHUB_TEST_ADMIN_TOKEN
│                    (administration on test2 only, for the demo's signed-commit ruleset)
├── model.env        OSTRA_DEV_MODEL_BASE_URL, OSTRA_DEV_MODEL_API_KEY and OSTRA_DEV_MODEL_ID
└── tunnel.env       whatever the chosen tunnel needs to give the dev server a public address
```

`model.env` points at any model endpoint: an API base URL, a bearer token and a model ID. ostra never assumes a particular provider, and neither does its development setup.

The code reads secrets only from the environment. Load a file into your shell when you need it, for example `set -a; . ~/.config/ostra-dev/linear.env; set +a`.

Develop and test only against ostra's own test workspaces: a Linear workspace and a GitHub org set up for ostra (`AGENTS.md`).

Never paste a secret into a chat, a ticket, a commit message or a log. `.gitignore` blocks common secret files (`.env`, `*.pem`, `*.key`) as a backstop, not as the plan.

## Working in the repo

You need Node 24.2 or newer and pnpm 11. The exact pnpm version is pinned in `package.json`, and Corepack (`corepack enable`) picks it up.

```
pnpm install      # installs every workspace package from the lockfile
pnpm typecheck    # tsc in every package, strict, through Turborepo
pnpm lint         # ESLint (typescript-eslint strict-type-checked) in every package
pnpm test         # Vitest in every package, plus the repo's own scripts
pnpm build        # Turborepo's build task, for the packages that have one
```

`pnpm format` runs Prettier over the code. `spikes/` is outside the workspace, and each spike has its own `pnpm-workspace.yaml`.

Every package is `private: true` for now, including the ones ADR 0045 lists as published (`runner`, `protocol`, `adapter-sdk` and the adapters). Their `exports` point at TypeScript source, and publishing starts at the v1 launch in milestone 7. That commit removes `private` and adds a built `exports` and `publishConfig`.

**The license check.** `pnpm check:licenses` reads every workspace package's `package.json`. It fails when a package declares no license, or when an Apache-2.0 package depends on a restricted one, today one under the Sustainable Use License, directly or through another package (ADR 0048, ADR 0045). CI runs it with the other checks, so run it before you push a new dependency between packages.

## Run it

```
pnpm dev                 # the whole dev stack: the dev database, the migrations, core and the panel
pnpm dev:reset           # says what it would delete; `pnpm dev:reset --yes` deletes .ostra-dev/
```

`pnpm dev` starts the dev database (below) unless `DATABASE_URL` is set, generates Prisma's client (a fresh clone has none), applies the migrations, then starts `apps/core` and `apps/web` in watch mode. Each line of output carries its piece's label (`[db  ]`, `[core]`, `[web ]`), and the terminal shows the panel's address (`http://localhost:3000`, `OSTRA_WEB_PORT`) and core's (`http://localhost:8787`, `OSTRA_CORE_PORT`). On an empty database the panel creates the first admin at start (F-001), and `pnpm dev` says in a box how to sign in: `demo@demo.com` (or `demo`) with the password `demo`, which the panel then asks you to change. `OSTRA_ADMIN_EMAIL`, `OSTRA_ADMIN_USERNAME`, `OSTRA_ADMIN_PASSWORD` and `OSTRA_ORGANIZATION_NAME` seed another account instead (`docs/configuration.md`). A server whose package has no `dev` script yet isn't started, and `pnpm dev` says so.

Ctrl-C stops everything: the servers' process trees first, then the dev database, which stops Postgres. No `node` or `postgres` process of the stack is left. If one is (after a crash of the terminal, say), `pnpm dev:reset --yes` stops the dev cluster.

**Windows: keep the checkout path short.** The embedded Postgres unpacks deep inside `node_modules/.pnpm`, and Windows' 260-character path limit stops it (initdb exits with code 3221225734, `STATUS_NAME_TOO_LONG`) when the checkout's own path is long: it failed at 123 characters and worked at 27. Clone to something like `C:\src\ostra`.

**A runner, from source.** With the stack running, start a personal runner on the same machine in another terminal:

```
pnpm ostra runner --server http://localhost:8787
```

It prints a code and the panel's `/device` address. Approve the code in the panel, and the runner shows up online. Once `ostra` is published, `ostra runner` does the same (ADR 0046).

**Milestone 1's demo** (`e2e/m1-first-pr/`, ticket 39). With `pnpm dev` running on an empty data folder, and the dev secrets loaded, it drives the panel in Chromium from the first admin to a PR on the test repo, runs the checks after the run, and closes everything but the final PR. It signs in as the admin the stack seeded, with the same `OSTRA_ADMIN_*` variables and defaults as the server, and on a fresh stack changes the default password to one it keeps in `.ostra-dev/e2e-m1/`. For the PR's `Co-authored-by` to link to the test member's GitHub account, start the stack with `OSTRA_ADMIN_EMAIL=<GITHUB_TEST_MEMBER_LOGIN>@users.noreply.github.com`:

```
set -a; . ~/.config/ostra-dev/model.env; . ~/.config/ostra-dev/github.env; . ~/.config/ostra-dev/github-test.env; set +a
pnpm e2e:m1
```

It keeps screenshots in `context/specs/m1-first-pr/demo/`, its runner's folder in the system temp folder (outside the repo, so the agent doesn't read ostra's own `AGENTS.md`), and the result in `.ostra-dev/e2e-m1/result.json`. A step that already happened is skipped, so it can be run again on the same stack. `OSTRA_E2E_STACK_LOG` names a file with the stack's output, to search it for credentials too. `pnpm --filter @ostra/e2e-m1 clean-up` closes the demo's PRs and deletes its branches and hidden refs.

## Database

ostra keeps everything in Postgres. In development you don't need to install one: `packages/db` starts an embedded Postgres (the `embedded-postgres` package, a development dependency only, ADR 0007).

```
pnpm db:dev        # starts Postgres in .ostra-dev/pg on port 54329 and prints its DATABASE_URL; Ctrl-C stops it
pnpm db:migrate    # applies packages/db/prisma/migrations to it (or to DATABASE_URL)
pnpm db:generate   # writes Prisma's client to packages/db/src/generated/ (Turborepo runs it before typecheck, lint and test)
pnpm dev:reset     # says what it would delete; `pnpm dev:reset --yes` stops the dev database and deletes .ostra-dev/
```

- **The embedded default.** The cluster lives in `.ostra-dev/pg` at the repo root, which is gitignored, and listens on 127.0.0.1 with a fixed local user (`ostra`/`ostra`). `OSTRA_DEV_PG_PORT` changes the port. Every embedded cluster is UTF-8 with the C locale, whatever the machine's locale: a cluster made before that (on Windows, WIN1252) refuses an emoji in an agent's message, and `pnpm db:dev` says to run `pnpm dev:reset --yes`.
- **The override.** Set `DATABASE_URL` to use another Postgres server instead. `pnpm db:dev` then does nothing and says so, `pnpm db:migrate` migrates that database, and the tests create their throwaway databases on that server.
- **The reset.** `pnpm dev:reset --yes` stops the dev cluster (only after the server on its port confirms the data folder is the dev cluster's) and deletes `.ostra-dev/`. Use it when a crashed `pnpm db:dev` left Postgres running.
- **Tests.** A package's tests get one embedded Postgres per run and a fresh, migrated database per test file: add `globalSetup: [fileURLToPath(import.meta.resolve("@ostra/db/testing/global-setup"))]` to its `vitest.config.ts`, then call `createTestDatabase()` from `@ostra/db/testing` in `beforeAll`. `seedIsolationFixture` seeds two organizations and a restricted project, for the isolation checks every data test makes (ADR 0026).
- **New migrations.** Change `packages/db/prisma/schema.prisma`, then, with `pnpm db:dev` running, `pnpm --filter @ostra/db exec prisma migrate dev --name <what-changed>`. Migrations run on other teams' installs: add first, and drop or rename only in a later release (`AGENTS.md`). Raw SQL that Prisma can't declare (check constraints, the `UNLOGGED` live-text table in the `ostra_live` schema) goes at the end of a migration, marked `ostra:`.
