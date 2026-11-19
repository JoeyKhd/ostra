# Target: the environment's services, checks and snapshot (milestone 3, screen 14)

> **Committed image:** `environment-services.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel.

- **Prompt:** `environment-services.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation. References: `app-targets/m1/environment.png` (the approved page this one grows from, spec section 12), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route:** `apps/web/src/app/(panel)/projects/[project-id]/environment/page.tsx` → `components/projects/environment-view.tsx`, with the new tab in `components/projects/environment-services.tsx` (ticket 48). The tab is `?tab=services`; no query is the Setup tab.
- **Features:** F-094 (services), F-051 (snapshots), F-054 (checks before the PR). Spec section 12, screen 14. Ticket 40 (`environments.services.*`, `.checks.*`, `.snapshot.get` / `.rebuild`, the "no runner can start services" flag), ticket 48 (this screen), tickets 14, 15, 26, 27 (the executors and core). ADR 0038 (amended for milestone 3), ADR 0052 (checks), ADR 0029 (`host` starts no services).
- **Status:** a proposed target, waiting on approval (ticket 41's `## Comments`). Ticket 48 builds its data and tests until then, not its UI.

> Build it in real HTML/React (app-design.md, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

Milestone 1's environment page holds what a task gets before its agent starts: the setup script and each repo's variables, secrets and files. Milestone 3 adds three things a project admin sets once and then mostly watches:

1. **Services:** containers that start beside each box on `docker` runners (a database, a cache, a mail catcher), with their health on the last box that ran them.
2. **Checks:** commands that run in order after every turn with changes, before the push. A failure makes the PR a draft (ADR 0052).
3. **The snapshot:** on `docker`, the image a box starts from, who built it and when, and "Rebuild". On `host`, no image: a worktree and a dependency cache stand in (ADR 0038, amended).

The page also has to say the one rule that surprises people: **a project with services runs only on runners that can start them.** A personal runner uses `host`, which starts none, so it never gets this project's tasks while the list isn't empty.

The page gets two underline tabs, `Setup` (milestone 1's page, unchanged) and `Services and checks` (this target), so neither grows past a screen. The picture shows the second tab for `calculator`, whose pool `build-fleet` has `docker` runners online, with a ready snapshot.

## Layout (CSS px at 1440 wide)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 232px, `--side`, 1px `--line` on its right | the shared sidebar: `calculator` expanded, **Environment** selected (`--sel`). Built from `components/shell/sidebar.tsx`, never from the picture |
| Top bar | 44px, 1px `--line` below | breadcrumb `calculator › Environment`. On the `Setup` tab, milestone 1's `Save environment`. On this tab, **no button**: services and checks save one at a time from their sheet |
| Page | `1fr`, padding `28px 40px`, content max 760px | eyebrow, title, lede, tabs, Services, Checks, footnote |
| Properties panel | **340px** (`wideProperties`, as milestone 1's environment page), 1px `--line` on its left, padding `20px 18px` | Snapshot, On host runners, Where tasks run |

The picture draws the sidebar at about 246px and the panel at about 405px. Build 232px and 340px.

### Heading

1. **Eyebrow:** Plex Mono 12px `--faint`, as milestone 1: `Saved 2h ago` (`Draft · not saved yet` on a draft).
2. **Title:** `Environment`, Manrope 700 24px, letter-spacing −0.015em.
3. **Lede,** 13.5px `--muted`, one line, on both tabs: `What every task of this project gets: its setup, the services beside it, and the checks after each turn.` (It replaces milestone 1's ordinary lede. The just-created lede, `ostra drafted this from the repo's files…`, stays as it is.)
4. **Tabs** (`Tabs`, underline style), 14px under the lede, 36px tall, a 1px `--line` under the whole row: `Setup` and `Services and checks`, 13px weight 500; the selected one `--text` with a 2px `--text` underline, the other `--muted`. Switching tabs keeps unsaved Setup edits in memory; `Save environment` saves them when the member comes back.

### Services

1. **Title line,** 24px under the tabs: `Services`, count in Plex Mono 12px `--faint` (`3`), inline note `start beside each box on docker runners, before the setup script` (12.5px `--muted`).
2. **Table,** no box. Header 30px, 11.5px `--faint` weight 500, 1px `--line` under it; body rows **40px**, 1px `--line` under each. A row is a button: click or Enter opens the service in the sheet.

| Column | Width | Contents |
|---|---|---|
| Service | flex | the name in Plex Mono 13px `--text` (`db`), then 10px on, the image in Plex Mono 12px `--faint` (`postgres:17`), truncated with a `title` |
| Port | 70px | Plex Mono 12.5px `--text` (`5432`); `none` in `--faint` |
| Variables | 110px | 12.5px `--muted`: `3 · 1 secret` (the count, then the secrets among them); `none` in `--faint` |
| Health check | 150px | Plex Mono 12.5px `--muted` (`pg_isready -U app`), truncated; `none` in `--faint` |
| Last box | 130px | a 7px dot and a word, then the time in Plex Mono 12px `--faint`: `healthy 4s` (green dot; `afterMs` from `service.healthy`), `failed` (red dot; the reason in the tooltip and in the sheet), `started no check` (grey dot: no health check, so no health), `not run yet` in `--faint` with no dot. Tooltip: `On build-01, 2h ago` |
| Remove | 28px, right | ghost icon button, Lucide `x` 14px `--faint`, `--red` on hover, `aria-label="Remove db"` |

   The header reads `Last box`: health is an event on the last box that ran the service, never a live probe (spec 5.3: "a service's health is an event, not a column").
3. **Add:** 8px under the table, one ghost button, 24px, `--muted`, Lucide `plus` 13px, no border: `Service`.
4. **The runner note,** 8px down, 12.5px `--muted`, Lucide `server` 13px `--faint`: `Host runners start no services, so this project's tasks run only on docker runners. build-fleet has 2 online.` The pool names and the count come from the API (see "Data"). With several pools: `build-fleet and gpu-pool have 3 online.` Shown only while the list isn't empty.

### Checks

1. **Title line,** 28px above: `Checks`, count `3`, inline note `run in this order after every turn with changes, before the push`.
2. **Table,** same header and 40px rows. A row is a button that opens the check in the sheet.

| Column | Width | Contents |
|---|---|---|
| Handle | 24px | Lucide `grip-vertical` 14px `--faint`, the drag handle; `cursor: grab` |
| # | 24px | the position, Plex Mono 12.5px `--muted` |
| Name | 120px | Plex Mono 13px `--text` (`typecheck`) |
| Command | flex | Plex Mono 12.5px `--muted` (`git diff --check origin/main...HEAD`), one line, truncated with a `title` |
| Repo | 170px | Plex Mono 12.5px `--muted` (`acme/calculator-web`); `workspace root` in `--faint` sans when the check runs at the root |
| Timeout | 70px | Plex Mono 12.5px `--muted`: `10 min`, `90 s` (whole minutes as `N min`, otherwise seconds) |
| Remove | 28px | as in Services, `aria-label="Remove typecheck"` |

   Reordering: drag by the handle, or focus the handle and press `Alt+↑` / `Alt+↓` (announced: `typecheck moved to position 2 of 3`). The new order saves at once (`environments.checks.reorder`); while it saves, the numbers show the new order and a failure puts the old order back with the error line.
3. **Add:** ghost `Check`, as above.
4. **Help,** 8px down, 12.5px `--faint`: `A failing check doesn't stop the push: the pull request opens as a draft, and the task page offers Ask the agent to fix.`

### Footnote

22px under the checks, Lucide `shield-check` 13px `--faint`, then 12.5px `--muted`: `Services and checks get the environment's variables, never a model key or a GitHub token.` (ADR 0052, spec section 2.)

### The sheet (add or edit)

A `Sheet` from the right, 420px (as milestone 1's file editor), title `New service` / `db`, or `New check` / `typecheck`. Saving here saves that one item (`environments.services.save`, `environments.checks.save`), never the Setup tab's edits.

- **Service:** `Name` (mono `Input`, required, letters, digits and `-`, unique in the environment; it's the host name the agent reaches it by: help `The agent reaches it at db:5432.`), `Image` (mono `Input`, required, `postgres:17`), `Port` (mono number `Input`, optional), `Variables` (the Setup tab's table in small: rows of name and value, `+ Variable` and `+ Secret`; a stored secret reads `set` with `Set: type to replace it` as its placeholder, and its value never comes back from the API), `Health check` (mono `Input`, optional, help `Runs in the service's container. Healthy when it exits 0.`). On a service that failed on the last box, a `--red` line at the top, `role="status"`: `Failed on build-01, 2h ago: health check timed out.` Buttons `Cancel` and primary `Save service`. Saving queues a snapshot rebuild; the sheet says so under the buttons in 12px `--faint`: `Saving rebuilds the snapshot. Running tasks keep theirs.`
- **Check:** `Name` (mono, required, unique), `Command` (mono `Textarea`, 3 lines, required), `Repo` (`Select`: each repo of the project, then `Workspace root`), `Timeout` (mono number `Input` with a `min` / `s` unit `Select`, default 10 min, the stored `timeoutSeconds`). Buttons `Cancel` and `Save check`. A new check goes last.
- **Errors:** under the field, 12px `--red` (`A service with that name exists.`, `An image like postgres:17.`); a save failure as a `role="alert"` line above the buttons.

### Properties panel

`PropGroup`s with an 11px 500 `--faint` label, 30px `PropRow`s (key column **120px** here, so `Can start services` fits on one line: `PropRow`'s `labelWidth` from milestone 2), 12.5px, key `--muted`, value `--text`. The Snapshot group sits at the top of the panel on **both** tabs (milestone 1's `environment.md` reserved that place); the two groups under it show only on this tab.

1. **Snapshot.** The label row has, at its right, a secondary `Button size="sm"` (26px, 1px `--line-2`, Lucide `refresh-cw` 13px): `Rebuild` (project admins only; `environments.snapshot.rebuild`).
   - `Status` · 7px dot and word: `Ready` (green, with halo), `Building` (a grey ring), `Queued` (a grey ring), `Failed` (red).
   - `Built` · `2h ago · 2m 41s` (age, then the build's duration in Plex Mono).
   - `On runner` · `build-01` (mono): the `docker` runner that holds it (`Snapshot.runnerId`).
   - `Why` · `Environment changed` / `A lockfile changed` / `Nightly` / `Rebuilt by Alex Kim` (from `reason`).
   - `Secret scan` · `Passed`.
   - `Digest` · `sha256:9c41e2a` (mono, the first 7 hex digits; the full digest in the `title`, with a teal `Copy` on hover).
2. **On host runners:**
   - `Instead` · `Worktree and dependency cache`.
   - `Services` · an outline `Badge`, Plex Mono 11px `--muted`: `not on host` (never amber: it's a fact, not a wait).
3. **Where tasks run:**
   - `Pools` · `build-fleet` (the project's pools, comma-separated).
   - `Can start services` · `2 runners online` (Plex Mono numbers): online runners of those pools whose executor declares `services`.
   - `Executors` · `docker` (mono): the executors of the online runners of those pools, comma-separated (`docker, host` when a personal runner of the member is online too).

## States and copy

### Services

| State | What it shows |
|---|---|
| Services, a runner can start them (the picture) | as above |
| **No runner online can start them** | in place of the runner note, a block in milestone 2's `repo-checks` blocker style (2px `--red` left rule, `--surface` fill, 12px padding, Lucide `ban` 15px `--red`), `role="status"`: first line 13px 600 `--text`: `Tasks of this project are waiting.`; second line 12.5px `--muted`: `It has services, and no runner online can start them. Host runners start none; a docker runner of build-fleet can.` Never amber: amber means the member is needed, and this isn't theirs to answer unless they run a runner |
| No pool runner uses `docker` | the same block, second line: `It has services, and none of this project's runners can start them: they all use the host executor. Remove the services, or add a docker runner to build-fleet.` |
| No services | one 40px row with hairlines, 13px `--faint`: `No services. Add one when tasks need a database or a cache beside them.` No runner note |
| A service never run | `Last box` reads `not run yet` |
| A service failed | red dot, `failed`, its reason in the tooltip (`health check timed out`, `image not found`, `exited with code 1`) and at the top of its sheet |
| Remove | `AlertDialog`: title `Remove the db service?`, body `New boxes start without it, and the snapshot rebuilds. Running tasks keep theirs.`, buttons `Cancel` and `Remove` (destructive) |
| Not a project admin | no add buttons, no remove buttons, no handles; rows open the sheet read-only (fields disabled, secrets read `set`, no Save). The note and the block still show |

### Checks

| State | What it shows |
|---|---|
| Checks (the picture) | as above |
| No checks | one 40px row, 13px `--faint`: `No checks. Pull requests open without them.` The help still shows |
| One check | the handle and `Alt` keys do nothing; the handle is hidden |
| Remove | `AlertDialog`: title `Remove the typecheck check?`, body `It stops running after the next turn. Pull requests already open keep their state.`, `Cancel` / `Remove` |
| Reorder failed | the old order comes back, and under the table `role="alert"`, 12.5px `--red`: the error text |
| Not a project admin | read-only, as for services |

### Snapshot (panel)

| State | What it shows |
|---|---|
| Ready (the picture) | as above |
| Queued | `Status` · `Queued`; `Why` · the reason; `Rebuild` disabled with `Queued` as its label. The ready snapshot before it, if any, shows under it as `In use` · `built 2d ago on build-01` |
| Building | `Status` · `Building` · `since 1m` (mono); `On runner` · the runner building it; `Rebuild` disabled; `In use` as for Queued |
| Failed | `Status` · `Failed` (red dot); `Reason` · `The setup script failed` (`setup-failed`), `A setup secret was found in the image, so it was deleted` (`secret-found`), `The image didn't build` (`build-failed`); `Detail` · the first line of `detail` in Plex Mono 12px `--faint`, its full text in the `title`; `In use` · the previous ready one, or `Full setup on each box` in `--muted` when there's none. `Secret scan` · `Failed` in `--red` for `secret-found`. `Rebuild` enabled |
| None yet | `Status` · `None yet` in `--faint`; under the rows, 12px `--faint`: `A docker runner builds one after the next change, or with Rebuild. Until then each box runs the full setup.` |
| Only `host` runners in the project's pools | the Snapshot group shows one row, `Kind` · `Worktree and dependency cache`, no `Rebuild`, and the `On host runners` group is left out (it would say the same) |
| Rebuild pressed | the button reads `Queued`, disabled; `Status` turns `Queued`; a failure shows a `role="alert"` line in `--red` under the group |
| Not a project admin | no `Rebuild` |

### The page

| State | What changes |
|---|---|
| Loading | the tables' rows are 40px hairline rows with `Skeleton` bars where values go; the panel's values are skeletons; the tabs and heading render at once |
| Load failed | one `role="alert"` line in `--red` in place of the tab's sections |
| Narrow (below 1280px) | the panel drops under the page (`PageFrame`). Below 900px the Services table hides Variables and Health check, and the Checks table hides Repo; each row's sheet still has them. At phone width both tables scroll sideways inside their section, never the page |

### Elsewhere: the task's dispatch note

Not on this screen, but built in ticket 48 from milestone 1's dispatch note field on the task page: a queued task whose environment has services and no runner to take it reads `Waiting for a runner that can start services. Online now: alex-mbp (host).` (`--muted`, never amber).

## Components (shadcn/ui names)

`Sidebar` (existing), `PageFrame` with `Breadcrumb` and `properties` (`wideProperties`), `PageHeading`, `Tabs` / `TabsList` / `TabsTrigger` (new, underline style), `Section`, `Table` family, `Button` (`ghost` for add and remove, `sm` secondary for Rebuild), `Sheet` (existing), `Input`, `Textarea`, `Select` (existing), `Badge` (outline), `AlertDialog`, `Tooltip`, `Skeleton`, `PropGroup` / `PropRow` (with `labelWidth`), the `Status` dot. Drag and drop: whatever the panel already uses for lists, else plain pointer events on the handle (ask before adding a dependency, `AGENTS.md`). Lucide 15px, stroke 1.75: `box`, `server`, `grip-vertical`, `plus`, `x`, `refresh-cw`, `shield-check`, `ban`, `check`.

## Tokens (`app-concepts/html/graphite.css`)

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page, panel |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | inputs in the sheet, the blocker block, skeletons |
| `--raise` | `#17181B` | row hover |
| `--line` | `#1F2023` | hairlines, tab rule, panel edge, group lines |
| `--line-2` | `#2A2C30` | control borders, the Rebuild button, the badge |
| `--text` | `#EDEDEE` | names, ports, values, the selected tab and its underline |
| `--muted` | `#9A9DA3` | lede, notes, commands, health checks, keys, the other tab |
| `--faint` | `#64676D` | eyebrow, headers, images, handles, `none`, times, help |
| `--sel` | `#1A1B1E` | the selected Environment nav row |
| `--green` | `#4FB286` | `healthy` dots, `Ready` (halo `rgba(79,178,134,0.15)`) |
| `--red` | `#E5675C` | `failed`, the blocker's rule and icon, errors, remove on hover |
| `--teal` | `#6FB8AA` | `Copy` on the digest |
| `--amber` | `#FFB224` | only the sidebar's Needs you count. Nothing on this page is amber |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | the sheets' Save buttons, `Save environment` on the Setup tab |

Type: Manrope 700 24px (title); IBM Plex Sans 13px body, 12.5px secondary, 11–11.5px labels and headers, 500 for tabs and buttons, 600 for section titles; IBM Plex Mono for service and check names, images, ports, commands, health checks, repos, timeouts, runner names, the digest and durations.

## Data this screen needs beyond ticket 40

- **Where tasks run:** ticket 40's `environments.get` returns a flag (services and no runner that can start them). The note and the panel also need the project's **pool names**, the **count of online runners that can start services**, and the **executors online**. Add them to that query, or drop the runner note's second sentence and the `Where tasks run` group.
- **A service's last box:** the health list needs the runner's name and when, for the tooltip, and a failed service's reason (`service.failed { reason }`).
- **The snapshot's duration** (`2m 41s`): from `snapshot.built { durationMs }`; store it on `Snapshot` or read it from the event.
- The check's **`position`** and **`timeoutSeconds`** come from ticket 06's migration.

## Differences from the current code

Checked against `apps/web` on `main` (2026-11-19):

1. **Tabs.** `environment-view.tsx` is one page. Split it: the current page becomes the `Setup` tab unchanged, and `environment-services.tsx` is the new tab. The top bar's `Save environment` shows only on `Setup`.
2. **Lede.** `environment.lede` changes to the line above (both tabs).
3. **Properties panel.** The Snapshot group goes at the top on both tabs. Milestone 1's detection group **Services** (`not on host`, with `They come with milestone 3.`) changes: on a draft, a service found in `docker-compose.yml` gets a teal `Add` link that opens the service sheet with its name and image filled, and the help becomes `Found in docker-compose.yml. Services start only on docker runners.`
4. **New pieces:** `Tabs`, `AlertDialog` (milestone 2's, if it landed), `Tooltip` (milestone 1's environment spec asked for it), and `PropRow`'s `labelWidth` (milestone 2).
5. **Messages.** New keys under `environment.services.*`, `environment.checks.*` and `environment.snapshot.*` in `messages/en.json`.

## Wrong in the image

Build the copy and details in this file, not these:

- The sidebar is about 246px and the panel about 405px. Build 232px and 340px.
- The table rows are about 35px. They're 40px, as every table on this page.
- In the `mailpit` row, `started no check` runs into the remove `x`. Give `Last box` its 130px and the remove column its own 28px.
- The selected tab is drawn semibold, and its underline doesn't quite sit on the row's hairline. Both tabs are weight 500, and the underline sits on the shared 1px rule.
- The panel's `Can start services` value and `build-fleet` are mono in the picture. `build-fleet` (a pool name) is sans, as on the Runners page; only the numbers are mono.
- The Storage icon is a database cylinder and the Linear icon a slashed circle. Use `hard-drive` and the icon milestone 2's Linear screen settled on.
- The picture has no sheet, blocker, empty, failed, building, read-only, loading or narrow states: they're in the tables above.

All visible copy in the image is spelled right.
