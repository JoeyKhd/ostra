# Target: limits and crashes on the task page

> **Committed image:** `task-limits.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px, read directly against the WebP.

`task-limits.webp` is the target for the task page (`apps/web/src/app/(panel)/tasks/[task-id]/page.tsx`, rendering `components/tasks/task-view.tsx` and `task/task-thread.tsx` + `task/renderers.tsx`) when a runaway limit or a crash has stopped the task's session and the task needs you. It is screen 7 of `context/specs/m2-tickets-in/spec.md` section 12, built on milestone 1's approved `../m1/task.md`: everything that file says about the frame, the thread, the properties panel, tokens and type still holds. This file adds only the four states. Where this file and the image disagree, this file wins.

- **Image:** `task-limits.webp`, generated with Higgsfield `gpt_image_2_6` (3:2, 2k, high), with the 2048 original of the approved `../m1/task.webp`, `app-concepts/html/home-graphite.png` and the Hinge logo as references. Prompt: `task-limits.prompt.txt`. One generation.
- **State shown:** the spend cap. A ticket task from Linear whose first turn opened PR #491; Sam Rivera reopened it with a follow-up, the turn resumed in the same box, and the key proxy refused a model call at $25.00 of the $25.00 cap. The viewer (Alex Kim) is not the driver.
- **States specified but not pictured:** stalled, maximum duration, crashed (below). They use the same layout; only the copy, the thread row and the action change.
- **Features:** F-068 runaway protection (the stall, the maximum duration, the spend cap), F-047 agent crashes don't kill tasks. Reopening itself (the composer, the "resumed" and "restored" markers) is screen 6's target; this file uses it and doesn't redefine it.

## Purpose

When ostra stops a session on its own (a limit) or the session dies (a crash), the member must see at once, without reading the thread: what stopped it, that the work is safe, and the one thing to do next. That's reopen, or, at the spend cap, why reopening has to wait and who can change that. The thread keeps the record of when it happened.

## Layout (1440 x 956 CSS px)

The frame is `../m1/task.md`'s, unchanged: sidebar 232px, top bar 44px, thread column `1fr` with `padding: 28px 40px 20px`, properties panel 300px. What differs:

| Region | In this state |
|---|---|
| Top bar, right | copy-link ghost icon button, then one `PR #491` outline button per PR. **No `Stop`**: the session has already ended (`capabilities.stop` is false). |
| Header | key line, title, status line as in m1. Then, 16px below the status line, the **needs-you block** (below). Then the hairline, 20px below the block. |
| Thread | as m1, ending with the limit's or the crash's system row and the "work saved" row. |
| Composer | the reopen composer from screen 6, in the state the limit allows (below). |
| Properties | m1's rows, plus `Box` (screen 5's box state) and `Spend` (now real, F-068), with the limit's status. |

### The needs-you block (header)

This is milestone 1's amber-ruled `needs-you` note, which m1's spec keeps "only for other needs-you reasons": limits and crashes are exactly those. It is not a card.

- `border-left: 2px solid var(--amber)`, `padding-left: 12px`, `margin-top: 16px`. The block is as wide as the thread column (max 760px of text).
- **Title:** Lucide `hand` 14px + `Needs you · <reason>`, `--amber`, 13px weight 600. This is the one amber text on the page.
- **Body:** 13px/1.5 `--text`, one or two sentences: what stopped the session and that the work is kept. Numbers (money, minutes, tokens) in the body stay in Plex Sans, as the image shows them; mono is for keys, refs, setting names.
- **Detail:** 12px `--muted`, 4px below. Setting names as inline code chips (mono 11.5px, `--surface`, 1px `--line`, radius 5px, padding 1px 6px).
- **Action row** (all states but the spend cap), 10px below: `Reopen` as the amber button (28px, `--amber` fill, `--ink` text, weight 600, `rotate-ccw` icon 14px), then a 12px `--faint` footnote on the same line, 12px gap. The spend cap has no button: the detail line says why.
- **Refusal:** a red 12px line under the action row with the API's reason (below). The block stays.

### Thread rows

The limit or the crash adds one 28px system row (m1's tool-style row: 28px icon gutter, `--muted` 13px text), then the "work saved" row:

| State | Icon | Row |
|---|---|---|
| Stalled | `timer-off`, `--muted` | `OpenCode sent nothing for 10 minutes. ostra stopped the session.` |
| Maximum duration | `timer`, `--muted` | `The session ran for 2 hours, its maximum. ostra stopped it.` |
| Spend cap | `gauge`, `--muted` | `The task reached its spend cap: $25.00 of $25.00. ostra stopped the session.` |
| Spend cap, in tokens | `gauge`, `--muted` | `The task reached its token cap: 10.0M of 10.0M tokens. ostra stopped the session.` |
| Crashed, the agent died | `triangle-alert`, `--red` | `The session crashed: <error>` (milestone 1's `task.system.crashed`, unchanged) |
| Crashed, the box was lost | `triangle-alert`, `--red` | **new** `The runner lost the box mid-turn.` |

Then, after a stop that cut a turn short: `Saved unfinished work to <ref>` (milestone 1's copy, `info` icon, the ref in mono `--faint`). After a crash on a lost box there is no such row (the box couldn't push); the block says what is kept instead. The agent message whose turn was cut keeps the status word `stopped` (`--faint`); after a crash, `the turn failed` (`--red`, milestone 1). A tool that was running when the limit hit shows `cancelled` (`--faint`).

The limit's minutes and money come from `session.limit_reached { limit, observed }`: `observed` is minutes, micro-USD or tokens. The row prints the observed value and the cap from `tasks.get`, never a hard-coded `10` or `2 hours`.

### Composer (pinned)

Screen 6's reopen composer. In these states:

| State | Composer |
|---|---|
| Stalled, maximum duration, crashed | enabled. Placeholder `Message the agent…`; the button is screen 6's `Reopen` (Shell primary). Typing a message and pressing it reopens with that message; the block's amber `Reopen` reopens without one. |
| Spend cap | **disabled**: box border `--line` (not `--line-2`), textarea `disabled`, placeholder **new** `Reopening waits until the spend cap is raised.` in `--faint`, `Reopen` at 40% opacity with `aria-disabled`. No hint row. |
| Reopen in flight | both `Reopen` buttons show **new** `Reopening…` and are disabled. |

### Properties panel

As m1, with these rows (keys 84px, values at the same x, no icons in values):

| Row | In the image | Source |
|---|---|---|
| Status | amber dot + `Needs you · spend cap` | `task.state` + the limit (below) |
| Box | `Stopped` | screen 5's box state (`running`, `idle`, `stopped`, `released`): `tasks.get`, ticket 30 |
| Tokens | mono `7.4M in · 212k out` | as m1, summed across the task's sessions |
| Spend | 80px meter + mono `$25.00 / $25.00` | `tasks.get`'s spend against the cap (ticket 30). The meter is m1's context meter (`--line-2` track, `--muted` fill), **not** red or amber: the block carries the meaning. Under the cap it reads e.g. `$3.40 / $25.00`. In tokens: `10.0M / 10.0M tokens`, and the row's `title` says **new** `This model has no price, so the cap is counted in tokens.` |
| Time | mono `1 h 48 min` | from `createdAt` |

Code group: as m1 (Repo, Branch, PR with ` · open`, ` · draft`, ` · merged`, ` · closed`: screen 5's PR states).

## Every state, with its copy

Copy goes in `apps/web/messages/en.json`. Everything here is **new** unless marked. The reason word is the same in the status line, the properties' Status row and the block's title.

`needs_you` reasons in the domain are `stalled`, `spend_cap` and `crashed`; the maximum duration also raises `stalled` (spec 5.4, `limit_reached`). The panel tells the two apart by the limit `tasks.get` returns (`limit: "stall" | "max-duration" | "spend-cap"`, ticket 30), so the build switches on that, exhaustively, not on the reason alone.

### 1. Stalled (`limit: "stall"`)

- Status: amber dot, `Needs you · stalled` · `Stopped {age} ago on <runner>`.
- Block title: `Needs you · stalled`.
- Body: `OpenCode sent nothing for {minutes} minutes, so ostra stopped the session. Its work is saved.` (`{agent}` is the agent profile's name.)
- Detail: none.
- Action: amber `Reopen`. Footnote: `Reopening resumes the session where it stopped. Any member of {project} can reopen it.`
- Thread row: stalled, above.

### 2. Maximum duration (`limit: "max-duration"`)

- Status: `Needs you · maximum duration`.
- Body: `The session ran for {duration}, the most one session may run, so ostra stopped it. Its work is saved.` (`{duration}`: `2 hours`, `90 minutes`, from `observed` minutes.)
- Detail: `The limit is OSTRA_SESSION_MAX_MINUTES on the server.` (the name as a code chip)
- Action: amber `Reopen`. Footnote: `A reopened session gets its own {duration}.`

### 3. Spend cap (`limit: "spend-cap"`), the image

- Status: `Needs you · spend cap`.
- Body: `This task spent {spent} of its {cap} cap. The key proxy refused the next model call, and the session stopped cleanly.`
- Body, in tokens (the model has no known price, spec section 11 item 8): `This task used {used} of its {cap} tokens. Its model has no known price, so the cap is counted in tokens. The key proxy refused the next model call, and the session stopped cleanly.`
- Detail: `It can't be reopened until the cap is raised. An admin sets OSTRA_TASK_SPEND_CAP_USD on the server; the task keeps what it spent.` In tokens: the same with `OSTRA_TASK_TOKEN_CAP`. (Milestone 2 raises the cap only through the setting; when per-task or per-project caps come with F-037, this line becomes an action.)
- Action: none. Composer disabled (above).
- Once the cap is raised above what the task spent, the same task shows the stalled layout's action with the body unchanged and the detail replaced by **new** `The cap is now {cap}. Reopen to carry on.`

### 4. Crashed (`needs_you`, reason `crashed`)

Two variants, by whether the box is still there (`tasks.get`'s box state).

- Status: `Needs you · crashed`.
- **The agent died, the box is there:** body `{agent} stopped mid-turn: {error}. The branch and the hidden ref are kept.` The error is agent output: render it as text, one line, truncated at 160 characters with the full text in a `Show the error` disclosure (m1's teal disclosure, `.code` block under it). Footnote: `Reopening starts {agent} again on the same box.`
- **The box was lost:** body `The box was lost mid-turn. The branch, the hidden ref and the last finished turn's archive are kept.` Footnote: `Reopening restores the last finished turn on a fresh box and replays {name}'s last message.` (`{name}`: the member whose message the lost turn was answering, F-047.)
- Action: amber `Reopen` in both.
- Thread row: crashed, above (`--red`, `triangle-alert`).

### Refusals and in-flight

`tasks.reopen` refuses with a reason (ticket 30). Show it as a 12px `--red` line under the block's action row, `role="alert"`:

| Reason | Copy |
|---|---|
| at the spend cap (a race: the page was stale) | `This task is at its spend cap. An admin has to raise it first.` |
| another active task holds the ticket | `Another task on {ticketKey} is active: {taskKey}.` with `{taskKey}` a teal link to it |
| anything else | the API's error text (`errorText`) |

While the reopen is in flight, both buttons read `Reopening…`, disabled. On success the block goes away with the needs-you item, the status turns to `Preparing` / `Running`, and screen 6's "resumed" or "restored" marker appears in the thread.

### Where else the state shows

- The project's task list and Home's "Needs you" rows use the same reason words (`Needs you · spend cap`, …) as the row's "doing" text. No new layout there.
- The sidebar's needs-you count includes these tasks, as any needs-you item.

## Components (shadcn/ui names) and tokens

> **Scale.** The sizes and colours below are `graphite.css`'s. The panel is built at the approved pictures' scale, which wins on size, spacing and contrast: body 14.5px, dense rows 14px, secondary 13px, small 12px, title 26px, `--muted` `#B4B7BB`, `--faint` `#8B8E93`, buttons 30px, a 46px top bar and a 320px properties panel (380px with a form). The measured values are in `../m1/README.md`, "Scale".

| Part | Component |
|---|---|
| Needs-you block | plain markup (the existing `data-testid="needs-you"` block), `Button` with an `amber` variant (as the approval's `Approve once`), `Collapsible` for `Show the error` |
| Setting-name chip | `<code>` styled as m1's inline code chip, smaller (above) |
| Thread system rows | the existing `Line` in `renderers.tsx` with `TimerOffIcon`, `TimerIcon`, `GaugeIcon`, `TriangleAlertIcon`, `InfoIcon` |
| Composer | screen 6's reopen composer; `Textarea` `disabled`, `Button` `aria-disabled` |
| Spend meter | `Progress` (as m1's context meter), 80px × 4px |
| Status | the existing `Status` (dot + label) |
| Refusal | `<p role="alert">`, `--red` 12px |

Tokens from `app-concepts/html/graphite.css`, as m1: `--amber #FFB224` (block rule, hand icon, title, status dots, the `Reopen` fill), `--ink #0C1D21` (text on amber), `--text`, `--muted`, `--faint`, `--line`, `--line-2`, `--surface`, `--red #E5675C` (crash row, refusals only), `--teal` (links, `Take over`, `Show the error`). Type: IBM Plex Sans 13px body, 12px detail; Plex Mono for refs, setting names, runner and branch names, spend and tokens in the panel.

## Differences from the current code

1. **`task-view.tsx`'s needs-you block** prints `summary ?? data.reason ?? needsYouDefault`, so a limit would show the raw enum (`spend_cap`). Target: a title with the reason word and a body/detail/action per state, from a `limitCopy(task)` switch over the limit and crash variants, exhaustive with `satisfies never`.
2. **Status words** (`task-words.ts`): `taskStateText("needs_you")` is just `Needs you`. Target: append ` · stalled`, ` · maximum duration`, ` · spend cap`, ` · crashed` (as m1's ` · approval`, ` · question`), in the header, the properties and the lists.
3. **Status line:** add `Stopped {age} ago on <runner>` for a task whose session a limit or crash ended (m1 has `Started {age} ago` for live ones).
4. **Top bar:** `Stop` hides when `capabilities.stop` is false; check the API sets it false once the session ended at a limit (today the button shows on any non-`stopped` state with the capability).
5. **Thread** (`renderers.tsx`): render `session.limit_reached` (new kind, fold in `packages/task-view`) with the three rows above; add the lost-box crash row. An unknown limit value still renders as `unsupported`, not dropped.
6. **Properties:** add `Box`, and `Spend` with its meter (hidden in m1).
7. **Composer:** the disabled spend-cap state is new; the enabled state is screen 6's.
8. **Open point for the build:** the block's one-click `Reopen` (F-047: "one action reopens the task") has no message, but `tasks.reopen` takes `text`. Either let a reopen from a limit or crash carry no text (the runner replays the last member message after a lost box anyway), or send a fixed `Carry on.` as the member's message. Settle it with the maintainer; don't invent the text in code.

## Wrong in the image

The image model drew these; build the version on the right.

| In the image | Build |
|---|---|
| The agent's avatar glyph (a briefcase) | a neutral Lucide icon (`square-terminal` or `box`), never `bot`, as m1 |
| `Pool` / `docker` chips with bright text | `.chip`: `--muted` text, 1px `--line-2`, 22px tall (m1's erratum) |
| The Spend meter is 90px, thick and starts left of the other values; `$25.00 / $25.00` runs into the panel's right padding | 80px × 4px meter starting at the value column's x, as m1's context meter, mono value after an 8px gap, inside the 18px padding |
| `Time` value `1 h 48 min` starts left of the other values | same x as every value |
| `on` in the status line in Plex Sans next to a mono runner name, and `Stopped 6 min ago` muted | as specified: muted `Stopped 6 min ago on`, then the runner in mono `--faint` |
| The disabled `Reopen` drawn as a grey filled button | the Shell primary at 40% opacity |
| The composer is one line tall | m1's composer height (2-row textarea, then the button row), disabled |
| Sidebar rows (Inbox, Repos, Settings, Members, counts, other projects) | the real shared sidebar (`components/shell/sidebar.tsx`); milestone 2 adds only what exists then |
| The org logo top-left, redrawn by the model | the real Hinge SVG (`/brand/ostra-mark.svg`), 20px |
| `CALC-174`, `$25.00`, `7.4M`, `build-fleet-07`, `#491`, `tsk_7Hq2Lm`, names | demo data, not copy. The real hidden ref is `refs/ostra/wip/<taskId>` with the task's real ID |

Everything else in the image is spelled as specified.
