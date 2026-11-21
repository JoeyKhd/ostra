# Target: reopening a task

> **Committed images:** `task-reopen.webp` and `task-reopen-stopped.webp`, each downscaled from a 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

The targets for reopening on `apps/web/src/app/(panel)/tasks/[task-id]/page.tsx`: the composer that reopens a task, and the thread's markers for how a session came back. The page is `task-ticket.md` (itself `../m1/task.md` plus the ticket); this file only adds the reopen. Where a picture and this file disagree, this file wins.

| Picture | State shown |
|---|---|
| `task-reopen.webp` | A day after its first turn, Alex Kim reopened `CALC-174`. The old box was released, so the task came back on a fresh box (`alex-desktop`) from the session archive, and the hidden ref conflicted with 2 commits pushed since: the restore-conflict needs-you item is open, and OpenCode is already working from the branch's head. |
| `task-reopen-stopped.webp` | Later: the task has been reopened twice more (once resumed in the same box, once rebuilt from the template after the box was lost and the archive couldn't be read, with the member's unanswered message replayed). Sam Rivera stopped it, the box was released, and the composer now reopens. |

- **Generated** with Higgsfield `gpt_image_2_6` (3:2, 2k, high). `task-reopen`: references the `task-ticket` generation, the approved `../m1/task` original, `home-graphite.png` and the Hinge logo. `task-reopen-stopped`: references the `task-reopen` generation, the `../m1/task` original and the Hinge logo. Prompts: `task-reopen.prompt.txt`, `task-reopen-stopped.prompt.txt`.
- **Features:** F-032 reopen, F-033 reopen anywhere (ADR 0039's three steps), F-047 (a lost box, the replayed message). Ticket 36 builds it; ticket 30 serves `tasks.reopen`; ticket 18 decides the step; `packages/task-view`'s fold renders the markers.

## Purpose

Any member can pick a task back up, months later, with one message, and see how it came back: in the same box, from its archive on a fresh box, or rebuilt from the template. If the unfinished work couldn't be put back, the driver is told, with what happened to it, and the task doesn't stall on it.

## Layout

Unchanged from `task-ticket.md`: sidebar 232px, top bar 44px, thread column `padding: 28px 40px 20px`, properties 300px. This screen changes three places:

1. **The composer** (pinned, the same box: `--surface`, 1px `--line-2`, radius 8px, padding 12px 14px): its placeholder, hint and button follow the task's state (below).
2. **The thread:** reopen messages, the day dividers and the markers (below).
3. **The properties panel:** `Box` and a new `Session` row.

### Thread rows

Rows emitted during a turn (tool rows, pushes, `Work saved`, PRs) sit in the turn's tool grid (`../m1/task.md`). Rows between turns sit at message level: a 14px icon centred in the 40px gutter, **no circle**, 13px text in the content column, `--muted` unless noted, then a mono 12px `--faint` detail after 12px. 28px tall.

- **Day divider:** 12px mono `--faint` label at the gutter's left edge (the thread's left padding), then a 1px `--line` to the right edge, 16px above and 8px below. Labels: `Today`, `Yesterday`, then `Mon 17 Nov` (weekday, day, month; the year when it isn't this year). Only between messages on different days.
- **Reopen message:** milestone 1's user message, with ` · reopened the task` in `--faint` 12px after the time.
- **Restore conflict:** milestone 1's approval block style (2px amber left rule, 12px left padding, indented to the content column, no card). See below.

## Every state, with its copy

Copy goes in `apps/web/messages/en.json`. **New** strings are marked; all of this section is new unless it says milestone 1.

### The composer: send or reopen

The button says which call it makes (ticket 36). `capabilities` from `tasks.get` decides which row applies; the client never infers it from the state alone.

| Task and box | Call | Placeholder | Hint (`info` 13px + 12px `--faint`) | Buttons |
|---|---|---|---|---|
| a turn running | `tasks.send` | `Message the agent…` | milestone 1's per-agent hint | `Interrupt and send` (outline, `pause`), `Send` (primary, `arrow-up`) |
| the session idle on a warm box (any task state) | `tasks.send` | `Message the agent…` | `The session is idle in the same box. Send starts the next turn.` | `Send` |
| stopped, in review, or needs you, with no live session | `tasks.reopen` | `Reopen with a message…` | `Reopening picks a runner, restores the session and keeps the same branches and PRs.` | `Reopen` (primary, `rotate-ccw`) |
| merged or done | `tasks.reopen` | `Reopen with a message…` | open point, below | `Reopen` |
| queued or preparing | none | `Message the agent…`, disabled | `The task is starting. You can send once the agent is ready.` | `Send`, disabled |
| the viewer can't send (milestone 1's rule) | none | no composer | milestone 1's take-over line | none |

- **Empty textarea:** the button is disabled.
- **In flight:** `Reopening…` (or `Sending…`), disabled; the message shows at once in the thread with `--faint` `sending…`, as milestone 1 does. One `clientMessageId` per press, so a double press reopens once.
- **Refused** (a red 12px line under the textarea, the text kept):
  - spend cap: `This task reached its spend cap of {cap}. It can't be reopened until the cap is raised.`
  - another active task holds the ticket: `{key} already has an active task.` + teal `Open it` linking to that task.
  - any other error: milestone 1's error line.

### Markers in the thread (the fold, `packages/task-view`)

| Event | Icon | Text | Detail (`--faint`, mono) |
|---|---|---|---|
| `session.saved`, both saved | `archive` | `Work saved after turn {n}` | `archive {size} · hidden ref {sha7}`; several repos: `archive {size} · hidden refs in {n} repos` |
| `session.saved`, `archive: null` | `archive` | `Work saved after turn {n}` | `no archive (the upload failed) · hidden ref {sha7}` |
| `session.saved`, `hiddenRefSha: null` | `archive` | `Work saved after turn {n}` | `archive {size} · unfinished work not saved` |
| the box stopped after the idle timer | `moon` | `The box stopped after {n} idle minutes.` | |
| the box was released | `box` | `The box was released.` | the reason when known: `the PR merged`, `the task stopped`, `after 14 idle days` |
| `session.restored`, `origin: "resumed"` | `square-play` | `Resumed in the same box` | `{runner} · the session was still idle` or `{runner} · the box was started again` |
| `session.restored`, `origin: "restored"` | `history` | `Restored from the session archive` | `on {runner}, a fresh box · {n} updates replayed` |
| `session.restored`, `origin: "rebuilt"` | `layers` | `Rebuilt from the template` | the reason (`no archive was saved`, `the archive couldn't be read`, `the archive was over {cap}`, `{agent} can't load archives`) + ` · {n} messages · {m} branch logs` |
| `hiddenRef: "applied"` | | appended to the restored or resumed detail | ` · unfinished work restored` |
| `hiddenRef: "conflict"` | | the restore-conflict block, below | |
| `user.message` with `replayed: true` | `corner-down-right` | `Replayed {name}'s unanswered message from {time} as the first prompt.` | The original message stays where it was; the replay is never drawn as a second copy |
| the box was lost (the session crashed with its box gone) | `triangle-alert`, `--red` text | `The box was lost before {agent} answered.` | |
| a minor-0 runner, no origin | `info` | milestone 1's `The session was restored.` | |
| an unknown kind | `info` | milestone 1's `An event this panel doesn't know:` + mono kind | |

Numbers: sizes as `2.4 MB` (one decimal, SI), counts as plain integers, SHAs 7 characters.

### The restore conflict

A needs-you item for the driver (`restore_conflict`, spec section 11, item 7). Amber marks it because it waits on the viewer; for anyone else, the same block draws in `--muted` with a `--line-2` rule and no buttons. *Changed 2026-11-21 (the maintainer): the block sits at the end of the thread, above the composer, not in the header (`../../app-design.md`, rule 3).*

- **Title:** `git-merge` 14px + `Needs you · restore conflict`, amber, 13px 600.
- **Body,** 13px `--text`: `The unfinished work saved after turn {n} conflicts with {count} commits pushed to the branch since. Nothing was restored from it; {agent} carries on from the branch's head.` With several repos, the repo's name follows `the branch` (`… pushed to the branch in calculator-api since.`), one block per repo.
- **Chip:** the hidden ref, mono 12.5px, `--surface`, 1px `--line`, radius 6px, padding 6px 10px.
- **Buttons,** 28px, 8px apart: `Show the saved work` (outline; opens the hidden ref's commit on GitHub in a new tab) and `Carry on without it` (amber fill, `--ink` text, 600; closes the needs-you item).
- **Footnote,** 12px `--faint`: `The saved work stays until the box is released at the end of the task.`
- **Answered:** one muted 12px line in its place: `{name} carried on without the saved work.`
- **Status:** while it's open, the header and Properties read amber dot + `Needs you · restore conflict` (the words in `--text`, as every needs-you status).

### Properties

| Row | Values |
|---|---|
| Status | as milestone 1, plus `Needs you · restore conflict` |
| Box | `Running · fresh box` (a reopen onto a new box, until the turn ends), `Running`, `Idle · stops in {n} min`, `Stopped`, `Released` (`task-ticket.md`) |
| Session **new** | `{n} · resumed`, `{n} · restored from the archive`, `{n} · rebuilt from the template`, `1` for a task never reopened; `{n}` counts the task's sessions |
| Runner | `--faint` `None` once the box is released |

## Tokens and components

> **Scale.** The sizes and colours below are `graphite.css`'s. The panel is built at the approved pictures' scale, which wins on size, spacing and contrast: body 14.5px, dense rows 14px, secondary 13px, small 12px, title 26px, `--muted` `#B4B7BB`, `--faint` `#8B8E93`, buttons 30px, a 46px top bar and a 320px properties panel (380px with a form). The measured values are in `../m1/README.md`, "Scale".

Tokens: `app-concepts/html/graphite.css`; nothing new. Icons (Lucide, 14px in the thread): `archive`, `moon`, `box`, `square-play`, `history`, `layers`, `corner-down-right`, `triangle-alert`, `git-merge`, `rotate-ccw`.

| Part | Component |
|---|---|
| Composer | assistant-ui `ComposerPrimitive` as today; the button is `Button` (`default` = Shell) with the label and icon from the row above |
| Refusal line | plain `p role="alert"`, `--red` 12px, with `Button variant="link"` for `Open it` |
| Markers | the existing `Line` in `renderers.tsx`, with a message-level variant (icon in the gutter) |
| Day divider | plain markup, `Separator` for the rule |
| Restore conflict | the approval block's markup (`ApprovalNote`), `Button` `outline` and the amber variant |

## Differences from the current code

1. **Composer** (`task/task-thread.tsx`): it only sends (`tasks.send`), with one fixed hint, and disappears when `capabilities.send` is false. It gains the reopen mode (`tasks.reopen`, its own placeholder, hint and button), the per-state hints and the refusal lines.
2. **`session.restored`** (`renderers.tsx`) renders one string, `The session was restored.`; it becomes one row per origin, with its detail, and the conflict block when `hiddenRef` is `conflict`.
3. **New fold parts** in `packages/task-view`: `session.saved`, the box's idle stop and release, a replayed `user.message`, the lost box, the day dividers, the reopen tag on a user message. Today `session.saved` would fall through to `unsupported`.
4. **Message-level system rows:** today every system row uses the turn's tool grid; rows between turns move to the gutter.
5. **Properties:** add `Box` and `Session`; `Runner` reads `None` when released.
6. **Status:** the needs-you text gains the reason, `· restore conflict` (milestone 1's pattern).

## Open points for the build

Settle each with the maintainer; don't guess in code.

1. **Reopening a merged or done task in milestone 2.** The domain model gives a merged repo a fresh branch and a new PR (F-066), which is milestone 3. Until then, either refuse the reopen of a merged task with a reason, or reopen it on the same branch and say the merged PR won't update. The hint's copy waits on that answer.
2. **The task's state during a restore conflict.** Ticket 06 moves the task to needs you on `restore_conflict`, while ticket 18 says the task carries on from the branch's head. The picture shows both: the needs-you status and the agent working. If the task is in needs you, the composer and the Stop button follow that state; if it keeps running, the conflict is a needs-you item on a running task, and the status line should read `Running` with the item only in the thread and the Needs you list.
3. **`Carry on without it`** needs an API to close a needs-you item; ticket 30 doesn't list one. Without it, the block shows only `Show the saved work` and closes when the task's next turn ends.
4. **The lost box line and the reopen tag** need the events to say so (a crash reason for a lost box, and a link from the `user.message` to the `reopen`). If ticket 18 doesn't carry them, show milestone 1's crash line and no tag.
5. **Who drives after a reopen.** The pictures show the member who reopened as the driver. Ticket 30 doesn't say; F-002's handover rules come with milestone 4.

## Wrong in the image

| In the image | Build |
|---|---|
| Message-level system rows (`The box stopped…`, `Restored from…`, `Resumed…`, `Rebuilt…`, `Replayed…`) draw their icon inside a round outlined circle | the icon alone in the gutter, no circle: the circle is for authors |
| `Work saved after turn {n}` at message level | in the turn's tool grid, under that turn's rows |
| `task-reopen`: `Stop` in the top bar while the conflict waits | follows open point 2 |
| `task-reopen-stopped`: `Load earlier turns` with a chevron-up icon | milestone 1's ghost button, no icon |
| `task-reopen-stopped`: Runner `None` in near-white | `--faint` |
| `task-reopen-stopped`: Box `Released` in bright weight | regular `--text` 12.5px |
| Spend `$1.12 of $25.00` mono for the whole value | mono amount, `--muted` sans ` of $25.00` |
| The ticket strip's chips 26px tall | 22px `.chip` |
| Sidebar rows that don't exist yet | the shared sidebar's real routes |
| The hinge mark, redrawn | the real `kit/logo/export/ostra-hinge-single-color.svg`, 20px |
| `alex-desktop`, `refs/ostra/tasks/9f3c2a1b`, `214 updates`, `41 messages`, SHAs, sizes, names, times | demo data, not copy |
