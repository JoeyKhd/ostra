# Target: a pool's page (milestone 5, screen 1)

> **Committed image:** `pool.webp`, downscaled from its 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel.

- **Prompt:** `pool.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation. References: `app-targets/m1/runners.png` (the screen this one starts from: its tables, meters, chips, state dots and properties panel), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route:** `/organization/runners/pools/{poolId}`. A pool row on the Runners page opens it (spec section 12, "Screens that only grow"); the breadcrumb `Runners` goes back.
- **Features:** F-092 (the fleet view: a page per pool), F-067 (capacity and the queue, with Cancel), F-091 (join tokens and the approval switch). Spec section 12, screen 1. Ticket 25 (`pools.get`, `pools.update`, `joinTokens.*`), ticket 26 (`runners.list` grown, `pools.queue`, `tasks.cancelQueued`), ticket 30 (this page).
- **Status:** a proposed target, waiting on approval (ticket 29's `## Comments`). Ticket 30 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

One pool, read top to bottom, answers four questions for an organization admin:
1. Is there room, and what does the agent reach here? (the lede, and the isolation or internet line)
2. Which runners serve it, and how is each connected? (Runners)
3. Who is using it, against which share? (Projects)
4. What is waiting, in which order, and why? (Queue, with Cancel)

The properties panel holds what the admin changes: the approval switch, the caps, the token lifetime, the projects, and the join tokens.

The picture shows Alex Kim (an admin) on `k8s-east`, a `kubernetes` pool of three runners at its cap of 24 boxes. `calculator` is at its share (8 of 8), so its three tasks are passed over; `web-storefront`'s three wait because the pool is full. Six tasks wait across two projects, as ticket 29 asks.

Only admins open a pool's page. A member who follows a link to it gets the panel's not-found page (`pools.get` answers `NOT_FOUND` for them, as for another organization's pool). A member sees their own task's place on the task page instead (ticket 26).

## Layout (CSS px at 1440 wide)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 234px | the shared sidebar; **Runners** selected, with its busy-box count in the plain count style (`24`), never amber |
| Top bar | 46px, bottom hairline | breadcrumbs `Acme Corp › Runners › k8s-east` (the pool's name in Plex Mono, `--text`). Right: one primary (Shell) button `New token` with Lucide `plus`, which makes a token and opens `pool-join`'s sheet |
| Page | `1fr`, padding `28px 36px` | title, lede, the line, then **Runners**, **Projects**, **Queue**, 24px apart |
| Properties panel | 320px, left hairline, padding `20px` | **Pool**, **Settings**, **Join tokens**, hairlines between |

No cards. Each section is a `.shead` line (Plex Sans 600 14px, `--text`, then a faint mono count) and hairline rows, as on the Runners page. The only boxes are the selected-row fill and the switch.

### Heading
- **Title:** the pool's name, Manrope 700 26px, then 10px after it on its baseline the executor chip (`Chip`, grey outline, Plex Mono 13px): `kubernetes`, `docker`, `host`, or each of them when the runners are mixed. The default pool also gets the chip `default`.
- **Lede** (15px `--muted`): `{n} runners, {busy} of {cap or slots} boxes busy, {queued} tasks waiting.` Picture: `3 runners, 24 of 24 boxes busy, 6 tasks waiting.` `{cap or slots}` is the pool's `maxBoxes` when it's lower than the summed slots of its `online` and `draining` runners, the slots otherwise. With nothing waiting the tail is `nothing waiting.` One runner: `1 runner`.
- **The line** (13px `--faint`, Lucide icon 14px, 8px under the lede). One per pool, from its runners' capabilities (ticket 26 returns it):
  - `kubernetes`, Lucide `globe`: `The agent has direct internet access: on kubernetes it shares the pod's network. Private ranges, the metadata address and other boxes stay blocked.` (ADR 0029, difference 4; Q151.)
  - `host`, Lucide `shield`: `Not isolated: the agent runs as its own OS user on the runner's machine, not in a container.` A runner on `OSTRA_DEV_HOST_POOL_SAME_USER` makes it `Not isolated, same user (development only): the agent runs as the runner's own user.`
  - `docker`: no line.
  - Mixed executors: one line per executor that has one, `kubernetes` first.
  - Never amber, never red: it's a fact about the pool, not an alarm.

### Runners
`.shead`: `Runners` + count. A `Table` with faint 12.5px headers. Columns: **State**, **Runner**, **Carrier**, **Containment**, **Labels**, **Busy**, **Version**. Rows 38px.

| Column | Picture | Rule |
|---|---|---|
| State | dot + word | the Runners page's `Status`: `online` green dot; `draining` grey half dot; `joining` grey ring; `offline` grey dot. A `joining` runner of a pool that requires approval reads `waiting for approval`, with the ring. `revoked` runners aren't listed |
| Runner | `k8s-east-a` | Plex Mono `--text`. The row is a link to the runner's page (`m5/runner`) |
| Carrier | `WebSocket`, `HTTP` | `--muted`. `—` when not connected |
| Containment | `container` | `--muted`: `container`, `job object`, `cgroup`, `process tree`. `process tree` adds Lucide `info` 13px `--faint` whose tooltip says `A process the agent detaches isn't contained.` |
| Labels | `tier:fast`, `gpu` | grey mono chips, the runner's own labels only (the built-in `executor:`, `os:` and `arch:` are on the runner's page). `—` with none. Past two, `+N` |
| Busy | `10 / 12 busy` | mono `--muted`: boxes held on it / its slots. `—` when joining or offline |
| Version | `v0.5.0` | mono `--muted`. A runner one minor behind adds a grey chip `behind`; outside the window, `outdated` (`m5/runner` has the fix). Never amber |

- Order: `online`, `draining`, `joining`, `offline`, then by name.
- Hovering a row shows its row menu at the right (`···`, `DropdownMenu`): `Drain` or `Resume`, and `Revoke`, with the confirms `m5/runner` specifies. Not in the picture; it's the Runners page's menu (ticket 31).
- Empty: `No runner has joined k8s-east yet. Start one with New token.`

### Projects
`.shead`: `Projects` + count. Columns: **Project**, **Boxes**, **Share**, **Queued**. Rows 38px, one per project allowed on the pool, in name order.

| Column | Picture | Rule |
|---|---|---|
| Project | 8px colour square + name | `--text`, a link to the project's settings, "Runners" (`m5/project-runners`) |
| Boxes | meter + `8 / 8` | `.meter` 120px × 4px, Mist `#CFD8D4` fill on `--line-2`; fill is busy ÷ share, or busy ÷ the pool's cap when the project has no share. Then mono `busy / share`, or mono `busy` alone without a share |
| Share | `8 boxes` + chip `at its share` | `{n} boxes` (Plex Sans); `No share` in `--faint`. A project at its share gets the grey chip `at its share` |
| Queued | `3` | mono, this project's tasks in the queue below |

- Counted from ostra's own rows (`Box` rows holding a slot), the same count admission uses (ADR 0037, ADR 0059).
- Empty: `No project uses k8s-east yet. A project lists its pools in its settings, Runners.`

### Queue
`.shead`: `Queue` + count, and at the right of the line a 13px `--faint` note: `Priority, then time queued`. Columns: **#**, **Priority**, **Task**, **Project**, **Waiting**, **Why**, and the action. Rows 38px.

| Column | Picture | Rule |
|---|---|---|
| # | `1` to `6` | mono `--faint`, the task's place (ticket 26's `place`) |
| Priority | icon + word | Lucide 14px `--muted` and the word in `--text`: `zap` Urgent, `arrow-up` High, `arrow-right` Medium, `arrow-down` Low. Prompt tasks and tickets without a priority are Medium (spec section 11, item 3). Grey only: never amber or red |
| Task | `WEB-88` + title | the key in Plex Mono `--faint`, then the title in `--text`, one line with an ellipsis. A prompt task has Lucide `message-square` 14px `--faint` in place of a key. The cell links to the task |
| Project | square + name | `--text` |
| Waiting | `4m` | mono `--faint`, since `queuedAt` (`4m`, `2h`, `3d`) |
| Why | `Pool full, 24 of 24` | 13.5px `--muted`, the short form of the task's wait reason (below); the full sentence is the cell's tooltip and the task page's waiting line |
| Action | `Cancel` | a teal link button, right-aligned |

Short forms of the reasons the queue shows (the full sentences are `m1/task`'s waiting line, grown by ticket 33):

| Reason (ticket 05) | Short form | Full sentence |
|---|---|---|
| `pool-full` | `Pool full, {busy} of {cap}` | `k8s-east is full: 24 of 24 boxes.` |
| `project-share-reached` | `At its share, {cap} boxes` | `calculator is at its share of k8s-east: 8 boxes.` |
| `no-runner-with-labels` | `Needs labels {labels}` | `No runner in k8s-east has the labels gpu.` |
| `needs-registry` | `Needs a registry` | `k8s-east needs a registry for snapshots.` |
| `size-too-large` | `Size {size} doesn't fit` | `No runner in k8s-east has room for a large box.` |
| `no-runner-online` | `No runner online` | `No runner in k8s-east is online.` |
| `queued` | `Next in line` | `1st in k8s-east's queue.` |

- **Cancel** opens an `AlertDialog`: title `Cancel this task?`, body `{key or "This prompt task"} stops as cancelled before it starts. It can be reopened like any stopped task.`, buttons `Keep it` and `Cancel task` (destructive: `--red` text on `--surface`). It calls `tasks.cancelQueued`; the row leaves the queue, the places below move up, and the audit log has `task.cancelled`. A task that started meanwhile answers `This task has already started.` in `--red` under the dialog's body, and the dialog stays open with only `Close`.
- The live stream refreshes the queue and every count (ticket 30); a task that starts slides out without a toast.
- The queue lists every queued task the pool could run, whichever project. A task whose project lists this pool second appears in both pools' queues; its place is in each.
- Past 50 rows, `Show all {n}` at the foot as a ghost button; the list doesn't page by itself.
- Empty: `Nothing waiting. Tasks wait here when k8s-east is full or a project is at its share.`

### Properties panel
Groups under 12px 500 `--faint` labels, `PropRow`s 30px with a 110px key column (`--muted`), values `--text`.

**Pool**
| Key | Picture | Rule |
|---|---|---|
| Executor | `kubernetes` | mono |
| Runners | `2 / 3 online` | mono numbers |
| Busy | `24 / 24 boxes` | mono numbers |
| Queue | `6 waiting` | `Nothing waiting` at 0 |

**Settings**, with a teal `Edit` at the right of its label, which opens the `pool-new` sheet in edit mode (title `Edit k8s-east`, button `Save`, no Projects list: a project's pools are its own setting, `m5/project-runners`):
| Key | Picture | Rule |
|---|---|---|
| Approval | switch on + `Required` | a `Switch` that saves at once (`pools.update`), then `Required` or `Not required`. Switching it off applies to runners that join from then on; a runner already waiting still needs its Approve, and the switch's tooltip says so |
| Max boxes | `24` | mono; `No limit` (sans) |
| Token lifetime | `30 days` | `{n} days`, or `No expiry` |
| Projects | `calculator, +2` | sans, as the Runners page's panel |

**Join tokens** + faint mono count of active tokens. Rows with hairlines between: the label (`Join token` with none) in Plex Mono `--text`, under it 12.5px faint mono `expires {date} · used {age} ago · {n} runners` (`never expires`, `never used`, `no runner` as they apply), and a `--muted` ghost `Revoke` at the right, top-aligned. A revoked token: the label struck through in `--faint`, `revoked {date}`, no button. Revoke asks first, with the Runners page's `AlertDialog` (`Revoke this join token?` / `Runners that already joined stay connected. No new runner can join with it.`).

The token itself is never on this page: it's shown once, in `pool-join`'s sheet.

## States and copy

| State | What changes |
|---|---|
| The picture | a `kubernetes` pool at its cap with six queued tasks, one project at its share |
| Room free, nothing queued | the lede ends `nothing waiting.`; the queue's empty line; meters below full |
| A `host` pool | the `shield` line; Containment shows each runner's own (`cgroup`, `process tree`, `job object`); the Busy column counts slots only |
| A minor-3 `docker` runner | its Version cell adds `behind`, and its Busy cell's tooltip says `Sizes not enforced: update this runner.` (spec section 5.1) |
| Requires approval, a runner waiting | its row reads `waiting for approval` with the ring, and the row menu offers `Approve` and `Reject` (ticket 31, `m5/runner-approval`) |
| No runner | the Runners section's empty line; the lede reads `No runner yet, {queued} tasks waiting.` |
| Loading | 38px hairline rows with a `--surface` bar where each value goes; the title and lede wait for the first answer |
| Cancel failed | the dialog's `--red` line (above); the row stays |
| Switch failed | the switch flips back and a `--red` line under the Settings label, `role="alert"`, from `errorText()` |
| Phone (F-075) | the properties panel stacks under the page. Each table scrolls sideways inside its section, the page never does. The queue keeps **#**, **Task** and the action visible, and puts the priority icon before the key and the short reason as a second 12.5px `--faint` line under the title (rows 52px); Project and Waiting go to the scrolled part. Runners keep State, Runner and Busy first |

## Components (shadcn/ui names)

`PageFrame` (with its properties-panel slot), `PageHeading`, `Section`, `Table` / `TableHeader` / `TableRow` / `TableCell`, the existing `Status`, `Chip` (`Badge variant="outline"`), `Progress` as `.meter`, `Button` (primary for `New token`, `link` teal for `Cancel` and `Edit`, ghost for `Revoke`), `DropdownMenu` (the row menu), `AlertDialog` (cancel, revoke), `Switch`, `PropRow`, `Separator`, `Tooltip`, `Skeleton`. Lucide 15px, stroke 1.75: `plus`, `globe`, `shield`, `info`, `zap`, `arrow-up`, `arrow-right`, `arrow-down`, `message-square`, `ellipsis`.

## Tokens

At the approved pictures' scale (`../m1/README.md`, "Scale"; the colours `app-design.md` lists).

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page, panel |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | the switch's track when off, skeleton bars |
| `--sel` | `#1A1B1E` | the sidebar's selected row, a hovered table row |
| `--line` | `#1F2023` | hairlines |
| `--line-2` | `#2A2C30` | chip borders, meter track |
| `--text` / `--muted` / `--faint` | `#F2F3F4` / `#B4B7BB` / `#8B8E93` | text tiers |
| `--green` | `#4FB286` | the `online` dot only |
| Mist | `#CFD8D4` | meter fills |
| `--teal` | `#6FB8AA` | `Cancel`, `Edit` |
| `--red` | `#E5675C` | the destructive buttons in the dialogs, errors |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | `New token`, the switch when on |
| `--amber` | `#FFB224` | nowhere on this page (only the sidebar's Needs you count) |

Type: title Manrope 700 26px; lede 15px; section titles Plex Sans 600 14px; rows 14px; headers 12.5px `--faint`; the line 13px; mono (names, keys, versions, labels, counts, times) Plex Mono at the same steps.

## Differences from the current code

Checked against `apps/web` and `packages/api` on `main` (2026-11-19):

1. **No pool page exists.** The Runners page (`apps/web/src/app/(panel)/organization/runners/page.tsx`, `components/runners/runners-view.tsx`) selects a pool into its properties panel (`pool-properties.tsx`). Add the route `organization/runners/pools/[poolId]/page.tsx`; the Runners page's pool rows become links to it, and its panel keeps the summary.
2. **`pools.get` doesn't exist** (`packages/api/src/routers/runners.ts` has `pools.list`, `create`, `update`, `joinTokens`, `createJoinToken`, `revokeJoinToken`). Ticket 25 adds it; ticket 26 adds `pools.queue` and `tasks.cancelQueued`, and the per-project counts.
3. **Runner rows** (`runner-rows.tsx`) have no carrier, containment or labels columns, and no row menu. The pool page uses the same row component, grown.
4. **Join token rows** (`pool-properties.tsx`) show label, expiry and last use; they gain the runner count. The shown-once code box moves out of the panel into `pool-join`'s sheet.
5. **The approval switch** is read-only text (`runners.approvalRequired`) today; here it's a `Switch` on `pools.update`, which exists.
6. **Messages.** New keys under `runners.pool.*` and `runners.queue.*` in `messages/en.json`; the wait reasons' short forms beside their sentences under `tasks.wait.*`.

## Wrong in the image

Build the copy and details in this file, not these:

- **The `kubernetes` chip** after the title is drawn large, in a box taller than the Runners page's chips. Use the same `Chip` as `default` and `not isolated`, mono 13px.
- **Mono where it should be sans:** `8 boxes`, `16 boxes`, `No share`, `24`, `30 days` and `calculator, +2` are drawn in mono. Only `24` (Max boxes) and the numbers in the Boxes and Busy cells are mono; `{n} boxes`, `No share`, `30 days`, `calculator, +2` and `Required` are Plex Sans.
- **The internet line** is drawn at about 12px; it's 13px, with its `globe` icon at 14px.
- **The sidebar** is the members picture's; build it from the shell, whatever it shows. The logo is the model's approximation; use the real Hinge SVG.

All visible copy is spelled right.
