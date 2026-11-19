# Target: Take it local (the task page's popover)

> **Committed image:** `take-it-local.webp`, downscaled from a 2048×1360 picture to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Image:** Higgsfield `gpt_image_2_6` (3:2, 2k, high), 2 generations: a first one, then an edit of it that fixed the organization switcher, a misspelt branch, the popover title's size and two sidebar icons. References: the approved milestone 2 original `task-ticket.png` (the task page this popover sits on, itself built on `../m1/task`), `app-concepts/html/home-graphite.png` and the Hinge logo (`kit/logo/export/ostra-hinge-single-color-2048.png`). Prompt: `take-it-local.prompt.txt` (the edit, then the first generation's full prompt).
- **Status:** a candidate target for milestone 3, not yet approved by the maintainer (ticket 41).
- **Starts from:** `../m1/task` and `../m2/task-ticket`, which still hold for everything this file doesn't change: the sidebar, the header, the thread, the composer and the properties panel.
- **State shown:** ticket task `OST-142` from Linear, in review, idle on a warm box, one branch pushed to two repos (`acme/calculator-web`, `acme/calculator-api`), each with its PR. The viewer, Alex Kim, has opened "Take it local" and has no CLI session yet, so the `ostra login` hint shows.
- **Features:** F-028 (take it local), F-103 (`ostra login`, `ostra checkout`). Data: `tasks.local(taskId)` (ticket 39). Builder: ticket 47. ADR 0051, "Taking a task local".

## Purpose

A member wants the task's work on their own machine: to run it, read it in their editor, or finish it by hand. The popover gives them one line to paste, `ostra checkout OST-142`, and, for anyone who'd rather not install the CLI, the plain git commands per repo. It says plainly that git uses the member's own access (ostra hands out no token), and that a reopen starts from the branches as they are, so hand-made commits aren't lost. It's a reference card, not a form: nothing in it changes the task.

## Layout (CSS px at 1440×960)

The page is `task-ticket`'s, unchanged. Two things are new.

### The top bar's button

- **`Take it local`:** `Button variant="outline"` (28px, radius 7px, 12.5px weight 500, 1px `--line-2`), a 15px `square-terminal` icon, the words. It sits **after the copy-link ghost button and before the `PR #<n>` buttons**, so the order is copy link · Take it local · PR buttons · Stop (when Stop shows).
- **Pressed** while the popover is open: `--sel` fill, the same border, `aria-expanded="true"`.
- It shows on every task that has at least one pushed branch, in any state (running, idle, in review, needs you, stopped, merged). See "States" for a task with nothing pushed.

### The popover

`Popover` + `PopoverContent`, `align="end"`, `sideOffset={6}`, so its right edge lines up with the button group's right edge (18px from the window). **480px wide**, `--surface` fill, 1px `--line-2` border, radius 10px, padding 16px, the shadcn popover's soft shadow and nothing more. It overlays the thread and the properties panel; the page behind isn't dimmed.

Top to bottom:

1. **Title** `Take it local`: 13px, weight 600, `--text`.
2. **Lede**, 4px under it, 12.5px/1.5 `--muted`, wrapping: `Check out this task's branches on your machine. Git fetches them with your own access; ostra hands out no token.`
3. **Group label** `With the ostra CLI`, 14px under the lede: 11px weight 500 `--faint` (the properties panel's group label style).
4. **The command field**, 6px under the label: a read-only code line, 32px tall, `--bg` fill, 1px `--line-2`, radius 7px, padding `0 6px 0 12px`. Mono 12.5px `--text`: `ostra checkout {ref}`. On its right, the **copy button**: ghost icon button, 24px, `copy` 14px `--muted`, `aria-label="Copy"`. The whole line is selectable text too.
5. **The `ostra login` hint**, only while the member has no CLI session (`tasks.local` says so), 8px under the field: a 13px `info` icon in `--faint`, then 12px `--muted`: `First time on this machine? Run ostra login, then approve its code in the browser.` with `ostra login` in mono `--text`. Under it, 6px, a second command field like item 4 holding `ostra login --server {publicUrl}` with its own copy button: a fresh CLI doesn't know the server, and the install's public address is the one value the member can't guess. With a CLI session, items 5's line and field don't render.
6. **A hairline** (`--line`), 14px above and below.
7. **Group label** `With git, in each repo` (one repo: `With git`).
8. **Per repo**, in the task's repo order, 12px apart:
   - the repo's full name, mono 12px `--muted` (`acme/calculator-web`)
   - 6px under it, a code block: `--bg` fill, 1px `--line-2`, radius 7px, padding `8px 40px 8px 12px`, mono 12px/1.7 `--text`, two lines, no wrapping (it scrolls sideways if a branch is longer than the block):
     - `git fetch origin {branch}`
     - `git switch {branch}`
   - the copy button at the block's top-right (6px in), copying both lines joined by a newline.
   - The branch is the same in every repo (`domain-model.md`, Task repo), but each repo gets its own block, since the member runs them in each clone.
9. **Footnote**, 12px under the last block, 12px `--faint`: `Reopening the task starts from the branches as they are, your commits included.`

## States

| State | What shows |
|---|---|
| Closed | The outline button only |
| Open, the member has a CLI session | Items 1 to 4, then 6 to 9. No login hint |
| **Open, no CLI session** (`take-it-local.webp`) | As above, plus item 5 |
| Loading (`tasks.local` in flight, the first open only) | The title and lede at once; the fields and blocks as `Skeleton` bars of their height. The copy buttons are disabled |
| Error | Under the lede, `role="alert"`, 12.5px `--red` with a 13px `circle-alert`: `errorText(error)`. Nothing else |
| Copied | The copy button's icon turns to `check` in `--green` for 1.5s, with a `Tooltip` `Copied`, and a polite live region says `Copied`. The text is written with `navigator.clipboard.writeText`; when that's refused (an insecure origin), the tooltip says `Select the text and copy it` and the line's text is selected |
| A prompt task (no ticket) | `ostra checkout {id}`, with the task's ID as `tasks.local` returns it (the CLI takes a key, an ID or a URL) |
| One repo | The git label reads `With git`, and one block shows |
| A repo whose PR merged and whose task reopened on a fresh branch (F-066) | The block shows the current branch (`…-2`) |
| A repo whose PR merged, task not reopened | The block still shows, and a 12px `--faint` line under it: `PR #{n} is merged. GitHub may have deleted its branch.` |
| **Nothing pushed yet** (no repo has a branch on the code host) | The button shows **disabled**, with a `Tooltip`: `Nothing to check out yet. A branch appears after the first turn with changes.` |
| Phone width (F-075) | The button keeps its icon and drops its words (`aria-label="Take it local"`); the popover opens as a bottom `Sheet` with the same contents, full width |

**Keyboard and focus:** the button opens and closes it (Enter, Space); focus moves to the first copy button; Tab cycles inside; Esc closes and returns focus to the button. A click outside closes it.

## Components (shadcn/ui names)

- **From the repo:** `Button` (`outline`, `ghost` with `size="icon"`), `Skeleton`, `Sheet` (phone).
- **New in `components/ui/`:** `Popover`, `PopoverTrigger`, `PopoverContent` (on `radix-ui`, already a dependency, as `sheet.tsx` is) and `Tooltip`. A small shared `CopyButton` (icon, copied state, the live region), which `account`'s CLI sessions and the device page can reuse.
- **New:** `components/tasks/take-it-local.tsx` (ticket 47).
- **Icons:** Lucide `square-terminal` (the button), `copy`, `check`, `info`, `circle-alert`; 15px in the bar, 14px in the popover, stroke 1.75.

## Tokens (`app-concepts/html/graphite.css`)

| Token | Value | Used for |
|---|---|---|
| `--surface` | `#131416` | the popover |
| `--bg` | `#0D0E10` | the command fields and git blocks, inset in the popover |
| `--sel` | `#1A1B1E` | the pressed button |
| `--line` | `#1F2023` | the hairline in the popover |
| `--line-2` | `#2A2C30` | the popover's border, the fields' and blocks' borders, the button's border |
| `--text` | `#EDEDEE` | the title, the commands, `ostra login` in the hint |
| `--muted` | `#9A9DA3` | the lede, the hint, repo names, the copy icons |
| `--faint` | `#64676D` | group labels, the hint's icon, the footnote, the merged line |
| `--green` | `#4FB286` | the copied check |
| `--red` | `#E5675C` | the error line |

No amber anywhere in the popover: nothing in it waits on the member.

- **Type:** IBM Plex Sans 13px/600 title, 12.5px lede, 12px hint and footnote, 11px/500 labels; IBM Plex Mono 12.5px for the checkout line, 12px for the git lines and repo names.
- **Radii:** 10px popover, 7px fields, blocks and the button.

## Differences from the current code

1. **There's no "Take it local".** `components/tasks/task-view.tsx`'s top-bar `actions` hold `CopyLink`, the PR buttons and Stop. Add `TakeItLocal` between `CopyLink` and the PR buttons.
2. **`components/ui/`** has no `Popover` or `Tooltip`. Add both from shadcn/ui on `radix-ui` (no new dependency).
3. **`tasks.local`** doesn't exist yet (ticket 39): it returns the checkout ref, the repos with their branch and PR state, whether the member has a CLI session, and the install's public address for the login line (`settings.publicUrl`, already read by the web app).
4. **The CLI** prints that `ostra login` and `ostra checkout` aren't there yet (`apps/runner/src/cli/help.ts`). Ticket 33 builds them; the popover's lines must match what it accepts, `--server` included.
5. **New message keys** (`apps/web/messages/en.json`): `takeLocal.button`, `takeLocal.title`, `takeLocal.lede`, `takeLocal.cli`, `takeLocal.firstTime`, `takeLocal.git`, `takeLocal.gitOne`, `takeLocal.merged`, `takeLocal.reopen`, `takeLocal.nothingPushed`, `takeLocal.copy`, `takeLocal.copied`, `takeLocal.copyRefused`.

## Wrong in the image (build from this file)

- **The popover is about 546px wide** (x 877 to 1423). Build 480px.
- **The title** `Take it local` renders at about 17px. Build 13px weight 600.
- **The lede's "ostra"** has a faint underline under some letters. It's plain text, no underline and no link.
- **The login hint** shows `ostra login` inline only. Build the hint line and, under it, the `ostra login --server {publicUrl}` field with its copy button (item 5).
- **The popover's caret** under the button: build none. A popover aligned to the button's edge needs no arrow.
- **The properties panel's branch value** has a stray mark (`4b̃7e`). It's `ostra/ost-142-4b7e…`, truncated, the full name in `title`.
- **The sidebar** is drawn from the image's own shell. Build it from `sidebar.tsx`; its rows here (Agent profiles, Linear) are what milestone 3's sidebar holds, but the picture's spacing is looser than 26px rows.
- **`OST-142`, the branch, `alex-laptop`, the repos and PR numbers** are demo data. Build from `tasks.get` and `tasks.local`.

Right as drawn: the popover in `--surface` with the fields and git blocks inset in `--bg` (sampled `#151516` and `#0E0E0F`), the pressed button's `--sel` fill, the copy buttons as plain icons with no border, and every word of the popover's copy.
