# Target: Connect Linear's agent mode (milestone 6, screen 6)

> **Committed image:** `linear-agent-mode.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel.

- **Prompt:** `linear-agent-mode.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation, kept as made. References: `app-targets/m2/connect-linear.png` (the approved page this one grows, spec section 12), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route:** milestone 2's `apps/web/src/app/(panel)/organization/linear/page.tsx` → `components/linear/linear-view.tsx`, grown. The board switch also shows on the project's Boards page (`m2/project-boards`, a screen that only grows).
- **Features:** F-012 (start from Linear). Spec section 12, screen 6; section 3, step 10; section 4, "Linear agent mode"; section 11, items 5 to 8. Ticket 26 (`linear.status` grown, `linear.enableAgentMode`, `linear.setBoardAgentMode`), ticket 33 (this screen), ticket 13 (the server), ticket 06 (the activity renderers, whose words are in "What ostra posts in Linear" below). ADR 0013 (amended), ADR 0057.
- **Status:** a proposed target, waiting on approval (ticket 30's `## Comments`). Ticket 33 builds its data and tests until then, not its UI.

> Build it in real HTML/React (app-design.md, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

`m2/connect-linear` connects the organization's Linear app. Agent mode is what lets people in Linear hand ostra a ticket: delegate it to ostra's app user, or `@mention` it, and follow the work in the ticket's agent session. The page grows to answer, in this order:

1. **Is agent mode on, and can it work?** The state, the public address Linear's webhooks need, the app user people see, the two agent scopes the token was granted, and when the token renews.
2. **Which boards take delegations?** One board per Linear team, in one project. Each board's "Start from Linear" switch.
3. **Is it working right now?** The last session events: who delegated, stopped or followed up, and what ostra did.

The page also fixes, once, **the words ostra posts in Linear** (ticket 06's renderers): they're below, so the copy is designed in one place.

The picture shows Alex Kim, an organization admin, on Acme's connection with agent mode on: `Calculator` and `Billing` take delegations, `Billing exports` can't (its team already starts on `Billing`), and the last four events include an outside task waiting for approval and a mention for a team with no board.

## Layout (CSS px at 1440 wide)

`m2/connect-linear`'s frame, unchanged: the shared shell with `Linear` selected, a 44px top bar (`Acme Corp › Linear`, right: `Open in Linear`), the page column (padding `28px 40px`, content `max-width: 760px`), a 300px properties panel.

### Page column, top to bottom

1. **Heading and lede,** as `m2/connect-linear`.
2. **Connection,** as `m2/connect-linear` (one row).
3. **Agent mode** (new, 24px below). `.shead` `Agent mode`, then one 12.5px `--muted` line: `People in Linear delegate a ticket to ostra or @mention it, and follow the work in the ticket's agent session.` Then `.rows`, 40px, key column 160px `--muted`, value `--text`:

| Key | Value (on, the picture) |
|---|---|
| `State` | `.dot.green` + `--green` `On` + `--muted` ` · turned on {date} by {name}` (`Connection.agentModeAt` and the audit entry's member) |
| `Public address` | Lucide `check` 14px `--green` + mono `--text` the address (`OSTRA_CORE_PUBLIC_URL`) + `--muted` ` · Reachable: Linear's webhooks arrive here` |
| `App user` | the Hinge mark 16px (Linear shows ostra's app avatar; the panel shows ostra's mark) + mono `--text` the app user's name + `--muted` ` · offered as a delegate on boards with Start from Linear` |
| `Agent scopes` | one `.chip` (22px, mono 12px) per agent scope the token holds: `app:assignable`, `app:mentionable` + `--muted` ` · granted {date}` |
| `Token renewal` | `--muted` `Next renewal in {h} h · last renewed {time}, with the rotating refresh token` |

4. **Start from Linear** (new, 24px below). `.shead` `Start from Linear` + `--faint` mono count of boards switched on. One 12.5px `--muted` line: `One board per Linear team takes its delegations. Agent mode starts code tasks only.` A header row 28px (11.5px `--faint`: `Board`, `Team`, `Project`, and an unlabelled right column), then one 40px row per board of the organization's Linear connection, grid `1fr 120px 200px auto`:
   - `Board`: the board's name, 13px `--text` (`--muted` when the switch can't be turned on).
   - `Team`: the Linear team's key, Plex Mono 12.5px `--text`.
   - `Project`: the project's name, Plex Mono 12.5px `--muted`, a link to the project's Boards page.
   - Right: the `Switch` (`setBoardAgentMode`). When another board of the same team is on, this one's switch is off and disabled, with 12px `--faint` before it: `{TEAM} already starts on {board}` (and ` in {project}` when that board is in another project). A project admin of the board's project may switch it; others see the switch disabled with the `title` `Only calculator's admins change this.`
   - Order: switched on first, then by project, then by board name.
5. **Last session events** (new, 24px below). `.shead` `Last session events`. Up to 10 rows, 36px, hairlines, grid `52px 90px 80px 1fr auto`: the time (Plex Mono 12px `--faint`, `HH:mm` today, `D MMM` before), the event (`Delegated`, `Mention`, `Follow-up`, `Stop`), the ticket key (Plex Mono, a link to the task when there is one), who (the Linear user's name as Linear gives it; ` · not a member` in `--faint` when unmatched), and the outcome, right-aligned, 12.5px `--muted` (list below). An outcome that is an error gets Lucide `triangle-alert` 14px `--red` before it. With none yet: one 13px `--faint` row `No sessions yet. Delegate a ticket to ostra in Linear to start one.`
6. **Events, Token, Disconnect:** `m2/connect-linear`'s sections, unchanged, below (off the picture). The `Access token` row keeps its health; the renewal detail lives in Agent mode's row once agent mode is on.

**Outcomes** (`linear.agentEvents.outcome.*`): `Started a task` · `Waiting for approval` · `Approved by {name}` · `Rejected by {name}` · `Sent after the running turn` · `Not a member: told who can steer it` · `Turn stopped, final response posted` · `Already stopped` · `No board takes {TEAM}'s delegations` · `Already has a task: sent as a follow-up` · `Could not start: {reason}`.

### Properties panel

`m2/connect-linear`'s groups, grown:
1. **App:** `App user`, `Client ID`, `Workspace`, `Secrets` (as before).
2. **Scopes** + count: every scope the token holds, mono `--muted`, now including `app:assignable` and `app:mentionable`.
3. **Agent sessions** (new): `Open` mono count (`AgentSession.state` active) · `Awaiting approval` mono count · `Heartbeat` `after 20 min of silence` (`OSTRA_LINEAR_HEARTBEAT_MINUTES`; `as a plain thought` added when `OSTRA_LINEAR_HEARTBEAT_KIND=thought`) · `Posted today` mono count of sent activities.
4. **Webhook events** + count, as before (the list may fold after 3 with `+{n} more`, which expands in place).

## States and copy

The page's milestone 2 states (not connected, pending, polling, silent, failed, loading) hold. Agent mode adds:

| State | What shows |
|---|---|
| **On** (the picture) | as above |
| **Off, can be turned on** (connected by webhooks, agent scopes missing) | Agent mode's rows: `State` `.dot` grey + `Off`; `Public address` as in the picture; `Agent scopes` `--muted` `Not granted yet`. Under the rows: `--muted` 12.5px `Linear asks a workspace admin to authorize ostra's app again, with two more scopes: app:assignable and app:mentionable. Nothing else changes.` and the page's one primary button `Turn on agent mode` (Shell, Lucide `arrow-up-right` first). Start from Linear and Last session events are hidden |
| **Turning on** | the button reads `Opening Linear…`, disabled; the browser goes to Linear's consent page (`actor=app`, PKCE). Back with `?agent-mode=1`: `State` `On` with a `--green` `check` and `--faint` `Just turned on` at its right; a status line under the section, `role="status"`: `Agent mode is on. Turn on Start from Linear for a board.` |
| **Back without the scopes** | the red line under the lede (milestone 2's): `Linear didn't grant app:mentionable. Authorize again and keep every scope checked.` (the missing scopes named) |
| **The address isn't public** (polling mode, or the pre-check fails) | `Public address` `triangle-alert` 14px `--red` + `--text` `Not reachable from Linear` + `--muted` ` · {reason}`; under the rows, `--muted`: `Agent mode needs Linear's webhooks. Set OSTRA_CORE_PUBLIC_URL to a public https address.` The `Turn on agent mode` button is disabled. When agent mode was already on, `State` reads `On, not receiving` and the Last session events section adds the same line |
| **Renewal failing** | `Token renewal` `triangle-alert` `--red` + `--text` `The last renewal failed at {time}` + `--muted` ` · retrying until {time}`. Past the window, milestone 2's `Token failed` state takes over, and agent sessions get no posts until an admin authorizes again |
| **Switching a board** | the switch shows its new position at once, disabled, with a 12px spinning `loader-circle` before it; on success a 12.5px `--muted` status line under the section, `role="status"`: `Calculator takes CALC's delegations now.` / `Calculator stopped taking delegations. Open sessions finish.` Refused (another board of the team won the race): the switch returns, and `--red` `role="alert"` `CALC already starts on Calculator in calculator.` |
| **No board on** | the section's count `0`, and under its lede, 12.5px `--muted`: `No board takes delegations yet: people in Linear see ostra, and a delegation gets an error.` |
| **A member, or a project admin who isn't an organization admin** | no `Turn on agent mode`, no Disconnect. Board switches enabled only for boards of projects they administer. Agent mode's rows read the same; Last session events show only tickets of projects they can open |
| **Loading** | Agent mode's rows as three 40px `Skeleton` rows; the board list as two |

The colours: green on `On`, `Reachable`, the check and switches that are on; red only on error icons and lines; teal on links; no amber on this page (an outside task's amber is on Needs approval).

## What ostra posts in Linear

Ticket 06's renderers, one per moment, each a pure function with a snapshot test. ADR 0057: ostra's own words, counts and links, **never** agent output, a tool's input, a plan, a draft, a question's text or check output. Names and project names are the only variables besides counts, keys and links. `{project}` is the project's name; `{link}` is the task page's absolute URL (`OSTRA_PUBLIC_URL` + `/tasks/{id}`), also set as the session's link where Linear has the field.

| Moment | Kind | Body |
|---|---|---|
| Received, a member, starting | thought | `Received. Starting a task in {project}.` |
| Received, outside, waiting | thought | `Waiting for a member of {project} to approve this task in ostra.` |
| Approved | thought | `Approved by a member of {project}. Starting the task.` |
| Queued (no runner yet) | thought | `Queued: waiting for a runner on {project}'s pool.` |
| Held by the budget | thought | `Held: {project}'s budget for {month} is reached. It starts when an admin raises it.` |
| A turn starts (first) | thought | `Working on it in ostra.` |
| A turn starts (later) | thought | `Working on it in ostra: turn {n}.` |
| A PR opened | action | action `Opened a pull request`, parameter `{owner}/{repo}#{number}`, result the PR's URL |
| Needs you | elicitation | `This needs a member of {project} in ostra: {moment}. {link}` with `{moment}` one of `a question from the agent`, `a plan to approve`, `an approval`, `a draft to review`, `the setup failed`, `no progress for 20 min`, `the automatic turns ran out` |
| A follow-up from a matched member | thought | `Got it. Your message goes to the agent after the running turn.` |
| A follow-up from anyone else | thought | `Only members of {project} can steer this task. A member can reply here, or in ostra.` |
| A mention on a ticket that already has a task | thought | `This ticket already has a task in ostra. Your message goes to it as a follow-up.` (from a member; otherwise the line above) |
| Heartbeat | thought, ephemeral | `Still working.` |
| Finished, PRs ready | response | `Finished. Ready for review: {pr link}.` With several: `Finished. {n} pull requests ready for review: {pr link}, {pr link}.` |
| Finished, no changes | response | `Finished without changes. Nothing to review.` |
| Stopped in Linear | response | `Stopped on request from {linear user}. Nothing further will run.` |
| Stopped in ostra | response | `Stopped in ostra by {member}. Nothing further will run.` |
| Rejected | response | `Rejected in ostra by a member of {project}.` With a reason: ` Reason: {reason}` (the member's words, at most 300 characters, quoted as text) |
| Failed | error | `The task failed in ostra: {failure}. A member of {project} can reopen it. {link}` with `{failure}` from ostra's own words (`the runner went offline`, `the setup script failed`, `the agent exited`, `the box couldn't start`) |
| No board for the team | error | `No board in ostra takes {TEAM}'s delegations. A project admin turns on Start from Linear for one of {TEAM}'s boards.` |
| Agent mode turned off since | error | `Agent mode is off in ostra. Nothing was started.` |
| Not a code start (a refine asked for) | response | not reachable in v1: agent mode starts code tasks only (Q215) |

Every body is plain text; Linear renders Markdown, so a renderer escapes `*`, `_`, `` ` ``, `[` and `]` in names and reasons. Each post has an idempotency key `{session}:{moment}:{n}` and moves the session's heartbeat 20 minutes on.

## Components (shadcn/ui names)

- `m2/connect-linear`'s: `PageFrame`, `PropGroup`, `PropRow`, `Separator`, `.rows`, `Status`, `Button`, `AlertDialog`, `Skeleton`.
- `Switch` (in `components/ui/switch.tsx` already), `Table` parts for the board list and events, `Badge variant="outline"` as `.chip` for the scopes, `Tooltip` for a disabled switch's reason.
- Icons: Lucide 15px, stroke 1.75: `check`, `triangle-alert`, `arrow-up-right`, `external-link`, `loader-circle`, `lock`.

## Tokens (`app-concepts/html/graphite.css`)

> **Scale.** The sizes and colours below are `graphite.css`'s. The panel is built at the approved pictures' scale, which wins on size, spacing and contrast: body 14.5px, dense rows 14px, secondary 13px, small 12px, title 26px, `--muted` `#B4B7BB`, `--faint` `#8B8E93`, buttons 30px, a 46px top bar and a 320px properties panel (380px with a form). The measured values are in `../m1/README.md`, "Scale".

As `m2/connect-linear`: `--bg`, `--side`, `--surface`, `--line`, `--line-2`, `--text`, `--muted`, `--faint`, `--sel`, `--teal`, `--green` (`On`, `Reachable`, switches on: the `Switch`'s checked track), `--red` (error icons), `--shell` and `--ink` (the `Turn on agent mode` button). No amber. Type: Manrope 700 24px; IBM Plex Sans 13px rows, 12.5px secondary; IBM Plex Mono for the address, scopes, team keys, ticket keys, times and counts.

## Data this screen needs beyond ticket 26

- `linear.status`'s growth lists most of it. Add: **who turned agent mode on** (the audit entry's member), **when the token was last renewed**, each board's **team key and project name**, which board **holds the team** when a switch is blocked, and per event the **outcome** (from the session's first activity or the task's state) and whether the creator was **matched**.
- The **Agent sessions** counts (open, awaiting approval, posted today): a small aggregate in `linear.status`.
- Members who aren't organization admins see the page (milestone 2's decision): `linear.status` filters the events to projects they can open.

## Open points (the build takes the recommendation and records it in ticket 33's `## Comments`)

1. **Does a rejection's reason go to Linear?** ADR 0057 allows ostra's own words; a reason is a member's words, not agent output. Recommended: yes, quoted and capped at 300 characters, and the Reject dialog says so (`needs-approval`).
2. **Where the finished response is posted:** at the turn's end with PRs open, or at merge. Recommended: at the first turn's end that leaves the task in review; later turns post a thought and an action per new PR, and the session ends with the response.
3. **Who switches a board:** ticket 26 says a project admin. Recommended: as written, with organization admins too (they administer every project).

## Differences from the current code

Checked against `apps/web` on `main` (2026-11-19): there's no Linear page yet (milestone 2 builds `m2/connect-linear`). This screen adds to that page:

1. **Three sections** in `linear-view.tsx`: `AgentModeSection`, `StartFromLinearSection`, `SessionEventsSection`, and the panel's `Agent sessions` group.
2. **`Turn on agent mode`** calls `linear.enableAgentMode()` and follows the consent URL; the callback route handles `?agent-mode=1` and the missing-scopes error.
3. **The Boards page** (`m2/project-boards`) gains the same `Switch` per board, sharing the component.
4. **Messages:** `linear.agentMode.*`, `linear.startFromLinear.*`, `linear.agentEvents.*` in `messages/en.json`. The activity bodies above live in `packages/domain` (ticket 06), not in the panel's messages: they're posted by core.

## Wrong in the image

Build the copy and details in this file, not these:

- **The panel's group labels** (`App`, `Scopes`, `Agent sessions`, `Webhook events`) are drawn 13px. They're 11px 500 `--faint`, and the counts beside them faint mono.
- **The Agent sessions values** are drawn right-aligned; values sit in the value column like the App group's. `after 20 min of silence` is sans, not mono.
- **The App user's mark** is the Hinge drawn as an avatar; use `kit/logo/export/ostra-hinge-single-color.svg` at 16px.
- **The board list's header** has no label over the switches, which is right; its first column header `Board` sits 2px left of the rows' text. Align them.
- **`Billing exports`' blocked line** is drawn in `--muted`; it's 12px `--faint`.
- **The sidebar's rows** come from the shell, not the picture.
- The picture has no off, turning-on, unreachable, renewal-failing, switching, member or loading states: they're in the table above.

All visible copy in the image is spelled right.
