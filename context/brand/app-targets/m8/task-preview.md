# Target: the task page with a live preview pane (approved 2026-11-21)

> **Committed images:** each `<name>.png` is the render at 2× (2880×1912), and each `<name>.webp` is 1440×956, one image pixel per CSS pixel. All of them render from `html/task-preview.html`, a query string choosing the state, with the panel's own tokens and fonts. The app inside the pane (`html/app-fixture.js`, "Tally") is demo data drawn in the customer app's own colours, on purpose. Sizes in this file are CSS px. Re-render: `node html/render.mjs <playwright's index.mjs> <name>`, then `python -I html/to-webp.py <name>`.

| Picture | State shown |
|---|---|
| `task-preview-pane.webp` | `CALC-192` is running. The thread is on the left. On the right is the pane, showing `web :5173` at `/history` live: the box's browser, streamed, at the pane's own size, with two members watching. The agent's `Preview` row in the thread is the place it opened the preview. The project panel's live row for the task is selected. |
| `task-preview-pane-light.webp` | The same in the light theme. The app keeps its own colours. |
| `task-preview-expanded.webp` | **Expand:** the pane takes the page's whole width. The context panel collapses and the thread hides. A steer bar floats at the bottom: the agent's activity now, and a one-line composer. `Back to the chat` and `esc` return. |
| `task-preview-starting.webp` | The member opened the pane before the app answered: `Starting web`, its three steps, and the start command's last lines. |
| `task-preview-stopped.webp` | The agent's turn ended and the box went to sleep after 15 minutes idle. The last screenshot sits behind a card: `The box is asleep`, `Wake to preview`, what waking does and what it costs. |
| `task-preview-none.webp` | Nothing is declared or announced. The pane says so, lists a port the box is listening on (`:3001`, detected), and offers to ask the agent or to declare the app in Environment. |
| `task-preview-services.webp` | The service switcher is open. It lists the task's previews, primary first, each with its source: `web` (declared, primary), `api`, `mailpit` (a service), `storybook` (opened by the agent, with `Keep it for calculator`), then a detected port, `Open a port…` and the Environment link. |
| `preview-share.webp` | The share menu of `web :5173`, set to `Anyone with the link`, with the expiry, the link, `Allow input` off, who made it, its first use and `Revoke`. `Public` is greyed, with the reason. |

- **Route:** unchanged, `apps/web/src/app/(panel)/tasks/[task-id]/page.tsx` → `components/tasks/task-view.tsx`. The pane is a side pane of the task page, chosen from the top bar's `Preview | Properties` toggle, and kept in the URL (`?pane=preview&preview={label}&path=/history`), so a link reopens it. Expand adds `&view=full`.
- **Shell:** the double sidebar (`app-shell.md`): the Projects space, the project panel, the task's live row selected.
- **Features:** F-141 (the live preview), F-142 (sharing a preview), F-140 (app processes: the services in the switcher) and F-144 (the preview domain: the in-your-browser mode). The milestone 8 spec builds them (`context/specs/m8-previews-and-library/spec.md`, section 13, targets 1 to 3 and 6). F-121 covers the screenshots behind the stopped state. The facts are in `context/research/live-previews.md` (sections 7 and 8) and the spec's ADR 0068.
- **Status: approved 2026-11-21** (the maintainer: "yes to all"). The maintainer approved the idea the same day ("live previews in the task chat").

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with each picture.

## Purpose

The maintainer, 2026-11-20: "it would be really nice if in the chat window of our tasks, we are able to preview the website that we're currently building … Perhaps that could then have an expanded view." The page has to show:
1. **The running app beside the conversation,** so a member steers by what they see.
2. **Which app, and where it comes from:** a task can have several processes (a frontend, an API, a mail catcher). Each is declared, opened by the agent, or detected.
3. **Whether it's really live:** live, starting, asleep, or nothing to show, and through which view (the box's browser, or the member's own browser under the preview domain).
4. **Who else can open it,** and changing that safely.

## Layout (`task-preview-pane.webp`)

The page's width at 1440, with the panel docked, is 1136. Under the top bar it splits in two:
- **The chat column:** `clamp(440px, 44%, 560px)`, 500 at 1440. It holds the task's head, tabs, thread and composer, as today, with padding `22px 28px 16px`. The title is Manrope 700 24px here, 26px on the full page.
- **The pane:** the rest, 636 at 1440. A 1px `--line` divider sits between the two, and dragging it resizes them (the pane at least 420, the chat at least 440). A double-click resets it.
- **At 1280 wide** the page is 976: the chat 440, the pane 536.
- **Below 1180** the context panel collapses when the pane opens. The member can dock it again, and the choice holds for this task.

The properties panel isn't shown while the pane is open. The top bar's segmented control `Preview | Properties` (28px, `app-window` and `panel-right` 15px) switches the side pane. With no preview for the task, `Properties` is the default.

### The pane

Top to bottom:
1. **Toolbar,** 46px, padding `0 10px`, 6px gaps, a 1px `--line` under it:
   - **The service switcher:** 30px, padding `0 8px 0 10px`, 1px `--line-2`, 6px radius, `--surface`. Inside: the state dot (7px: `--green` live, `--faint` starting, asleep or stopped), the label in Plex Mono 13.5px `--text`, the port in mono `--faint`, and `chevron-down` 14px `--faint`. It opens the services menu.
   - **Reload:** `rotate-cw` in a 28px icon button, `--muted`. It reloads the page in the view, not the app's process.
   - **The path field:** flexible, at least 60, 30px, `--surface`, 1px `--line-2`, Plex Mono 13.5px `--text`. Enter navigates. It shows the path alone, never the host.
   - **The width preset:** `monitor` 15px, the preset's name in 13px 500 `--muted`, and `chevron-down` 12px. The presets are `Fit` (the default: the view is the pane's own size, 1:1, so text stays crisp), `Desktop 1280`, `Tablet 768` and `Phone 390`. A fixed preset scales down to fit, and the footer shows the scale (`1280 × 800 · 48%`).
   - **Share:** a 26px button, `users` 15px plus the level's short name (`Members`, `People · 3`, `Link · 24 h`, `Public`) plus `chevron-down`. It opens the share menu.
   - **`camera`** (`Take a screenshot`): it lands in the thread as an attachment (`task-attachments.md`).
   - **`external-link`** (`Open in a new tab`): under the preview domain, it opens the app's host; without one, it opens the panel's own full-tab viewer.
   - **`maximize-2`** (`Expand · f`).
2. **The viewport:** `--surface`, padding 10px. The frame inside has a 1px `--line-2` edge and an 8px radius, and the app draws in its own colours. Pointer and keys go to the app while the frame has focus, and the frame then shows the 2px `--teal` focus outline. The panel's single-key shortcuts are off while the app has focus, and ⌘. (Ctrl+. elsewhere) hands focus back to the toolbar.
3. **Footer,** 32px, padding `0 12px`, a 1px `--line` above it, 13px `--muted`:
   - **Left:** the mode's dot and word in `--text` 500, then its line in `--faint`. The words for each mode are in the table below.
   - **Right:** `eye` 14px and `{n} watching` when more than one person watches, then mono 12.5px `--faint`: the view's size, ` · `, the runner's name.

| Mode | The footer's line |
|---|---|
| Design B, no preview domain (drawn) | `Live` · `the box's browser, streamed` |
| Design A, the preview domain set | `Live` · `in your browser` · the host in mono, `5173-k3f9d2.preview.acme.dev` |
| The runner reaches ostra over HTTP only | `Live` · `the box's browser, 2 frames a second over HTTP` |
| Starting | spinner, `Starting` · `the box's browser opens it when it answers` |
| Asleep | grey dot, `Asleep` · `since 14:56 · behind it, the last screenshot (14:41)` |
| Nothing to preview | grey dot, `No preview` · `screenshots still land in the timeline` |

### The thread's `Preview` row

When the agent opens a port (`show_preview`), its turn gains a tool row in milestone 1's grid: `app-window`, the verb `Preview`, the label and port in mono (`web :5173`), the path in `--faint`, and `Show` in `--teal`. `Show` opens the pane on that preview and path. A declared process started by the environment adds no row: the pane lists it.

## The pane's states

| State | Picture | What shows |
|---|---|---|
| **Live** | `task-preview-pane` | As above |
| **Starting** | `task-preview-starting` | The frame is replaced by a centred block 400 wide on `--bg`. It has a 36px icon box with a spinner, `Starting web` 16px 600, a line of `--muted`, and three steps (`Box ready`, `Started pnpm dev`, `Waiting for :5173 to answer · 9 s`), each with a `check` `--green` or a spinner. Under them, the start command's last three log lines in a `--surface` code block, mono 12.5px `--muted`. The thread's `Started` row shows `starting`. After 90 s *(working value)*, the step turns red with `It didn't answer in 90 s.`, `Show the log` and `Restart web` |
| **Asleep** (an idle box, ADR 0039) | `task-preview-stopped` | The last screenshot, grayscale at 10% (35% in light), behind a `--raise` card 420 wide with a 12px radius and `--shadow-pop`. The card has `moon`, `The box is asleep`, the reason and the time, `Wake to preview` (`power`), the ghost `See the last screenshot`, and 12.5px `--faint` text on what waking does: a box from the project's snapshot on the task's branch, the start command, about how long, and no model tokens. The top bar has no `Stop`. The task's line reads `Idle · the agent finished its turn · box asleep` |
| **Ended** (the task stopped, failed or merged; no box) | not drawn | As asleep, with `The task's box is gone` and `Start the app` (the same action, F-141) |
| **Nothing to preview** | `task-preview-none` | A 430-wide block: `app-window` in a 36px box, `No preview for this task`, why, then `The box is listening on` and each detected port as a 40px row (dot, mono port, process and source, `Open as a preview`). Then `Ask the agent to start the app` (it puts that text into the composer and doesn't send it) and a teal `Declare it in Environment →`. The toolbar's path, reload, width and share are at 45% opacity and inert |
| **The app stopped answering** | not drawn | The frame keeps its last picture, dimmed to 40%. A top banner reads `web :5173 stopped answering at 14:58`, with `Restart web` and `Show the log`. The thread gets no row: it isn't the agent's action |
| **The stream dropped** | not drawn | The frame keeps its last picture, with a 24px pill at its top centre: spinner and `Reconnecting…`. After 30 s: `Lost the stream.` and `Retry` |
| **A runner too old** (below the preview minor) | not drawn | The none block's shape, with `build-fleet-03 needs upgrading to show previews.`, a teal `How to upgrade a runner` (docs), and share disabled. It fails closed, never falls back to an unprotected view (F-142) |
| **Expanded** | `task-preview-expanded` | Below |
| **Light** | `task-preview-pane-light` | `../m7/light-home.md`'s tokens. The app's own colours don't change |

### Expanded (`task-preview-expanded.webp`)

- **The pane takes the page's width:** the context panel collapses (the top bar's `panel-left-open` docks it) and the chat column hides. The DOM doesn't move: the grid's columns change, so the stream or the iframe doesn't reload.
- **The top bar** reads breadcrumbs, then right: 13px `--faint` `Press`, a `Kbd` `esc`, `Back to the chat` (`minimize-2`) and `Stop`.
- **The steer bar** floats centred, 760 wide, 46px above the pane's bottom: `--raise`, 1px `--line-2`, 12px radius, `--shadow-palette`, padding `10px 10px 10px 14px`.
  - **Line 1,** 13.5px `--muted`: the agent's state mark, `OpenCode · Editing`, the path in mono `--text`; right, `CALC-192 · Running` `--faint`.
  - **Line 2:** a 36px field `Message the agent about what you see…` and `Send` (primary). Enter sends, and the message lands in the thread as from the composer.
  - **It hides** with the composer's own rules: no driver right, no bar, and a member who isn't the driver sees `Take over` there instead.
- **Escape,** with the focus outside the app, goes back.

### The services menu (`task-preview-services.webp`)

A `DropdownMenu`, 380 wide, under the switcher at a 4px gap. `--raise`, 1px `--line-2`, 10px radius, `--shadow-pop`, padding 6px.
1. **Label** `Previews of CALC-192` (12px 500 `--faint`).
2. **A row per preview,** in a `14px 1fr auto` grid with padding `7px 10px`, two lines:
   - **Line 1:** the state dot, the label in mono 14px `--text` and the port in `--faint`, then chips (22px, 1px `--line-2`, 5px radius, 12px `--muted`): `primary` where it is, and its source (`declared`, `service`, `opened by the agent`). The current preview has a `check` at the end and a `--sel` fill.
   - **Line 2,** 12.5px `--faint`: what it is (`The app · pnpm dev in calculator-web`, `Opens /docs · the frontend reaches it through /api`, `Mail the app sends in this box`). An agent's preview adds `This task only ·` and a teal `Keep it for calculator`, which turns it into an environment proposal (F-140; a project admin accepts it, as `../m6/environment-proposal`).
   - The order is primary first, then declared, services and the agent's, each alphabetical.
3. **`Detected`:** ports the box listens on that belong to the task's processes, each with `Open`. The key, git and MCP proxies' ports and OpenCode's never show (research §7: a preview reaches only the task's ports).
4. `Open a port…` (`plus`) asks for a port and a label, for this task only. `Edit the app's processes in Environment` (`box`) is there for project admins.

### The share menu (`preview-share.webp`)

A `Popover` from the share button, 392 wide, aligned to its right edge, under it at a 4px gap, padding 6px.
- **Head:** `Who can open web :5173` (14.5px 600, the port in mono), then 12.5px `--faint` `For CALC-192 only. Each preview has its own setting.`
- **Four options,** as a `RadioGroup`. Each row is a `18px 1fr` grid with padding `9px 10px`: a 16px radio (`--control-line` ring; `--teal` ring and dot when chosen), the label in 14px 500 and a description in 13px `--muted`. The chosen row has a `--sel` fill.
  1. `Project members` · `Everyone who can open calculator. The default.`
  2. `Named people` · `Only the people you pick in Acme Corp.` Chosen, it opens a people picker (a `Command` list of the organization's members, avatars and names) and shows the chosen ones as removable chips.
  3. `Anyone with the link` · `Until it expires or you revoke it.` Chosen, it shows:
     - `Expires`, a select of `in 1 hour`, `in 24 hours` (the default) and `in 7 days`;
     - the link in a mono 12.5px field, with `Copy`;
     - an `Allow input` switch, off by default (the teal switch when on), with `off: viewers only watch` in 12.5px `--faint`;
     - `Made by {who} at {hh:mm} · opened {n} times, first {hh:mm} · Revoke`, with `Revoke` teal.
  4. `Public` with a `lock` icon. It's greyed out (labels in `--faint`, the radio ring in `--line-2`) with `An admin of Acme Corp turned public previews off.` Where an admin allows it, it reads `Anyone, signed in or not, until you change it.`
- **Footer:** a 1px `--line` above, `scroll-text` 14px and 12.5px `--faint` `Making a link and each first use of it go to the audit log.`
- **Rules** (F-142, research §7):
  - Changing the level takes effect at once.
  - Narrowing it ends every viewer who no longer qualifies.
  - A runner or install that can't enforce a level shows that level disabled, with the reason. It never widens access.
- **Without the preview domain,** a link opens the panel's signed-out viewer page (`preview-viewer`, target 7 of the m8 spec, not drawn here), which streams pixels. With the preview domain and `Allow input` on, the link's viewer runs the app in their own browser on the preview host.

## Phone (`shell-phone.webp`, picture 2)

- **The top bar:** the shell's menu button with its amber dot (`app-shell.md`, "Phone"), the task's title (15px 600) over mono 12px `--faint` `CALC-192 · ● Running`, and `ellipsis` (Stop, Copy link, Properties).
- **Under it,** a full-width segmented control: `Chat | Preview`. The two never share the screen.
- **The pane's toolbar,** 50px: the switcher (label only), the path, reload and share, all 36 to 44px. The width preset and the screenshot button move into `ellipsis`.
- **The view** is the phone's width (`Fit`), with the footer line, and the composer docked at the bottom on both tabs, with 44px controls. The shell has no tab bar on a phone, so nothing else takes the bottom.

## Keyboard

- `f` toggles Expand when the focus isn't in a field or the app. `esc` leaves Expand.
- The toolbar is one `toolbar` landmark (`aria-label="Preview"`). ← and → move between its controls.
- The services menu and the share menu are Radix menus: arrows, Enter, Escape, and focus back on the trigger.
- The share options are a radio group: ↑ and ↓ choose, Tab enters the link's controls.
- The frame has `tabindex="0"` and is named `web :5173 at /history, live`. While it has focus, keys go to the app; ⌘. or Ctrl+. hands focus back.
- `p` (new) switches the side pane between Preview and Properties. It joins the registry and the `?` sheet with `f`.

## Components (shadcn/ui names)

- **From the repo:** `ToggleGroup` (the side-pane control), `DropdownMenu`, `Popover`, `RadioGroup`, `Switch`, `Select`, `Command` (the people picker), `Button`, `Kbd`, `Tooltip`, and the task view's tool rows (`task/renderers.tsx`).
- **New:**
  - `components/tasks/preview-pane.tsx`: the toolbar, the viewport and the footer;
  - `preview-services-menu.tsx`;
  - `preview-share-menu.tsx`;
  - `preview-state.tsx`, for starting, asleep, ended, none, crashed, dropped and too old;
  - `preview-steer-bar.tsx`;
  - `preview-frame.tsx`, which draws the stream onto a `<canvas>` for Design B and an `<iframe>` for Design A, behind one interface.

  The pane's state is a union with an exhaustive `switch` (`satisfies never`). The access level is the union `"members" | "people" | "link" | "public"`.
- **Icons** (Lucide, stroke 1.75): `app-window`, `panel-right`, `rotate-cw`, `monitor`, `tablet`, `smartphone`, `users`, `link`, `camera`, `external-link`, `maximize-2`, `minimize-2`, `eye`, `moon`, `power`, `lock`, `scroll-text`, `copy`, `plus`, `box`, `check`.

## Tokens

`globals.css`'s, both themes:
- **Surfaces:** `--bg` for the pane, the blocks and the states; `--surface` for the viewport's ground and the fields; `--raise` for the menus, the asleep card and the steer bar.
- **Edges:** `--line-2` for the frame and controls, `--line` for hairlines.
- **The words:** `--muted` and `--faint`.
- **Colours:** `--green` live, `--teal` for links, `Show`, a chosen radio and the frame's focus, `--red` for a failure. No amber in the pane: nothing in it waits on a person.
- **Shadows and the primary:** `--shadow-pop` and `--shadow-palette` on the overlays, and `--primary` on the steer bar's `Send`.

## WCAG AA (F-081)

| Pair | Dark | Light | Need |
|---|---|---|---|
| `--faint` on `--bg` (the footer's line, the state's notes) | 5.9:1 | 5.6:1 | 4.5 |
| `--muted` on `--surface` (log lines, the path) | 9.2:1 | 7.6:1 | 4.5 |
| `--faint` on `--raise` (menu lines 2, the share footer) | 5.4:1 | 5.8:1 | 4.5 |
| `--teal` on `--bg` (`Show`, `Revoke`, `Keep it`) | 8.4:1 | 6.1:1 | 4.5 |
| `--faint` on `--surface` (a port in the switcher) | 5.6:1 | 5.3:1 | 4.5 |
| The app inside the frame | the customer's own; ostra doesn't check it | | |

## Data it needs

From the m8 spec (ADR 0068) and `context/research/live-previews.md`:
1. **The task's previews:** label, port, source (`declared | service | agent | detected`), primary, path, state, and access level. They come from the environment's app processes (F-140), the agent's `show_preview`, and the box's port scan.
2. **The view:**
   - **Design B,** with no setting: frames and input over the preview connection, opened only while someone watches.
   - **Design A,** with the preview domain: the one-time code handshake and the per-origin cookie.

   The watchers' count comes from the open views.
3. **The box's lease and idle state** (ADR 0039), the last screenshot (F-121), and "warm while watched".
4. **Access:** the level per preview, named people, links (expiry, input, made by, first use, revoked), the organization's "Allow public preview links", and audit entries.
5. **The runner's protocol minor**, to fail closed.

## Differences from the current code

1. **The task page has no side-pane choice:** the properties panel is fixed. It gains `Preview | Properties`, the pane, and the URL state.
2. **No preview rows** in the thread renderers.
3. **No previews, processes, views or access levels** in the API (the m8 spec's tickets).
4. **Messages:** new keys under `task.preview.*`.

## Open points (recommendations; the maintainer's approval settles them)

1. **Expanded:** *settled 2026-11-21, as drawn: a floating steer bar over the full-width app, not the thread folded to a strip* (the maintainer: "yes to all"). The m8 spec had the strip. Why the bar: a strip 56 wide shows nothing readable, and the bar keeps the one thing needed while looking, telling the agent what you see.
2. **`Wake to preview` for an idle box and `Start the app` for an ended task:** *settled 2026-11-21: keep both labels, as drawn* (the maintainer: "yes to all"). They're two labels for one action. The maintainer's words fit a sleeping box, and an ended task has nothing to wake.
3. **The default width preset:** `Fit` (the pane's own size, crisp), as drawn, or `Desktop 1280` scaled down. Recommended: `Fit`. A scaled 1280 view at 636 wide is 48%, and text becomes unreadable.
4. **Who can change the level:** the task's driver and the project's admins (recommended), or any member who can open the task.

## Wrong in the image (build from this file)

- **`task-preview-pane.webp`:** the composer's hint is cut to `Queues for the next step` at this width. Build the full hint, which wraps at most once.
- **`task-preview-expanded.webp`:** the steer bar covers the app's bottom row of keys. Build the viewport with a bottom padding equal to the bar's height plus 16, so nothing of the app is hidden.
- **`task-preview-services.webp`:** the `primary` chip sits beside the label rather than with the source chip. Either is fine; build it as drawn, before the source chip.
