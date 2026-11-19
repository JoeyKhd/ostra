# Target: the task page with a Claude Code session (milestone 7, screen 9)

> **Committed images:** `task-subagent.webp` (the session, a subagent open and one folded) and `task-subagent-preparing.webp` (the task waiting while the runner prepares Claude Code), each downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Prompts:** `task-subagent.prompt.txt` and `task-subagent-preparing.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation each, both kept. References: the approved 2048 original of `app-targets/m1/task` (the screen this one starts from, spec section 13), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route:** unchanged, `apps/web/src/app/(panel)/tasks/[task-id]/page.tsx` → `components/tasks/task-view.tsx`, the Activity tab. This target adds the agent badge to the header, the subagent row with its nested calls to the thread, the preparing block, and two panel groups.
- **Features:** F-018 (Claude Code: subagents nested, its install on a runner), F-023 (live activity: `parentToolCallId`). Spec section 4 ("Claude Code's subagents", "Preparing an agent on a runner"), section 5.1 (tool events), section 12 item 16 (Q265). Ticket 02 (the parent in the adapter SDK), ticket 09 (preparing and choosing), ticket 15 (this screen).
- **Status:** a proposed target, waiting on approval (ticket 12's `## Comments`). Ticket 15 builds the fold and its tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

Claude Code can hand part of a turn to a **subagent** (its Task tool): one tool call that runs a second agent, whose own reads, searches and edits arrive as tool calls marked with the call that started them (`parentToolCallId`). Shown flat, ten of a subagent's reads bury the two edits that matter. The page has to show:

1. **Which agent works this task**, at a glance, now that a project can have OpenCode and Claude Code profiles side by side: the agent badge in the header.
2. **A subagent as one row** with what it was asked, how many calls it made, how long it took and whether it's done; its calls nested under it, **folded by default**, one click to open.
3. **The wait before the first turn** when the runner doesn't have Claude Code yet: what it's doing, how far along, and that the task starts by itself.

`task-subagent.webp` shows `CALC-188` on the Claude Code profile: an `Explore` subagent finished and opened (five calls and its answer), two edits, and a `general-purpose` subagent running, folded. `task-subagent-preparing.webp` shows the same task two minutes after it was started, while `build-fleet-07` builds the agent image.

## Layout (CSS px at 1440×960)

The panel's measured scale (`../m1/README.md`, "Scale"): body 14.5px, dense rows 14px, secondary 13px, small labels 12px, title 26px, buttons 30px, top bar 46px, properties 320px.

| Region | Size | Contents |
|---|---|---|
| Sidebar | 234px, the shared shell | Built from `sidebar.tsx`. The project's **Tasks** row selected |
| Top bar | 46px | Crumbs `calculator › Tasks › CALC-188`; right: copy-link (ghost) and `Stop` (outline, while a turn runs). While preparing: `Cancel` (outline, Lucide `x`), as for any queued task |
| Main column | `1fr`, padding `28px 36px 20px` | Header with the agent badge, the thread, the composer |
| Properties panel | 320px | Properties (grown), Subagents (new), Code; while preparing, Agent on this runner (new) |

### Header

1. Key line, title and status line, as `../m1/task.md` and `../m2/task-ticket.md`.
2. **The agent badge** (new), at the end of the status line, 12px after its last word: a 22px chip, 1px `--line-2`, radius 6px, `--surface`, padding `0 8px`; the agent's mark 13px `--muted` and its name 12.5px weight 500 `--text` (`Claude Code`, `OpenCode`). The mark and name come from the adapter's metadata (`AgentAdapter`'s display name and its monochrome SVG mark), never typed in the panel. It shows for every agent, OpenCode included, so the badge's presence doesn't mean "unusual". `Tooltip`: `{agent} {version} on {runner}` (`Claude Code 0.108.1 on build-fleet-07`). Not a button.
3. While **preparing**, the status line reads: Lucide `circle-dashed` 13px `--faint` + `Queued` `--text` weight 500, ` · ` `--faint`, `Preparing {agent} on` `--muted` + mono runner `--faint`, ` · ` + the elapsed time `--muted`. No amber: nothing waits on a person.

### A subagent in the thread

A subagent is a tool row in the agent's turn, in the strict tool grid of `../m1/task.md` (`24px icon | 72px verb | subject | 12px | inline result`), with a disclosure in front:

1. **The row,** 32px, with a 1px `--line` hairline above and below it while it's open (it groups what's under it; folded, no hairlines):
   - Lucide `chevron-right` (folded) / `chevron-down` (open) 14px `--faint`, in a 16px column left of the icon column; the whole row is the toggle (`button`, `aria-expanded`, `aria-controls` the nested list).
   - Icon Lucide `layers` 14px `--faint`; verb `Subagent` `--muted`.
   - The subject: the subagent's type in `--text` weight 500 (`Explore`, `general-purpose`, `Plan`: the `subagent_type` Claude Code sends, as data), ` · ` `--faint`, then its description in `--muted` (the Task tool's `description`, truncated with an ellipsis and a `title`).
   - The result, inline after the subject (not at the far right; the picture pushes it right, see "Wrong in the image"): mono 12px `--faint` `{n} calls · {duration}`, then the state: `done` with `check` `--green`; `running` with a spinning `loader-circle` `--teal` (no duration while it runs); `failed` `--red` with `x`; `stopped` `--faint`.
2. **The nested calls** (open), under the row, indented 24px from the row's icon column, with a 1px `--line-2` vertical guide on their left, from under the row's icon to the last nested line:
   - Each call is a normal tool row (`Read`, `Searched`, `Edited`, `Ran`, …) with milestone 1's grid and colours, one step quieter: verbs `--faint`, subjects `--muted` mono, results `--faint`. Edits keep `+n` `--green` and `−n` `--red`.
   - A call that needs approval inside a subagent opens the subagent and shows milestone 1's approval block under that call, at the nested indent, and the subagent row's state reads `needs approval` (amber, the tool-row word, only while the block is open).
   - More than 12 nested calls: the first 10, then `{n} more calls` 12px `--teal` that shows the rest.
   - **The answer:** under the last nested call, 12px `--faint`: `Returned: {first line of the subagent's final text}`, then `Show the full answer` 12px `--teal`, which opens it as a `.agent-md` block at the nested indent.
3. **Folded by default**, open while it runs only if the viewer opened it; the open/closed state is per viewer and kept in `sessionStorage` per task (a convenience, not data). Keyboard: `Enter` / `Space` on the row toggles it; `→` opens, `←` closes.
4. **Nested subagents** (a subagent that starts one): the same row at the nested indent, its calls one more 24px step in. At most two levels drawn; deeper ones fold into `{n} calls in a nested subagent` with `Show`.
5. **Order:** nested calls in arrival order; the subagent row stays where its Task call started, so the agent's own calls after it continue below the block.
6. **An orphan** (a child whose parent call never arrived, ticket 15): shown at the top level as a normal row with a 12px `--faint` note `from a subagent`, so nothing is lost.
7. **An agent that sends no parent** (OpenCode today): flat rows, exactly as milestone 1. No subagent row is ever invented.

### Preparing the agent (`task-subagent-preparing.webp`)

When the runner the task was given lacks the agent (spec section 4: admission offers the task to a runner that has it first), the thread shows the member's message and then one **system block**:

- Gutter: the 28px outlined circle with Lucide `server` 14px `--muted`.
- Header: `Preparing {agent} on this runner` 13px weight 600 `--text` + mono 12px `--faint` time.
- Steps, in the tool grid, 28px each, as the runner reports them (`agent.preparing` progress):

| Executor | Steps (verb · subject) |
|---|---|
| `host` | `Downloading` / `Downloaded` · mono `{package} {version}`; `Checking` / `Checked` · `SHA-256 matched the pinned checksum` |
| `docker` | the two above, then `Building` / `Built` · mono `the agent image from {base image}@sha256:{12}` + mono `--faint` elapsed |
| `kubernetes` | the two above, then `Building` / `Built` · `the agent image in a BuildKit pod`, then `Pushing` / `Pushed` · mono `{registry}/{repo}@sha256:{12}` |

  Done steps `check` `--green`, the current one a spinning `loader-circle` `--teal` with its verb in `--text`, later ones a `--faint` ring and `--faint` words. Verbs `--muted` when done.
- Footnote 12px `--faint`: `The task starts as soon as {agent} is ready. It's downloaded from npm under Anthropic's terms.` (the second sentence only for Claude Code: the license note `runner-agents` also shows) + teal `Open {runner}` to the runner's page (`../m5/runner.md`, its agents section).
- When it's ready, the block folds to one `--muted` system line, `Claude Code 0.108.1 is ready on build-fleet-07 · 2 min 31 s`, and the turn starts under it.

### Properties panel

Milestone 1's groups, plus:

- **Properties** gains `Profile` (the agent profile's name, `../m3/agent-profiles.md`) after `Agent`. `Agent` shows the agent's name, plain text.
- **Subagents** (new, between Properties and Code, only once the session started one): `Started` mono `{n}`, `Calls` mono `{n}` (the subagents' calls), `Running` mono `{n}` (hidden at 0).
- **Agent on this runner** (new, only while preparing or after a failure): `{agent}` · `Preparing` / `Failed` (`--red`); `Version` mono; `Image` `Building` / `Built` (docker and kubernetes only). Gone once the task starts.
- **Code** while preparing: `Branch` reads `Made when the task starts` in `--faint`, sans.

## States

| State | What shows |
|---|---|
| **A Claude Code session, one subagent open, one running** (`task-subagent.webp`) | As above |
| **Preparing Claude Code** (`task-subagent-preparing.webp`) | The preparing block; the status `Queued · Preparing Claude Code on build-fleet-07`; `Cancel` in the top bar; the composer hint `The task hasn't started. A message waits for its first turn.` |
| Preparing failed | The current step `x` `--red` with the reason in 12px `--red` under it (`The binary's SHA-256 didn't match the pinned checksum.`, `npm couldn't reach the registry: {error}`); the footnote becomes `The task stays queued. ostra offers it to another runner that has Claude Code, or tries again here.` + `Try again` (outline, 30px) for an admin of the runner's pool (ticket 09). The status line: `Queued · Claude Code couldn't be prepared on {runner}` |
| Another runner has it | No block: admission gave the task to that runner, and the session starts as any |
| A subagent running, folded | The row with `running` and the live call count; no nested rows |
| A subagent failed | `failed` `--red` on the row; open, its last call shows its error as any failed call |
| The turn stopped mid-subagent | The row reads `stopped` `--faint`; its calls so far stay |
| Replay and reconnect | The fold is rebuilt from the events (`packages/task-view`), so a reload or a reconnect shows the same nesting (ticket 15's test) |
| An OpenCode task | The badge reads `OpenCode`; no subagent rows; nothing else changes |
| Light theme | `light-task.md`'s rules; the guide line `--line-2` |
| Narrow / phone | The badge moves under the title on its own line; nested rows keep a 16px indent (not 24px) and the guide line; descriptions truncate first |

## Components (shadcn/ui names)

- **From the repo:** `PageFrame`, `PropGroup`, `PropRow`, `Button`, `Tooltip`, `Collapsible` (Radix, already a dependency through `radix-ui`), milestone 1's thread renderers (`task/renderers.tsx`).
- **New:** `components/tasks/agent-badge.tsx`, `task/subagent-call.tsx` (the row and its nested list), `task/preparing-agent.tsx` (the system block; its steps an exhaustive `switch` on the step kind, `satisfies never`).
- **Icons** (Lucide 15px, stroke 1.75; 14px in rows): `layers`, `chevron-right`, `chevron-down`, `check`, `x`, `loader-circle`, `circle-dashed`, `server`, `search`, `file-text`, `pencil`, `terminal`, `info`.

## Tokens

The measured tokens (`apps/web/src/app/globals.css`), as `../m6/task-rounds.md`. Nothing on this page is amber except the sidebar's count, and a nested approval's block and its row's `needs approval` word. `--teal` for running spinners and links; `--green` for done and additions; `--red` for failures and deletions.

## Data this screen needs beyond ticket 28

- **`parentToolCallId`** on `tool.started` and `tool.updated` (spec section 5.1, ticket 01), folded by `packages/task-view` into a `subagent` part: its tool call ID, `subagentType`, `description`, state, started and ended times, its children (each a normal tool part), and its final text.
- **The agent's display name, version and mark** on `tasks.get` (from the adapter's metadata and the runner's reported agents), and the **profile's name**.
- **The preparing progress:** `agent.preparing` with a step kind (`download`, `checksum`, `build`, `push`) and state, `agent.ready` with the version and image digest, `agent.failed` with a reason (spec section 4, ticket 09), joined to the task by its runner and agent.

## Differences from the current code

1. **No nesting.** `packages/task-view`'s fold puts every tool event at the top level; it gains the parent and the `subagent` part (ticket 15), with the orphan rule.
2. **No agent badge.** `task-view.tsx`'s header has no agent; the Properties group shows `Agent` only.
3. **No preparing state.** A queued task shows milestone 1's `Waiting for a box on {runner}`; the preparing block, its events and the `Cancel` wording are new.
4. **Thread renderers:** the `switch` over parts in `renderers.tsx` gains `subagent` and `agent-preparing`, and stays exhaustive.
5. **Messages:** new keys under `task.subagent.*`, `task.agentBadge.*` and `task.preparing.*`.

## WCAG AA check (F-081)

Dark: nested verbs and results `--faint` `#8B8E93` on `#0D0E10` 5.9:1; nested subjects `--muted` 9.6:1; the badge's name `--text` on `--surface` 16.6:1; the guide line `--line-2` is decoration, never the only cue (the indent says it too). The row's toggle has a visible `--teal` focus outline. Light: `light-task.md`'s values.

## Open points (recommendations; ticket 15 records the answer)

1. **Folded by default, even while running.** Recommended, as drawn: the count and `running` say enough; a running subagent's calls stream inside the fold and show the moment it's opened.
2. **Cost per subagent.** Not shown. ostra meters calls at the key proxy per task, not per subagent; the row shows calls and time only.
3. **The badge for every agent.** Recommended: yes, OpenCode included, so the header reads the same whichever agent works the task.

## Wrong in the image (build from this file)

- **The subagent row's result** (`6 calls · 41 s ✓ done`) sits at the far right edge. Build it inline after the description, as milestone 1's tool rows (`../m1/task.md`, "Tool rows").
- **The nested rows' results** (`14 matches`, `3 matches`) are pushed right. Build them inline after the subject.
- **The folded subagent row** has hairlines above and below. Folded rows have none; only an open one does.
- **The nested verbs and paths** are as bright as the top-level ones. Build them one step quieter (`--faint` verbs, `--muted` subjects).
- **The agent badge** uses an asterisk glyph. Build the adapter's own mark at 13px, `--muted`.
- **`billing-platform` and `web-storefront`** have orange squares close to amber. Project squares are the projects' own colours; the sidebar is built from `sidebar.tsx` anyway.
- **Preparing:** the status line ends with a stray ` · ` before the badge. Build without it. `Preparing` and `building` in the panel and `made when the task starts` are drawn in mono; they're sans (`Made when the task starts`, `--faint`). The sidebar's `calculator` has an amber dot though nothing in it waits on the viewer here: build it from the data.
- **Preparing:** the steps' verbs are all `--muted`; build the current one (`Building`) in `--text`.

Right as drawn: the badge chip after the status line, the `Subagent` row with its chevron, `layers` icon, type in white and description in grey, the nested calls on a guide line with the answer and `Show the full answer` under them, the second subagent folded with a teal spinner and `running`, the Subagents group in the panel, and the preparing block with its two green checks, a spinner on `Building`, the footnote with the license sentence and `Open build-fleet-07`.
