# Target: a runner's page (milestone 5, screen 4)

> **Committed image:** `runner.webp`, downscaled from a 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Prompt:** `runner.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation, kept. References: the approved milestone 1 original `app-targets/m1/runners.png` (the screen this one starts from, spec section 12), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route (new):** `apps/web/src/app/(panel)/organization/runners/[runnerId]/page.tsx` → `components/runners/runner-view.tsx`. Ticket 31 names `src/app/(panel)/runners/[runnerId]/`; the Runners page lives under `organization/runners/` on `main`, so the runner's page goes beside it.
- **Features:** F-092 (the fleet view: state, carrier, containment, drain, resume, revoke), F-061 (the version against the server's, its state and fix), F-013 (the carrier and the HTTP fallback), F-014 (a member's own runner). ADR 0029 (drain and revoke), ADR 0034 (the carriers, the window), ADR 0046 (install paths); spec sections 3 (steps 9 to 11), 4 ("Drain and resume", "The pin") and 5.1. Tickets 15 (drain and resume), 16 (versions), 26 (`runners.get`, `runners.drain`, `runners.resume`), 31 (this screen).
- **Status:** a proposed target, waiting on approval (ticket 29's `## Comments`). Ticket 31 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

An organization admin opens one runner from the Runners page (`../m1/runners`, or a pool's page, `pool`) and sees, in one place, whether it's working and why not: its state and its connection, which carrier it's on, whether its version still fits the server's and how to fix it, how it contains a task, how much room it has, which boxes run on it now, and how it got here (the token it joined with, who approved it). Then the admin acts on it: **Drain** to let its tasks finish and take no new one, **Resume** to lift the drain, **Revoke** to cut it off at once.

`runner.webp` shows `build-03`, a `docker` runner of `build-fleet`, on the 19th at about 16:16: online, on **HTTP** since a proxy refused its WebSocket at 14:02, and **outdated**: `v0.4.2` (protocol minor 3) against a `v0.5.0` server (minor 4), installed from the runner image, so it can't pin itself. Three of its four slots are busy.

A member who isn't an admin sees only their own personal runners' pages (from **Your machine**): the same page with **Revoke** and no **Drain** (ticket 31; a member stops their own runner instead of draining it, ticket 15). Anyone else's runner is `NOT_FOUND`.

## Layout (CSS px at 1440 wide)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 234px, the shared shell | Build it from `components/shell/sidebar.tsx`. **Runners** (Lucide `server`) is selected, with its busy-box count in the plain style |
| Top bar | 46px, hairline under | Breadcrumb `Acme Corp › Runners › build-fleet › build-03`: `Runners` links to the Runners page, `build-fleet` to the pool's page (`pool`), the runner's name in mono `--text` 500. A personal runner: `Acme Corp › Runners › Your machine › alex-mbp`. Right: the actions (below). No primary button: nothing here is the page's main path, and each action asks first |
| Page | `1fr`, padding `28px 36px` | Title line, lede, the status rows, the fix, Capacity, Boxes, History |
| Properties panel | **320px**, 1px `--line` on its left, padding `20px 18px` | Runner, Labels, Joined, the actions' consequence line |

### The actions (top bar, right)

Outline buttons, 30px, 8px apart, each with a 15px Lucide icon. Which ones show follows the state (domain model, "A runner's lifecycle"):

| State | Buttons |
|---|---|
| `joining` | `Reject` (outline) and `Approve` (amber, the needs-you answer; `runner-approval`) |
| `online`, `offline` | `Drain` (`circle-pause`), `Revoke` (`ban`, its text `--red`) |
| `draining` | `Resume` (`circle-play`), `Revoke` |
| `revoked` | none |
| a member's own personal runner | `Revoke` only |

**The confirms** (`AlertDialog`, title in 600, body `text-sm` `--muted`, buttons `Cancel` and the action):

- **Drain:** title `Drain build-03?`; body `Its 3 running tasks finish. It takes no new task until an admin resumes it, through disconnects and restarts.` With none running: `It takes no new task until an admin resumes it, through disconnects and restarts.` Button `Drain` (outline, the default `--text`).
- **Resume:** title `Resume build-03?`; body `It takes tasks again as soon as it's connected.` For a minor-3 runner (no `resume` command, spec 5.1): `It's one minor behind, so it takes tasks again after it restarts.` Button `Resume`.
- **Revoke:** title `Revoke build-03?`; body `Its 3 running tasks stop at once, and each can reopen on another runner. It's disconnected and can't connect again. Runners that joined with the same token stay.` With none: drop the first sentence. A member's own: `Your machine can't connect again until you run ostra runner and sign in.` Button `Revoke` (destructive: `--red` text on `--surface`). The count is `runners.revoke`'s `stoppedTasks` source, read when the dialog opens.
- On success: the dialog closes, the title line's state and the buttons change at once, and History gains the entry. On failure: `role="alert"` `--red` 12.5px `errorText(error)` above the dialog's buttons.

### Title line and lede

- Title: the runner's name, `PageHeading` (Manrope 700 26px; names are mono elsewhere, the title stays Manrope). 12px after it, the state as `Status`: the dot and the word, 14px `--muted` (`online` green dot, `draining` grey half dot, `joining` grey ring, `offline` and `revoked` grey dot), as `runner-words.ts`.
- Lede, `text-lede` `--muted`, one line: `A {executor} runner in {pool}. {busy} of {slots} slots busy, on {carrier} since {time}.` Variants: a personal runner `Your machine: a host runner, not isolated. {busy} of {slots} tasks at once.`; offline `A docker runner in build-fleet. Offline since 13:40; its boxes keep working.` (docker and kubernetes only: each sidecar connects on its own, Q38); draining `Draining since 17 Nov 15:02: its 3 tasks finish, and it takes no new one.`; joining `Waiting for an admin to approve it.`; revoked `Revoked by Alex Kim on 19 Nov. It can't connect again.` The `on {carrier} since` half shows only on HTTP.

### The status rows

No box. 24px under the lede: 40px rows, a 1px `--line` hairline under each; key column 160px, `text-ui` `--muted`; value `text-ui` `--text`, with a secondary half in `--muted` 13px after a 12px gap.

| Key | Value (the picture) | Every case |
|---|---|---|
| Connection | green dot, `Connected 2h 14m` | `Connected {duration}` (from the presence row); `Disconnected {age} ago` with a grey dot; `Never connected` for a joining runner that registered and left. A draining runner shows its connection here, since a drain outlasts a disconnect (Q108) |
| Carrier | mono `HTTP`, then `WebSocket was refused at 14:02, so it fell back. It tries WebSocket again every 10 min.` | `WebSocket` with no second half. `HTTP` and the trigger, one of: `WebSocket was refused at {time}` (a non-101), `WebSocket dropped 3 times in a minute at {time}`, `No welcome over WebSocket in 10 s at {time}`; then `, so it fell back.` and the retry, from `OSTRA_RUNNER_WS_RETRY_MINUTES`. Started with `--transport http`: `HTTP` + `Set to HTTP when it started.` Offline: the last carrier, `--faint` |
| Version | mono `v0.4.2`, the chip `outdated`, then mono `--faint` `server v0.5.0 · protocol 1.3 of 1.4` | From `runnerVersionState` (ticket 16): `current` (no chip, no fix), `behind` (chip `outdated`, the fix below), `ahead` (chip `newer`; fix `Newer than the server: it speaks the server's minor until the server is upgraded.`), `outside` (red chip `refused`; it's refused at `hello`, so this shows only for a runner that once joined and was refused after an upgrade) |
| Executor | mono `docker` | `host`, `docker`, `kubernetes`. A `host` pool runner adds the chip `not isolated`; with `OSTRA_DEV_HOST_POOL_SAME_USER`, `not isolated, same user (development only)`. A `kubernetes` runner adds `--muted` `the agent has direct internet access` only when its pool's NetworkPolicy isn't applied (ticket 30's line) |
| Containment | `Container`, then `each task in its own box` | `Container` (docker, kubernetes), `Job object` · `a task's processes end with it` (Windows), `cgroup` · `the same, through a cgroup` (Linux), `Process tree` · `a process the agent detaches isn't contained` (macOS, or no cgroup), from `processContainment`; `Not reported yet` `--faint` |
| Install | `Runner image` | `npm CLI` · `pins itself to the server's version at start`; `Runner image`; `From source` · `a development build` |

### The fix (version behind or ahead)

Directly under the Version row's value, inside its row (the row grows), indented to the value column: a 2px `--line-2` left rule (not amber, not red: the runner works), 12px left padding, `text-sm` `--muted`, max-width 620px. Copy by state and install:

- `behind`, image: `One minor behind the server: it runs tasks, but gets no resume command and doesn't enforce box sizes. It came from the runner image, so it doesn't update itself: run the v0.5.0 image and restart it.` (the picture)
- `behind`, npm, pin on: `One minor behind the server: it runs tasks, but gets no resume command and doesn't enforce box sizes. Restart it: it installs v0.5.0 at start.`
- `behind`, npm, `OSTRA_RUNNER_PIN=false`: `… It was started with the pin off: update the CLI to v0.5.0, or start it with the pin on.`
- `behind`, source: `… Pull and rebuild ostra at v0.5.0.`
- `ahead`: as the table above.

Then a teal `How to update` link to the docs' runner upgrade page (no underline; the picture's underline is wrong).

### Capacity

Section head 28px above: **Capacity** (Plex Sans 600 `text-body`). Rows 34px: key 160px `--muted`; a bar 220px × 6px, radius 3px, track `--line`, fill `--chart` (Mist), the share of use; then mono `--text`.

- `Slots` · `3 of 4 busy`. `CPU` · `8 of 15 vCPU`. `Memory` · `16 of 30 GiB`. CPU and memory count the sizes of the boxes holding a slot (`runnerRoom`, ticket 05) against what the runner offers (`resources`).
- Under them, 12.5px `--faint`: `What it offers after keeping 1 vCPU and 2 GiB for itself.` (`OSTRA_RUNNER_RESERVE_*`; docker only). Kubernetes: `What its namespace's quota allows.` or `What OSTRA_RUNNER_SLOTS allows: the namespace has no quota.`
- `host` (`resources` is `null`): the `Slots` row only, and the line `host counts slots only: no CPU or memory limit.`
- A minor-3 `docker` runner reports no `resources`: the `Slots` row and `Sizes not enforced: update this runner.` (spec 5.1), linking to the fix.
- Full (no free slot): the bar stays Mist; the number reads `4 of 4 busy`. Never red or amber: a full runner is working.

### Boxes

Section head **Boxes** + mono `--faint` count, 28px above. A `Table` with no box, header 30px (12px 500 `--faint`), rows 40px with hairlines.

| Column | Width | Contents |
|---|---|---|
| Task | `1fr` | mono `--faint` key (`CALC-212`, or the short ID of a prompt task), 12px gap, the title `text-ui` `--text`, truncated. Links to the task |
| Project | 180px | the 8px colour square and the name, `--muted` |
| Size | 200px | mono `small · 2 vCPU · 4 GiB`; on `host` mono `slot`; on a minor-3 runner the name and `--faint` ` · not enforced` |
| Running | 72px, right | mono, since the box was made; `Waiting for a node 2m` in `--muted` on `kubernetes` (`box.waiting`) |

Empty: one hairline-bounded row in `--muted`: `No box running.` Draining with none left: `No box running. It's drained.`

### History

Section head **History**, 28px above. Up to 20 of the runner's audit entries (`runners.get`), newest first, 26px rows, 12.5px: mono `--faint` time in a 120px column, then the sentence in `--muted` (`Resumed by Alex Kim`, `Drained by Alex Kim`, `Approved by Alex Kim`, `Joined build-fleet with ci-bootstrap`, `Rejected by …`, `Revoked by …`). A teal `Audit log` link after the last row opens the audit log filtered to the runner. Carrier changes aren't audit entries and aren't listed.

## The properties panel

`PropGroup` labels 12px 500 `--faint`; `PropRow`s 30px with a **110px** key column, keys `--muted`, values `--text`.

1. **Runner:** `Pool` · `build-fleet` (links to the pool; a personal runner: `Personal · Alex Kim`); `Host` · mono `build-03.acme.internal` (the name the runner reported); `System` · mono `Linux · x64` (`os`, `arch`); `Last seen` · `now`, or `3h ago`.
2. **Labels:** chips (`Chip`, outline, mono 12px), the runner's own first (`tier:fast`, `region:eu`), then the built-ins `executor:`, `os:`, `arch:` in `--faint`. None of its own: `None` `--faint` and the built-ins. Labels come from `OSTRA_RUNNER_LABELS` and aren't edited here.
3. **Joined:** `Token` · mono `ci-bootstrap` (links to the pool's tokens; a revoked one struck through in `--faint`, with `revoked` after it; a personal runner: `Device code`); `Joined` · mono `12 Nov 14:08`; `Approved by` · `Alex Kim · 12 Nov` (a pool without approval: `Not required`); `Key` · mono, the first and last 4 characters of the public key's SHA-256 fingerprint, `SHA256:q7Hc…9fLm`, with the whole one in a `Tooltip` and a teal `Copy`.
4. A hairline, then 12.5px `--faint`, the consequence of the actions, from the live count: `Draining lets its 3 tasks finish and takes no new ones. Revoking stops them at once.` Draining: `Resuming lets it take tasks again. Revoking stops its 3 tasks at once.` Revoked: nothing.

## States

| State | What changes |
|---|---|
| online, HTTP, outdated (`runner.webp`) | As above |
| online, WebSocket, current | Carrier `WebSocket`, no chip, no fix, no `on … since` in the lede |
| offline | Grey dot `offline`; Connection `Disconnected 40 min ago`; on docker and kubernetes the boxes keep running and are listed; leases past the grace end (F-045) and leave the list |
| draining | Half dot `draining`; Connection beside it as ever; buttons `Resume` and `Revoke`; lede `Draining since …`; the boxes finish and leave the list |
| joining | Ring `joining`; buttons `Reject` and `Approve`; Capacity and Boxes hidden; the panel's `Approved by` reads `Waiting` `--faint`. It's `runner-approval`'s panel, in full page |
| revoked | Grey dot `revoked`; no buttons; lede `Revoked by …`; Connection `Disconnected`; Capacity hidden; Boxes `No box running.`; the page stays for history |
| outdated, refused (`outside`) | Red chip `refused` and the fix `It speaks protocol 1.2; this server accepts 1.3 to 1.5. Update it to v0.5.0.` (the refusal's words, ticket 16) |
| A member's own personal runner | Breadcrumb `… › Your machine › alex-mbp`; `Revoke` only; Executor `host` + chip `not isolated`; Capacity `Slots` · `1 of 2 busy` (personal runners run 2 at once by default) |
| Loading | The title at once; rows' values, bars and the panel's values as `Skeleton` bars; three skeleton rows under Boxes. No spinner |
| Not found (another organization's, or a member's view of someone else's) | `NotFound`: `This runner doesn't exist, or you can't see it.` |
| Live | Polls `runners.get` every 5 s while the tab is visible; state, carrier and boxes change in place, no toast |
| Narrow (below `xl`) | The panel drops under the page (`PageFrame`); the actions stay in the top bar |
| Phone (F-075) | One column; the status rows wrap the secondary half under the value; Boxes become two-line rows (key and title, then project, size and age); the actions go into a `…` menu in the top bar |

## Components (shadcn/ui names)

`Sidebar`, `PageFrame` with `properties` (320px), `Breadcrumb`, `PageHeading`, `Status` (dot + word, existing), `Button` (outline; `variant="destructive-outline"` for Revoke's `--red` text, or the outline with a red text class), `AlertDialog` (existing), `Chip` / `Badge` outline (`outdated`, `newer`, `refused`, `not isolated`, labels), `Progress` or a plain `div` meter with `role="meter"` (as `spend-budgets`), `Table` (existing `ui/table.tsx`), `PropGroup` / `PropRow`, `Separator`, `Tooltip`, `Skeleton`. Lucide 15px stroke 1.75: `server`, `circle-pause`, `circle-play`, `ban`, `copy`.

## Tokens (`app-concepts/html/graphite.css`)

> **Scale.** The panel is built at the approved pictures' scale, which wins on size, spacing and contrast: body 14.5px, dense rows 14px, secondary 13px, small 12px, title 26px, `--muted` `#B4B7BB`, `--faint` `#8B8E93`, buttons 30px, a 46px top bar and a 320px properties panel. The measured values are in `../m1/README.md`, "Scale".

| Token | Value | Used for |
|---|---|---|
| `--bg` / `--side` | `#0D0E10` / `#0A0B0C` | page and panel / sidebar |
| `--surface` | `#131416` | outline buttons, skeletons |
| `--sel` | `#1A1B1E` | the Runners nav row |
| `--line` / `--line-2` | `#1F2023` / `#2A2C30` | hairlines, bar tracks / button and chip borders, the fix's rule |
| `--text` / `--muted` / `--faint` | `#F2F3F4` / `#B4B7BB` / `#8B8E93` | values / keys, lede, fix / help, built-in labels, times |
| `--green` | `#4FB286` | the `online` dot and `Connected`'s dot only |
| `--chart` | `#CFD8D4` (Mist) | capacity bars |
| `--red` | `#E5675C` | Revoke's text, the `refused` chip, errors |
| `--teal` | `#6FB8AA` | `How to update`, `Copy`, `Audit log`, links |
| `--amber` | `#FFB224` | only the sidebar's Needs you count, and `Approve` on a joining runner |

Type: Manrope 700 26px (title); IBM Plex Sans for keys, copy and buttons; IBM Plex Mono for the name in the breadcrumb, versions, the carrier, executor, host, system, labels, the token's label, times, sizes, counts and the fingerprint.

## Data this screen needs beyond ticket 26

`runners.get { runnerId }` (ticket 26) returns most of it. Check that it carries, typed end to end:
- the presence row: `connectedAt`, `carrier`, and the fallback's trigger and time (ticket 18's runner reports it in its `hello` over HTTP: add `fallback: { reason: "refused" | "dropped" | "no-welcome" | "forced", at } | null` to the hello's optional fields if ticket 01 hasn't);
- `versionState` with the server's version and both minors, and `install`, and the pin setting the runner reported;
- `resources` with the reserve it kept (or the quota's source on kubernetes), and the boxes' sizes summed;
- the join token's label and state, the approver's name and time, the key's fingerprint (computed from the stored public key; never the key itself in a log);
- the boxes now (`Box` rows holding a slot, with task key, title, project, size, waiting reason);
- the last 20 audit entries naming the runner, and the counts for the confirms.

## Differences from the current code

Checked against `apps/web` and `packages/api` on `main` (2026-11-19):

1. **New route and view.** Nothing exists under `organization/runners/[runnerId]/`. The Runners page's rows (`runner-rows.tsx`) become links to it.
2. **`runners.get`, `runners.drain`, `runners.resume`** don't exist; `runners.approve`, `runners.reject` and `runners.revoke` do (`packages/api/src/routers/runners.ts`). `revoke` already returns `stoppedTasks`.
3. **`runner-words.ts`** has the state's word and dot; add the version state's chip and fix, the carrier's trigger sentence, the containment's words and the install's words, each an exhaustive `switch`.
4. **`Runner` rows** have `version`, `os`, `labels`, `capacity`, `processContainment`; `install`, `minor`, `cpuMillis`, `memoryMiB`, `slots`, `joinTokenId`, `drainedAt`, `drainedByMemberId` come with ticket 04.
5. **Messages.** New keys under `runner.*`: the lede's variants, the row keys, the carrier lines, the version fixes, the containment and install words, the section heads, the panel's keys, the confirms (`drainTitle`, `drainBody`, `drainBodyIdle`, `resumeTitle`, `resumeBody`, `resumeBodyOld`, `revokeTitle`, `revokeBody`, `revokeBodyIdle`, `revokeBodyOwn`), the consequence lines, `notFound`.

## Wrong in the image (build from this file)

All visible copy is spelled right and the numbers add up (the three boxes' sizes sum to 8 vCPU and 16 GiB). These differ from what to build:

- **The properties panel** is drawn about 360px wide (from x 1080). It's 320px.
- **`How to update`** is underlined. Teal links carry no underline.
- **`Revoke`** has a red border as well as red text. Its border is `--line-2`, as every outline button.
- **The fingerprint** reads `SHA256:q7Hc….9fLm` with a stray dot after the ellipsis. One `…`.
- **The status rows' secondary halves** (`WebSocket was refused…`, `each task in its own box`) start at different x from row to row. They sit 12px after the value.
- **The Version row** puts the chip close to the version and the server text far right of it; build them in one line with 12px gaps.
- **History** is drawn in mono throughout. The time is mono; the sentence is Plex Sans `--muted`.
- **The sidebar** is drawn from the image's own shell (its rows `Box sizes` and `Registry` are milestone 5's and right). Build it from `sidebar.tsx`.
- **The picture has no draining, offline, joining, revoked, personal, loading, confirm or narrow states:** they're in the tables above.
