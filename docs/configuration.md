# Configuration reference

Every setting ostra reads, with its default and what it does. A fresh install needs none of them: each has a working default (the self-hosting rule in `AGENTS.md`). With Docker Compose, a server setting goes in the `.env` file beside `compose.yaml`; with Helm, in the server chart's `env`.

**Every new setting adds its line here, in the same commit.** A test (`packages/domain/src/settings.test.ts`) reads this file and the settings schema, and fails when one lists a name the other doesn't. The server refuses an `OSTRA_*` variable it doesn't know, and names the ones it does, so a typo is caught at start. A setting ostra no longer reads is the exception: it is ignored with a warning, so an upgrade never fails on it (below, "Removed settings").

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
| `OSTRA_CORE_INTERNAL_URL` | `http://127.0.0.1:<OSTRA_CORE_PORT>` | Core's address as the panel reaches it, to hand it the files a member uploads (a skill's files) and to read the blobs a member downloads (a check's output, a screenshot, a library file), from whichever blob store keeps them. Set it only when the panel and core run apart. |
| `OSTRA_GITHUB_API_URL` | `https://api.github.com` | The GitHub REST API the panel and core talk to. Set it to a GitHub Enterprise Server's API (`https://<host>/api/v3`), or to a fake GitHub in tests. The website a member links their account on, and an App is created on, follows from it: `https://github.com` for the default, `https://<host>` for a GitHub Enterprise Server. |
| `OSTRA_LINEAR_API_URL` | `https://api.linear.app/graphql` | Linear's GraphQL API the panel and core read and write tickets through. Set it only to a fake Linear in tests: "Connect Linear" then opens the fake's new-app form and consent page, and exchanges and refreshes the token there, at the same paths on this address's origin. |
| `OSTRA_JIRA_API_URL` | unset: Jira's own (`https://api.atlassian.com`, and each site's `https://<site>.atlassian.net`) | Where the panel and core reach Jira Cloud. Unset, every call goes through Atlassian's gateway (`https://api.atlassian.com/ex/jira/<cloudId>`), and step 1 of connecting Jira reads the site's own `https://<site>.atlassian.net/_edge/tenant_info` for its cloud ID. Set it only to a fake Jira in tests: the gateway and the site lookup then both go to it. A fresh install leaves it unset and connects Jira by webhook or by polling. |
| `OSTRA_GITHUB_LFS_HOSTS` | `github-cloud.githubusercontent.com,github-cloud.s3.amazonaws.com,lfs.github.com` | The hosts a task's git proxy may send Git LFS uploads and downloads to, besides the code host's own address: comma-separated host names, `*.` for a subdomain. A GitHub Enterprise Server install lists its own storage host (below, "Code hosts and Git LFS"). |
| `OSTRA_DATA_DIR` | `.ostra-dev/server` (development), `/var/lib/ostra` (production) | Where the server keeps its generated keys. Back it up: it holds the secrets key when `OSTRA_SECRETS_KEY` is unset. |
| `OSTRA_SECRETS_KEY` | generated on first start, kept in `OSTRA_DATA_DIR` | The key the built-in secret store encrypts with (32 bytes, base64). **Back it up**: without it, stored secrets can't be read. At every start core and the panel check it against a value the database stores the first time a key is used, and a key that can't read it stops the start, naming the two fixes: set `OSTRA_SECRETS_KEY`, or restore `secrets-key` in the data folder. |
| `OSTRA_RUNNER_TOKEN_KEY` | generated on first start, kept in `OSTRA_DATA_DIR` as `runner-token.key` | The key core signs runners' 10-minute access tokens and tasks' MCP tokens with: 32 bytes, base64 or 64 hex characters. Core replicas that don't share a data folder need the same one, or each refuses the tokens the others issued. Changing it makes every runner get a new token, nothing more. |
| `OSTRA_CATALOG_FETCH` | `true` | Fetch the models.dev catalog daily. `false`: use the copy bundled with ostra only. |
| `OSTRA_MODEL_ENDPOINT_ALLOW_PRIVATE` | `false` | Let a model provider's base URL point at a private, loopback or link-local address, such as a model server on your own network. Off: those addresses and cloud metadata hosts are refused. |
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
| `OSTRA_TRACKER_POLL_SECONDS` | `60` | How often a board is polled when its tracker can't reach ostra's webhooks: an install with no public address (F-042). Polls run on a schedule of whole minutes, so a value under 60 polls every minute. A connection with webhooks is polled every `OSTRA_RECONCILE_MINUTES` instead, as the drift check (F-044). |
| `OSTRA_RECONCILE_MINUTES` | `5` | How often core checks GitHub for what a missed webhook would have brought (F-044): the open task PRs' states, their new comments, reviews and line comments, and a closed task PR reopened; and how far each task's branch is behind its base (F-070). |
| `OSTRA_WEBHOOK_INSERT_DEADLINE_MS` | `2000` | How long saving a webhook may take before core answers `503`, so the sender retries rather than losing it. |
| `OSTRA_BOX_RELEASE_IDLE_DAYS` | `14` | A stopped box is released after this many idle days, and its task's hidden ref deleted (F-079). Only a `host` worktree stays stopped: a `docker` box or a `kubernetes` pod is removed when its session ends, at its idle stop (ADR 0039, Q343). |
| `OSTRA_RETENTION_DAYS` | unset: keep while the task exists | Delete a finished task's histories, archives and blobs this many days after it ends (F-079). It applies only until an admin saves a retention in the panel, which wins, "keep" included. |
| `OSTRA_BLOB_STORE` | `postgres` | Where blobs are kept (session archives, a ticket's images and files, message files and the text extracted from them): `postgres`, in the database's own tables, or `s3`, any S3-compatible store (F-114). |
| `OSTRA_BLOB_MAX_MIB` | `64` | The largest blob in MiB, and so the largest session archive; over it, the next reopen uses the rebuild template. At most `64`. |
| `OSTRA_S3_ENDPOINT` | unset: AWS S3 | The S3-compatible store's endpoint, such as a MinIO, Garage or R2 URL. Set, the bucket is addressed by path (`<endpoint>/<bucket>/<key>`). Read only with `OSTRA_BLOB_STORE=s3`. |
| `OSTRA_S3_BUCKET` | unset; required with `OSTRA_BLOB_STORE=s3` | The bucket blobs are kept in. |
| `OSTRA_S3_REGION` | unset: us-east-1 | The store's region, which AWS S3 needs and most other stores ignore. Read only with `OSTRA_BLOB_STORE=s3`. |
| `OSTRA_S3_ACCESS_KEY_ID` | unset; required with `OSTRA_BLOB_STORE=s3` | The access key's ID. |
| `OSTRA_S3_SECRET_ACCESS_KEY` | unset; required with `OSTRA_BLOB_STORE=s3` | The access key's secret. Never logged. |
| `OSTRA_EMAIL_PROVIDER` | unset: the panel decides, and mail is off until an admin sets it | The install's email (F-115): `resend`, `smtp` or `off`. Set, it locks the panel's email settings to it; unset, an instance admin chooses in the panel, and mail stays off until they do. Everything else works without email. Until milestone 4 verifies addresses, a "needs you" mail goes to the member's account address. |
| `OSTRA_EMAIL_FROM` | unset; required with `OSTRA_EMAIL_PROVIDER=resend` or `smtp` | The address mail comes from, such as `ostra@example.com`. Its domain must be one the provider sends for. |
| `OSTRA_EMAIL_FROM_NAME` | `ostra` | The name mail comes from. |
| `OSTRA_RESEND_API_KEY` | unset; required with `OSTRA_EMAIL_PROVIDER=resend` | Resend's API key. Never logged. Read only when the provider is `resend`. |
| `OSTRA_RESEND_API_URL` | `https://api.resend.com` | Resend's API the panel and core send mail through. Set it only to a fake Resend in tests. |
| `OSTRA_SMTP_HOST` | unset; required with `OSTRA_EMAIL_PROVIDER=smtp` | The SMTP server's host. Read only when the provider is `smtp`. |
| `OSTRA_SMTP_PORT` | `587` | The SMTP server's port. Read only when the provider is `smtp`. |
| `OSTRA_SMTP_SECURE` | `starttls` | How SMTP is secured: `starttls` (upgrade a plain connection, port 587), `tls` (TLS from the start, port 465) or `none` (a local relay only). Read only when the provider is `smtp`. |
| `OSTRA_SMTP_USER` | unset: no sign-in | The SMTP user, when the server wants a sign-in. Read only when the provider is `smtp`. |
| `OSTRA_SMTP_PASSWORD` | unset | The SMTP user's password. Never logged. Read only when the provider is `smtp`. |
| `OSTRA_EMAIL_DELAY_SECONDS` | `120` | How long a needs-you mail waits after its moment. It isn't sent if the member read it in the panel meanwhile, or the item closed (ADR 0050). |
| `OSTRA_TRACKER_NOTIFY_COALESCE_MINUTES` | `10` | Within this many minutes of a task's last notification comment on its ticket, a later moment edits that comment instead of posting a new one (ADR 0050). |
| `OSTRA_CHECK_TIMEOUT_SECONDS` | `600` | A check's timeout, unless the check sets its own (F-054). At most `3600`. |
| `OSTRA_CHECKS_TOTAL_MINUTES` | `30` | All of a turn's checks together; past it, the rest are timed out (F-054). |
| `OSTRA_CLI_SESSION_DAYS` | `30` | How long an `ostra login` session lasts (F-103). A member can revoke one sooner in Account. |
| `OSTRA_SNAPSHOT_NIGHTLY_HOUR` | `3` | The hour, in UTC (0 to 23), at which projects whose default branch moved get a fresh snapshot (F-051). |
| `OSTRA_DIFF_MAX_FILES` | `300` | Past this many changed files, the Changes tab links to the code host instead of drawing the diff (F-027). |
| `OSTRA_DIFF_MAX_PATCH_KIB` | `1024` | A file whose diff is over this many KiB shows "Too large to show here", with a link to the code host (F-027). |
| `OSTRA_INVITATION_DAYS` | `7` | How many days an invitation's link works (F-002). It works once. |
| `OSTRA_RESET_LINK_HOURS` | `24` | How many hours a password reset link works (F-002). It works once. |
| `OSTRA_BUDGET_WARN_PERCENT` | `80` | At this share of a monthly budget, its admins are told once, in the panel and by mail (F-037). At 100% new tasks and turns wait. |
| `OSTRA_INSIGHTS_INTERVAL_MINUTES` | `5` | How often Insights are recomputed (F-108). The page says when they were. |
| `OSTRA_MEMORY_INDEX_MAX_NOTES` | `100` | The most notes the memory index an agent starts with lists (F-110). The rest are found with search. |
| `OSTRA_MEMORY_INDEX_MAX_KIB` | `8` | The memory index's size, in KiB (F-110). |
| `OSTRA_MEMORY_ALWAYS_MAX_KIB` | `8` | The "always" notes' size together, in KiB (F-110). An "always" note past it is listed in the index instead. |
| `OSTRA_MEMORY_PROPOSALS_PER_TASK` | `20` | The most memory notes one task's agent may propose (F-111). |
| `OSTRA_PROJECT_MAX_REPOS` | `10` | The most repos one project holds (F-098). Every task checks them all out side by side. |
| `OSTRA_SEARCH_ENTRY_MAX_KIB` | `8` | The most text, in KiB, search keeps of one message, tool input or PR (F-080). Longer text is cut. |
| `OSTRA_JOIN_TOKEN_DAYS` | `30` | A new join token's lifetime in days, for a pool that names none (F-091). `0`: tokens never expire. |
| `OSTRA_BOOTSTRAP_JOIN_TOKEN` | `true` | Make the bootstrap join token at first start: one token for the default pool, written to `OSTRA_DATA_DIR` for the compose file's pool runner (F-013). It's made once, and one an admin revokes stays revoked. `false`: make none. The Helm chart sets `false`, since its runner chart joins with a token from the panel. |
| `OSTRA_PERSONAL_RUNNER_CAPACITY` | `2` | How many tasks a personal runner runs at once, unless its member sets another number on the runner (F-014, F-067). |
| `OSTRA_QUEUE_SWEEP_SECONDS` | `5` | How often each pool's queue is swept for tasks that now fit, besides the admission every change of room starts (F-067). |
| `OSTRA_SCHEDULE_MIN_INTERVAL_MINUTES` | `60` | The fewest minutes between two occurrences of a schedule (F-106). A schedule that fires more often is refused when it's saved, and one saved under a lower value fires at most once in that many minutes, checked at each tick. |
| `OSTRA_SCHEDULE_MISSED_HOURS` | `6` | How late an occurrence may be and still fire, after the install was down (F-106). Only the latest due one fires; older ones are skipped and audited. |
| `OSTRA_INTAKE_STARTS_PER_HOUR` | `20` | The most tasks one intake rule starts in an hour (F-011). The next match pauses the rule and tells the project's admins. |
| `OSTRA_WEBHOOK_STARTS_PER_HOUR` | `20` | The most tasks one webhook automation starts in an hour (F-139). The next request is answered 429, pauses the automation and tells the project's admins. |
| `OSTRA_WEBHOOK_REQUESTS_PER_MINUTE` | `60` | The most requests one webhook automation takes in a minute (F-139). More are answered 429 with `Retry-After`, and leave nothing in its history. |
| `OSTRA_WEBHOOK_BODY_MAX_KIB` | `64` | The largest body a webhook automation's request may have, in KiB (F-139). A larger one is answered 413 and stores nothing. |
| `OSTRA_BULK_START_MAX` | `50` | The most tickets a member starts at once, from the Inbox or a dry run's "Start all" (F-107). |
| `OSTRA_SUB_ISSUES_MAX` | `50` | The most sub-issues one start on a parent ticket runs (F-077). More than that starts nothing, and the member is told. |
| `OSTRA_SUB_ISSUES_DEPTH` | `3` | How many levels of sub-issues below a parent a start reaches (F-077). |
| `OSTRA_LINEAR_HEARTBEAT_MINUTES` | `20` | How long a Linear agent session may go without a post before ostra posts a heartbeat, so it doesn't look stale (F-012). |
| `OSTRA_LINEAR_HEARTBEAT_KIND` | `ephemeral` | The heartbeat's kind: `ephemeral` (it replaces itself) or `thought` (it stays in the session). |
| `OSTRA_CI_NONE_SECONDS` | `120` | How long after a push ostra waits for any check before it decides the repo has no CI (F-035). |
| `OSTRA_CI_WAIT_MINUTES` | `60` | How long CI may stay pending before the AI review starts anyway, with no fixing round (F-035). |
| `OSTRA_CI_LOG_TAIL_KIB` | `64` | The most of each failing check's log, in KiB, that reaches the agent as a file (F-035). The tail is kept. |
| `OSTRA_CI_LOG_CHECKS` | `5` | The most failing checks whose logs reach the agent in one CI round (F-035). |
| `OSTRA_CI_ROUNDS` | `2` | The most CI rounds a task gets before a person acts (F-035). |
| `OSTRA_REVIEW_ROUNDS` | `2` | The most review rounds a task gets before a person acts: its findings rounds, and each AI review run again on a new head pushed while the last one ran (F-101). |
| `OSTRA_AUTOMATIC_TURNS` | `4` | The most automatic turns, CI and findings rounds together, a task gets before a person acts (F-101). |
| `OSTRA_REVIEW_FINDINGS_MAX` | `30` | The most findings one AI review hands in (F-100). |
| `OSTRA_DRAFT_IMAGES_MAX` | `10` | The most images a refine draft holds, 10 MiB each (F-099). |
| `OSTRA_LIBRARY_UPDATE_HOURS` | `24` | How often, in hours, ostra checks each library item's source for a newer pin (F-145). An update waits for an organization admin, with its diff. An organization with no items makes no call. |
| `OSTRA_MARKETPLACE_SEARCH` | `true` | Whether organization admins may turn on the library's search of skills.sh and their MCP registries (F-146), which is off in each organization until an admin turns it on. `false` keeps it off on the whole install; installing by reference still works. |
| `OSTRA_SKILLS_SEARCH_URL` | `https://skills.sh/api/search` | Where the library's skill search asks, from core, with the admin's words and nothing else (F-146). It's the `skills` CLI's search endpoint, not a documented public API: when it fails, the page says search is unavailable. |
| `OSTRA_PREVIEW_DOMAIN` | `preview.localhost` when `OSTRA_PUBLIC_URL` and `OSTRA_CORE_PUBLIC_URL` are both on this machine (`localhost`, `127.0.0.1`, `::1`); otherwise none: no native preview | The domain a task's app is served on in the member's own browser, one host per port, such as `previews.example.com` (F-144). Optional: unset on public hosts, or `off`, the browser view, `ostra preview` and screenshots still work, and nothing of it listens. **On one machine it's on by itself:** with the setting unset and the panel and core both on loopback (`docker compose up` on a laptop, `pnpm dev`), it's `preview.localhost`, which needs no record and no certificate, and core checks it when it starts, so the pane opens previews in the member's own browser with nothing to set. `off` turns that off; on any other host unset stays none, since `*.localhost` would be the viewer's own machine. Set, it needs one wildcard DNS record and a wildcard certificate for `*.<domain>` pointing at core (the ingress in front of it, passing WebSocket upgrades), and previews serve on `<port>-<previewId>.<domain>` on `OSTRA_CORE_PUBLIC_URL`'s scheme and port: a real domain needs core's public address on `https`, since browsers drop the preview's cookie on plain `http`. `preview.localhost` works on a development machine with no record and no certificate. A registrable domain of its own is safest; a subdomain beside the panel's works, with the panel's cookies kept host-only. The preview's cookie is `SameSite=None; Partitioned` in the pane's frame on another site than the panel's and `SameSite=Lax` in a tab or on the panel's site, by the browser's own `Sec-Fetch-Site` and `Sec-Fetch-Dest`, so a two-part suffix such as `co.uk` needs no setting. Core answers every name under it with the preview proxy alone, so the server refuses to start with the panel's or core's own host under it. webpack-dev-server's live reload needs `client.webSocketURL: "auto://0.0.0.0:0/ws"` there. |
| `OSTRA_PREVIEW_WARM_MINUTES` | `60` | How long, in minutes after its last turn ended or its app started, a box stays running while someone watches one of its previews (F-141). Past it, the box idles out as `OSTRA_BOX_IDLE_MINUTES` says, watched or not. The app's own sockets, such as a dev server's HMR, never count as watching. |
| `OSTRA_PREVIEW_LINK_MAX_DAYS` | `7` | The longest an expiring preview link may last, in days (F-142). A new link lasts 24 hours unless its member picks less or more, up to this. |
| `OSTRA_CORE_REPLICA_URL` | this process's first non-loopback address and `OSTRA_CORE_PORT`, over `http` | This core process's address as the other core processes reach it, to forward a preview's stream to the one that holds its box's connection (F-141). Set it when the default address isn't the one the others reach; the Helm chart sets the pod's IP. A one-machine install never forwards. |
| `OSTRA_MESSAGE_FILES_MAX` | `10` | The most files one message carries, in the new-task box and every message after it (F-148), at most 20. The box refuses one more as it arrives; the server leaves out what's over at send, with a note in the thread. It also caps a member's unsent uploads: twice this value per member and project, and the next upload is refused until they send or remove some. |
| `OSTRA_MESSAGE_FILE_MAX_MIB` | `10` | The largest file a message carries, in MiB (F-148), at most 25, and never more than `OSTRA_BLOB_MAX_MIB`. A bigger one is refused in the box and left out at send, with a note. |
| `OSTRA_MESSAGE_FILES_TOTAL_MIB` | `25` | The most MiB one message's files carry together (F-148), at most 64. A file past it is left out with a note. |
| `OSTRA_TICKET_FILES_MAX` | `20` | The most files ostra fetches from a ticket for one read of it, its start's or a later one's (F-149), at most 50. The rest are named in the prompt and the thread as left out; `0` fetches none. |
| `OSTRA_TICKET_FILE_MAX_MIB` | `10` | The largest file ostra fetches from a ticket, in MiB (F-149), at most 25, and never more than `OSTRA_BLOB_MAX_MIB`. A bigger one is left out with a note. |
| `OSTRA_TICKET_FILES_TOTAL_MIB` | `50` | The most MiB of a ticket's files one read of it fetches together (F-149), at most 200. A file past it is left out with a note. |
| `OSTRA_FILE_TEXT_EXTRACTION` | `true` | Whether core reads the text out of a `.docx`, `.xlsx`, `.pptx` or `.pdf` a member attaches or a ticket holds, and writes it beside the file for the agent (F-150). `false` reads none: each document goes as a file alone, marked so. |
| `OSTRA_DEV_HOST_POOL_SAME_USER` | `false` | Development and tests only: lets a `host` pool runner run the agent as its own OS user, labelled "not isolated, same user (development only)". The server refuses to start with it `true` unless `NODE_ENV` is `development` or `test`. |
| `OSTRA_DOCS_URL` | `https://joeykhd.github.io/ostra/` | The docs site's address, which the panel's help links point at (F-058). Set it to a copy you host yourself, such as one for your own version. |

Booleans take `true`, `false`, `1`, `0`, `on`, `off`, `yes` or `no`.

**Blobs in an S3-compatible store.** With `OSTRA_BLOB_STORE=s3` new blobs go to the bucket, and the bucket must exist already: core creates none. The access key needs to read, write, list and delete objects in it. A blob written before the switch stays in Postgres and is still read from there, because each blob's row names its store. A blob written to S3 is read from S3 only while the `OSTRA_S3_*` settings are set, so keep them when you change the default back. Only core needs them: the panel reads every blob through core, at `OSTRA_CORE_INTERNAL_URL`. **Back up the bucket as well as the database**: an archive in the bucket is not in the database's backup. The bucket's `blobs/` prefix holds the blobs and its `uploads/` prefix holds uploads in flight. Core drops an upload nobody finished within 24 hours (`blob.gc`); as a backstop, give the bucket a lifecycle rule that expires `uploads/` and `upload-index/` after a few days, and one that aborts incomplete multipart uploads. A blob over `OSTRA_BLOB_MAX_MIB` is refused either way.

**The database runs in UTC.** Core and the panel open every connection with `TimeZone=UTC` (added to `DATABASE_URL` as `options=-c TimeZone=UTC`, unless the URL sets a time zone itself), because times are written as UTC with no offset. At start core checks `SHOW timezone` and the job queue's forwarding heartbeat, and refuses to start its workers, with a `jobs.boot_check_failed` log line, when either is wrong (ADR 0037).

**Connections.** Each core and each panel replica opens up to 15 connections to Postgres (10 for its queries, 4 for the job queue and one that listens for notices), so leave the server's `max_connections` room for 15 per replica. A transaction that finds every connection busy waits its turn for up to 10 seconds before it fails, so a burst bigger than the pool, such as 50 tickets delegated at once in Linear, queues instead of failing. A query connection nothing uses is closed after a minute, not after `pg`'s own 10 seconds, so the connections a burst opened are still there for the next one.

**The first admin.** A fresh install has an account from its first start: sign in at `OSTRA_PUBLIC_URL` as `demo@demo.com` (or `demo`) with the password `demo`, and choose a new password when asked. To start with your own account instead, set `OSTRA_ADMIN_EMAIL`, `OSTRA_ADMIN_USERNAME`, `OSTRA_ADMIN_PASSWORD` and `OSTRA_ORGANIZATION_NAME` before the first start. Several server processes starting at once still create one admin. The server logs `setup.first_admin_seeded` with the new IDs, never the email or the password.

**Several server processes.** Core and the panel can run as several processes, on one machine or many (ADR 0034: any replica serves any request). Processes that share one `OSTRA_DATA_DIR` share its keys. Processes that don't, such as replicas in a cluster, must all be given the same three settings: `OSTRA_SECRETS_KEY`, `BETTER_AUTH_SECRET` and `OSTRA_RUNNER_TOKEN_KEY`. Without the first, a process can't read the stored secrets and refuses to start; without the other two, a session or a runner's token made by one process is refused by another. Only the secrets key is checked at start: a new `BETTER_AUTH_SECRET` signs everyone out, and a new runner-token key makes every runner ask for a new token, which are both allowed.

**What core keeps in `OSTRA_DATA_DIR`.** Besides the keys above, core makes these files there at first start, each readable by its owner only: `secrets-key`, the built-in secret store's key when `OSTRA_SECRETS_KEY` is unset (the panel reads the same file, so back it up); `runner-token.key`, the key runners' 10-minute access tokens are signed with when `OSTRA_RUNNER_TOKEN_KEY` is unset (it also signs each task's MCP token; deleting it makes every runner get a new token, nothing more); and `bootstrap-join-token`, the default pool's bootstrap join token for the compose file's pool runner. The bootstrap token is stored hashed in the database and shown nowhere else; core writes it once the first organization exists, and doesn't make another after an admin revokes it in the panel (`OSTRA_BOOTSTRAP_JOIN_TOKEN=false` makes none). Core's daily catalog job also keeps the last good copy of the models.dev catalog in `catalog/models-dev.json` there, and the logos of the providers your models matched in `model-logos/`, which the panel serves (with `OSTRA_CATALOG_FETCH=false`, neither is fetched, and the copy bundled with ostra is used).

**The GitHub App's webhook.** What the App's webhook brings about task PRs is also read on a schedule (`OSTRA_RECONCILE_MINUTES`), so an install whose App has no webhook (an App created while ostra had no public address, Q187), or whose webhook stopped, still gets it (F-044): PR merges, closes and reopens, their CI and reviewers, how far a branch is behind, and each task PR's new comments, reviews and line comments, so `@ostra` (F-053) and "changes requested" (F-105) reach the task within the interval instead of seconds. Each lands once whichever way it came, by GitHub's comment or review ID (F-046). One thing needs the webhook: a comment edited after it was posted is heard only from its delivery, which names who edited it. A reopen is looked for in the 30 days after a PR's close. Give the App its webhook in its settings on GitHub for changes in seconds.

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
| `OSTRA_RUNNER_DATA_DIR` | `--data-dir` | `~/.ostra/runner` | The runner's folder: its key pair, its spool and the task workspaces (`tasks/<task>/workspace/<repo>`). On Windows the runner turns on git's `core.longpaths` for every clone and checkout it makes, so a repo with deep paths works under a long folder; git still refuses a `.git` folder path of about 250 characters, so keep this folder short. One runner uses a folder at a time: it holds `runner.lock`, with its pid, while it runs, and a second `ostra runner` on the folder exits with code 4, naming that pid. A lock whose process is gone (a crash), was written under another host name (a recreated container) or names the runner's own pid (a restarted container) is taken over. |
| `OSTRA_RUNNER_TRANSPORT` | `--transport` | `auto` | How the runner talks to the server: `auto` (a WebSocket, falling back to HTTP by itself when a proxy blocks it), `websocket` or `http`. Both go through HTTPS_PROXY, HTTP_PROXY and NO_PROXY, and trust NODE_EXTRA_CA_CERTS. |
| `OSTRA_RUNNER_EXECUTOR` | `--executor` | `host` | Where tasks run: `host` (a worktree on this machine, not isolated), `docker` (a box per task) or `kubernetes` (a pod per task, from a pool runner in the cluster). |
| `OSTRA_RUNNER_CAPACITY` | `--capacity` | (none: the slots' default) | How many tasks a `host` runner runs at once: the older name of `OSTRA_RUNNER_SLOTS`, which wins. |
| `OSTRA_RUNNER_LABELS` | `--labels` | (none) | Comma-separated labels that tasks can ask for, such as `gpu,macos`. |
| `OSTRA_RUNNER_NAME` | `--name` | the machine's host name | The runner's name in the panel. |
| `OSTRA_JOIN_TOKEN` | `--join-token` | (none) | A pool runner's join token, used once to register. A personal runner signs in with a device code instead. |
| `OSTRA_RUNNER_SHELL` | `--shell` | `bash` | The shell the `host` executor runs setup scripts with, and the environment's checks and app processes' command lines (`bash -lc <command>`). On Linux and macOS, `bash` from `PATH`. On Windows, the bare name `bash` means Git for Windows' own `bin\bash.exe`, found from the `git` on `PATH`, never WSL's `System32\bash.exe`; without Git for Windows, set it to a shell's full path. A full path is used as given. |
| `OSTRA_JOIN_TOKEN_FILE` | `--join-token-file` | (none) | A file holding a pool runner's join token, such as the bootstrap token core writes to `OSTRA_DATA_DIR` at first start (the compose file's runner reads it). `--join-token` wins. |
| `OSTRA_BOX_BASE_IMAGE` | `--box-base-image` | `<the release's image namespace>/base:<the runner's version>` | The `docker` executor's base image, for an environment that names none. The default is the base image of the runner's own release, under the namespace that release published its images to: the root `package.json`'s `imageNamespace`, which the release's stamp writes (`node scripts/version.ts`), and `ostra` in a clone, which `pnpm images:build` tags its local builds with. |
| `OSTRA_BOX_RUNNER_IMAGE` | `--box-runner-image` | `<the release's image namespace>/runner:<the runner's version>` | The image each `docker` box's sidecar runs: the `ostra` CLI. The default is the runner image of the runner's own release, under the same namespace as `OSTRA_BOX_BASE_IMAGE`'s. |
| `OSTRA_BOX_SERVER_URL` | `--box-server-url` | the `--server` address | Core's address as a `docker` box's sidecar reaches it, when that differs from `--server`. |
| `OSTRA_BOX_SUBNET_POOL` | `--box-subnet-pool` | `10.89.0.0/16` | The IPv4 network, /8 to /24, the `docker` executor carves each box's own network out of, a /24 per box (F-017, Q154). Docker's default address pools hold about 31 networks, which 50 boxes on one host would run out; the runner names each box network's subnet itself, skipping every /24 another network on the host already holds, and refuses a box once the pool is full. The default is clear of Docker's own pools (`172.17.0.0/16` to `172.31.0.0/16`, `192.168.0.0/16`). Keep it clear of your own networks too: the host routes each box's /24 to that box's bridge. The boxes' shared egress network still takes its subnet from Docker's pools. `deploy/egress-baseline.sh` reads the same variable, with the same default, to close the host to every box network (F-116): run it with the runner's value. |
| `OSTRA_RUNNER_SLOTS` | `--slots` | `docker`: the host's CPUs ÷ 2; `kubernetes`: `20`; `host`: `2` | How many tasks or boxes the runner holds at once (ADR 0059). The server may hold a personal runner to fewer (its member's setting, `OSTRA_PERSONAL_RUNNER_CAPACITY`, 2 by default). |
| `OSTRA_RUNNER_RESERVE_CPU_MILLIS` | `--reserve-cpu-millis` | `1000` | The CPU, in millicores, a `docker` runner keeps for the host and itself: it offers the engine's CPU less this. |
| `OSTRA_RUNNER_RESERVE_MEMORY_MIB` | `--reserve-memory-mib` | `2048` | The memory, in MiB, a `docker` runner keeps for the host and itself: it offers the engine's memory less this. |
| `OSTRA_RUNNER_WS_RETRY_MINUTES` | `--ws-retry-minutes` | `10` | After falling back to HTTP, how often the runner tries the WebSocket again. |
| `OSTRA_RUNNER_PIN` | `--pin` | `true` | Whether a runner installed from npm installs its server's version at start (ADR 0034). `false` keeps the installed one, inside the version window. A released server names the CLI its release published to npm, under the root `package.json`'s `cliPackage` (which the release's stamp writes, `node scripts/version.ts`) at the server's version, so its runners pin to that. A server built from a clone (`0.0.0`) names no package, since no registry has that version, so no runner pins; a development server pins from `pnpm dev:npm-registry`. |
| `OSTRA_RUNNER_NPM_REGISTRY` | `--npm-registry` | `https://registry.npmjs.org` | The npm registry the pin installs the `ostra` CLI from, such as a company mirror. Read only when the pin runs (see `OSTRA_RUNNER_PIN`). |
| `OSTRA_HOST_POOL_AGENT_USER` | `--host-pool-agent-user` | (none: a `host` pool runner refuses to start without it) | The OS user a `host` pool runner runs the agent as, separate from the runner's own (Linux and macOS): every process of a task starts through `sudo -n -u <user> --`. Make the user, add the runner's user to that user's group (the runner hands each task's folder to it), and give the runner's user a sudoers rule for that user alone: `<runner> ALL=(<user>) NOPASSWD:SETENV: ALL` and `Defaults><user> umask=0007, umask_override, closefrom_override` (`closefrom_override` keeps the box's browser's pipe open as the runner starts it as that user, with `sudo -C 5`; without it a task on the pool has no browser, and says so). Keep `OSTRA_RUNNER_DATA_DIR` outside every home folder (`/var/lib/ostra-runner`): the user must get through each folder above it. The runner checks at start that the rule works for that user and no other, that the user gets through to the data folder, and that it can't read the runner's key. A `host` pool runner on Windows refuses to start. The steps, and the systemd unit with `Delegate=yes` that gives each task a cgroup on Linux, are in the docs' "A pool on the host executor" (`apps/docs/content/runners/pools.mdx`). |
| `OSTRA_K8S_NAMESPACE` | `--k8s-namespace` | the service account's namespace | The namespace a `kubernetes` runner makes its boxes' pods in. The cluster must run Kubernetes 1.29 or later, for native sidecars. |
| `OSTRA_K8S_BUILD_NAMESPACE` | `--k8s-build-namespace` | `<namespace>-builds` | The namespace a `kubernetes` runner builds snapshots in, with BuildKit. |
| `OSTRA_K8S_NODE_WAIT_MINUTES` | `--k8s-node-wait-minutes` | `15` | How long a `kubernetes` box waits for a node before it fails and its task is queued again. |
| `OSTRA_K8S_RUNTIME_CLASS` | `--k8s-runtime-class` | (none) | The RuntimeClass a `kubernetes` box's pod runs with, such as `gvisor`. |
| `OSTRA_EGRESS_ALLOW` | `--egress-allow` | the server's address only | Comma-separated addresses a `docker` or `kubernetes` box may reach in private ranges, besides the server's (F-116). |
| `OSTRA_SIDECAR_CPU_MILLIS` | `--sidecar-cpu-millis` | `1000` | The CPU limit, in millicores, of a box's sidecar, counted in the box's footprint. |
| `OSTRA_SIDECAR_MEMORY_MIB` | `--sidecar-memory-mib` | `256` | The memory limit, in MiB, of a box's sidecar, counted in the box's footprint. |
| `OSTRA_SERVICE_CPU_MILLIS` | `--service-cpu-millis` | `1000` | The CPU limit, in millicores, of a service that names none, counted in the box's footprint. |
| `OSTRA_SERVICE_MEMORY_MIB` | `--service-memory-mib` | `1024` | The memory limit, in MiB, of a service that names none, counted in the box's footprint. |
| `OSTRA_RUNNER_SUBAGENT_WAIT_MINUTES` | `--subagent-wait-minutes` | `30` | How long a turn waits, once its agent's prompt is answered, for the subagents it started and the turns their reports wake (OpenCode runs subagents in the background). Past it, ostra stops them, fails each one on the call that started it, and ends the turn. The runner logs the bound and how many it stopped, never what they were asked. It counts inside the task's turn limit, and the runner passes it on to each `docker` and `kubernetes` box. |
| `OSTRA_RUNNER_BROWSER` | `--browser` | (none: the runner finds Chrome, Chromium or Edge, else downloads its pinned headless shell) | The Chromium-family browser a `host` runner takes screenshots, recordings and the browser view with (F-121, F-141): its executable's path. Unset, the runner finds Chrome, then Chromium, then Edge in the system's usual places, else, when a task first needs a browser, downloads Chrome for Testing's `chrome-headless-shell` at the version pinned in its release (158.0.8127.36), refuses it unless its SHA-256 is the pinned one, and keeps it in `<data folder>/browser/`. A setting that names no file means no browser, never a download. The machine's browser keeps its own sandbox. On Linux the downloaded shell's sandbox needs unprivileged user namespaces, which Ubuntu 23.10 and later restrict through AppArmor: there, install Chrome or Chromium from its package, which sets its sandbox up, or name it here. `docker` and `kubernetes` boxes use the image's Chromium (Debian's, pinned in the base image), without its own sandbox, inside the box's. |
| `OSTRA_RUNNER_BROWSER_DOWNLOAD` | `--browser-download` | `true` | Whether a `host` runner with no browser of the machine's may download the pinned headless shell (F-121). It's a public download carrying no usage data. `false` never downloads: the runner then reports no browser, and the panel says how to fix it. |

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
| `OSTRA_DEV_BLOCK_WEBHOOKS` | (none) | Any of `linear`, `jira` and `github`, comma-separated: core answers those webhook routes with 503 and stores nothing, so a test sees the polling and the reconcile catch up (milestone 2's demo and failure suite). Ignored when `NODE_ENV=production`. |
| `OSTRA_DEV_CORE_REPLICAS` | `1` | How many core replicas `pnpm dev` starts, 1 to 8, each on the next port after `OSTRA_CORE_PORT`, with one panel, for milestone 5's demo and load test. Runners are told the first one's address. |
| `OSTRA_DEV_DATA_DIR` | `.ostra-dev` at the repo root | Where milestone 5's dev tools write what other processes read: the fake cluster's kubeconfig, the proxies' CA. |
| `OSTRA_DEV_FAKE_KUBE_PORT` | `16443` | The port of `pnpm dev:fake-kube`, the fake Kubernetes API, on loopback. |
| `OSTRA_DEV_REGISTRY_PORT` | `15000` | The port of `pnpm dev:registry`, the fake OCI registry, on loopback. |
| `OSTRA_DEV_REGISTRY_AUTH` | `bearer` | `bearer` (Docker's token flow) or `basic`: how the fake registry asks for its credentials. |
| `OSTRA_DEV_NPM_REGISTRY_PORT` | `14873` | The port of `pnpm dev:npm-registry`, the fake npm registry, on loopback. |
| `OSTRA_DEV_NET_PROXIES_PORT` | `13128` | The first of the four ports of `pnpm dev:net-proxies` on loopback: the CONNECT proxy, the TLS-inspecting proxy, nginx's defaults, then the control port. |
| `OSTRA_PSEUDO_LOCALE` | (none: English) | `1` at `next build` and `next start` of `apps/web`: the pseudo-locale, every message of the panel wrapped as `⟦…⟧` with its letters accented, so a word that bypasses the message file shows (F-083). It builds into `.next-pseudo`, beside the ordinary build. The e2e pass `e2e/pseudo-locale.spec.ts` uses it; never set it on an install. |

Variables named `OSTRA_SPIKE_*` belong to the spikes in `spikes/`. The server neither reads nor refuses them, so the dev env files can be loaded before `pnpm dev`.

## The Helm charts

Two charts in `deploy/helm/`, versioned with the release (ADR 0060): `ostra-server` runs the panel and core against a Postgres you provide, and `ostra-runner` runs a `kubernetes` pool runner. They're often in different clusters. Each value below has its default in the chart's `values.yaml`; only the ones marked (required) have none, and Helm refuses an install without them. Each chart's `values.schema.json` is generated from `packages/deploy-checks/src/helm/values.ts`, so Helm also refuses a mistyped key. `examples/` in each chart holds working values files, one with only the required values.

**The cluster.** Both charts need Kubernetes 1.29 or later, for native sidecar containers (`kubeVersion: ">=1.29.0-0"`; F-093), and the runner chart needs a network plugin that enforces NetworkPolicy, such as Calico or Cilium: without one, its egress baseline is written and nothing enforces it (F-116).

**The server's keys.** Every server process gets the same `OSTRA_SECRETS_KEY`, `BETTER_AUTH_SECRET` and `OSTRA_RUNNER_TOKEN_KEY` (above, "Several server processes") from one secret. Without `secrets.existingSecret` the chart makes it once, on install, keeps its values on every upgrade (Helm's `lookup`), and never deletes it, uninstall included (`helm.sh/resource-policy: keep`). Back it up: without `OSTRA_SECRETS_KEY` the stored secrets can't be read.

**The runner's rights.** The runner's service account gets a Role in the box namespace and one in the build namespace, and nothing else: no cluster role. It may make and delete pods and secrets there, read their events, logs and quotas, and list the network policies, never change them (ADR 0060).

`pnpm check:helm` checks both charts: the schemas, the defaults, the examples and this reference everywhere, and where `helm` is on the PATH also `helm lint` and `helm template` with every example and the rendered manifests.

### `ostra-server`

| Value | Default | What it does |
|---|---|---|
| `image.repository` | `<namespace>/server` | The server image (ADR 0046). A release's chart names the namespace that release's images are published under; a clone's says `ostra`. |
| `image.tag` | the chart's `appVersion` | The image's tag. |
| `image.pullPolicy` | `IfNotPresent` | Kubernetes' pull policy for it. |
| `imagePullSecrets` | `[]` | The names of secrets to pull the image with. |
| `publicUrl` | (empty: the server's default) | `OSTRA_PUBLIC_URL`, the panel's address as browsers reach it. |
| `corePublicUrl` | (empty: the server's default) | `OSTRA_CORE_PUBLIC_URL`, core's address as runners and webhooks reach it. |
| `database.url` | (required: this or `database.existingSecret`) | The Postgres URL (`DATABASE_URL`). The chart keeps it in a secret of its own. |
| `database.existingSecret` | (required: this or `database.url`) | A secret you made that holds the Postgres URL. |
| `database.existingSecretKey` | `DATABASE_URL` | The key the URL is under, in either secret. |
| `secrets.existingSecret` | (empty: the chart makes one) | A secret you made holding `OSTRA_SECRETS_KEY`, `BETTER_AUTH_SECRET` and `OSTRA_RUNNER_TOKEN_KEY`. Set, the chart makes none. |
| `web.replicas` | `2` | How many panel processes run. |
| `web.port` | `3000` | The panel's port (`OSTRA_WEB_PORT`). |
| `web.resources` | 250m CPU and 512Mi requested, 1Gi memory limit | The panel's container's requests and limits. |
| `core.replicas` | `2` | How many core processes run. Any replica serves any request (ADR 0034). |
| `core.port` | `8787` | Core's port (`OSTRA_CORE_PORT`), which runners connect to. |
| `core.resources` | 250m CPU and 512Mi requested, 1Gi memory limit | Core's container's requests and limits. |
| `service.type` | `ClusterIP` | The type of the panel's and core's services. |
| `ingress.enabled` | `false` | Whether the chart makes an ingress. |
| `ingress.className` | (empty: the cluster's default) | The ingress class. |
| `ingress.webHost` | (empty; needed when `ingress.enabled`) | The panel's host name. |
| `ingress.coreHost` | (empty: no rule for core) | Core's host name. Runners outside the cluster need it. |
| `ingress.tlsSecretName` | (empty: no TLS) | The secret with the TLS certificate for both hosts. |
| `ingress.idleTimeoutSeconds` | `3600` | How long a quiet connection stays open through the ingress, raised for runners' and the panel's WebSockets (ADR 0034). Written as ingress-nginx's annotations. |
| `ingress.annotations` | `{}` | More annotations, such as another controller's timeouts. |
| `env` | `{}` | Any other server setting, by name (above, "The server"), such as `OSTRA_EMAIL_PROVIDER`. |

### `ostra-runner`

| Value | Default | What it does |
|---|---|---|
| `image.repository` | `<namespace>/runner` | The runner image: the runner, and each box's sidecar (ADR 0046). Under the release's image namespace, as the server chart's is. |
| `image.tag` | the chart's `appVersion` | The image's tag, which is the runner's pin (ADR 0034). |
| `image.pullPolicy` | `IfNotPresent` | Kubernetes' pull policy for it. |
| `imagePullSecrets` | `[]` | The names of secrets to pull the runner image with. |
| `boxImage.repository` | `<namespace>/base` | The base image a box's agent runs in, for an environment that names none (`OSTRA_BOX_BASE_IMAGE`). Under the release's image namespace. |
| `boxImage.tag` | the chart's `appVersion` | Its tag. |
| `server.url` | (required) | Core's address as the runner reaches it (`OSTRA_SERVER_URL`). |
| `server.boxUrl` | (empty: `server.url`) | Core's address as a box's sidecar reaches it (`OSTRA_BOX_SERVER_URL`). |
| `server.egress.cidr` | (required: this or `server.egress.namespace`) | The server's address or CIDR: the egress baseline's one exception (ADR 0060). |
| `server.egress.namespace` | (required: this or `server.egress.cidr`) | The namespace of a server in this cluster, for the exception. |
| `server.egress.podLabels` | (required with `server.egress.namespace`) | The labels of core's pods there, such as `app.kubernetes.io/component: core`. |
| `server.egress.port` | (required) | Core's port, the only one the exception opens. |
| `joinToken.existingSecret` | (required) | The secret holding the pool's join token, which the runner reads as a file (`OSTRA_JOIN_TOKEN_FILE`). |
| `joinToken.key` | `join-token` | The key the token is under. |
| `runner.name` | (empty: the release's name) | The runner's name in the panel (`OSTRA_RUNNER_NAME`). |
| `runner.labels` | `[]` | Labels profiles can ask for (`OSTRA_RUNNER_LABELS`). |
| `runner.slots` | `20` | How many boxes it holds at once (`OSTRA_RUNNER_SLOTS`). |
| `runner.nodeWaitMinutes` | `15` | How long a box waits for a node (`OSTRA_K8S_NODE_WAIT_MINUTES`). |
| `runner.runtimeClass` | (empty: the cluster's default) | The RuntimeClass boxes run with, such as `gvisor` (`OSTRA_K8S_RUNTIME_CLASS`). |
| `runner.resources` | 250m CPU and 256Mi requested, 512Mi memory limit | The runner's container's requests and limits. |
| `namespaces.create` | `true` | Whether the chart makes the two namespaces. `false`: an admin made them. |
| `namespaces.boxes` | `ostra-boxes` | Where boxes' pods run (`OSTRA_K8S_NAMESPACE`), with the egress baseline. |
| `namespaces.builds` | `ostra-builds` | Where snapshots are built (`OSTRA_K8S_BUILD_NAMESPACE`), with its own policy. |
| `egress.allow` | `[]` | Private addresses or CIDRs a box may reach besides the server's, such as a private model endpoint (`OSTRA_EGRESS_ALLOW`). |
| `build.registry.addresses` | `[]` | The registry's addresses, which a snapshot build pushes to. Empty: a build reaches DNS only. |
| `build.registry.port` | `443` | The registry's port. |
| `build.packageHosts` | `[]` | Addresses or CIDRs of the package hosts a build installs from, on HTTPS. |
| `build.codeHosts` | `[]` | Addresses or CIDRs of the code hosts a build clones from, on HTTPS. |
| `persistence.enabled` | `true` | A volume for the runner's key pair and spool. `false`: an emptyDir, and the runner joins again after a restart. |
| `persistence.size` | `1Gi` | The volume's size. |
| `persistence.storageClassName` | (empty: the cluster's default) | The volume's storage class. |

## Removed settings

Settings ostra no longer reads. A server that still finds one in its environment starts anyway and ignores it: core and the panel each log one `settings.retired_ignored` warning for it at start, with its name, the date it was removed and why, never its value. Remove it from your environment to quiet the warning.

| Setting | Removed | Why |
|---|---|---|
| `OSTRA_OPEN_SIGNUP_ACCOUNTS` | 2026-11-19 | ostra is self-hosted only, so sign-up is always closed: after the first admin, accounts join only by an admin's invitation (F-002). Set to `true`, it no longer opens sign-up. |
| `OSTRA_OPEN_SIGNUP_ORGANIZATIONS` | 2026-11-19 | Only the instance admin creates organizations (ADR 0026). Set to `true`, it no longer lets other accounts create one. |
