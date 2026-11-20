# Target: New task (`/tasks/new`)

> **Committed image:** `task-new.webp`, downscaled from the 2048×1360 generation to 1440 px wide, so one image pixel is one CSS pixel. Where this file gives sizes in image px at ×1.42, read them as CSS px directly against the WebP.

- **Image:** `task-new.webp`, 2048×1360 px, a 1440×960 CSS px viewport at about 1.42×. Generated with Higgsfield `gpt_image_2_6` (3:2, 2k, high), with the first draft, the graphite concepts (`task-b`, `home`) and the Hinge logo as references. Prompt: `task-new.prompt.txt`. Two generations.
- **Status:** a candidate target for milestone 1, not yet approved by the maintainer (`app-design.md`: a target needs the maintainer's yes).
- **Features:** F-097 (prompt tasks), F-014 (personal runner, "personal, not isolated", picked per task), F-021 (agent profiles; read-only here in milestone 1). Data: `apps/web/src/components/tasks/new-task-view.tsx`, `new-task-form.tsx`, `packages/api/src/routers/tasks.ts` (`tasks.create`, `tasks.list`), `projects.ts` (`projects.list`, `projects.get`), `runners.ts` (`runners.mine`), `packages/domain/src/use-cases/create-prompt-task.ts`.

## Purpose

A member starts work from a prompt: pick the project, type what the agent should do, see which agent and model will do it and where it runs, then start. It should feel like the beginning of real work: one big composer, and around it, quietly, the facts of what will happen. Starting lands on the task page (`/tasks/{taskId}`), where the session streams.

## Layout

The shared shell, unchanged (`app-concepts/html/shell.js`): 232px sidebar with no item selected (the sidebar's `+` is how most members get here), a 44px top bar. Build the sidebar from the shell component, not from the image.

| Region | Size | Contents |
|---|---|---|
| Top bar | 44px, hairline under | Breadcrumbs `{organization} › New task` (last crumb `--text`, weight 500). Nothing on the right: the page's one primary button is in the composer. |
| Page column | `1fr`, padding `28px 40px 20px` | Heading, composer, help line, "What happens next", "Recent in {project}". Content fills the column (was `max-width: 760px`; the maintainer, 2026-11-20: "the new task is not the full width of the pages container"). |
| Properties panel | 340px (it pairs with a form), `border-left: 1px var(--line)`, padding `20px 18px` | What the task will be: project and repo, agent profile, runner. |

### Page column, top to bottom

1. **Eyebrow** (`.key`: IBM Plex Mono 500 12px, `--faint`): `{project.slug} · prompt task`.
2. **Heading.** `h1` "New task" (Manrope 700, 24px, `letter-spacing: -0.015em`, margin `6px 0`). Lede, `--muted`, 13.5px: "Type what the agent should do. It works on its own branch and opens a pull request." (`newTask.lede`, unchanged).
3. **Composer** (margin-top 24px). The page's one box: `--surface` fill, `1px solid var(--line-2)`, radius 10px, padding `14px 16px 10px`, min-height 250px; focused, the border becomes `#34363A` (no ring, no glow). It's a `<form>`.
   - **Prompt:** a `Textarea` with no border and no fill, IBM Plex Sans **14px**/1.6, `--text`, autofocus, grows with its content (min 150px, max 50vh, then scrolls). Placeholder in `--faint`: "Add a short CONTRIBUTING.md that explains how to run the tests" (`newTask.placeholder`). Visually hidden label "Prompt".
   - **Footer row** (flex, `align-items: center`, gap 4px, margin-top 10px), three **ghost** triggers on the left, 28px tall, no border, no fill (hover `--raise`, radius 7px, padding `0 8px`), 12.5px IBM Plex Sans 500, each ending in a 12px `chevron-down` in `--faint`:
     1. **Project:** the 8px project square (`.pdot`, the project's colour) + project name. Opens a `Popover` + `Command` list of the member's projects with a filter.
     2. **Agent profile:** `sliders-horizontal` icon + `{agent} · {model}` (e.g. "OpenCode · Claude Sonnet 5.5"). In milestone 1 it's **read-only**: the project's default code profile always applies (`create-prompt-task.ts`). Render it as the same trigger without the chevron, with a `Tooltip`: "The project's default code profile. Agent profiles come with F-021." Once F-021 ships, it opens a `Popover` + `Command` of the profiles the member may use.
     3. **Run on:** `laptop` icon + `{runner} · yours` for a personal runner, or `server` icon + "The project's pools". Opens a `Select`/`Command` list: each personal runner as `{name}` mono + `· yours` + its state (`online` with a green dot, else `--faint` text "offline"), then a separator, then "The project's pools". Default: the first online personal runner, else the pools (current logic).
     - On the right (`margin-left: auto`): a `Kbd` hint in faint mono 11px, `⌘ ↵` on macOS and `Ctrl ↵` elsewhere, then the primary `Button`: `--shell` fill, `--ink` text, 600, 28px tall, `arrow-up` icon + "Start task". ⌘/Ctrl+Enter submits (current behaviour).
4. **Help line** under the composer (margin-top 8px, 12px `--faint`, 13px `info` icon), only when a personal `host` runner is chosen: "{runner} is your own machine. The agent runs in a worktree there, not isolated." Not amber: it's a fact, not something that needs the member.
5. **What happens next** (`.section`, margin-top 32px). `.shead` with `h2` "What happens next" (13px, 600). Three 38px hairline rows (`.rows > .r`), each a 15px `--muted` Lucide icon then 13px text, IDs in IBM Plex Mono 12.5px `--text`:
   - `folder-git-2`: "A worktree of `{repo.fullName}` from `{repo.defaultBranch}`, on `{runner}`". With pools: "A box of `{repo.fullName}` from `{repo.defaultBranch}`, on one of the project's pools".
   - `git-branch`: "{agent} works on its own branch, `ostra/…-{slug}`", the slug live from the prompt's first line with `branchNameFor`'s rule (the ID part isn't known before the task exists: render it as `…` in `--faint`). Empty prompt: "{agent} works on its own branch."
   - `git-pull-request`: "It opens a pull request. Steer it while it runs, and reopen it any time."
6. **Recent in {project}** (`.section`). `.shead`: `h2` "Recent in {project}", faint mono count, right: `.more` link "All tasks →" to the project's tasks. Up to 3 rows from `tasks.list({ projectId })`, 38px hairline rows, columns: state (dot + label, 110px), title (`.grow`, `--text`), what happened (`--muted` 12.5px, paths and PR numbers mono), age (faint mono 12px, right). State marks: Running = green `.dot`; In review = grey `.dot`; Merged = 13px `git-merge` icon in `--faint`. A failed task: `--red` `circle-x` icon + "Failed". Hidden when the project has no task yet.

### Properties panel

Group labels use `.props h5` (11px IBM Plex Sans 500, `--faint`); groups split by `.sep` hairlines. Rows `.row2`: 84px key column, 30px rows, 12.5px; keys `--muted`, values `--text`.

1. **This task**
   - `Project` → `.pdot` + name
   - `Repo` → `repo.fullName` (mono)
   - `Base` → `repo.defaultBranch` (mono)
   - `Branch` → "made when it starts" (`--muted`, **IBM Plex Sans**, not mono)
2. **Agent profile**, right of the label: teal `Change` link (to Agent profiles; hidden until F-021 ships, or for members who can't change it)
   - `Profile` → the profile's name ("Default")
   - `Agent` → `bot` icon + the adapter's display name ("OpenCode")
   - `Model` → `sparkles` icon + the model's name ("Claude Sonnet 5.5")
   - No model on the profile: `Model` → `--red` "None yet" and the error state below applies.
3. **Runs on**
   - `Runner` → `laptop` icon + `{name}` (mono) + `· yours` (`--muted`); pools: `server` icon + "The project's pools"
   - `State` → green `.dot` + "online" / grey dot + "offline"; pools: "picked when it starts" (`--muted`)
   - `Executor` → `host · not isolated` (`--muted`) for a host runner; pools: the pool's executor, or omit the row

## States

| State | What shows |
|---|---|
| Loading projects | The shell, eyebrow-less heading and lede, the composer drawn but disabled, with a `Skeleton` in each footer trigger. Panel: three `Skeleton` rows per group. |
| No project | No composer, no panel (`.content.full`). Under the lede: 13px `--muted` "There's no project yet." (`newTask.noProject`) and the primary `Button` "Create a project" (`checklist.project.action`) → `/projects/new`. |
| Empty prompt | Placeholder "Add a short CONTRIBUTING.md that explains how to run the tests", "Start task" disabled (opacity .5, no hover), branch row reads "{agent} works on its own branch." |
| Ready (the image) | Prompt typed, project, profile and runner shown, "Start task" enabled. |
| Run on: the project's pools | Run on trigger `server` + "The project's pools"; no help line; panel `State` "picked when it starts". |
| Starting | Button disabled, label "Starting…" (`newTask.starting`) with a 13px spinning `loader-circle` in place of `arrow-up`; textarea and triggers read-only. |
| Refused / error | A line under the composer in place of the help line, 12.5px `--red`, `circle-alert` icon, `role="alert"`: `errorText(error)`. The two refusals milestone 1 has: "The project's default code profile has no model yet: an admin picks one under Models" and "The project's model provider isn't allowed on personal runners: an admin turns it on under Models". The word "Models" in each is a teal link to Models. Never amber. Form re-enabled; the prompt is kept. |
| Started | Redirect to `/tasks/{taskId}` (unchanged). |

## Components (shadcn/ui names)

`Textarea` (borderless inside the composer), `Button` (`default` = Shell primary; `ghost` for the three triggers), `Popover` + `Command` (`CommandInput`, `CommandList`, `CommandItem`, `CommandSeparator`) for the project and runner pickers (or `Select` if no filter is wanted), `Tooltip` (read-only profile), `Kbd`, `Skeleton`, `Separator` (panel hairlines), `Breadcrumb`. Icons, Lucide 15px stroke 1.75 (13px in the panel): `sliders-horizontal`, `laptop`, `server`, `chevron-down`, `arrow-up`, `info`, `folder-git-2`, `git-branch`, `git-pull-request`, `git-merge`, `bot`, `sparkles`, `arrow-right`, `circle-alert`, `loader-circle`.

## Tokens (`app-concepts/html/graphite.css`)

> **Scale.** The sizes and colours below are `graphite.css`'s. The panel is built at the approved pictures' scale, which wins on size, spacing and contrast: body 14.5px, dense rows 14px, secondary 13px, small 12px, title 26px, `--muted` `#B4B7BB`, `--faint` `#8B8E93`, buttons 30px, a 46px top bar and a 320px properties panel (380px with a form). The measured values are in `../m1/README.md`, "Scale".

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page and panel background |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | the composer |
| `--raise` | `#17181B` | ghost trigger hover |
| `--sel` | `#1A1B1E` | selected item in the picker lists |
| `--line` | `#1F2023` | row hairlines, panel border, separators |
| `--line-2` | `#2A2C30` | composer border (focused: `#34363A`) |
| `--text` | `#EDEDEE` | prompt, values, row titles |
| `--muted` | `#9A9DA3` | lede, panel keys, "what happened", "made when it starts" |
| `--faint` | `#64676D` | eyebrow, group labels, help line, counts, ages, `Kbd`, chevrons |
| `--teal` | `#6FB8AA` | "Change", "Models" link in an error |
| `--green` | `#4FB286` | online dot, Running dot (always with a label) |
| `--red` | `#E5675C` | refusals and errors, "None yet" model |
| `--shell` | `#F3F0E8` | "Start task" fill |
| `--ink` | `#0C1D21` | text on "Start task" |
| `--amber` | `#FFB224` | **not used on this page**; only the shell's "Needs you" count and project dots |

Type: Manrope 700 24px (title); IBM Plex Sans 13px body, **14px** for the prompt, 12.5px triggers and panel, 13px/600 section titles, 500 for buttons; IBM Plex Mono for the eyebrow, repo, branches, runner names, paths, PR numbers, ages, `Kbd`. Radii: 10px composer, 7px controls. Control height 28px, rows 38px, panel rows 30px.

## Differences from the current code

`new-task-view.tsx` and `new-task-form.tsx` today:

1. **No properties panel.** One 720px column on `PageFrame`. Target: the `.content` grid with a 340px panel.
2. **Project is a labelled native `<select>` above the form.** Target: a ghost trigger in the composer's footer (`Popover` + `Command`), and the project in the eyebrow and the panel.
3. **"Run on" is a labelled native `<select>` under the textarea**, options like "alex-mbp (yours, online) · not isolated". Target: a ghost trigger "alex-mbp · yours", the state in the list and the panel, "not isolated" moved to the help line and the panel's `Executor` row.
4. **No agent profile or model is shown.** The task silently uses the project's default code profile. Target shows it in the composer and the panel. `projects.get` returns `defaultCodeProfile: { id, name }` only: it needs the adapter's display name and the model's name (and `null` model, so the page can warn before submitting).
5. **No repo or base branch shown.** Target reads them from `projects.list`/`projects.get` (`repos[0].fullName`, `defaultBranch`).
6. **Composer:** today `rounded-lg border-line-2 bg-surface`, textarea `min-h-28` (or `min-h-14` compact), 13px. Target: min-height 250px, prompt 14px, autofocus, grows; the compact variant (used elsewhere) keeps its own size.
7. **Button** "Start the task" with a `send` icon, `mb-3.5` to line up with the select's label. Target: "Start task" with `arrow-up`, in the footer row beside a `Kbd` hint.
8. **No "What happens next" and no "Recent in {project}".** Both are new; Recent uses `tasks.list`.
9. **Error** is a bare `text-sm text-red` paragraph inside the box. Target: under the composer with an icon, and the "Models" link.
10. **Loading** renders nothing for the project select. Target: `Skeleton`s.

New message keys in `apps/web/messages/en.json`: `newTask.eyebrow` ("{project} · prompt task"), `newTask.start` changes to "Start task", `newTask.hostHelp`, `newTask.profileReadOnly`, `newTask.nextTitle`, `newTask.nextWorktree`, `newTask.nextBox`, `newTask.nextBranch`, `newTask.nextBranchEmpty`, `newTask.nextPr`, `newTask.recent`, `newTask.allTasks`, `newTask.thisTask`, `newTask.branchLater`, `newTask.agentProfile`, `newTask.change`, `newTask.runsOn`, `newTask.stateLater`, `newTask.noModel` ("None yet"), and the panel keys (`Project`, `Repo`, `Base`, `Branch`, `Profile`, `Agent`, `Model`, `Runner`, `State`, `Executor`), reusing existing ones where they exist.

## Wrong in the image (build the copy and shell from this file)

The image's text is correct and legible everywhere; no garbled words. These details differ from what to build:

- **Branch name** in "What happens next" reads `ostra/1f3a9c2e-add-keyboard-navigation`: a branch's ID part isn't known before the task exists. Build `ostra/…-{slug}` with the slug from `branchNameFor`.
- **"made when it starts"** in the panel renders in mono; it's prose: IBM Plex Sans, `--muted`.
- **Ghost triggers** render in `--text`; build them in `--text` for the value (fine) with the chevron in `--faint`. The profile trigger has a chevron in the image; in milestone 1 it has none (read-only).
- **"Change"** next to "Agent profile" shows in the image; hide it until F-021 ships.
- **Sidebar:** take it from the shell; the image's sidebar type is a little larger than the concepts' 13px, and the `Models` icon differs.
- **Recent rows** are demo data ("Export history as CSV", PR #483, #479); build from `tasks.list`.
