# Target: the task page

> **Committed image:** `task.webp`, downscaled from the 2048×1360 generation to 1440 px wide, so one image pixel is one CSS pixel. Where this file gives sizes in image px at ×1.42, read them as CSS px directly against the WebP.

`task.webp` is the target for `apps/web/src/app/(panel)/tasks/[task-id]/page.tsx` (it renders `components/tasks/task-view.tsx` and `task/task-thread.tsx` + `task/renderers.tsx`). It is the concept `app-concepts/html/task-b-graphite` made buildable from the real data, with the fixes listed under "Differences from the current code". Build it from this file and the image; where the two disagree, this file wins.

- **Image:** `task.webp`, 2048 x 1360 px, a 1440 x 960 CSS viewport at about 1.42x. Generated with Higgsfield `gpt_image_2_6` (3:2, 2k, high), with `task-b-graphite.png`, `home-graphite.png` and the hinge logo as references. Prompt: `task.prompt.txt`.
- **State shown:** a ticket task from Linear, OpenCode working on a pool runner, a turn paused on an approval for `pnpm db:migrate`. The viewer (Alex Kim) is not the driver; Sam Rivera is.
- **Features:** F-023 live activity, F-024 steer (the composer), F-025 stop, F-026 approvals (the buttons), F-084 usage (tokens, spend, time), F-027's change list in the properties panel. The approval buttons, steering copy, spend and the change list are milestone 3 or later: see "Milestone 1 scope" for what milestone 1 renders in their place.

## Purpose

One task, live. A member sees what the agent did, what it's doing now, and whether it waits on them; answers it; steers it; stops it; and opens its PR. Everything that describes the task and doesn't change turn to turn lives in the properties panel. The thread is for what happened, in order.

## Layout (1440 x 960 CSS px)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 232px, `--side`, right hairline | The shared sidebar (`app-concepts/html/shell.js`), with `calculator › Tasks` selected. Milestone 1 renders only the routes that exist (`components/shell/sidebar.tsx`): don't add dead rows to match the image. |
| Top bar | 44px, bottom hairline, `padding: 0 18px` | Breadcrumb `calculator › Tasks › CALC-161` (last crumb `--text` weight 500). Right: copy-link icon button (ghost), `PR #483` (outline, git-pull-request icon), `Stop` (outline, square icon). No primary button in the bar. |
| Thread column | `1fr`, `padding: 28px 40px 20px` | Header, one hairline, the thread (scrolls), the composer (pinned to the bottom). |
| Properties | 300px, left hairline, `padding: 20px 18px` | Three groups: Properties, Code, Changes. |

### Header (not scrolling)

1. Key line: `CALC-161 · from Linear`, IBM Plex Mono 12px, `--faint`.
2. Title: `Add history panel`, Manrope 700 24px/1.25, letter-spacing -0.015em, margin 6px 0.
3. Status line, 13px: `Status` dot (amber here) + `Needs you · approval` in `--text` weight 500, then ` · ` in `--faint`, then the elapsed time and runner in `--muted`/mono `--faint`. **No amber text** in this line: the dot carries the colour, the words stay neutral.
4. One hairline (`--line`), 20px below. No tabs in milestone 1 (only Activity exists; tabs come back with Changes F-027 and Checks F-054).

### Thread

Messages are rows, not bubbles: a 28px round outlined icon (`--line-2` border, `--muted` icon 14px) in a 40px gutter, then the content column. 10px vertical padding per message.

- **Message header:** author 13px weight 600, then mono 12px `--faint` time; for the agent also ` · <model>` and a status word (`working` in teal, `the turn failed` in red, `stopped` faint). User messages add `queued`, `after an interrupt` or `sending…` in `--faint`.
- **Text:** 13px/1.5 `--text`, markdown via `.agent-md`.
- **Plan** (`data-plan`): label `Plan` 12px `--faint`, then 24px rows: 12px glyph + text. Completed: green check, text `--muted` (no line-through: it reads as deleted). In progress: teal `circle-dot`, text `--text`. Pending: `--faint` circle, text `--muted`.
- **Tool rows** (28px): a strict grid of `24px icon column (14px icon) | verb in a fixed 72px column | mono path | 12px | inline result`, so every path starts at the same x (about 104px into the content column, as in the image). The result sits right after the path, not at the far right edge (`ml-auto` makes the eye travel 900px on a wide screen).
  - Read: `file-text` icon, `Read`, path.
  - Edited: `pencil`, `Edited` (`Editing` while running), path, `+118` green mono 12px, `−6` red mono 12px (U+2212 minus).
  - Ran: `terminal`, `Ran` (`Running` while running), command, then `✓ exit 0` green, or `exit 1` / `killed` red.
  - Disclosure under a row (`Show the output`, `Show the diff`, `Show the setup log`, `Show the body`): 12px teal text, aligned with the paths (same indent as the path column), **no underline** (underline on hover only).
  - Output and diffs open below as `.code` blocks (`--surface`, 1px `--line`, radius 8px, mono 12px/1.6, max-height 320px, scroll).
- **Approval** (pending): no card. A 2px amber left rule, 12px left padding, indented to the content column.
  - Title: `hand` icon 14px + `Needs you · approval`, amber, 13px weight 600. This is the one amber text on the page.
  - Body: `OpenCode wants to run a command that changes the database:` (the descriptor's summary, as data).
  - The command in an inline code chip: mono 12.5px, `--surface`, 1px `--line`, radius 6px, padding 6px 10px.
  - Buttons, 28px, 8px apart: `Deny` (outline), `Approve once` (amber fill, `--ink` text, weight 600), `Approve for this task` (outline).
  - Footnote 12px `--faint`, plain text, no link: `Any member of calculator can answer. The first answer wins.`
- **Approval** (answered): one muted 12px line indented under the tool row, no rule: `Approved once by Sam Rivera` and the rest below.
- **System lines** (runner connected, compaction, pushed, driver changed, session ended): a 28px tool-style row, `info` icon, `--muted`. Crashes and problems: `triangle-alert`, `--red`.

### Composer (pinned)

One box: `--surface`, 1px `--line-2`, radius 8px, padding 12px 14px. Textarea 2 rows, placeholder `Message the agent…` in `--faint`. Bottom row: `info` 13px + the hint in 12px `--faint` (left, truncates), then `Interrupt and send` (outline, `pause` icon) and `Send` (primary: `--shell` fill, `--ink` text, `arrow-up` icon). Both disabled while the textarea is empty.

### Properties panel

Group labels (`Properties`, `Code`, `Changes`): 11px weight 500 `--faint`, not bold, 8px below. Rows: `.row2`, 84px key column, 30px min height, 12.5px; keys `--muted`, values `--text`. **No icons inside values**, so every value starts at the same x; the only markers allowed are the status dot and the driver's 18px avatar. Groups separated by `.sep` (1px `--line`, 14px margin).

| Group | Row | Value in the image | Source |
|---|---|---|---|
| Properties | Status | amber dot + `Needs you · approval` | `task.state` + `needsYou[0].reason` |
| | Driver | avatar `SR` + `Sam Rivera` + teal `Take over` | `task.driver`, `capabilities.takeOver` |
| | Agent | `OpenCode` | the session's agent profile (not in `tasks.get` yet) |
| | Model | `Claude Sonnet 5.5` | the session's model (not in `tasks.get` yet) |
| | Runner | mono `build-fleet-07`, then chips `Pool` `docker` on the next line, aligned with the values | `task.runner`, `RunnerKind` |
| | Tokens | mono `182k in · 31k out` | the fold's tokens, max with `session.*Tokens` |
| | Context | 80px meter (`--line-2` track, `--muted` fill) + mono `64k / 200k` in `--muted` | `view.context` |
| | Spend | mono `$1.82` | F-084, milestone 3: hide until it exists |
| | Time | mono `14 min` | from `createdAt` (agent time with F-084) |
| Code | Repo | mono `acme/calculator-web` | `repo.fullName` |
| | Branch | mono `calc-161-add-history…` (truncate, full name in `title`) | `repo.branchName` |
| | PR | teal `#483` + `--muted` ` · draft` | `repo.pr`; `None yet` in `--faint` when null |
| Changes | header | faint mono `+203 −6`, right-aligned in the label line | F-027 |
| | rows | mono file name left, green/red counts right | F-027: hide in milestone 1 |

## Tokens (`app-concepts/html/graphite.css`)

> **Scale.** The sizes and colours below are `graphite.css`'s. The panel is built at the approved pictures' scale, which wins on size, spacing and contrast: body 14.5px, dense rows 14px, secondary 13px, small 12px, title 26px, `--muted` `#B4B7BB`, `--faint` `#8B8E93`, buttons 30px, a 46px top bar and a 320px properties panel (380px with a form). The measured values are in `../m1/README.md`, "Scale".

```css
--bg: #0D0E10; --side: #0A0B0C; --surface: #131416; --raise: #17181B; --line: #1F2023; --line-2: #2A2C30;
--text: #EDEDEE; --muted: #9A9DA3; --faint: #64676D;
--sel: #1A1B1E; --teal: #6FB8AA; --green: #4FB286; --red: #E5675C; --amber: #FFB224; --shell: #F3F0E8; --ink: #0C1D21;
```

- Type: IBM Plex Sans 400 13px/1.5 body; 500 for nav, buttons, crumbs; 600 for authors and the approval title. Manrope 700 24px for the title only. IBM Plex Mono for keys, paths, commands, branch and runner names, token counts, times, diff counts.
- Buttons (`.btn`): 28px, padding 0 11px, radius 7px, 12.5px weight 500, 1px `--line-2`, `--surface`. Primary: `--shell`/`--ink`. Amber: `--amber`/`--ink`, weight 600. Ghost: transparent, `--muted`.
- Status dot (`.dot`): 7px, with a 3px ring of the same colour at 15%.
- Icons: Lucide 15px, stroke 1.75 (14px in thread rows, 13px in the properties panel).

## Components (shadcn/ui names)

| Part | Component |
|---|---|
| Sidebar | `Sidebar`, `SidebarMenu`, `SidebarMenuButton`, `SidebarMenuBadge` (the existing `components/shell/sidebar.tsx`) |
| Crumbs | `Breadcrumb`, `BreadcrumbList`, `BreadcrumbItem`, `BreadcrumbLink`, `BreadcrumbPage`, `BreadcrumbSeparator` |
| Top-bar actions | `Button` `variant="outline"`, `Button` `variant="ghost" size="icon"` + `Tooltip` for copy link |
| Status | the existing `Status` (dot + label); `Badge` `variant="outline"` for the `Pool` / `docker` chips |
| Thread | assistant-ui `ThreadPrimitive` in a `ScrollArea`; `Avatar` + `AvatarFallback` for the 28px author icons |
| Reasoning, output, diff | `Collapsible`, `CollapsibleTrigger` (the teal disclosure), `CollapsibleContent` |
| Approval | plain markup (amber rule) + `Button` (`outline`, and an `amber` variant) |
| Composer | assistant-ui `ComposerPrimitive` styled as `Textarea`; `Button` `outline` and `default` (Shell) |
| Properties | the existing `PropGroup` / `PropRow`, `Separator`, `Progress` for the context meter, `Avatar` 18px for the driver |

## Every state, with its copy

Copy lives in `apps/web/messages/en.json`; keys in brackets. New or changed strings are marked **new** / **changed**.

### Header status line

`<dot> <state text> · <activity> · <elapsed> on <runner>`. Drop the activity when it only repeats the state (waiting-approval, waiting-answer), and drop the runner part while there is none.

| Task state | Dot | State text |
|---|---|---|
| queued | grey | `Queued` |
| preparing | teal | `Preparing` |
| running | teal | `Running` |
| needs_you, approval | amber | **changed** `Needs you · approval` (today: `Needs you`) |
| needs_you, question | amber | **changed** `Needs you · question` |
| needs_you, other reason | amber | `Needs you`, and the reason under the line as the existing amber-ruled note (`needsYouDefault`: `The agent stopped and waits on a person.`) |
| awaiting_approval (an outside task waiting to be accepted, F-040) | amber | **changed** `Awaiting approval` (today: `Approval`, which reads like a tool approval) |
| in_review | green | `In review` |
| stopped | grey | `Stopped` (`Stopping…` while the stop is in flight) |
| merged, done | green | `Merged`, `Done` |

Activity words are `doing.*` (`Thinking`, `Writing`, `Running the setup script`, the tool's title, `The runner is offline`, …). Elapsed: **new** `Started {age} ago` + ` on ` + mono runner name. `Reconnecting…` appears at the end of the line in `--muted` (not amber: it's not waiting on the member).

### Thread rows

- Tool status words: `running`, `failed`, `cancelled`, `denied` (red), `needs approval` (amber, only while the approval block is open below it), `exit {code}`, `killed`.
- Disclosures: `Show the output` / `Hide the output`, `Show the diff` / `Hide the diff`, `Show the setup log` / `Hide the setup log`, `Show the body` / `Hide the body`.
- Plan: `Plan`. Reasoning: `Thinking` (open while streaming) / `Thought` (closed).
- Setup: `Setup script` + `done · 41s` green, or `exit 1` red with the log open.
- Git and PR: `Pushed <branch> <sha7>`, `Saved unfinished work to <ref>`, `Pull request text: <title>`, `Opened a pull request #483 <title>` (`Opened a pull request` green, the link teal).
- Session: `The session ended with changes.`, `The session ended without changes: no pull request.`
- System: `The runner connected.`, `The runner lost its connection.` (warning icon), `The session was restored.`, `The session crashed: {error}` (red), `{key} set to {value}`, `{name} asked the agent to stop.`, `{name} is driving now ({by} handed it over)`.
- Unknown: `An event this panel doesn't know: <kind>`. Load more: `Load earlier turns` (ghost button, top of the thread).

### Approval block

| State | Shows |
|---|---|
| pending, `capabilities.answerApprovals` | the full block in the image |
| pending, milestone 1 (no answering until F-026) | the rule, the title and the command chip; in place of the buttons, `--muted` 12px: `The agent asked to run this. Answering comes in milestone 3.` (`task.approval.readOnly`) |
| answered | one muted line: `Approved once by {name}`, `Approved for this task by {name}`, `Denied by {name}`, `Approved by rule {rule}` |
| closed | `The approval expired`, `The approval was cancelled` |

A question (`data-question`) uses the same block: title `Needs you · question`, the agent's message, then the answer field (F-026) or `Answering comes in milestone 3.`

### Composer

| Condition | Shows |
|---|---|
| `capabilities.send` is false (not the driver, or no session going) | no composer; **new** one `--faint` 12px line in its place: `Sam Rivera is driving. Take over to send messages.` with `Take over` as the teal action |
| agent declares mid-turn steering (OpenCode) | hint **changed**: `Send reaches OpenCode at its next step. Interrupt and send stops the turn first.` |
| agent without steering | hint: `Send queues. Interrupt and send stops the current turn.` (today's copy) |
| a turn is running and `capabilities.interrupt` | `Interrupt and send` is shown |
| empty textarea | both buttons disabled |
| send failed | red 12px line under the textarea with the error |

### Page states

- Loading: the frame with crumbs and an empty thread; no spinner in the title.
- Error: crumbs + one red line with the error (today's behaviour).
- Properties with no runner: `Not picked up yet` in `--faint`. No PR: `None yet` in `--faint`.

## Milestone 1 scope

Milestone 1 builds the layout above. These parts render only when their feature ships: the approval buttons (F-026, show the read-only line), the steering hint (F-024, keep today's hint until then), Spend (F-084), the Changes group (F-027), Agent and Model rows (until `tasks.get` returns the session's profile and model). The sidebar shows only the routes that exist.

## Differences from the current code

1. **Header.** Today: key, title, a status line with activity, a `needs-you` amber block under it, then a hairline. Target: the same, but the status line gets `<elapsed> on <runner>`, drops activity text that repeats the state, and the `needs-you` block is gone when the thing waiting is an approval or question already in the thread (keep it only for other needs-you reasons). No amber text in the line.
2. **Key line:** `from a ticket` → **changed** `from Linear` (the tracker's name; `from a prompt` stays).
3. **Tool rows** (`renderers.tsx` `Line`): the verb gets a fixed 72px column so paths align; the end slot moves inline after the subject instead of `ml-auto`.
4. **Disclosure buttons** (`ml-6 text-sm text-teal hover:underline`): indent to the path column, 12px; keep underline on hover only.
5. **Plan:** completed entries lose `line-through` (muted is enough); in-progress uses teal `circle-dot` (already) with `--text`.
6. **Approval** (`ApprovalNote`): pending block gets the summary sentence, the command chip and the footnote; buttons behind `capabilities.answerApprovals` + F-026; the `needs approval` word stays on the tool row.
7. **Message avatars:** user `user` and agent `bot` icons. Brief: no robots. Use `user` for members and the agent's own mark or a neutral `square-terminal`/`box` icon for the agent, never `bot`.
8. **Agent message header:** add the time (mono, faint) and ` · <model>`; today it shows only `Agent` + status. The author is the agent's name (`OpenCode`), not the word `Agent`.
9. **Properties:** add Agent, Model, Time (and Spend later); remove the icons in values (laptop/server, branch, PR) so values align; runner chips move to their own line aligned with values (today `pl-[104px]`, keep). Group titles 11px `--faint`.
10. **Runner chips:** `RunnerKind` shows `Not isolated` in amber. Amber means only "needs you" (`app-design.md`): use `--muted` text with a `triangle-alert` icon instead.
11. **Status words:** `taskState.awaitingApproval` `Approval` → `Awaiting approval`; needs-you states append the reason (`· approval`, `· question`).
12. **Top bar:** add the copy-link ghost icon button left of `PR #483`.
13. **Composer:** the hint becomes per-agent (steering or queueing); a non-driver sees the take-over line instead of nothing.
14. **Open point for the build:** in the image `Interrupt and send` shows while the turn waits on an approval, but `capabilities.interrupt` is false in `needs_you`. Either hide the button in that state, or let the driver interrupt a turn that waits on an approval (it closes the approval as cancelled, F-026). Settle with the maintainer; don't guess in code.

## Wrong text in the image

The image model drew these; build the version on the right.

| In the image | Build |
|---|---|
| Status line `Running 14 min on build-fleet-07` | `Started 14 min ago on build-fleet-07` (the task isn't running while it waits on you) |
| Deletion counts `-6` with a hyphen | `−6` with U+2212, as `renderers.tsx` already does |
| The agent's avatar glyph (a bot/briefcase shape) | a neutral Lucide icon (`square-terminal` or `box`), never `bot` (`brief.md`: no robots) |
| The org logo top-left, redrawn by the model | the real `kit/logo/export/ostra-hinge-single-color.svg` (`/brand/ostra-mark.svg` in the app), 20px |
| `Pool` / `docker` chips with bright text | `.chip`: `--muted` text, 1px `--line-2`, 22px tall |
| Sidebar rows Needs you, My tasks, Inbox, Automations, Memory, Repos, Runner pools, Agent profiles, Insights, Members, Audit log, Background work, Search ⌘K | concept rows from `shell.js`; milestone 1 shows only its real routes (Home, New task, projects with Tasks and Environment, New project, Runners, Models, GitHub) |
| `Claude Sonnet 5.5`, `build-fleet-07`, `$1.82`, `182k in · 31k out`, `#483`, names, counts | demo data, not copy |

Everything else in the image is spelled as specified.
