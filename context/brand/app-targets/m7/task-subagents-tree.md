# Target: an agent's subagents, as a badge and a tree (proposed 2026-11-20)

> **Committed images:** `task-subagents-badge.webp` (the task page, the badge on the agent's turn) and `task-subagents-tree.webp` (the window the badge opens), each downscaled from its 2048×1360 generation (`task-subagents-badge.png`, `task-subagents-tree.png`) to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

| Picture | State shown |
|---|---|
| `task-subagents-badge.webp` | `CALC-188` on OpenCode. The agent's turn started three subagents, and one of them started a fourth; the turn's header carries the badge `4 subagents · 1 running`; the thread shows the agent's own three `Subagent` calls as one-line rows, and none of the subagents' own calls. |
| `task-subagents-tree.webp` | The badge was clicked. The **Subagents** window shows the tree: OpenCode, the main agent, at the root; two `explore` subagents done; a `general` subagent running, selected; and under it an `explore` it started, done. The selected subagent's prompt, calls and answer are on the right. |

- **Prompts:** `task-subagents-badge.prompt.txt` and `task-subagents-tree.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation each, both kept (5.5 credits). References: the approved 2048 original of `../m1/task`, `../m3/task-approval` and the Hinge logo for the badge; the badge picture, `shortcut-sheet` (the panel's dialog) and the maintainer's screenshot of Claude Code's agent tree (its shape only) for the window.
- **The maintainer's ask (2026-11-20):** "just a badge in the conversation that shows the amount of agents and then you can click on it and see a modal and see the parent of each subagent", with Claude Code's agent tree as the reference: nodes with a status dot, a name, a duration and a token count, and lines from each parent to its children.
- **Route:** unchanged, `apps/web/src/app/(panel)/tasks/[task-id]/page.tsx` → `components/tasks/task-view.tsx`, the Activity tab. The window is a `Dialog` over the task page, with no route of its own.
- **Features:** F-023 (live activity), and a new row for subagents (proposed in the lead's report, not in `features.md` until this target is approved). F-026 (a subagent's approvals), F-084 and F-089 (its tokens, counted at the key proxy). The data: `context/research/opencode-subagents.md`.
- **Status: a proposed target, waiting for the maintainer's approval.** Nothing builds it until then. It replaces the postponed inline design of `task-subagent.md` (rows nested in the thread) for every agent: that file stays for its preparing block, which waits with F-018.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with each picture.

## Purpose

OpenCode hands work to **subagents** (its `subagent` tool, types `explore` and `general`), and runs them in the background, in the same box, on the task's model and key. Today ostra flattens a subagent's calls into the thread and shows its answer as if the main agent had written it (research, section 9). The page has to show, without burying the agent's own work:

1. **That the turn has subagents, how many, and whether any still runs:** the badge on the turn.
2. **Who started whom:** the tree, with the main agent at the root and each subagent under the agent that started it.
3. **What each one was asked, did, answered, took and cost:** its node and the pane beside the tree.

## 1. The badge (`task-subagents-badge.webp`)

**Where:** at the end of the agent turn's header line (`OpenCode 14:02 · Claude Sonnet 5.5 · working`), 12px after its last word. One badge per turn, for the subagents that turn started, nested ones included. A turn with no subagent has none.

**What it is:** a `button`, 24px tall, radius 6px, `--surface` fill, 1px `--line-2`, padding `0 9px`, gap 6px:
- Lucide `layers` 13px `--muted`;
- `{n} subagents` (`1 subagent`) 12.5px weight 500 `--text`;
- then the one state that matters most, after ` · ` `--faint`, in this order: `{n} need approval` / `1 needs approval` with an amber 7px dot, `--amber-text`; `{n} failed` with Lucide `x` 12px, `--red`; `{n} running` with Lucide `loader-circle` 11px spinning, `--teal`. When all are done, nothing follows the count.
- Hover: border `--line-3`, fill `--hover`. Focus: the panel's 2px `--text` outline. `aria-haspopup="dialog"`; its name reads the whole badge (`4 subagents, 1 running`).

**The thread:** the main agent's own `subagent` calls stay one-line tool rows in milestone 1's grid (`24px icon | 72px verb | subject | 12px | inline result`): Lucide `layers`, verb `Subagent`, subject the type in Plex Mono 14px `--text` (`explore`, `general`: the agent's own names, as data) + ` · ` + the description in `--muted` (OpenCode's 3-to-5-word label), then inline mono 12px `--faint` `{n} calls · {duration}` and the state (`check` `--green`; `loader-circle` + `running` `--teal`; `x` + `failed` `--red`; `stopped` `--faint`). A row is a button that opens the window with that subagent selected. **Nothing is nested under it:** the subagents' own calls, thoughts and answers live in the window, never in the thread.

## 2. The window (`task-subagents-tree.webp`)

`Dialog` (`radix-ui`, as `shortcut-sheet.tsx`): `w-[min(1140px,calc(100vw-32px))]`, centred on both axes, its height its content's, at most `min(80vh, 720px)`; `--raise` fill, 1px `--line-2`, radius 12px, `--shadow-palette`, over the `--scrim` overlay.

1. **Header,** 52px, padding `0 20px`, a 1px `--line` under it: `Subagents` 15px weight 600 `--text` (`Dialog.Title`); 12px after it, 13px `--faint` `{n} in {agent}'s turn at {hh:mm}` and, after ` · `, the badge's state words in their colours (`1 running`); at the right the shortcut sheet's ghost close: `Kbd` `esc` + `Close` 12px `--faint`.
2. **Body,** two panes, a 1px `--line` between them.
   - **The tree pane,** 740px, padding `28px 24px`, scrolls both ways when the tree outgrows it. Cards in columns, read left to right: the root in column 1, its subagents in column 2, theirs in column 3; 36px between columns, 24px between cards in a column; a parent is level with the middle of its children.
   - **The detail pane,** 400px, padding 20px, scrolls on its own.
3. **Footer,** 44px, padding `0 20px`, a 1px `--line` above it: Lucide `info` 13px `--faint` + 12.5px `--faint` `Subagents run in the task's box, on its model and key. Their tokens are in the task's spend.`; at the right mono 12px `--faint` `{tokens} tokens · {spend} in subagents` (the turn's subagents together; `≈` before an estimate, as F-084).

### A node

A card 220×76, `--surface` fill, 1px `--line-2`, radius 8px, padding `10px 12px`, three lines:
1. The state mark (7px dot, or the 9px spinner), then the description 13.5px weight 500 `--text`, truncated with an ellipsis and a `title`.
2. Mono 12px `--faint`: `{type} · {duration} · {n} calls`.
3. Mono 12px `--faint`: `{tokens} tokens · {spend}`.

| State | Mark | Line 2 ends with |
|---|---|---|
| Running | `loader-circle` 9px, spinning, `--teal` (still with reduced motion: a ring) | the time so far, live |
| Done | dot `--green` | |
| Needs approval (one of its calls waits) | dot `--amber` | ` · needs approval` `--amber-text` |
| Failed | dot `--red` | ` · failed` `--red` |
| Stopped (interrupted, or the box ended) | ring `--faint` | ` · stopped` |

**The root** is the main agent: `{agent}` weight 500 + ` main agent` `--faint`; line 2 its model; line 3 `{turn time} · {n} calls` (its own calls). Its mark is the turn's state. It has no tokens line: the task's figures are in the properties panel.

**Selected:** `--sel` fill, 1px `--faint` border. Hover: `--hover` fill. **Connectors:** 1px `--line-3`, square elbows, no arrows: from the parent's right edge a 18px stub to a vertical trunk spanning its children's middles, and an 18px branch into each child's left edge.

**Opening:** the window opens with the subagent selected that the person clicked (a `Subagent` row), else the first one that needs approval, else the first running, else the first.

### The detail pane

For the selected subagent, top to bottom:
1. A chip, the type: mono 11.5px `--text`, 20px tall, 1px `--line-2`, radius 4px; 8px after it the state mark and word (`running` `--teal`).
2. The description, 16px weight 600 `--text`, wrapping.
3. Mono 12px `--faint`, two lines: `started {hh:mm:ss} · {duration} · {n} calls` and `{tokens} tokens · {spend}`.
4. Label `Asked by {parent}` (12px weight 500 `--faint`; the parent is the main agent's name or the subagent's description), then the prompt, 13.5px `--muted`, paths and commands in mono, as `.agent-md` without raw HTML. More than 6 lines: the first 6 and `Show all` 12px `--teal`.
5. Label `Calls`, then its calls as milestone 1's tool rows, one step quieter (verbs `--faint`, subjects mono `--text`, results `--faint`), 28px each, in arrival order. A `Subagent` call is a button that selects that node. An edit keeps `+n` `--green`, `−n` `--red`; a command keeps `Show the output`. More than 40 calls: the last 40 and `Show {n} earlier calls`.
6. Label `Answer`, then its final message as `.agent-md`. Running: 13px `--faint` `Still working. Its answer shows here when it's done.` Failed: the error in 13px `--red`, then `It stopped before it answered.` `--faint`. Stopped: `It was stopped before it answered.` A subagent sent a follow-up shows each round: `Round 2 · asked at {hh:mm}`, its prompt, its calls and its answer.

For the root, the pane shows the turn: the member's message under `Asked by {member}`, the agent's own calls, and no answer section (the thread is its answer).

## Every state

| State | What shows |
|---|---|
| **A running subagent** (both pictures) | As above |
| **All done** | The badge: `4 subagents` alone. The window opens on the first subagent |
| **A subagent fails** | The badge: `· 1 failed` `--red`; its node red; the detail's error |
| **A subagent's call waits for approval** | The approval is **never only in the window**: the thread shows milestone 3's approval block (`../m3/task-approval.md`) in the turn, its first line naming the subagent: `explore · Find the version source asks before running this command:`. The badge reads `· 1 needs approval` amber; the node amber; in the detail, the call reads `needs approval` (amber) with the same block under it at the nested indent. One answer, from either place, closes both |
| **Stopped mid-subagent** (Stop, a crash, or the session ended while it ran) | `stopped` on the row, the node and the badge's state; its calls so far stay |
| **A subagent outlives its turn** (OpenCode tells the agent to end its turn; research, section 2) | The badge stays on the turn that started it and keeps `running` until its `completed`, even after the turn ended; the main agent's wake-up turns are new turns in the thread |
| **Empty** | No subagents in the turn: no badge, no window. An agent that doesn't report subagents (its adapter declares no `subagents` capability): no badge, and its calls show flat, as today |
| **Many subagents** (12 in one turn) | Column 2 holds all twelve; the tree pane scrolls; the badge reads `12 subagents`. The window keeps its size |
| **Deep nesting, folded** | At most three columns. A node in column 3 with children of its own ends in a chip (24px, radius 6px, 1px `--line-2`, mono 12px `--faint`, `+{n} below`). Clicking it, or selecting a deeper node from a `Subagent` call, re-roots the tree at that node's parent, and a breadcrumb over the tree reads `OpenCode › Write version row test › …` (13px; each part a button that re-roots there) |
| **No tokens per subagent** (until the key proxy can tell a subagent's calls apart; research, section 4) | Line 3 of every card and the footer's figure are left out; nothing is invented. The properties panel's task totals already hold the subagents' spend (proved, F-089, F-084) |
| **Replay, reload, reconnect** | The tree is folded from the task's events (`packages/task-view`), so a reload shows the same tree, and a second tab the same badge |
| **Light theme** | `light-task.md`'s tokens; connectors `--line-3` `#9A9DA3` |

## Keyboard

- **The badge** and each `Subagent` row: Enter or Space opens the window. When it closes, focus returns to what opened it.
- **The window:** Radix `Dialog` traps focus; Escape closes it; first focus on the selected node.
- **The tree:** `role="tree"`, each card a `treeitem` with `aria-level`, `aria-selected`, and `aria-expanded="true"` when it has children. ↓ and ↑ move through the nodes depth first; → goes to the first child, ← to the parent; Home and End to the first and last node. Selection follows focus, and the detail pane updates. Each card's name reads it whole: `explore subagent, Find the version source, done, 1 minute 12 seconds, 14 calls, 96.4 thousand tokens, 31 cents`.
- **Tab** goes from the tree to the detail pane's controls (`Show all`, a `Subagent` call, `Show the output`), then to Close.

## Narrow and phone width

- **Below 1180px** the window is `100vw - 32px` wide: the detail pane keeps 360px and the tree pane shrinks and scrolls.
- **Below 900px** (and on a phone, 390px) the window is the panel's bottom `Sheet`, full height. It shows the tree as an indented list: one 56px row per node (mark, description, then mono `{type} · {duration}` under it), 16px per level, a 1px `--line-2` guide on the left of each level. Tapping a row pushes its detail inside the sheet, with `‹ Subagents` at the top to go back. The badge stays on the turn header, and wraps under it when the line is full.

## Components (shadcn/ui names)

- **From the repo:** `Dialog` (`radix-ui`, as `shortcut-sheet.tsx`), `Sheet` (phone), `Kbd`, `Button` (ghost), milestone 1's tool-row renderers (`task/renderers.tsx`), milestone 3's approval block.
- **New:** `components/tasks/subagents-badge.tsx`, `components/tasks/subagents-window.tsx` (header, panes, footer), `components/tasks/subagent-tree.tsx` (the columns and connectors, drawn with CSS borders, no canvas), `components/tasks/subagent-detail.tsx`. The node state is a union with an exhaustive `switch` (`satisfies never`).
- **Icons** (Lucide, stroke 1.75): `layers`, `loader-circle`, `check`, `x`, `info`, `file-text`, `search`, `pencil`, `terminal`.

## Tokens

The measured tokens of `apps/web/src/app/globals.css`. `--raise` window, `--surface` cards and chips, `--sel` the selected card, `--line` hairlines, `--line-2` borders, `--line-3` connectors, `--text`, `--muted`, `--faint`; `--teal` running and links, `--green` done and additions, `--red` failures and deletions. **Amber only for a subagent's call that waits on a person**, as everywhere else.

## WCAG AA (F-081), dark

| Pair | Ratio | Need |
|---|---|---|
| `--text` #F2F3F4 on `--surface` #131416 (descriptions) | 16.6:1 | 4.5 |
| `--faint` #8B8E93 on `--surface` (card lines 2 and 3) | 5.6:1 | 4.5 |
| `--faint` on `--raise` #17181B (labels, footer) | 5.4:1 | 4.5 |
| `--faint` on `--sel` #1A1B1E (the selected card's lines) | 5.2:1 | 4.5 |
| `--red` #E5675C on `--surface` (`failed`) | 5.6:1 | 4.5 |
| `--teal` #6FB8AA on `--surface` (`running`) | 8.0:1 | 4.5 |
| `--line-3` #34363A on `--raise` (connectors) | decoration: the columns and `aria-level` carry the structure | — |

## Data this screen needs (research, section 4)

1. **The driver** advertises `_meta["opencode/child-session-updates"]: true` and reads the notification `opencode/session/child_update`: every update of a subagent, its `created`, `running`, `completed`, `failed` (with its error) and `interrupted`, its depth and its parent, also after the turn ends. Without it, OpenCode stops sending a subagent's updates when the turn that started it ends.
2. **The protocol, a new minor:** `subagent.started {toolCallId, subagentId, parentSubagentId?, depth, type, description, prompt}`, `subagent.status {subagentId, status, error?}` (each with its time from the event's `at`), and `subagentId` on `tool.called`, `agent.message`, `agent.thought` and `plan.updated` (the postponed minor 6's `parentToolCallId`, `../../../specs/m7-launch/issues/01-protocol-minor-6.md`, said the same for Claude Code). An older peer gets them dropped, and the flat calls it gets today. Each adapter declares a `subagents` capability (ADR 0025); OpenCode's is true.
3. **The adapter** maps OpenCode's child updates to those events: the `subagent` call's `rawInput` gives the type, description and prompt, its `rawOutput.metadata.sessionID` the subagent's ID; a child's answer becomes its own `agent.message`, never the main agent's.
4. **The fold** (`packages/task-view`) builds the tree per turn: nodes, states, times, call counts, rounds; a child whose start never arrived stays under the root with a note, so nothing is lost.
5. **Tokens per subagent:** an ADR first. Nothing in ACP gives them; the runner could attribute each model call at the key proxy by the subagent's opening message (research, section 4.4). Until then, no tokens line.
6. **The approval's subagent:** the driver keeps `toolCall._meta["opencode/child-session"]` on a permission request, so the approval names the subagent.
7. **The turn's end:** a decision on a subagent that outlives its turn (research, section 2): on a one-shot task the runner ends the agent at once and kills it today.

## Differences from the current code

1. **Flat:** `packages/task-view` puts a subagent's calls at the top of the turn, and its answer is an `agent.message` of the main agent. Both move into the window.
2. **No badge, no window, no tree.**
3. **The driver** ignores `opencode/session/child_update` and doesn't ask for it.
4. **Messages:** new keys under `task.subagents.*`.

## Open points (recommendations; the maintainer's approval settles them)

1. **The `Subagent` rows in the thread.** Keep them as one-line rows of the agent's own calls (recommended, as drawn: they show where in the turn each one started, and open the window at that node), or the badge alone.
2. **Count nested subagents in the badge.** Recommended: yes (`4 subagents` for three and one nested), as drawn.
3. **Nesting under OpenCode.** OpenCode stops at one level unless `experimental.subagent_depth` is raised (research, item 7). The picture shows two levels, which ostra's config doesn't allow today. Recommended: leave OpenCode's default; the tree handles any depth for the agents that nest.
4. **Tokens and cost per subagent** (the maintainer's reference shows tokens per node). Recommended: attribute at the key proxy, in an ADR; until then, no figure rather than a guess.
5. **A subagent outliving its turn.** Recommended: a one-shot task waits for its open subagents (with the turn limit) before it ends the agent, and a turn reads `working` while any runs.

## Wrong in the image (build from this file)

`task-subagents-badge.webp`:
- **The `Subagent` rows' results** (`14 calls · 1m 12s`) sit in a column of their own, aligned across rows. Build them inline after the subject, as milestone 1's tool rows.
- **The spinners** are closed rings. Build Lucide `loader-circle`, spinning (a ring only with reduced motion).
- **`billing-platform`'s square** is purple and **`web-storefront`'s** orange, close to amber. Project squares are the projects' own colours; build the sidebar from `sidebar.tsx`.

`task-subagents-tree.webp`:
- **The title** `Subagents` is drawn at about 21px bold and the subtitle at 15px `--muted`. Build 15px weight 600, and 13px `--faint`.
- **Card lines 2 and 3** are drawn in `--muted`. Build `--faint`.
- **The labels** `Asked by OpenCode`, `Calls` and `Answer` are drawn at about 14px weight 600. Build 12px weight 500 `--faint`.
- **The scrim** is lighter than the panel's; build `--scrim`.
- **The composer underneath** reads `Messaget the agent…`; it's `Message the agent…`.
- **The tokens line** is drawn although nothing gives per-subagent tokens yet (open point 4). Build it only once the figure exists.

Right as drawn: the badge's place, size and words; the window's size and frame; the three columns, the root level with its middle child, the square-elbow connectors; the selected card's fill and border; the detail pane's order (chip and state, title, figures, prompt, calls, answer); the footer.
