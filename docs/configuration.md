# Configuration reference

Every setting ostra reads, with its default and what it does. A fresh install needs none of them: each has a working default (the self-hosting rule in `AGENTS.md`).

**Every new setting adds its line here, in the same commit.** A test (`packages/domain/src/settings.test.ts`) reads this file and the settings schema, and fails when one lists a name the other doesn't. The server refuses an `OSTRA_*` variable it doesn't know, and names the ones it does, so a typo is caught at start.

## The server

Read by `apps/core` and `apps/web` through `parseServerSettings` (`packages/domain/src/settings.ts`).

| Setting | Default | What it does |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `production` or `test`. Production requires `DATABASE_URL`. |
| `DATABASE_URL` | the dev database (development); required in production | The Postgres server ostra keeps everything in. Unset in development: the embedded one `pnpm db:dev` starts. |
| `OSTRA_WEB_PORT` | `3000` | The port the panel (`apps/web`) listens on. |
| `OSTRA_CORE_PORT` | `8787` | The port core (`apps/core`) listens on: runners connect here. |
| `OSTRA_PUBLIC_URL` | `http://localhost:3000` | The panel's address as browsers reach it. Runners are sent here to approve a device code. |
| `OSTRA_CORE_PUBLIC_URL` | `http://localhost:8787` | Core's address as runners and webhooks reach it. |
| `OSTRA_DATA_DIR` | `.ostra-dev/server` (development), `/var/lib/ostra` (production) | Where the server keeps its generated keys. Back it up: it holds the secrets key when `OSTRA_SECRETS_KEY` is unset. |
| `OSTRA_SECRETS_KEY` | generated on first start, kept in `OSTRA_DATA_DIR` | The key the built-in secret store encrypts with (32 bytes, base64). **Back it up**: without it, stored secrets can't be read. |
| `OSTRA_CATALOG_FETCH` | `true` | Fetch the models.dev catalog daily. `false`: use the copy bundled with ostra only. |
| `OSTRA_OPEN_SIGNUP_ACCOUNTS` | `false` | Let anyone create an account. Off: after the first admin, accounts come by invitation. |
| `OSTRA_OPEN_SIGNUP_ORGANIZATIONS` | `false` | Let any account create an organization. Off: only the instance admin can. |
| `BETTER_AUTH_SECRET` | generated on first start, kept in `OSTRA_DATA_DIR` | Signs sessions and tokens (at least 32 characters). Changing it signs everyone out. |
| `OSTRA_SETUP_TOKEN` | generated and printed in the server's log at first start | Needed to create the first admin. It stops working once the first account exists (F-001, Q117). |
| `OSTRA_DEV_PG_PORT` | `54329` | The embedded dev database's port (development only). |

Booleans take `true`, `false`, `1`, `0`, `on`, `off`, `yes` or `no`.

**What core keeps in `OSTRA_DATA_DIR`.** Besides the keys above, core makes these files there at first start, each readable by its owner only: `secrets-key`, the built-in secret store's key when `OSTRA_SECRETS_KEY` is unset (the panel reads the same file, so back it up); `runner-token.key`, the key runners' 10-minute access tokens are signed with (it also signs each task's MCP token; deleting it makes every runner get a new token, nothing more); and `bootstrap-join-token`, the default pool's bootstrap join token for the compose file's pool runner. The bootstrap token is stored hashed in the database and shown nowhere else; core writes it once the first organization exists.

## The runner

Read by `ostra runner` through `parseRunnerConfig` (`packages/protocol/src/runner/config.ts`). Each setting is also a flag; a flag wins over its variable.

| Setting | Flag | Default | What it does |
|---|---|---|---|
| `OSTRA_SERVER_URL` | `--server` | (required) | The ostra server's core address, such as `http://localhost:8787`. |
| `OSTRA_RUNNER_DATA_DIR` | `--data-dir` | `~/.ostra/runner` | The runner's folder: its key pair, its spool and the task workspaces. |
| `OSTRA_RUNNER_TRANSPORT` | `--transport` | `websocket` | How the runner talks to the server. Milestone 1 has `websocket` only; `auto` and `http` come in milestone 5. |
| `OSTRA_RUNNER_EXECUTOR` | `--executor` | `host` | Where tasks run: `host` (a worktree on this machine, not isolated) or `docker` (a box per task). |
| `OSTRA_RUNNER_CAPACITY` | `--capacity` | `1` | How many tasks the runner runs at once. |
| `OSTRA_RUNNER_LABELS` | `--labels` | (none) | Comma-separated labels that tasks can ask for, such as `gpu,macos`. |
| `OSTRA_RUNNER_NAME` | `--name` | the machine's host name | The runner's name in the panel. |
| `OSTRA_JOIN_TOKEN` | `--join-token` | (none) | A pool runner's join token, used once to register. A personal runner signs in with a device code instead. |
| `OSTRA_RUNNER_SHELL` | `--shell` | `bash` | The shell the `host` executor runs setup scripts with, from `PATH` (Git Bash on Windows). |

## Development and tests only

Read by the dev setup and the live test cases, never by an install (`docs/development.md`).

| Setting | Default | What it does |
|---|---|---|
| `OSTRA_DEV_MODEL_BASE_URL` | (none: live model cases are skipped) | The model endpoint the live cases use, from `~/.config/ostra-dev/model.env`. |
| `OSTRA_DEV_MODEL_API_KEY` | (none) | Its token. Never printed or logged. |
| `OSTRA_DEV_MODEL_ID` | (none) | The model the live cases ask for. |
