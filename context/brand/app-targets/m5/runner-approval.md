# Target: a runner waiting to join (milestone 5, screen 5)

> **Committed image:** `runner-approval.webp`, downscaled from a 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Prompt:** `runner-approval.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation, kept. References: the approved milestone 3 original `app-targets/m3/needs-you.png` (the page the row lives on: the closest approved picture), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`. The spec starts this screen from `app-targets/m3/task-approval`; its approval block (the amber rule, the title, the answer buttons) is the one `needs-you` already carries, so the needs-you original was the better reference. How this panel differs from the task's card is below.
- **Route:** `apps/web/src/app/(panel)/needs-you/page.tsx` (milestone 3's), with `?item=<notificationId>` selecting the row. The same panel shows on the runner's own page while it's `joining` (`runner`). Components in `components/needs-you/` (the row's reason) and `components/runners/runner-approval.tsx` (the panel, shared by both pages).
- **Features:** F-091 (approval of each new runner, every join an audit entry and a notice to admins), F-036 (the panel channel: notices for admins). ADR 0029, Q48, Q94, Q130; spec sections 3 (step 2), 4 ("A join") and 5.2 (`runner_joined`, `runner_awaiting_approval`). Tickets 03 (the notice kinds), 12 (the join, the needs-you item), 25 (`runners.approve`, `runners.reject`), 31 (this screen).
- **Status:** a proposed target, waiting on approval (ticket 29's `## Comments`). Ticket 31 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

A runner joined a pool that requires approval, so it sits in `joining`: connected, holding its own key, offered nothing. Every admin of the organization gets a needs-you item for it (and a mail, `../m3/email-needs-you`, growing). The admin opens it, checks that this is the machine they meant to add (its host, system, executor, labels, version, the token it used, when it joined and its key's fingerprint), and answers in one press: **Approve** (it goes online and takes tasks) or **Reject** (its key is revoked, it's disconnected, and it can't connect again).

`runner-approval.webp` shows Alex Kim, an admin, on Needs you: `build-01` joined `build-fleet` 4 minutes ago with the token `ci-bootstrap` and waits; `gpu-01` joined `Default`, which doesn't require approval, an hour ago (a `runner_joined` notice, read). Four task items in three projects follow. The runner row is selected and its approval fills the properties panel.

### How it differs from `task-approval`'s card

| | A task's approval (`../m3/task-approval`, `../m3/needs-you`) | A runner's approval (this) |
|---|---|---|
| What's decided | one tool call, for one turn of one task | whether a machine joins the organization's fleet, for good |
| Who answers | any member of the project; the first answer wins | **organization admins only**; the first answer wins |
| Where it opens | inline, under the row (one command to read) | **in the properties panel** (380px): eight facts to check side by side with the list, too many for an inline block |
| Answers | `Deny`, `Approve once`, `Approve for this task` | `Reject`, `Approve`. No "once" and no rule: an approval is the runner's state, not a pattern |
| A reason | the deny can carry a reason to the agent | none: a reject tells the runner nothing but `revoked` |
| What it waits on | the agent's turn, 15 minutes, then expires | nothing: the runner waits in `joining` as long as it takes, connected or not, and the item stays open until an admin answers or the runner is revoked elsewhere |
| After | a receipt in the thread | `runner.approved` or `runner.rejected` in the audit log, and the item moves to Done with its outcome |

Both are the shared `NeedsYou` block: the 2px amber rule, the amber title, one amber button. That is the only amber on the page besides the sidebar's count and project dots.

## Layout (CSS px at 1440 wide)

Unchanged from `../m3/needs-you`: sidebar 234px, top bar 46px (`Acme Corp › Needs you`, `Mark all as read`), the main column with title, lede, tabs and grouped rows. Two changes:

1. **A group for runners.** Runner items have no project. They group under a band titled **Runners**, with a 15px Lucide `server` icon in the colour square's place, first in the list while any item in it is unread (the band, its count and its rows follow `needs-you`'s grid).
2. **The properties panel** is **380px** while a runner row is selected (it holds the decision), and shows the approval. With no runner row selected it's `needs-you`'s `Where these reach you` at 320px.

### The rows

Same grid as `needs-you` (unread dot 14px, key 80px, title `1fr`, reason, age, action 104px).

| Kind | Key | Title | Reason | Action |
|---|---|---|---|---|
| `runner_awaiting_approval` | mono `build-01` | `build-01 wants to join build-fleet` | `Runner approval` | `Review`: selects the row and opens the panel |
| `runner_joined` (pool without approval) | mono `gpu-01` | `gpu-01 joined Default` | `Joined, no approval needed` | `Open runner`: the runner's page |

- A `runner_joined` notice for a pool that requires approval isn't a second row: the awaiting-approval item is the notice.
- The selected row has `--sel` and `aria-selected`; `↑`/`↓` move focus as on `needs-you`, `Enter` selects.
- On Home (`../m1/home`, growing), the admin's needs-you list shows the same row; its `Review` opens `/needs-you?item=<id>`.

## The approval panel

One `NeedsYou` block filling the panel's top: a 2px `--amber` left rule running its full height, 12px left padding, no box, no fill.

1. **Title:** 15px `hand` + `Needs you · runner approval`, `--amber` 13px 600.
2. **The runner:** a grey ring (the `joining` dot) + the name in mono 600 15px `--text`, then `joining` 13px `--faint`. The name links to the runner's page.
3. **Line,** `text-sm` `--muted`: `Wants to join build-fleet. It gets no task until an admin approves it.` (pool name linked).
4. **Rows**, `PropRow` 30px, a **100px** key column, keys `--muted`, values `--text`:

| Key | Value (the picture) | Rule |
|---|---|---|
| Host | mono `build-01.acme.internal` | the host name the runner reported in `hello` |
| System | mono `Linux · x64` | `os` and `arch` |
| Executor | mono `docker` | a `host` pool adds the chip `not isolated` (and `same user (development only)` under `OSTRA_DEV_HOST_POOL_SAME_USER`); `kubernetes` adds `--muted` `the agent has direct internet access` when its pool says so (ticket 30) |
| Labels | chip `tier:fast` | its own labels as outline mono chips; `None` `--faint`. Built-in `executor:`/`os:`/`arch:` labels aren't repeated here |
| Version | mono `v0.5.0` + `--faint` `current` | the version state's word: `current`, `one minor behind`, `newer`. A runner outside the window never gets here (refused at `hello`) |
| Token | mono `ci-bootstrap` + `--faint` `by Alex Kim` | the join token's label (or `Join token`) and who made it. A token revoked since: struck through, `--faint`, with `revoked since` after it: the approval still holds whichever token joined (spec section 3) |
| Joined | mono `19 Nov 09:12` + `--faint` `4 min ago` | `runner.joined`'s time |
| Key | mono `SHA256:Xb4N…2kQe` | the first and last 4 characters of the runner's public key fingerprint; the whole one in a `Tooltip` and a teal `Copy` on hover |
| Connection | green dot `connected` | `connected` or grey dot `not connected` (it joined and went away: it can still be approved, and goes `offline`) |

5. **Buttons,** 30px, 8px apart, 16px above: `Reject` (outline) then `Approve` (`--amber` fill, `--ink` text, 600). Approve is the page's one filled button.
6. **Footnote,** 12.5px `--faint`, 10px under: `Any admin of Acme Corp can answer. Rejecting revokes its key, and the join stays in the audit log.`

**Reject asks first** (`AlertDialog`): title `Reject build-01?`, body `It's disconnected and can't join again with its key. The token it used stays active: revoke it from build-fleet if you don't trust it.`, buttons `Cancel` and `Reject` (destructive: `--red` text on `--surface`). **Approve doesn't ask:** the panel is the check.

## States and copy

| State | What shows |
|---|---|
| Waiting (`runner-approval.webp`) | As above |
| Approving / rejecting | The pressed button shows a 13px spinning `loader-circle` and `Approving…` / `Rejecting…`; both disabled |
| Approved | The block collapses to one 12.5px `--muted` line under the title: `Approved by you. build-01 is online.` (`… is offline: it takes tasks when it connects.` when it isn't connected), with a teal `Open runner`. The row's action column shows `Approved` `--faint`; it moves to Done on the next load |
| Rejected | `Rejected by you. build-01 can't connect again.` The same move to Done |
| Answered by another admin while open | The block shows that receipt (`Approved by Sam Rivera 1 min ago.`) and the buttons go. A press that crossed it changes nothing (`runners.approve` on an approved runner answers the same, ticket 25) |
| Revoked elsewhere | `build-01 was revoked by Sam Rivera.` The item closes |
| Done tab | Outcome column: `Approved by Alex Kim`, `Rejected by Alex Kim`, `Closed` (revoked elsewhere) |
| Error | `role="alert"`, 12.5px `--red` with `circle-alert`, `errorText(error)`, above the buttons |
| A member who isn't an admin | Never sees the item (its audience is the organization's admins, ticket 03) |
| Loading the panel | The title at once; the rows' values as `Skeleton` bars |
| Narrow (below `xl`) | The panel opens as a right `Sheet` (380px) on `Review` |
| Phone (F-075) | The row's tap opens a bottom sheet with the same block; buttons full width, `Approve` last |

## Components (shadcn/ui names)

`PageFrame` with `properties` (320px, 380px while a runner is selected), `Tabs`, the group band and row of `components/needs-you/`, `NeedsYou` (`components/ui/needs-you.tsx`), `PropRow` with `labelWidth` 100, `Chip` / `Badge` outline, `Status` (`joining` ring, `connected` dot), `Button` (outline; the amber variant), `AlertDialog`, `Tooltip`, `Skeleton`, `Sheet`. Lucide 15px stroke 1.75: `hand`, `server`, `loader-circle`, `circle-alert`, `copy`.

## Tokens (`app-concepts/html/graphite.css`)

> **Scale.** Built at the approved pictures' scale, which wins on size, spacing and contrast: body 14.5px, dense rows 14px, secondary 13px, small 12px, title 26px, `--muted` `#B4B7BB`, `--faint` `#8B8E93`, buttons 30px, a 46px top bar. Measured values: `../m1/README.md`, "Scale".

| Token | Value | Used for |
|---|---|---|
| `--bg` / `--side` | `#0D0E10` / `#0A0B0C` | page, panel / sidebar |
| `--surface` | `#131416` | group bands, outline buttons |
| `--sel` | `#1A1B1E` | the selected row, the Needs you nav row |
| `--line` / `--line-2` | `#1F2023` / `#2A2C30` | hairlines / chip and button borders |
| `--text` / `--muted` / `--faint` | `#F2F3F4` / `#B4B7BB` / `#8B8E93` | values / keys, line / footnote, `joining`, `current` |
| `--amber` / `--ink` | `#FFB224` / `#0C1D21` | the block's rule and title, `Approve`; the sidebar's count and project dots |
| `--green` | `#4FB286` | `connected`'s dot |
| `--red` | `#E5675C` | Reject's confirm button, errors |
| `--teal` | `#6FB8AA` | `Open runner`, `Copy`, links |

## Data this screen needs beyond tickets 25 and 26

- `notifications.list` returns `runner_awaiting_approval` and `runner_joined` items with the runner's ID and name and the pool's ID and name, and no project (the group band reads the kind).
- `runners.get` (ticket 26) for the panel: host, `os`, `arch`, executor, labels, version and its state, the join token's label, maker and revoked state, `joinedAt`, the key's fingerprint, connected or not.
- `runners.approve` / `runners.reject` exist (`packages/api/src/routers/runners.ts`); each resolves the needs-you item for every admin (ticket 12).

## Differences from the current code

Checked against `apps/web` and `packages/api` on `main` (2026-11-19):

1. **Needs you** has no group without a project and no row that selects into the panel; add the `Runners` band and the selection (`?item=`).
2. **The panel** is new: `components/runners/runner-approval.tsx`, shared with the runner's page in `joining`.
3. **`runners.approve` and `runners.reject`** exist; the panel is their first caller in the web app.
4. **The key's fingerprint** isn't returned anywhere; compute it in `runners.get` from the stored public key.
5. **Messages.** New keys under `needsYou.runner.*`: `group`, `wantsToJoin`, `joined`, `reasonApproval`, `reasonJoined`, `review`, `openRunner`, `title`, `waits`, the row keys, `current`, `behind`, `newer`, `by`, `connected`, `notConnected`, `approve`, `reject`, `approving`, `rejecting`, `footnote`, `rejectTitle`, `rejectBody`, `approved`, `approvedOffline`, `rejected`, `answeredBy`, `revokedElsewhere`.

## Wrong in the image (build from this file)

All visible copy is spelled right. These differ from what to build:

- **The properties panel** is drawn about 415px wide (from x 1025). It's 380px.
- **The group bands** are drawn with a 1px border around them, and the selected row's `--sel` fill is faint. Bands are a `--surface` fill with no border (as `needs-you`); the selected row is `--sel`, clearly.
- **The fingerprint** reads `SHA256:Xb4N..2kQe` with two dots. It's one `…`.
- **`CALC-139`'s reason** reads `Setup failed: pnpm install`. Home's reason line is `Setup failed: pnpm install exited 1`, as `needs-you`.
- **The panel's rows** are about 32px; they're 30px. The block's amber rule is right.
- **The sidebar** is drawn from the image's own shell. Build it from `sidebar.tsx`.
- **The picture has no approving, approved, rejected, answered-elsewhere, Done, loading or narrow states:** they're in the table above.
