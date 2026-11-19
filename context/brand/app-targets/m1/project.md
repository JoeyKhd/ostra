# Target: the project screen (milestone 1)

> **Committed image:** `project.webp`, downscaled from the 2048×1360 generation to 1440 px wide, so one image pixel is one CSS pixel. Where this file gives sizes in image px at ×1.42, read them as CSS px directly against the WebP.

- **Image:** `project.webp`, 2048×1360 (3:2). It's a 1440×960 layout drawn at about 1.42×, so divide a measurement by 1.42 to get CSS px.
- **Prompt:** `project.prompt.txt`. GPT Image 2.6 through Higgsfield, 1 generation. The references were `app-concepts/html/project-tasks-graphite.png`, `task-b-graphite.png`, `home-graphite.png` and `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route:** `apps/web/src/app/(panel)/projects/[project-id]/page.tsx` → `components/projects/project-view.tsx` and `project-properties.tsx`.
- **Features:** F-086 (projects), F-097 (prompt tasks), F-014 (picking a personal runner, "not isolated"), ticket 38 (the project's task list).
- **Status:** a proposed target. It isn't approved by the maintainer yet (`app-design.md`).

> app-design.md rule 5 says concepts are built as real HTML, not image-model mockups. This image is a visual target for the build, not a concept to approve as-is. Build it in real HTML/React, then screenshot that build and compare it with the image.

## Purpose

A project's home: what its tasks are doing right now, grouped by lifecycle state, and the one way to start a task in milestone 1, by typing a prompt. The member answers one question at a glance: what waits on me, and what is the agent doing on everything else? The properties panel says what the project is: its access, its repo, and where and how its tasks run.

## Layout (CSS px at 1440×960)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 232px, `--side`, 1px `--line` on its right | the organization switcher, search ⌘K and "+", Home; **Projects**: `calculator` (expanded: Tasks, Environment), `billing-platform`, New project; **Organization**: Runners, Models, GitHub; the member at the bottom |
| Top bar | 44px, 1px `--line` below | breadcrumb `calculator › Tasks`. No actions on the right: the page's one primary button is in the composer |
| Main column | flexible, padding `28px 40px` | title, lede, composer, grouped list |
| Properties panel | 300px, 1px `--line` on its left, padding `20px 18px` | Project, Repository, Runs |

Main column, top to bottom:

1. **Title:** the project's name, `calculator`, in Manrope 700, 24px, letter-spacing −0.015em.
2. **Lede:** 13.5px, `--muted`: `acme/calculator · 2 waiting on you · 3 running`. The repo name is in Plex Mono, in `--text`. The counts come from `projects.get` (`needsYouCount`, `runningCount`). Leave a count out when it's 0, and with no tasks at all show only the repo.
3. **Composer:** about 18px below the lede. The only box on the page: 1px `--line-2`, 8px radius, `--surface`, padding about `12px 14px`.
   - A borderless textarea, 2 lines tall, growing with its text. Placeholder: `Add a short CONTRIBUTING.md that explains how to run the tests`, in `--faint`.
   - The bottom row: `Run on` (12px, `--muted`), then a select, 28px tall, `--line-2` border, 7px radius. Its value is a laptop icon, `alex-mbp` in mono, then ` · yours, online · not isolated` in `--muted`, and a chevron-down. The other option is `The project's pools` (server icon).
   - On the right: a faint `⌘↵` hint (a `Kbd`), then the primary button `Start the task` with a send icon. Filled `--shell`, `--ink` text, weight 600, 28px tall.
4. **The grouped list:** about 22px below the composer, with an 18–20px gap between groups.
   - **Group band:** 32px tall, `--surface`, 6px radius, padding-left 12px. An icon (below), the name in Plex Sans 600 13px, and the count in mono 11.5px `--faint`.
   - **Rows:** 40px tall, no box, a 1px `--line` hairline under each. The columns, left to right:

| Column | Width | Style |
|---|---|---|
| Status mark | 28px, centred on the band's icon | the state's dot or icon (below) |
| Short ID | 88px | Plex Mono 12.5px, `--faint` |
| Title | flex, about 26% | 13px, `--text`, truncated with an ellipsis |
| Doing now | flex, about 30% | 13px, `--muted`; a command or path inside it is in mono, `--text` |
| Runner | 128px | laptop icon (personal) or server icon (pool), 13px `--faint`, then the name in mono 12.5px `--muted`. Empty when there's no runner |
| Driver | 22px | `Avatar` 22px, `#2A2C30`, initials 600 10px |
| Age | 40px, right-aligned | mono 12.5px, `--faint` |

   - **Every column starts at the same x in every group.** The image drifts here (see "Wrong in the image"): use one CSS grid template for all the rows.
   - A row is a link to `/tasks/{id}`. Hover is `--raise` (`#17181B`); keyboard focus is a 2px `--muted` outline, inset.

## States and copy

The groups appear in the order of `domain-model.md`. A group with no tasks isn't shown.

| Group | Band icon | Row mark | "Doing now" copy |
|---|---|---|---|
| `Needs you` | 7px amber dot with its 3px 15% amber ring | amber dot | `Approval: <command>` for `awaiting_approval`; `Question: <text>` for `needs_you`. Fallback: the row's `reason`, then `Waiting for an approval` / `Waiting for an answer` |
| `Running` | 7px green dot with its ring | green dot for `running`; Lucide `loader-circle`, 13px, `--faint`, for `preparing` | the `doing` text: `Running <cmd>`, `Editing <path>`, `Reading <path>`, `Thinking`, `Writing`, `Pushing the branch`. For `preparing`: `Preparing · running the setup script` |
| `Queued` | Lucide `circle-dashed`, `--faint` | `circle-dashed` | `Waiting for a runner` |
| `In review` | Lucide `git-pull-request`, `--muted` | `git-pull-request` | `PR #48 · open`, with `#48` in `--text` (one entry per PR: `prs[]`) |
| `Stopped and done` | Lucide `chevron-right`, collapsed by default | `square` for stopped, `git-merge` for merged, `check` for done, all `--faint` | `Stopped: <stoppedReason>` / `Merged` / `Done` |

The demo data in the image (fixtures, not real):

- **Needs you · 2**
  - `3f9c21ab` · Add a history panel · `Approval: pnpm db:migrate` · alex-mbp · AK · 14m
  - `8e04d7c2` · Retry webhook delivery on 5xx · `Question: keep the old retry header?` · alex-mbp · AK · 32m
- **Running · 3**
  - `a17be093` · Fix rounding in percent mode · `Running pnpm test percent` · alex-mbp · AK · 6m
  - `5d2e81f4` · Show units in the display · `Editing src/display/format.ts` · alex-mbp · SR · 9m
  - `c90b4e17` · Add a short CONTRIBUTING.md · `Preparing · running the setup script` · alex-mbp · AK · 1m
- **Queued · 1**
  - `e26f0a95` · Keyboard shortcuts for memory keys · `Waiting for a runner` · (no runner) · AK · 2m
- **In review · 2**
  - `71d3c8e0` · Upgrade Prisma to 7.2 · `PR #48 · open` · AK · 2h
  - `0b9fa246` · Parse locale decimal separators · `PR #46 · open` · SR · 5h
- **Stopped and done · 9:** collapsed

The other states the build must cover (none are in the image):

- **Loading:** the title and lede as `Skeleton` lines, then three skeleton bands with 3 rows each. The composer renders at once.
- **Empty (no tasks):** the composer, then one muted line 24px below it: `No tasks yet. Type a prompt above.` (`tasks.none`). No bands.
- **Error loading the list:** `role="alert"`, `--red` text, `errorText(error)`, where the list would be. The composer still works.
- **Composer, starting:** the button reads `Starting…` and is disabled. It's also disabled while the prompt is empty.
- **Composer error:** a `--red` line under the composer's bottom row, inside the box.
- **No personal runner online:** the select defaults to `The project's pools`. A personal runner that's offline stays listed as `alex-mbp · yours, offline` and can't be picked.
- **Collapsed group expanded:** the chevron turns to `chevron-down` and the rows show below it.

## Properties panel

The group labels are 11px, weight 500, `--faint`, with 8px below. Rows are 30px tall, in a grid of `84px 1fr`, 12.5px. The key is `--muted`; the value is `--text`, with a 13px `--muted` icon. A hairline `--line` sits between groups, with 14px of margin.

| Group | Key | Value |
|---|---|---|
| `Project` | `Access` | `Every member` / `Restricted` |
| | `Your role` | `Admin` / `Member` |
| | `Created` | `3 Nov 2026`, in mono (from `createdAt`) |
| `Repository` | `Repo` | `git-branch` icon, `acme/calculator` in mono |
| | `Default branch` | `main`, in mono |
| `Runs` | `Environment` | `box` icon, then `Saved` as a teal (`--teal`) link to `/projects/{id}/environment`; or `Draft: review it` in the same link style |
| | `Pools` | `server` icon, the pool names, comma-separated, or `–` |
| | `Agent` | `bot` icon, the default code profile's name (`OpenCode`), or `–` |

The `Default branch` key is 14 characters, more than 84px fits at 12.5px. Widen the key column to 96px for this panel, or name the key `Branch`.

## Components (shadcn/ui names)

- `Sidebar`, `SidebarHeader` (`DropdownMenu` organization switcher), `SidebarGroup` and `SidebarGroupLabel` ("Projects", "Organization"), `SidebarMenu`, `SidebarMenuItem`, `SidebarMenuButton` (26px; the selected one is `--sel`), `SidebarMenuSub` (the open project's pages), `SidebarMenuBadge` (the count `10`, mono 11px `--faint`), `SidebarFooter` (the member)
- `Breadcrumb`, `BreadcrumbList`, `BreadcrumbItem`, `BreadcrumbSeparator` (chevron-right 13px `--faint`), `BreadcrumbPage`
- `Textarea` (borderless, inside the composer `form`), `Select` with `SelectTrigger` and `SelectContent`, `Kbd`, and `Button` (`variant="primary"`, Shell)
- `Collapsible`, `CollapsibleTrigger` and `CollapsibleContent` for each group. Only "Stopped and done" starts collapsed.
- `Avatar` and `AvatarFallback` (22px)
- `Separator` (the hairlines between the property groups)
- `Skeleton` (loading)
- The repo's own `Status` (a dot with its label: the band gives the label) and `PropGroup`/`PropRow` (`components/shell/page-frame.tsx`)
- Icons: Lucide 15px, stroke 1.75: `house`, `list-checks`, `box`, `plus`, `server`, `cpu`, `git-pull-request`, `laptop`, `send`, `chevron-down`, `chevron-right`, `loader-circle`, `circle-dashed`, `git-branch`, `bot`, `search`, `chevrons-up-down`

## Tokens (from `app-concepts/html/graphite.css`)

> **Scale.** The sizes and colours below are `graphite.css`'s. The panel is built at the approved pictures' scale, which wins on size, spacing and contrast: body 14.5px, dense rows 14px, secondary 13px, small 12px, title 26px, `--muted` `#B4B7BB`, `--faint` `#8B8E93`, buttons 30px, a 46px top bar and a 320px properties panel (380px with a form). The measured values are in `../m1/README.md`, "Scale".

```css
--bg: #0D0E10;      /* page */
--side: #0A0B0C;    /* sidebar */
--surface: #131416; /* composer, group bands, inputs */
--raise: #17181B;   /* row hover */
--sel: #1A1B1E;     /* selected nav row */
--line: #1F2023;    /* hairlines */
--line-2: #2A2C30;  /* control borders, avatar fill */
--text: #EDEDEE; --muted: #9A9DA3; --faint: #64676D;
--amber: #FFB224;   /* Needs you, and nothing else */
--green: #4FB286;   /* running */
--teal: #6FB8AA;    /* links: "Saved" */
--red: #E5675C;     /* errors */
--shell: #F3F0E8; --ink: #0C1D21; /* the primary button */
```

- **Type:** body 13px/1.5 IBM Plex Sans; secondary 12–12.5px; title Manrope 700 24px; band titles Plex Sans 600 13px; IDs, runner names, commands, paths, ages and counts in IBM Plex Mono.
- **Radii:** 8px composer, 7px controls, 6px bands and nav rows, 2px project squares.
- **Dots:** 7px; amber and green carry a 3px ring at 15% alpha (`rgba(255,178,36,.15)`, `rgba(79,178,134,.15)`).

## Differences from the current code

1. **The composer:** it now has a bottom row of `Run on` select, `⌘↵` and `Start the task` on one line, inside the box. Today the `Field` label stacks above the select, the button sits on `mb-3.5`, and the textarea is `min-h-14`. The select's option reads `alex-mbp · yours, online · not isolated`, not `alex-mbp (yours, online) · not isolated`. That needs a new message, `newTask.personalRunnerShort`.
2. **"not isolated" leaves the rows.** Today every row with a host runner shows an amber `Chip`. That breaks "amber only for needs you", and it repeats on every row. The note lives on the `Run on` choice instead, where it's decided.
3. **The status label leaves the rows.** Today each row starts with a 112px `Status` text (`Running`, `Approval`…). The group band already names the state, so a row shows only its mark (dot or icon). The sub-state shows in "doing now" (`Approval: …`, `Preparing · …`).
4. **The group bands:** they get their icons (amber dot, green dot, dashed circle, PR icon, chevron) and 32px height, with 12px padding. Today they're `h-8 px-2`, and only "Needs you" has a mark.
5. **"Stopped and done"** shows as a collapsed `Collapsible` at the bottom. Today it's expanded like the others.
6. **The columns:** one grid template for every row, so the columns line up across groups. Today it's a `flex-wrap` row with variable widths. The driver shows as an `Avatar` with initials (today it's the name as text), and the PR moves into "doing now" for in-review tasks (today it's an icon and number at the end).
7. **The lede:** `acme/calculator · 2 waiting on you · 3 running`. Today it's only the repo names.
8. **The properties panel:**
   - `Created` is new.
   - Repositories become `Repository` with `Repo` and `Default branch` rows. Today the branch is the key and the repo the value, which reads backwards.
   - `Agent` gets a `bot` icon, not `sliders-horizontal`.
9. **Preparing** gets a `loader-circle` mark and `Preparing · running the setup script`.
10. **Copy:** `PR #48 · open` and `Waiting for a runner` are new strings for `en.json`.

## Wrong in the image (use the copy above, not the pixels)

- **Column drift:** in `Queued` and `In review`, the "doing now" column starts about 28 image px (about 20 CSS px) right of the other groups, and titles drift a few px between groups. Build one grid; ignore the drift.
- **The Tasks count:** the sidebar reads `10`, but the active tasks shown add up to 8. The badge counts the active tasks (every group but "Stopped and done"), so it should read `8`.
- **Extra spaces:** `PR #48  · open` has a double space before the dot. It's `PR #48 · open`.
- **The logo:** it's an approximation of the Hinge mark. Use `kit/logo/export/ostra-hinge-single-color.svg`, 20px.
- **Agent icon:** the image draws a bot-like glyph. Use Lucide `bot`.
- **The `Saved` link** is underlined in the image. Links in the panel are teal with no underline, underlined on hover.
- **Sidebar sizes:** the sidebar rows render taller than 26px, and the type larger than 13px, compared with the concepts. Keep 26px rows and 13px type from `graphite.css`.
