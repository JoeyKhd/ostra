# Target: the environment's app processes (proposed 2026-11-21)

> **Committed images:** each `<name>.png` is the render at 2× (2880×1912), and each `<name>.webp` is 1440×956, one image pixel per CSS pixel. All of them render from `html/environment-app-processes.html`, a query string choosing the state, with the panel's own tokens (`apps/web/src/app/globals.css`) and fonts (`apps/web/src/fonts`). Sizes in this file are CSS px. Re-render: `node html/render.mjs <playwright's index.mjs> <name>`, then `python -I html/to-webp.py <name>`.

| Picture | State shown |
|---|---|
| `environment-app-processes.webp` | Alex Kim, an admin of `calculator`, on the environment's new **App** tab. Two processes, `web` (the primary) and `api`, both ready on the last box. Under them, `storybook :6006`, which an agent announced in `CALC-192` and Sam Rivera kept, waits for a project admin; and `docs :4000`, which detection found in `.devcontainer/devcontainer.json`, isn't added. Then the services, with `mailpit` marked as having a web UI. The properties panel holds the screenshots after each turn, the in-box addresses and the box's browser. |
| `environment-app-processes-light.webp` | The same in the light theme. |
| `environment-app-process-sheet.webp` | The editor sheet for `api`, with the ready check's path typed without its `/`, so the API's refusal shows under it and `Save process` is disabled. |
| `environment-app-processes-no-browser.webp` | The environment's base image, `acme/calculator-base:4`, has no Chromium: the warning under the tabs, the screenshots' line, and the box's browser group. |

- **Route:** the environment page, `apps/web/src/app/(panel)/projects/[project-id]/environment/page.tsx` → `components/projects/environment-view.tsx`, with a fourth tab `?tab=app` in a new `components/projects/environment-app.tsx`. A process's sheet is `?tab=app&process={name}`, so a link from a task's failed process opens it.
- **Shell:** the double sidebar (`app-shell.md`): the rail's **Projects** space, the project panel with **Environment** selected.
- **Features:** F-140 (app processes), with F-141 (the live preview reads them), F-121 (the screenshots after each turn) and F-112 and F-113 (detection and onboarding propose them). The milestone 8 spec names this target (`context/specs/m8-previews-and-library/spec.md`, section 13, target 5), and ticket 17 builds it. The facts are ADR 0068 ("The app's processes", "What a preview may reach") and `context/research/live-previews.md` §8.
- **Status: a proposed target, waiting for the maintainer's approval.**

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with each picture.

## Purpose

A service is a container from an image, such as a database. An app process is the project's own program, run from its repo, such as a Vite frontend and its API (ADR 0068). A project admin declares them once, and then every task can start the app: the agent with `start_app`, ostra for the screenshots after each turn, the pane when someone opens a preview, and "Start the app" on a stopped task. The tab has to make four things plain:
1. **What runs, in which order, and when it counts as ready:** each process's repo and folder, command, port and ready check, and which one is the primary preview.
2. **What's waiting to be added:** a process an agent announced and a member kept, and one detection found in the repo.
3. **What a preview may reach:** these ports, the ports an agent announces, and the services marked as having a web UI. Nothing else.
4. **How the processes find each other:** each gets the others' in-box addresses, and none gets a browser-facing URL. The app keeps one origin, with its API behind the frontend's dev-server proxy.

## Layout (`environment-app-processes.webp`)

The page column is 1136 at 1440: the page `minmax(0, 1fr)` and the properties panel **340** (`wideProperties`, as every environment tab, since it holds form controls). Page padding `26px 36px 20px`, so the content is 724 wide.

1. **Top bar,** 46px: `calculator › Environment`; at the right milestone 6's `Test this environment` (outline, Lucide `flask-conical`). This tab has **no primary in the top bar**: each process saves from its sheet, and the panel's controls save at once, as on `Services and checks`.
2. **Heading,** unchanged: the eyebrow `Saved 2h ago` (Plex Mono 12px `--faint`), `Environment` (Manrope 700 26px), the lede.
3. **Tabs,** 38px, 14px under the lede: `Setup`, `Services and checks`, **`App`** (new), then `Proposal` while one is open. A proposal waiting carries milestone 6's 6px amber dot on `Proposal` for project admins (their needs-you, `environment_proposal`), and a `--faint` one for members.
4. **App processes:**
   - **Title line,** 24px under the tabs, 30px tall: `App processes` (Plex Sans 600 15px), the count in Plex Mono 13px `--faint`, the note `the project's own programs, started in the box in this order` (13px `--muted`).
   - **The table,** `table-layout: fixed`, no box. Head 30px, 12.5px weight 500 `--faint`, a 1px `--line` under it: (handle), `Process`, `Port`, `Ready when`, `Last box`, (remove). Columns 24 / rest / 62 / 122 / 120 / 28.
   - **A row,** 52px, a 1px `--line` under it. The whole row opens the process's sheet.
     - **Handle:** Lucide `grip-vertical` 14px `--faint`. Drag, or focus it and press Alt+↑ / Alt+↓, as milestone 3's checks; the order is the start order, and it saves at once.
     - **Process,** two lines: (1) the name in Plex Mono 14px 500 `--text`, the label in 13px `--muted`, and for the primary a `primary` chip (22px, 1px `--line-2`, 5px radius, 12px `--muted`); (2) Plex Mono 12.5px `--faint`: the repo's short name with the folder after a `/` when it isn't the root (`calculator-web/api`), ` · `, then the command in `--muted`. The full `owner/repo` and command are the row's `title`.
     - **Port,** Plex Mono 13.5px `--text`.
     - **Ready when,** 13px `--muted`: `HTTP` and the path in Plex Mono `--text` (`HTTP /health`); `Command` and the command; or `Port open`.
     - **Last box:** a 7px dot and a word, then the time to ready in Plex Mono 12.5px `--faint`: `ready 6 s` (green dot), `didn't answer` (red dot), `exited 1` (red dot), `not run yet` in `--faint` with no dot. Its tooltip names the runner and when (`On build-01, 2h ago`). As with services, it's an event of the last box, never a live probe.
     - **Remove:** a ghost icon button, Lucide `x` 14px `--faint`, `--red` on hover, `aria-label="Remove web"`. It confirms in an `AlertDialog` when the process is the primary: `web is the primary preview. Remove it, and the pane opens api first, and the screenshots stop until you choose a primary.`
   - **`Kept from a task`,** a band (30px, `--surface`, 6px radius, Lucide `app-window` 14px `--muted`, the label 13.5px 600, the count in mono `--faint`), shown while one waits. Its row:
     - the 6px amber dot in the handle column, for project admins only (it's an `environment_proposal`, milestone 6's needs-you item); none for members;
     - line 1 the name and label the agent gave (`show_preview`); line 2, 13px `--muted`: `Sam Rivera kept it from CALC-192 · 20 min ago`, the key in mono;
     - the port, `Port open` (an announced port has no ready check yet);
     - at the right, across the last two columns: `Dismiss` (ghost, 26px) and `Review` (outline, 26px), which opens the sheet filled in from the announcement, with `Accept` as its primary.
   - **`Found in the repo, not added`,** a band with Lucide `file-search`, for what detection (F-112) read and the list doesn't have. Line 2 names the file and the command it found (`.devcontainer/devcontainer.json · pnpm docs:dev`). At the right `Ignore` (ghost) and `Add` (outline), which opens the sheet filled in. `Ignore` hides it until the file changes.
   - **Under the table,** 8px down: a ghost `Process` (24px, Lucide `plus` 13px, `--muted`), then 13px `--faint`: `Each saves from its sheet. A process that exits shows on its task with its log's last lines.`
5. **Services with a web UI,** 28px down: the title, the note `open as a preview too, private like every preview`, and a table of the environment's services that have a port (milestone 3's services; 40px rows): the name in mono and the image in mono 12.5px `--faint`, the port, a `Switch` with `Yes` / `No`, and the label as a 28px input (`Mail`) while it's on, `—` while off. Turning it on asks for the label in place and saves at once. On `host` runners no service runs (ADR 0029), so the pane never lists one there.
6. **The footnote,** 22px down, Lucide `shield-check` 14px `--faint`, 13px `--muted`: `A preview reaches only these ports and the ones an agent announces, never the sidecar's, the agent's or one below 1024.`

### The properties panel (340px)

Groups as every properties panel (`app-design.md`, layout item 4): a 12px 500 `--faint` label, 28px rows with a 96px key column, a 1px `--line` between groups.
1. **`Screenshots after each turn`,** with its `Switch` in the label row (teal when on). It's on by default once a process is the primary. Under it, 12.5px `--faint`: `After a turn that changed a repo, ostra opens web and puts each route in the thread.`
   - `Routes`: removable chips (24px, mono 12.5px, Lucide `x` 11px) and a dashed `Route` chip to add one. At most 5, each a path starting with `/`.
   - `Widths`: two checkboxes (15px, teal when checked): `Desktop 1440 × 900` and `Phone 390 × 844`, the sizes in mono `--faint`. Desktop is required, so it can't be unchecked alone (ADR 0068: "desktop, and phone if chosen").
   - 12.5px `--faint`: `Up to 5 routes. Pictures are kept with the task, after its box stops.`
   - With no primary, the switch is off and disabled, with `Choose a primary first.`
2. **`In-box addresses`:** 12.5px `--faint`: `Each process gets the others'. None is for a browser: keep the app on web's origin, with /api behind its dev server's proxy.` Then each variable over its value, both Plex Mono 12.5px (`--text` over `--muted`): `OSTRA_APP_WEB_URL` `http://localhost:5173`, `OSTRA_APP_API_URL`, `OSTRA_SERVICE_MAILPIT_URL` `http://mailpit:8025`; then `and 2 services · Show all` (teal), which lists the rest in place. A service's address is its name on `docker` and `localhost` on `kubernetes`; the panel shows the `docker` one, with the other in its tooltip.
   - `Proxy`: what detection read from the primary's dev-server config, `/api → :3001` in mono and `vite.config.ts` 12.5px `--faint`. With no proxy found and more than one process, 12.5px `--muted`: `web doesn't proxy to api. Agents are told to add it.`
3. **`The box's browser`:** `Browser` `Chromium 131` (mono) and `the base image` `--faint`; `Last seen` `build-01 · 2h ago`; `Logs` `.ostra/app/<name>.log` (mono 12.5px), the file in the task's config folder, never in a repo.

## The editor sheet (`environment-app-process-sheet.webp`)

A right `Sheet`, 440 wide, full height, over the `--scrim`: `--bg`, a 1px `--line-2` left edge, `--shadow-palette`.
1. **Head,** 54px, a 1px `--line` under it: `Edit api` (16px 600, the name in mono) and `x` (`Close`). A new one reads `New process`; a proposal `Keep storybook`; a detected one `Add docs`.
2. **Body,** padding `14px 20px`, fields 13px apart. Labels 13px 500 `--muted`; inputs 32px, `--surface`, a 1px `--control-line` edge, 6px radius; help 12.5px `--faint`.
   - `Name` (mono) and `Label` (100 wide) side by side; help `Lowercase letters, digits and dashes. The label is what people see in the pane.`
   - `Repo` (a `Select` of the project's repos, mono) and `Folder` (mono, 120 wide, `.` by default, repo-relative).
   - `Command` (mono); help `Starts it and keeps running. Its output goes to .ostra/app/api.log in the task's config folder, never the repo.`
   - `Port` (mono, 120 wide).
   - `Ready when`: a segmented `HTTP path | Command | Port open`, and the path or command beside it (none for `Port open`); help `Tried every 2 s for up to 120 s. Ready when it answers below 500.` (the command's: `Ready when it exits 0.`).
   - A hairline, then two switch rows (a 30px `Switch`, the label 14px 500, the help under it):
     - `The primary preview`: `The pane and the screenshots open it first. web is the primary now: turning this on moves it here.` (With none yet: `The pane and the screenshots open it first.`)
     - `Rewrite the host`, on by default: `The app sees Host and Origin as localhost:3001, so dev servers' host checks pass. Off, it gets the preview's own host, for an app that builds its sign-in callback from it.`
   - A hairline, then `Addresses`: `It gets OSTRA_APP_WEB_URL and the 3 services'. The others reach it at OSTRA_APP_API_URL, http://localhost:3001.` The variable name follows the `Name` field as it's typed.
3. **Footer,** 60px, a 1px `--line` above: `Remove api` (ghost, Lucide `trash-2`, `--red` on hover) at the left; `Cancel` (ghost) and `Save process` (primary) at the right. For a proposal: `Dismiss` and `Accept`; for a detected one: `Cancel` and `Add process`.

**The refusals,** each 12.5px `--red` under its field with Lucide `circle-alert` 13px, the field's edge `--red`, and `Save process` disabled (the API's words, ticket 16):

| Field | Refusal |
|---|---|
| Name | `Lowercase letters, digits and dashes only.` · `Another process or service is called web.` |
| Folder | `A folder inside the repo, such as apps/web.` (no `..`, no absolute path) |
| Command | `Give it a command that starts the app.` |
| Port | `Ports below 1024 can't be previewed.` · `web listens on 5173. Each process needs its own port.` · `A port from 1024 to 65535.` |
| Ready when | `A path starts with /, such as /health.` (the picture) · `Give the check a command.` |
| Primary | none: turning it on moves the primary, and the help says so |

## Every state

| State | What shows |
|---|---|
| **Processes, ready** | The picture |
| **No process yet** | One 52px row in `--faint`: `No app processes. Add the command that starts your app, or test this environment and let onboarding find it.`, then the bands when there's something kept or found. The panel's screenshot switch is off and disabled with `Choose a primary first.` |
| **No primary** (processes, none marked) | A line under the table, Lucide `info` 14px `--muted`, 13px `--text`: `No primary: the pane opens web first, and no screenshots are taken after a turn.` + teal `Make web the primary` |
| **Kept from a task** | The band and its row (the picture). `Review` opens the sheet with what the agent announced (name, label, port, path) and, when `show_preview` gave them, the command and folder; else those fields are empty and `Accept` waits for them |
| **Accepted** | The row joins the list at its end; the band goes; the task's preview row in the pane loses `This task only`. Toast: `storybook is part of calculator's environment now. Tasks get it from their next box.` |
| **Dismissed** | The band goes; the member who kept it sees, on the task, `Alex Kim didn't keep storybook.` |
| **Found in the repo** | The band and its row (the picture). Shown on a saved environment too, whenever detection reads something the list lacks |
| **Last box: a process failed** | `exited 1` or `didn't answer` with a red dot. The row's tooltip and its sheet show the exit code, `It didn't answer in 120 s.` and the log's last lines from the task's blob, behind `Show the log`. Nothing is logged on the server |
| **Not run yet** | `not run yet` `--faint` |
| **A box with no browser** | `environment-app-processes-no-browser.webp`: under the tabs, Lucide `triangle-alert` 15px `--muted`, 14px `--text` `The last box had no browser: acme/calculator-base:4 has no Chromium.` and 13px `--muted` `The processes still start. Screenshots and the browser view need a browser in the image.` + teal `How to add one`. The screenshots' line reads `Waiting for a browser in the box: nothing is taken until then.` The browser group: `None in the image`, the image, the runner. Never red: the processes work |
| **A runner below protocol minor 7** | Under the tabs, the same line shape: `build-02 runs an older ostra and starts no app processes. Upgrade it to use them.` + teal `How to upgrade a runner` |
| **Loading** | The table's head, then three 52px rows of `--surface` bars; the panel's values as bars |
| **A member, not a project admin** | Read-only: no handles, remove buttons, add buttons, switches or inputs (they read as text); the bands show without their buttons and without the amber dot; the sheet opens read-only with `Close` |
| **Saving** | The sheet's primary reads `Saving…`, disabled |
| **Light theme** | `environment-app-processes-light.webp`: `../m7/light-home.md`'s tokens; the amber dot keeps its inset ring |

## Keyboard

- The tabs: ←/→ (Radix `Tabs`), as on the other environment tabs.
- The table: each row is one tab stop (a button that opens the sheet); ↑/↓ move between rows; Enter opens. The handle is its own stop, with Alt+↑ / Alt+↓ to move the process, announced as `api moved to position 1 of 2`. In a band's row, Tab reaches its two buttons.
- The sheet: focus starts on `Name`; Tab walks the fields in order; Escape closes it (asking `Leave without saving?` when something changed); ⌘Enter saves.
- The panel: the switch, each route chip's `x`, `Route`, and the checkboxes are each a stop. Enter in the new route's field adds it.
- No new shortcut: the page adds none to the registry.

## Narrow and phone width

- **1024–1279px:** the context panel collapses (the shell's rule). The table keeps its columns; line 2 ellipsizes sooner.
- **Below 1024px:** the properties panel moves under the page as sections, as milestone 1's environment does. `Last box` drops to the process's line 2 (`… · ready 6 s`).
- **Phone (390px):** the shell's phone pattern: a 54px top bar whose menu button opens the rail and the panel as one sheet (`app-shell.md`). The tabs scroll sideways. Each process is a 64px row (name, label, chip; then port and ready check in mono 12px `--faint`), and a tap opens the sheet as a full-height bottom `Sheet` with 44px controls. The bands' buttons stay on their rows at 44px. The panel's groups follow the list.

## Components (shadcn/ui names)

- **From the repo:** the shell, `Tabs` (`UnderlineTabs`), `Table`, `Button`, `Sheet`, `Input`, `Select`, `ToggleGroup` (the ready check), `Switch`, `Checkbox`, `AlertDialog`, `Tooltip`, `Skeleton`, the toast, milestone 3's `Section`, row and drag-handle styles (`environment-services.tsx`), milestone 6's proposal (`environment-proposal.tsx`), `PropGroup` and `PropRow`.
- **New:**
  - `components/projects/environment-app.tsx`: the tab;
  - `app-process-row.tsx`: the row's variants (declared, kept, found) as a union with an exhaustive `switch`;
  - `app-process-sheet.tsx`: the editor, with its modes (edit, new, keep, add);
  - `screenshot-settings.tsx`: the panel's first group;
  - `in-box-addresses.tsx`.
  The ready check is the union `{ kind: "http"; path } | { kind: "command"; command } | { kind: "port" }`, the same Zod schema the runner protocol imports.
- **Icons** (Lucide, stroke 1.75): `grip-vertical`, `app-window`, `file-search`, `plus`, `x`, `trash-2`, `circle-alert`, `triangle-alert`, `info`, `shield-check`, `flask-conical`, `chevrons-up-down`, `check`.

## Tokens

`globals.css`'s, both themes: `--bg` the page, the panel and the sheet; `--surface` the bands, inputs and the label field; `--line` hairlines; `--line-2` chips and the sheet's edge; `--control-line` inputs and checkboxes; `--text` names, ports and values; `--muted` labels, commands and notes; `--faint` heads, line 2 and help; `--green` a ready process's dot; `--red` a failed one's dot and a refusal; `--teal` the switches, checkboxes and links; `--amber` only the kept process's dot and the `Proposal` tab's dot, for project admins; `--primary` only the sheet's save.

## WCAG AA (F-081)

Computed from `html/m8.css`'s tokens (WCAG 2.x relative luminance).

| Pair | Dark | Light | Need |
|---|---|---|---|
| `--faint` on `--bg` (heads, line 2, help, the panel's labels) | 5.9:1 | 5.6:1 | 4.5 |
| `--muted` on `--bg` (labels, commands, notes) | 9.6:1 | 8.1:1 | 4.5 |
| `--text` on `--bg` (names, ports) | 17.4:1 | 17.5:1 | 4.5 |
| `--faint` on `--surface` (a band's count) | 5.6:1 | 5.3:1 | 4.5 |
| `--muted` on `--surface` (the ready check's off segments) | 9.2:1 | 7.6:1 | 4.5 |
| `--text` on `--sel` (the ready check's chosen segment) | 15.5:1 | 15.0:1 | 4.5 |
| `--teal` on `--bg` (`Show all`, `How to add one`; a switch's track as a control) | 8.4:1 | 6.1:1 | 4.5 |
| `--on-primary` on `--teal` (a switch's knob, a checkbox's tick) | 7.5:1 | 6.1:1 | 3 |
| `--red` on `--bg` (a refusal, a failed dot) | 5.9:1 | 5.7:1 | 4.5 |
| `--green` on `--bg` (a ready dot, always with `ready`) | 7.4:1 | 5.5:1 | 3 |
| `--control-line` on `--bg` / `--surface` (inputs' and checkboxes' edges) | 3.6:1 / 3.4:1 | 3.6:1 / 3.4:1 | 3 |
| `--amber` on `--bg` (the kept process's dot) | 10.7:1 | 1.7:1, with its `--dot-amber` inset ring, and never alone: the band says `Kept from a task` | 3 |

## Data it needs

From the m8 spec (section 5) and ADR 0068:
1. **The environment's app processes,** in order: `name`, the repo and `folder`, `command`, `port`, `ready` (the union above), `label`, `primary` (at most one), `hostRewrite`. Saved one at a time, each a new environment version (ADR 0038).
2. **A service's preview flag** and its label.
3. **The screenshot settings:** on or off, up to 5 routes, the widths.
4. **Each process's last box:** its state (`ready` with the time it took, `failed` with the exit code, `not ready` after 120 s), the runner and the time, from `app.process` events; the log's tail as a task blob.
5. **Proposals:** a kept announcement as an `environment_proposal` (its task, who kept it, what `show_preview` gave), and detection's findings (the file and what it read), for project admins.
6. **The box's browser,** from the runner's `hello` and the box's report (`app.browser`): its name and version, or none, and the image.
7. **The addresses** are computed from the names, never stored.
8. **Audit:** a process added, changed, removed or reordered, a proposal accepted or dismissed, and the screenshot settings changed are audit entries (ADR 0054), by name, never the command's text.

## Differences from the current code

1. **The environment page has three tabs** (`Setup`, `Services and checks`, `Proposal`). It gains `App`, and no process, screenshot setting or preview flag exists in the schema or the API (tickets 04, 16).
2. **A service has no preview flag.** Its sheet (`environment-services.tsx`) gains `Has a web UI` and its label, the same switch as this tab's table.
3. **Detection** (`environment-draft.tsx`'s findings) proposes no process; it reads more files (F-112, ticket 15).
4. **Milestone 6's proposal** knows only onboarding's; it gains the kept announcement as a second source, and its diff gains processes (`environment-proposal` grows, spec section 13).
5. **Messages:** new keys under `environment.app.*`.

## Open points (recommendations; the maintainer's approval settles them)

1. **The tab's name:** `App` (drawn), `App processes`, or `Previews`. Recommended: `App`. It holds the processes, the services' web UIs and the screenshots, all about the running app.
2. **A kept announcement is a needs-you item** for project admins (the amber dot), as onboarding's proposal is in milestone 6, or a plain count. Recommended: needs you, as drawn. A member asked for it, and it waits on an admin.
3. **The command of a kept process.** `show_preview` gives a port, a label, a path and the primary flag (ADR 0068), but not how the agent started it. Recommended: `show_preview` also takes the command and folder as optional fields, and the agent's instructions ask for them; without them, `Accept` waits until the admin fills them in.
4. **The screenshots after each turn** live in the properties panel (drawn), or as a section of the page under the processes. Recommended as drawn: they're settings of the whole tab, and the page stays one screen.
5. **The order is the start order** (drawn, with handles). Recommended: keep it, since a frontend may need its API up first. A `dependsOn` per process can come later.

## Wrong in the image (build from this file)

- **The kept row's key** `CALC-192` is drawn as plain mono `--faint`. Build it as a link to the task (underlined on hover).
- **The sheet's error** shows while the field still holds `health`. The build shows the refusal on blur or on save, never while typing.
- **`environment-app-processes-no-browser.webp`** keeps the processes' `ready` from the same box. That's possible (the processes need no browser), but the build takes both from the same box's report, so they always agree.

Right as drawn: no primary on the page (the sheet's save is the decision), the two bands under the list, the amber dot only on the kept row and the `Proposal` tab, the addresses in the panel with no browser-facing URL.
