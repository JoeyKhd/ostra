# Developing ostra

## Local secrets

This repo is public, so secrets never go in it, nor in its folder on disk. Keep them outside the repo, one file per service:

```
~/.config/ostra-dev/
├── linear.env       LINEAR_API_KEY (personal, for the test Linear workspace), LINEAR_TEST_TEAM_KEY and
│                    LINEAR_TEST_TEAM_ID; the Linear app's LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET and
│                    LINEAR_WEBHOOK_SECRET; LINEAR_REFRESH_TOKEN once the app is authorized; and
│                    LINEAR_APP_TOKEN only if the app's client-credentials grant is switched on
├── email.env        RESEND_API_KEY; EMAIL_FROM (an address on a domain verified in Resend, or
│                    Resend's onboarding sender, which mails only the account's own address); and
│                    EMAIL_TO, the maintainer's own address for milestone 3's manual demo; and
│                    EMAIL_TO_SAM and EMAIL_TO_RAE, two more addresses that reach the maintainer
│                    (plus addresses work), for milestone 4's manual run. Without this file, mail is
│                    proved on a fake Resend API and a local SMTP server, and milestone 4's scripted
│                    run sends its mail to the local mail sink (ticket 40)
├── github.env       the test GitHub App's ID, slug, client ID and secret, private key path, and
│                    GITHUB_APP_WEBHOOK_SECRET once the App's webhook is on
├── github-test.env  the test org and repos, the App's installation ID, GITHUB_TEST_ADMIN_TOKEN
│                    (administration on test2 only, for the demo's signed-commit ruleset),
│                    GITHUB_TEST_MEMBER_TOKEN (the linked member's own GitHub user, for milestone 3's
│                    `@ostra` comments), GITHUB_TEST_REVIEWER_TOKEN (a second user, linked to no
│                    member, a collaborator on test1 and test2 who can approve) and, for milestone
│                    4's two clients, GITHUB_TEST_ORG_B and GITHUB_TEST_REPO_B (a second test org
│                    and its one repo) and GITHUB_TEST_ORG_B_TOKEN (contents write on that repo only)
├── github-b.env     optional: GITHUB_B_APP_ID and GITHUB_B_APP_PRIVATE_KEY_PATH, an App the second
│                    test org owns, for milestone 4's "Connect another App"
├── model.env        OSTRA_DEV_MODEL_BASE_URL, OSTRA_DEV_MODEL_API_KEY and OSTRA_DEV_MODEL_ID
├── model-b.env      OSTRA_DEV_MODEL_B_BASE_URL and OSTRA_DEV_MODEL_B_API_KEY, a second key serving
│                    model.env's model under the same models.dev ID (milestone 4's second client)
└── tunnel.env       whatever the chosen tunnel needs to give the dev server a public address
```

`model.env` points at any model endpoint: an API base URL, a bearer token and a model ID. ostra never assumes a particular provider, and neither does its development setup.

Milestone 4's second GitHub organization, `github-b.env` and `model-b.env` are optional. Without them, its tests use the fake GitHub's second account and two stub model endpoints, which prove F-135 and F-136 on their own; only the live run with two clients needs them (ticket 55).

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

**The proof check.** `pnpm check:proof` reads `context/features.md` and `context/proof/`. It fails when a `done` row lacks a proof for any sentence of its "done when", or cites a test that doesn't exist, doesn't run or doesn't name the row's ID, and warns about the rows still `building`. `pnpm proof:new F-nnn` writes a row's proof file. CI runs it with the other checks. The rules: `context/proof/README.md`.

**The images.** `pnpm check:images` checks the three Dockerfiles in `deploy/` and the compose file without Docker (`packages/deploy-checks`): every `FROM` pinned by digest, OpenCode's checksum from `@ostra/adapter-opencode`'s pin, no secret-shaped `ARG`, `ENV` or `RUN`, non-root server and runner, and the compose file running the tags the build gives. Its tests run in CI. `pnpm images:build` builds the three, tagged with the release version (`ostra/server`, `ostra/runner`, `ostra/base`), and prints their sizes; it runs on Linux with Docker only, and `pnpm images:build --plan` prints the builds anywhere. Nothing is pushed anywhere before milestone 7 (ADR 0046).

**The panel's browser checks.** `pnpm --filter @ostra/web test:e2e` builds the panel and runs its Playwright suite (`apps/web/e2e/`) on a throwaway stack: an embedded Postgres, a fake GitHub, a stub model endpoint in each API format, core and a runner on the `host` executor. A second stack, started with `OSTRA_ALLOW_DEFAULT_PASSWORD=true`, serves `06-default-password.spec.ts` (the `default-password` project). CI runs it in its own job. The first stack listens on 3100 to 3103 and the second on 3110 to 3113; `OSTRA_E2E_PORT` moves all eight, so two checkouts can run it at once.

## Run it

```
pnpm dev                 # the whole dev stack: the dev database, the migrations, core and the panel
pnpm dev:reset           # says what it would delete; `pnpm dev:reset --yes` deletes .ostra-dev/
```

`pnpm dev` starts the dev database (below) unless `DATABASE_URL` is set, generates Prisma's client (a fresh clone has none), applies the migrations, then starts `apps/core` and `apps/web` in watch mode. Each line of output carries its piece's label (`[db  ]`, `[core]`, `[web ]`), and the terminal shows the panel's address (`http://localhost:3000`, `OSTRA_WEB_PORT`) and core's (`http://localhost:8787`, `OSTRA_CORE_PORT`). Unless they're set, `OSTRA_PUBLIC_URL` and `OSTRA_CORE_PUBLIC_URL` follow those ports, so a second stack on other ports signs in (the panel checks the sign-in's origin against `OSTRA_PUBLIC_URL`) and sends its runners to its own panel. On an empty database the panel creates the first admin at start (F-001), and `pnpm dev` says in a box how to sign in: `demo@demo.com` (or `demo`) with the password `demo`, which the panel then asks you to change. `OSTRA_ADMIN_EMAIL`, `OSTRA_ADMIN_USERNAME`, `OSTRA_ADMIN_PASSWORD` and `OSTRA_ORGANIZATION_NAME` seed another account instead (`docs/configuration.md`). For a second member (milestone 3: a driver and a watcher, an approval from someone else), `pnpm dev:seed-member <username>` adds one to the first organization, with the email `<username>@example.com` and the password `seeded-member-password` unless `--email` and `--password` say otherwise, and `--role admin` for an admin. It runs only with `NODE_ENV` `development` or `test`. A server whose package has no `dev` script yet isn't started, and `pnpm dev` says so.

**The mail sink** (milestone 4, ticket 40). `pnpm dev:mail-sink` runs a local SMTP server on loopback until Ctrl-C, milestone 3's fake SMTP server (`EHLO`, no `STARTTLS`, `AUTH PLAIN`, `MAIL`, `RCPT`, `DATA`), and writes each mail it takes to `.ostra-dev/mail/<time>-<to>.eml`, so the invitation, verification and reset mails of a dev stack can be opened without a mail provider. It listens on port 2525 unless `OSTRA_MAIL_SINK_PORT` says otherwise, and writes elsewhere with `OSTRA_MAIL_SINK_DIR`. Point the stack at it with `OSTRA_EMAIL_PROVIDER=smtp OSTRA_SMTP_HOST=127.0.0.1 OSTRA_SMTP_PORT=2525 OSTRA_SMTP_SECURE=none OSTRA_EMAIL_FROM=ostra@mail.localhost`. The end-to-end runs read the newest mail to an address, its subject and its links, with `newestMailTo` from `@ostra/dev-tools/mail-box`.

**The dev GitHub link** (milestone 4, ticket 40). `pnpm dev:link-github <username> <github-login>` links a dev account to a GitHub user as the panel's "Link GitHub" would after its OAuth round trip (F-119), so a review by that user counts as the member's (F-104). It reads the user's numeric ID from GitHub's API with `GITHUB_TEST_ADMIN_TOKEN` (from the environment, or `~/.config/ostra-dev/github-test.env`; without one it asks GitHub unauthenticated), and writes an audit entry in each of the account's organizations that names the tool. Both tools run only with `NODE_ENV` `development` or `test` (unset counts as development, as for `pnpm dev:seed-member`), live in `e2e/dev-tools/`, and aren't in the production build.

**Milestone 5's dev tools** (ticket 36), for the fleet's demo and its tests, in `e2e/m5-the-fleet/src/dev/`. Each binds to loopback only, runs until Ctrl-C, and refuses to start unless `NODE_ENV` is `development` or `test` (unset counts as development). What they write lands in `.ostra-dev/` (`OSTRA_DEV_DATA_DIR`); their ports are in `docs/configuration.md`.

- `pnpm dev:fake-kube [--process]`: the fake Kubernetes API (`@ostra/adapter-executor-kubernetes/testing`) on `https://127.0.0.1:16443`, with a per-run CA, and its kubeconfig in `.ostra-dev/fake-kube/kubeconfig` for a `--executor kubernetes` runner and for scripts (no `kubectl` needed). Containers are simulated unless `--process` runs each one as a local process, with **no isolation and no limits**, which every line it writes says: the runner image's `ostra` is this checkout's CLI, the base image's `sh` this machine's shell. From another terminal, `pnpm dev:fake-kube hold 40s` holds the next pods unschedulable with the autoscaler's `TriggeredScaleUp` event, `pnpm dev:fake-kube fail-pull <image>` fails an image's pull until `pnpm dev:fake-kube clear-pull-failures`, and `pnpm dev:fake-kube minor 28` reports Kubernetes 1.28.
- `pnpm dev:registry`: the fake OCI registry on `http://127.0.0.1:15000`, with a push-only and a pull-only credential printed once in its terminal and kept nowhere, and a seeded image, `ostra/base:seed`.
- `pnpm dev:npm-registry`: the fake npm registry on `http://127.0.0.1:14873`, serving the CLI at this checkout's version and one patch above with their integrity, for the runner's pin (`OSTRA_RUNNER_NPM_REGISTRY`). Until the CLI is published, it's a stand-in named `ostra` whose `ostra` prints its version.
- `pnpm dev:net-proxies`: spike 6's networks in front of core (`OSTRA_CORE_PORT`): a CONNECT proxy on 13128, a TLS-inspecting proxy on 13129 whose mode `pnpm dev:net-proxies mode pass|block|hold` switches while it runs, and nginx's defaults on 13130 (the control port is 13131), with their CAs in `.ostra-dev/net-proxies/ca.pem` for `NODE_EXTRA_CA_CERTS`. Through the proxies, core is `ostra-core.test`.

`OSTRA_DEV_CORE_REPLICAS=3 pnpm dev` starts three core replicas (on `OSTRA_CORE_PORT` and the two ports after it) and one panel over the one dev database, for the demo and the load test.

**The load test** (ticket 34, F-117, ADR 0061). `pnpm load:run --tasks N` or `pnpm load:run --ramp` (100, 250, 500 and 1,000 tasks; `--ramp 25,50` names others) starts its own stack for each step, with no dev database touched: an embedded Postgres in `.data/load/<time>/` (or `DATABASE_URL`), three core replicas from `OSTRA_CORE_PORT` up, and a panel on `OSTRA_WEB_PORT` (`next start` when `apps/web` has a production build, `next dev` otherwise). Simulated runners (`apps/runner`'s own peer and spool, with a scripted agent at spike 10's event rates) join a pool through `packages/api` and a join token, in generator processes of 250 tasks each, and the tasks are started, steered and checked through `packages/api`. Each step's `results.json` and its `summary.md` say the steer's p50 and p99, events stored once, ack and ingest times, Postgres's CPU, each replica's memory, the reconnect storm and what 5 real browsers saw, and name the largest step that held every bar. Options: `--replicas`, `--slots` (a runner's, 1 by default, so a fleet has a connection per box as `docker` and `kubernetes` do), `--per-process`, `--browsers`, `--warmup`, `--window`, `--steers`, `--transport`. Every child it starts ends with it. The run that counts is 1,000 tasks on a Linux machine of 16 or more vCPUs with its own Postgres (ticket 38).

**The live proof scripts** (ticket 35, ADR 0061). `scripts/live/docker.sh`, `scripts/live/kind.sh` and `scripts/live/macos.sh` are the steps of the `Proof` workflow's `live-docker`, `live-kind` and `live-macos` jobs (`gh workflow run Proof -f jobs=fleet`). Each runs on a fresh Linux machine with Docker, or a Mac, with passwordless sudo (it makes an OS user and applies firewall rules, so not on a machine you care about), pins every tool by SHA-256 and every image by digest, uses no secret, and writes its logs to `$LIVE_OUT` with one `RESULT` line a step. `scripts/live/check-logs.sh <folder>` checks the logs for anything secret-like before they're kept.

**Runners one minor apart** (ticket 16, F-061). `node scripts/build-runner-at.ts` checks out milestone 4's and milestone 3's runners as detached worktrees in `.ostra-dev/runner-builds/` and installs each from its own lockfile, for the demo's version step: milestone 4's speaks protocol 1.3 and joins a milestone 5 server, milestone 3's speaks 1.2 and is refused with the fix. It builds the tags `milestone-4` and `milestone-3`; until they exist, name the commits with `--ref milestone-4=<commit> --ref milestone-3=<commit>`. `--dry-run` prints the commands. Each build says the protocol minor it speaks and how to start it (`node .ostra-dev/runner-builds/<name>/apps/runner/src/main.ts runner --server <core>`). A development core (`NODE_ENV=development`) names `pnpm dev:npm-registry` in `GET /runner/v1/info` as where the pin installs from.

Ctrl-C stops everything: the servers' process trees first, then the dev database, which stops Postgres. No `node` or `postgres` process of the stack is left. If one is (after a crash of the terminal, say), `pnpm dev:reset --yes` stops the dev cluster.

**Windows: keep the checkout path short.** The embedded Postgres unpacks deep inside `node_modules/.pnpm`, and Windows' 260-character path limit stops it (initdb exits with code 3221225734, `STATUS_NAME_TOO_LONG`) when the checkout's own path is long: it failed at 123 characters and worked at 27. Clone to something like `C:\src\ostra`. When the embedded Postgres fails to start on a checkout path over 100 characters, `pnpm dev`, the tests and the e2e stack say so, with the path and its length. That limit is the checkout's own: the runner's git is long-path safe (see the runner's data folder in `docs/configuration.md`).

**A runner, from source.** With the stack running, start a personal runner on the same machine in another terminal:

```
pnpm ostra runner --server http://localhost:8787
```

It prints a code and the panel's `/device` address. Approve the code in the panel, and the runner shows up online. Once `ostra` is published, `ostra runner` does the same (ADR 0046).

**Milestone 1's demo** (`e2e/m1-first-pr/`, ticket 39). With `pnpm dev` running on an empty data folder, and the dev secrets loaded, it drives the panel in Chromium from the first admin to a PR on the test repo, runs the checks after the run, and closes everything but the final PR. It signs in as the admin the stack seeded, with the same `OSTRA_ADMIN_*` variables and defaults as the server, and on a fresh stack changes the default password to one it keeps in `.ostra-dev/e2e-m1/`. For the PR's `Co-authored-by` to link to the test member's GitHub account, start the stack with `OSTRA_ADMIN_EMAIL=<GITHUB_TEST_MEMBER_LOGIN>@users.noreply.github.com`. Start the stack and the demo with `OSTRA_BOX_IDLE_MINUTES=1` too: a finished turn's box stays warm on the runner's one slot for the idle timer (F-096), so the demo starts each next task once the last one's box has stopped, and with the default 15 minutes the run takes over half an hour:

```
export OSTRA_BOX_IDLE_MINUTES=1
set -a; . ~/.config/ostra-dev/model.env; . ~/.config/ostra-dev/github.env; . ~/.config/ostra-dev/github-test.env; set +a
pnpm e2e:m1
```

It keeps screenshots in `context/specs/m1-first-pr/demo/`, its runner's folder in the system temp folder (outside the repo, so the agent doesn't read ostra's own `AGENTS.md`), and the result in `.ostra-dev/e2e-m1/result.json`. A step that already happened is skipped, so it can be run again on the same stack. `OSTRA_E2E_STACK_LOG` names a file with the stack's output, to search it for credentials too. `OSTRA_E2E_SETUP_SCRIPT` saves a setup script in the project's environment when the demo creates the project, so its tasks run it (on Windows, in Git for Windows' bash). The checks read the stack's database directly: `DATABASE_URL`, or `OSTRA_DEV_PG_PORT`, when the demo's shell has them, otherwise the dev database running in this checkout's `.ostra-dev/pg`, so a stack on other ports (`OSTRA_E2E_PANEL_URL`, `OSTRA_E2E_CORE_URL`) needs nothing more when it runs from the same checkout. The demo stops as soon as a task it started isn't in that database, saying where it looked, instead of judging another stack's rows. After the run, the demo checks that no agent process is left below the runner and that each task folder left in its data folder is a kept box's: on `host` a stopped box's worktree stays until the box is released (its last PR merged or closed, or after `OSTRA_BOX_RELEASE_IDLE_DAYS`). `pnpm --filter @ostra/e2e-m1 clean-up` closes the demo's PRs and deletes its branches and hidden refs.

**Milestone 2's demo** (`e2e/m2-tickets-in/`, ticket 39; the steps in `context/specs/m2-tickets-in/spec.md`, section 3). It starts from milestone 1's steps (the same helpers, from `@ostra/e2e-m1`), then seeds the organization's Linear connection from `LINEAR_API_KEY` (`seed-linear.ts`: `credentialKind: api_key`, development only, until the maintainer authorizes the Linear app), attaches the team `LINEAR_TEST_TEAM_KEY` in the panel, creates a real ticket, starts it from the Inbox, and follows it to the PR, the idle stop, a reopen on a second personal runner from the session archive, and the merge. With `OSTRA_DEV_PUBLIC_URL` set to a public address of core (a quick tunnel to `OSTRA_CORE_PORT`, which the stack also needs as `OSTRA_CORE_PUBLIC_URL`), the seed registers a workspace webhook on the team and deletes it when the run ends; without one, the connection polls. `--checks` adds the checks after the run: no CI for a hidden ref, the tracker writer's outbox, a second task that gets a ticket with "Create ticket" and reopens from the rebuild template alone, and a ticket change by polling alone. Start the stack with `OSTRA_BOX_IDLE_MINUTES=2` and `OSTRA_ALLOW_DEFAULT_PASSWORD=true`:

```
export OSTRA_BOX_IDLE_MINUTES=2 OSTRA_DEV_PUBLIC_URL=https://<your tunnel>
set -a; . ~/.config/ostra-dev/model.env; . ~/.config/ostra-dev/github.env; . ~/.config/ostra-dev/github-test.env; . ~/.config/ostra-dev/linear.env; set +a
pnpm e2e:m2
```

Its runners' folders are in the system temp folder (`ostra-e2e-m2/runner` and `runner-2`), its state, logs and result in `.ostra-dev/e2e-m2/`, and its screenshots in `context/specs/m2-tickets-in/demo/`. A step that already happened is skipped. `pnpm --filter @ostra/e2e-m2 clean-up` closes this stack's PRs (those whose body links a task on its panel, `OSTRA_PUBLIC_URL`) and deletes their branches and hidden refs, archives the tickets labelled `ostra-demo`, and deletes the seed's webhooks; `--keep-pr <n>` and `--keep-ticket <KEY>` keep the final run's. Other stacks' PRs on the same test repo are never touched.

**Milestone 2's failure suite** (`e2e/m2-failure-suite/`, ticket 38; the cases in `context/specs/m2-tickets-in/spec.md`, section 3). Unlike the demos, it starts its own stack, because its cases kill and restart it: `pnpm dev:reset --yes` on this checkout's data folder, then the dev database, core (as `apps/core/src/testing/restart-child.ts`, core's own `startCore` with the test knobs a case sets: a kill point, the fault proxy in front of Linear, the runaway timers in seconds) and the panel (`next dev`), each its own process, on 3211, 8811 and 54411 (`OSTRA_FS_WEB_PORT`, `OSTRA_FS_CORE_PORT`, `OSTRA_FS_PG_PORT`; it refuses 3000, 8787 and 54329). It starts its own cloudflared quick tunnel to core (`~/.local/bin/cloudflared`, or `OSTRA_FS_CLOUDFLARED`), so Linear's webhooks reach it, and a stub model in Anthropic's format that OpenCode talks to through the runner's real key proxy: each ticket's description names the script the stub plays (`[[stub:slow <file> 8 2500]]`), so a turn takes seconds and does the same every run. It sets the stack up with milestone 1's and 2's helpers, signs in one personal runner on `host` behind spike 6's cut proxy, and runs every case against `OST` and `test1`, one at a time, so the machine holds one case's processes at once; `apps/core/src/failure-suite.test.ts` (spike 8's kill points on the fakes, run with `OSTRA_FAILURE_SUITE=1`) runs beside the live cases. Load `github.env`, `github-test.env` and `linear.env` (not `model.env`):

```
set -a; . ~/.config/ostra-dev/github.env; . ~/.config/ostra-dev/github-test.env; . ~/.config/ostra-dev/linear.env; set +a
pnpm e2e:m2:failures            # --long adds the 11-minute cut; --only kill-runner,limits runs those; --keep leaves the run's tickets and PRs
```

Its runners' folders are in the system temp folder (`ostra-f38/`), its logs, screenshots and `result.json` in `.ostra-dev/e2e-m2-failures/`. After the run it archives its tickets in `OST` (their titles start "Failure suite:"), closes its PRs on `test1` and deletes their branches and hidden refs, and deletes its webhook; `pnpm --filter @ostra/e2e-m2-failures clean-up` does the same after an interrupted run. Never run it on a checkout whose dev stack you want to keep: its first step empties `.ostra-dev/`.

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
