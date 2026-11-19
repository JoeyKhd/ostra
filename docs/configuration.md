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
| `OSTRA_GITHUB_API_URL` | `https://api.github.com` | The GitHub REST API the panel and core talk to. Set it to a GitHub Enterprise Server's API (`https://<host>/api/v3`), or to a fake GitHub in tests. |
| `OSTRA_GITHUB_LFS_HOSTS` | `github-cloud.githubusercontent.com,github-cloud.s3.amazonaws.com,lfs.github.com` | The hosts a task's git proxy may send Git LFS uploads and downloads to, besides the code host's own address: comma-separated host names, `*.` for a subdomain. A GitHub Enterprise Server install lists its own storage host (below, "Code hosts and Git LFS"). |
| `OSTRA_DATA_DIR` | `.ostra-dev/server` (development), `/var/lib/ostra` (production) | Where the server keeps its generated keys. Back it up: it holds the secrets key when `OSTRA_SECRETS_KEY` is unset. |
| `OSTRA_SECRETS_KEY` | generated on first start, kept in `OSTRA_DATA_DIR` | The key the built-in secret store encrypts with (32 bytes, base64). **Back it up**: without it, stored secrets can't be read. At every start core and the panel check it against a value the database stores the first time a key is used, and a key that can't read it stops the start, naming the two fixes: set `OSTRA_SECRETS_KEY`, or restore `secrets-key` in the data folder. |
| `OSTRA_RUNNER_TOKEN_KEY` | generated on first start, kept in `OSTRA_DATA_DIR` as `runner-token.key` | The key core signs runners' 10-minute access tokens and tasks' MCP tokens with: 32 bytes, base64 or 64 hex characters. Core replicas that don't share a data folder need the same one, or each refuses the tokens the others issued. Changing it makes every runner get a new token, nothing more. |
| `OSTRA_CATALOG_FETCH` | `true` | Fetch the models.dev catalog daily. `false`: use the copy bundled with ostra only. |
| `OSTRA_MODEL_ENDPOINT_ALLOW_PRIVATE` | `false` | Let a model provider's base URL point at a private, loopback or link-local address, such as a model server on your own network. Off: those addresses and cloud metadata hosts are refused. |
| `OSTRA_OPEN_SIGNUP_ACCOUNTS` | `false` | Let anyone create an account. Off: after the first admin, accounts come by invitation. |
| `OSTRA_OPEN_SIGNUP_ORGANIZATIONS` | `false` | Let any account create an organization. Off: only the instance admin can. |
| `BETTER_AUTH_SECRET` | generated on first start, kept in `OSTRA_DATA_DIR` | Signs sessions and tokens (at least 32 characters). Changing it signs everyone out. |
| `OSTRA_ADMIN_EMAIL` | `demo@demo.com` | The first admin's email. When the server starts with no account, it creates the first admin, the instance admin and the admin of the first organization (F-001). Read only then: changing it later changes nothing. |
| `OSTRA_ADMIN_USERNAME` | `demo` | The first admin's username: lowercase letters, digits and inner hyphens. Read only when the first admin is created. |
| `OSTRA_ADMIN_PASSWORD` | `demo`, which must be changed at the first sign-in | The first admin's password, 12 characters or more. **Unset, the admin gets the default password `demo`**: its first sign-in leads to "Choose a new password", and the panel does nothing else until it has one. Read only when the first admin is created. |
| `OSTRA_ORGANIZATION_NAME` | `Demo` | The first organization's name. Read only when the first admin is created. |
| `OSTRA_ALLOW_DEFAULT_PASSWORD` | `false` | `true` lets the seeded admin keep the default password, for a demo: no forced change at sign-in, but a warning across the panel until it changes. Never on an install others can reach. |
| `OSTRA_DEV_PG_PORT` | `54329` | The embedded dev database's port (development only). |
| `OSTRA_BOX_IDLE_MINUTES` | `15` | After this many minutes with no turn, a box stops its agent and its session ends (F-096). Its work was already pushed, with the hidden ref and the session archive, after its last turn; the next message reopens the task. |
| `OSTRA_SESSION_MAX_MINUTES` | `120` | A session's longest life. Past it, core stops the session and the task needs you (runaway protection, F-068). |
| `OSTRA_SESSION_STALL_MINUTES` | `10` | This long with no agent event, and core stops the session as stalled (F-068). |
| `OSTRA_TASK_SPEND_CAP_USD` | `25` | A task's spend cap in US dollars, counted on the four token kinds at the model's prices (F-068). At the cap the runner's key proxy stops the session and the task needs you. At most `2000`. |
| `OSTRA_TASK_TOKEN_CAP` | `10000000` | A task's cap in tokens, used instead of the dollar cap when the model has no known price; the panel says so. |
| `OSTRA_TRACKER_POLL_SECONDS` | `60` | How often a board is polled when its tracker can't reach ostra's webhooks: an install with no public address (F-042). |
| `OSTRA_RECONCILE_MINUTES` | `5` | How often core checks the open PRs' states on GitHub, in case a webhook was missed (F-044). |
| `OSTRA_WEBHOOK_INSERT_DEADLINE_MS` | `2000` | How long saving a webhook may take before core answers `503`, so the sender retries rather than losing it. |
| `OSTRA_BOX_RELEASE_IDLE_DAYS` | `14` | A stopped box is released after this many idle days, and its task's hidden ref deleted (F-079). |
| `OSTRA_RETENTION_DAYS` | unset: keep while the task exists | Delete a finished task's histories, archives and blobs this many days after it ends (F-079). It applies only until an admin saves a retention in the panel, which wins, "keep" included. |
| `OSTRA_BLOB_STORE` | `postgres` | Where blobs are kept (session archives, ticket images): `postgres`, in the database's own tables, or `s3`, any S3-compatible store (F-114). |
| `OSTRA_BLOB_MAX_MIB` | `64` | The largest blob in MiB, and so the largest session archive; over it, the next reopen uses the rebuild template. At most `64`. |
| `OSTRA_S3_ENDPOINT` | unset: AWS S3 | The S3-compatible store's endpoint, such as a MinIO or R2 URL. Read only with `OSTRA_BLOB_STORE=s3`. |
| `OSTRA_S3_BUCKET` | unset; required with `OSTRA_BLOB_STORE=s3` | The bucket blobs are kept in. |
| `OSTRA_S3_REGION` | unset | The store's region. Read only with `OSTRA_BLOB_STORE=s3`. |
| `OSTRA_S3_ACCESS_KEY_ID` | unset; required with `OSTRA_BLOB_STORE=s3` | The access key's ID. |
| `OSTRA_S3_SECRET_ACCESS_KEY` | unset; required with `OSTRA_BLOB_STORE=s3` | The access key's secret. Never logged. |

Booleans take `true`, `false`, `1`, `0`, `on`, `off`, `yes` or `no`.

**The database runs in UTC.** Core and the panel open every connection with `TimeZone=UTC` (added to `DATABASE_URL` as `options=-c TimeZone=UTC`, unless the URL sets a time zone itself), because times are written as UTC with no offset. At start core checks `SHOW timezone` and the job queue's forwarding heartbeat, and refuses to start its workers, with a `jobs.boot_check_failed` log line, when either is wrong (ADR 0037).

**The first admin.** A fresh install has an account from its first start: sign in at `OSTRA_PUBLIC_URL` as `demo@demo.com` (or `demo`) with the password `demo`, and choose a new password when asked. To start with your own account instead, set `OSTRA_ADMIN_EMAIL`, `OSTRA_ADMIN_USERNAME`, `OSTRA_ADMIN_PASSWORD` and `OSTRA_ORGANIZATION_NAME` before the first start. Several server processes starting at once still create one admin. The server logs `setup.first_admin_seeded` with the new IDs, never the email or the password.

**Several server processes.** Core and the panel can run as several processes, on one machine or many (ADR 0034: any replica serves any request). Processes that share one `OSTRA_DATA_DIR` share its keys. Processes that don't, such as replicas in a cluster, must all be given the same three settings: `OSTRA_SECRETS_KEY`, `BETTER_AUTH_SECRET` and `OSTRA_RUNNER_TOKEN_KEY`. Without the first, a process can't read the stored secrets and refuses to start; without the other two, a session or a runner's token made by one process is refused by another. Only the secrets key is checked at start: a new `BETTER_AUTH_SECRET` signs everyone out, and a new runner-token key makes every runner ask for a new token, which are both allowed.

**What core keeps in `OSTRA_DATA_DIR`.** Besides the keys above, core makes these files there at first start, each readable by its owner only: `secrets-key`, the built-in secret store's key when `OSTRA_SECRETS_KEY` is unset (the panel reads the same file, so back it up); `runner-token.key`, the key runners' 10-minute access tokens are signed with when `OSTRA_RUNNER_TOKEN_KEY` is unset (it also signs each task's MCP token; deleting it makes every runner get a new token, nothing more); and `bootstrap-join-token`, the default pool's bootstrap join token for the compose file's pool runner. The bootstrap token is stored hashed in the database and shown nowhere else; core writes it once the first organization exists. Core's daily catalog job also keeps the last good copy of the models.dev catalog in `catalog/models-dev.json` there, and the logos of the providers your models matched in `model-logos/`, which the panel serves (with `OSTRA_CATALOG_FETCH=false`, neither is fetched, and the copy bundled with ostra is used).

## Code hosts and Git LFS

An LFS batch answer names where each object goes, often a storage host other than the code host. A task's git proxy calls only the code host's own address and the hosts listed for its code host, over https, by name; an object sent anywhere else gets an error, and the agent never sees the signed URL or its headers (ADR 0030, Q119). One line per code host:

| Code host | The hosts its LFS actions may call |
|---|---|
| GitHub.com | `github-cloud.githubusercontent.com`, `github-cloud.s3.amazonaws.com` and `lfs.github.com`: the default of `OSTRA_GITHUB_LFS_HOSTS`. |
| GitHub Enterprise Server | Its own storage host, listed in `OSTRA_GITHUB_LFS_HOSTS` (such as `OSTRA_GITHUB_LFS_HOSTS=lfs.ghes.example.com`), with `OSTRA_GITHUB_API_URL` set to its API. Objects stored on the server's own address need no line. |

LFS objects of a cleaned-up task stay in the code host's storage: cleaning up a task deletes its refs, never the LFS objects it pushed, so the code host keeps them and counts them against the repo's storage quota (Q120).

## The runner

Read by `ostra runner` through `parseRunnerConfig` (`packages/protocol/src/runner/config.ts`). Each setting is also a flag; a flag wins over its variable.

| Setting | Flag | Default | What it does |
|---|---|---|---|
| `OSTRA_SERVER_URL` | `--server` | (required) | The ostra server's core address, such as `http://localhost:8787`. |
| `OSTRA_RUNNER_DATA_DIR` | `--data-dir` | `~/.ostra/runner` | The runner's folder: its key pair, its spool and the task workspaces (`tasks/<task>/workspace/<repo>`). On Windows the runner turns on git's `core.longpaths` for every clone and checkout it makes, so a repo with deep paths works under a long folder; git still refuses a `.git` folder path of about 250 characters, so keep this folder short. |
| `OSTRA_RUNNER_TRANSPORT` | `--transport` | `websocket` | How the runner talks to the server. Milestone 1 has `websocket` only; `auto` and `http` come in milestone 5. |
| `OSTRA_RUNNER_EXECUTOR` | `--executor` | `host` | Where tasks run: `host` (a worktree on this machine, not isolated) or `docker` (a box per task). |
| `OSTRA_RUNNER_CAPACITY` | `--capacity` | `1` | How many tasks the runner runs at once. |
| `OSTRA_RUNNER_LABELS` | `--labels` | (none) | Comma-separated labels that tasks can ask for, such as `gpu,macos`. |
| `OSTRA_RUNNER_NAME` | `--name` | the machine's host name | The runner's name in the panel. |
| `OSTRA_JOIN_TOKEN` | `--join-token` | (none) | A pool runner's join token, used once to register. A personal runner signs in with a device code instead. |
| `OSTRA_RUNNER_SHELL` | `--shell` | `bash` | The shell the `host` executor runs setup scripts with. On Linux and macOS, `bash` from `PATH`. On Windows, the bare name `bash` means Git for Windows' own `bin\bash.exe`, found from the `git` on `PATH`, never WSL's `System32\bash.exe`; without Git for Windows, set it to a shell's full path. A full path is used as given. |
| `OSTRA_JOIN_TOKEN_FILE` | `--join-token-file` | (none) | A file holding a pool runner's join token, such as the bootstrap token core writes to `OSTRA_DATA_DIR` at first start (the compose file's runner reads it). `--join-token` wins. |
| `OSTRA_BOX_BASE_IMAGE` | `--box-base-image` | `ostra/base:<the runner's version>` | The `docker` executor's base image, for an environment that names none. |
| `OSTRA_BOX_RUNNER_IMAGE` | `--box-runner-image` | `ostra/runner:<the runner's version>` | The image each `docker` box's sidecar runs: the `ostra` CLI. |
| `OSTRA_BOX_SERVER_URL` | `--box-server-url` | the `--server` address | Core's address as a `docker` box's sidecar reaches it, when that differs from `--server`. |

The `docker` executor finds the Docker Engine as Docker's own tools do: `DOCKER_HOST` (`unix://`, `npipe://` or `tcp://host:port`), or the platform's default socket. The socket is root on the host, so pool runners belong on dedicated hosts (Q97).

**The Docker socket** (Q97, ADR 0029). The compose file's pool runner (`deploy/compose.yaml`) mounts the Docker socket, `/var/run/docker.sock`, to start its boxes. That socket is root on that machine: whoever controls the runner, or escapes a box onto it, controls the host. That's right for a one-machine install. Beyond one, pool runners belong on dedicated hosts that run nothing else, preferably with rootless Docker or the gVisor runtime.

**The sidecar.** The runner sets a `docker` box's sidecar's environment itself, so none of it is an admin's setting: the server's address, the path of the task's token file (`/run/ostra/token`, which holds the task's own token: the runner asks core for it once, when it makes the box, and writes it once; it is valid as long as the task's lease and is never renewed, and the sidecar reads it when it starts and when it reconnects), the task, session, box and lease epoch, the bridge's nonce and port (7101), the sidecar's name on the box network (`sidecar`) and the task volume (`/task`). `ostra sidecar` refuses to start without them. OpenCode is the base image's `/opt/opencode/bin/opencode`, checked against its SHA-256 when the image is built.

## Development and tests only

Read by the dev setup and the live test cases, never by an install (`docs/development.md`).

| Setting | Default | What it does |
|---|---|---|
| `OSTRA_DEV_MODEL_BASE_URL` | (none: live model cases are skipped) | The model endpoint the live cases use, from `~/.config/ostra-dev/model.env`. |
| `OSTRA_DEV_MODEL_API_KEY` | (none) | Its token. Never printed or logged. |
| `OSTRA_DEV_MODEL_ID` | (none) | The model the live cases ask for. |
| `OSTRA_DEV_GITHUB_ORG` | (none) | The test GitHub org, from `~/.config/ostra-dev/github-test.env`. |
| `OSTRA_DEV_GITHUB_REPOS` | (none) | Its test repos, comma-separated. |
| `OSTRA_DEV_PUBLIC_URL` | (none) | A public address that reaches core's port, from `~/.config/ostra-dev/tunnel.env`, for webhook tests. |
| `OSTRA_DEV_BLOCK_WEBHOOKS` | (none) | `linear`, `github` or both, comma-separated: core answers those webhook routes with 503 and stores nothing, so a test sees the polling and the reconcile catch up (milestone 2's demo and failure suite). Ignored when `NODE_ENV=production`. |

Variables named `OSTRA_SPIKE_*` belong to the spikes in `spikes/`. The server neither reads nor refuses them, so the dev env files can be loaded before `pnpm dev`.
