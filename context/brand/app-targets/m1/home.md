# Home: target

> **Committed image:** `home.webp`, downscaled from the 2048×1360 generation to 1440 px wide, so one image pixel is one CSS pixel. Where this file gives sizes in image px at ×1.42, read them as CSS px directly against the WebP.

The organization's Home (F-062), with its first-run state (F-076). Picture: `home.webp` (2048×1360, 3:2; read it as the 1440px-wide frame at about 1.42×). Prompt: `home.prompt.txt`. Made with the `ui-taste` skill, image first, on Higgsfield `gpt_image_2_6` (2k, high), in two generations: the first from the graphite concepts (`../../app-concepts/html/home-graphite.png`, `task-b-graphite.png`) and the Hinge logo, the second an edit of the first (with `home-graphite.png` and the logo) that fixed the org switcher, the button widths and the panel labels. The picture shows the full state only; the first-run, empty, loading and error states are specified below in words.

**Status:** a target, not yet approved by the maintainer (ticket 34). The picture is an image-model render: the copy in this file wins over the copy in the picture, and the tokens below win over its colours. `app-design.md` rule 5 and ticket 34 ask for screens built in real HTML; this picture is the image-first step before that, so ticket 34's HTML version of Home should be built from it.

## Purpose

A member's first screen. It answers, in this order:
1. What waits on me? (needs you, amber, first)
2. How is each project doing? (running, queued, needs you, PRs, spend)
3. What just happened? (recent activity)
4. Is the fleet healthy, and what does it cost? (the right panel: merged PRs, spend, runner pools)

It covers every project the member can open in the organization (Q30), not one project.

## Layout (1440 px wide, the concepts' frame)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 232px, `--side`, right hairline | The shared sidebar (`shell.js`); **Home** is the selected row |
| Top bar | 44px, bottom hairline | Breadcrumbs `Acme Corp › Home`; one primary button `+ New task` on the right |
| Page | `1fr`, padding `28px 40px` | Heading, then the sections **Needs you**, **Projects**, **Recent activity**, 26px apart |
| Properties panel | 300px, left hairline, padding `20px 18px` | Three groups split by `.sep` hairlines: merged PRs, spend, runner pools |

No cards anywhere: each section is a title line (`.shead`, 28px) and rows split by hairlines (`.rows`, `table.t`). At `< xl` the properties panel stacks under the page (as `PageFrame` already does); at phone width (F-075) the Needs you rows wrap to two lines (key + title, then reason + action) and the Projects table keeps Project, Needs you and Running only.

### Heading
- Eyebrow, `.key` (Plex Mono 12px, `--faint`): `Wednesday 18 November` (the member's locale date, `en-GB`, as today).
- Title, `h1` (Manrope 700 24px): the organization's name, `Acme Corp`.
- Lede, `.lede` (13.5px, `--muted`): `238 tasks running across 18 projects, 41 queued. 37 pull requests merged today.`

### Needs you (first, amber)
- Header: an amber `.dot.amber`, `Needs you` (600 13px), the count `5` (`.shead .n`), and `Open all →` on the right (`.shead .more`), which opens the Needs you view.
- Rows, 40px, one grid for all of them so every column lines up:

| Column | Width | Style |
|---|---|---|
| Key | 80px | `.key` mono, `--faint` |
| Title | `1fr` (truncates) | 13px `--text` |
| Project | 150px | 8px `.pdot` in the project's colour + name in `--muted` |
| Reason | 260px (truncates) | `--muted`; commands and branch names inside it in Plex Mono `--text` |
| Age | 44px, right | mono 12px `--faint` |
| Action | 112px, right | one `Button` `size="sm"`, every row's the same width |

- Rows (demo data):

| Key | Title | Project | Reason | Age | Action |
|---|---|---|---|---|---|
| `CALC-142` | Retry webhook delivery on 5xx | calculator | Approval: `pnpm add p-retry` | 4m | **Approve** (amber) |
| `BIL-88` | Prorate seat changes | billing-platform | Plan ready for review | 11m | Review plan |
| `WEB-311` | Fix cart badge count | web-storefront | Draft PR #2213 ready, checks passed | 18m | Review PR |
| `MOB-57` | Crash in the Android share sheet | mobile-app | Question: keep the old share API? | 26m | Answer |
| `CALC-150` | Export history as CSV | calculator | Setup failed: `pnpm install` exited 1 | 41m | Open task |

- **Amber once:** only the oldest-waiting approval-type row (the top row) gets the filled amber `Approve` (`.btn.amber`). Every other action is the outline button (`.btn.sm`). If no row is an approval, no button is amber; the section's dot and the sidebar badge carry the colour.
- Sorted by how long it has waited, newest first (the age column), at most 5 rows; `Open all →` has the rest.
- The reason line per `NeedsYouReason` (`packages/db/prisma/schema.prisma`) and its action:

| Reason | Line | Action |
|---|---|---|
| `approval` | Approval: `<command>` | Approve |
| `plan` | Plan ready for review | Review plan |
| `draft_ready` | Draft PR #`<n>` ready, checks passed / checks failing | Review PR |
| `question` | Question: `<first line of the question>` | Answer |
| `no_changes` | Finished without changes | Open task |
| `stalled` | No progress for `<n>` min | Open task |
| `spend_cap` | Spend cap reached ($`<cap>`) | Open task |
| `crashed` | The agent crashed | Open task |
| `setup_failed` | Setup failed: `<command>` exited `<code>` | Open task |
| `ticket_closed` | The ticket was closed | Open task |
| `round_cap` | Review rounds used up | Open task |

- **Milestone 1:** there's no approval card in m1 (ticket 34), so no row shows `Approve`; the reachable reasons are `question`, `draft_ready`, `no_changes`, `stalled`, `crashed` and `setup_failed`. Prompt tasks have no ticket key, so the key column shows the task's short ID (`tasks.list` gives `key: ticketKey ?? id.slice(0, 8)`).
- **Empty:** the section stays, with one faint row: `Nothing waits on you.` The amber dot becomes a grey `.dot.grey`. It never disappears, so the page doesn't jump.

### Projects
- Header: `Projects`, count `18`, `All projects →`.
- `table.t`, header 30px (500 11.5px `--faint`), rows 40px. Numbers right-aligned (`.num`, Plex Mono 12.5px, tabular).

| Project | Repo | Running | Queued | Needs you | PRs this week | Spend, Nov |
|---|---|---|---|---|---|---|
| calculator | acme/calculator-web | 11 | 3 | 3 | 41 | $612 |
| billing-platform | acme/billing | 31 | 9 | 1 | 118 | $1,104 |
| web-storefront | acme/storefront | 44 | 12 | 2 | 176 | $1,380 |
| mobile-app | acme/mobile | 19 | 6 | 1 | 64 | $498 |
| data-pipeline | acme/pipeline | 8 | 2 | – | 22 | $210 |

- The project name has its 8px colour square (`projectColour(project.id)`). The repo column is Plex Mono `--faint` (`project.repos[].fullName`, joined with `, `). It replaces the concept's Tracker column: in m1 every project is prompts-only, and the repo is what tells two projects apart. When Linear lands (milestone 2), the tracker team (`Linear · CALC`) goes after the repo in the same cell, in `--faint`.
- Needs you is amber text when above 0; a zero is a faint en dash `–`, not a grey `0`.
- The whole row is a link to the project. Sorted by needs you, then running.
- At most 8 rows; `All projects →` lists the rest.
- **Empty (no projects):** one faint row: `No projects yet. Create one from the checklist.` (admin) or `No projects yet. An admin creates the first one.` (member), as `home.noProjectsAdmin` / `home.noProjects`.

### Recent activity
- Header: `Recent activity`, `Audit log →` on the right (admins only; members see no link).
- Rows 38px: a 15px Lucide icon, the event text (13px, names, branches and commits in Plex Mono), then the project in `--muted` and the age in mono `--faint`, right-aligned.

| Icon | Text | Where | Age |
|---|---|---|---|
| `git-merge`, `--green` | PR #2207 Add gift card balance check merged into `main` | web-storefront | 3m |
| `box`, `--muted` | Snapshot rebuilt from `main@9c41e2a` · 1.9 GB · 2m 41s | calculator | 12m |
| `server`, `--muted` | Runner `build-17` joined `build-fleet` | Organization | 20m |
| `circle-x`, `--red` | `CALC-139` stopped: spend cap reached | calculator | 34m |

- At most 6 rows. Colour only on the icon, and always with the words (merged, stopped).
- **Empty:** `Nothing has happened yet.` in faint.

### The right panel
1. **Pull requests merged, last 7 days** (`.props h5`). `849` in Manrope 700 28px. Under it, `--muted` 12.5px: `1,042 opened · 23 min median to first PR`. A single-series bar chart (dataviz skill): 7 bars in Mist `#CFD8D4`, today's bar in `--line-2` (partial day), a `--line` baseline, day labels in mono `--faint` (`T F S S M T today`), direct labels only on the peak (`211`) and today (`37`). No gridlines, no axis numbers.
2. **Spend, November** on the left, `$4,212 of $6,000` mono on the right; a 4px `.meter` at 70% (fill `--muted`, track `--line-2`). Over 90% the fill turns `--red`; it never turns amber.
3. **Runner pools**, with `238 busy · 41 queued` mono `--faint` on the right. One row per pool: the name, the figure in mono on the right, a full-width 4px meter below.

| Pool | Figure | Meter |
|---|---|---|
| build-fleet | 142 / 200 | 71% |
| k8s-autoscale | 58 · max 400 | 15% |
| mac-minis | 31 / 40 | 78% |
| laptops | 7 / 12 online | 58% |

- **Milestone 1:** there are no pools or budgets yet; the panel shows **Runners** (each runner's name, `online` / `offline` with a `.dot.green` / `.dot.grey` and the word, and its running count) and **Spend, November** without a cap (`$4,212`, no meter). Merged PRs need Insights (F-108); in m1 show `Pull requests opened, last 7 days` from the tasks' PR columns, or leave the group out.

### First run (a new organization)
While `setup.status.next` isn't `null`, the **Set up ostra** checklist (F-076, `SetupChecklist`) takes the Needs you section's place, at the top, and the right panel is empty (not rendered). Its copy, from `messages/en.json`:
- Title `Set up ostra`, progress `{done} of {total}` in mono `--faint`.
- 1 `Create the first admin`: You're signed in as the admin.
- 2 `Add a model provider`: A base URL and a token. ostra lists the models and tests the connection. → `Add a provider`
- 3 `Connect GitHub`: A GitHub App opens every pull request. Use an existing App or create one. → `Connect GitHub`
- 4 `Create a project`: Pick a repo. ostra drafts its environment from the repo's files. → `Create a project`
- 5 `Connect a runner`: Run one command on a machine. Tasks run there. → `Connect a runner`
- 6 `Start the first task`: Type a prompt and watch the agent work, then review its pull request. → `New task`
- (dashed) `Connect Linear`: Tickets become tasks. `milestone 2`
- The next step's button is the page's one primary (Shell) button; the top bar's `New task` drops to the outline style until setup is done.

### Loading and errors
- **Loading:** the heading renders at once; each section shows 3 skeleton rows (`--surface` bars, 40px rows, no shimmer). The right panel's numbers show `–`.
- **Error:** a section that fails keeps its header and shows one row: `Couldn't load this. Retry` with `Retry` as a teal link (`.lk`). The other sections still render.

## Components (shadcn/ui names)

| Piece | Component |
|---|---|
| Top bar actions | `Button` (default = Shell primary) with `PlusIcon` |
| Row actions | `Button` `variant="outline"` `size="sm"`; the one amber action is a new `variant="attention"` (`.btn.amber`) |
| Projects table | `Table`, `TableHeader`, `TableRow`, `TableHead`, `TableBody`, `TableCell` |
| Needs you and activity lists | plain `ul.rows` of links (not `Table`: they're lists, not data to compare) |
| Section header | the existing `Section` (`page-frame.tsx`) with `count` and an `end` link |
| Meters | `Progress` (4px, `--line-2` track) |
| Bar chart | a small inline SVG. shadcn `Chart` would add Recharts, a new dependency: ask first |
| Status dots | the existing `Status` (`components/ui/status.tsx`), tone `amber` / `green` / `grey` |
| Loading | `Skeleton` |
| Avatars (sidebar) | `Avatar`, `AvatarFallback` |
| Tooltips on truncated titles and reasons | `Tooltip` |

Of these, only `Button` and `Status` exist in `apps/web/src/components/ui/` today. `Table`, `Skeleton`, `Avatar`, `Progress` and `Tooltip` are added with the shadcn CLI; the last three build on `radix-ui`, which the app already depends on.

## Tokens (from `../../app-concepts/html/graphite.css`)

```css
--bg: #0D0E10;   --side: #0A0B0C;  --surface: #131416; --raise: #17181B;
--line: #1F2023; --line-2: #2A2C30;
--text: #EDEDEE; --muted: #9A9DA3; --faint: #64676D;
--sel: #1A1B1E;  --teal: #6FB8AA;  --green: #4FB286;  --red: #E5675C;
--amber: #FFB224; --shell: #F3F0E8; --ink: #0C1D21;
```

- Chart bars: Mist `#CFD8D4`.
- Project squares (demo): calculator `#6FB8AA`, billing-platform `#8C7CF0`, web-storefront `#E0A458`, mobile-app `#5FA8E8`, data-pipeline `#C27BA0`. In the app they come from `projectColour(project.id)`.
- Type: `h1` Manrope 700 24px / 1.25, -0.015em; body IBM Plex Sans 400 13px / 1.5; section titles 600 13px; table heads 500 11.5px; keys, numbers and times IBM Plex Mono (12–12.5px). The big panel number: Manrope 700 28px.
- Sizes: nav rows 26px, list rows 38–40px, table head 30px, buttons 28px (sm 24–26px), radius 6–7px, icons Lucide 15px stroke 1.75.
- Sections 26px apart (`.section { margin-top: 26px }`); page padding `28px 40px`.

## Differences from the current code

`apps/web/src/components/home/home-view.tsx` (rendered by `app/(panel)/page.tsx`) today:

1. **No Needs you section.** The page leads with the checklist, then Projects. Add Needs you first: it needs an organization-wide query of `needs_you` tasks the member can open (`tasks.list` is per project today), with reason, project, age and the per-reason action.
2. **Projects is a list, not a table.** Today: square, name, repos, an amber `Status` "{n} need you", and "{n} running". Target: a `Table` with Repo, Running, Queued, Needs you, PRs this week and Spend columns. `projects.list` has `needsYouCount` and `runningCount`; it needs `queuedCount`, `prsThisWeek` and `spendMonth` (spend comes from the key proxy's metering, F-084).
3. **No Recent activity.** Needs an organization feed (PR merged, task stopped, runner joined, snapshot rebuilt) from the event and audit tables.
4. **No right panel.** `PageFrame` already takes `properties`; Home passes none today. Target: merged PRs, spend, runners.
5. **The lede is static** (`home.lede`: "Your organization's projects and what waits on you."). Target: a live sentence of counts. New message keys, with plurals: `home.summary` ("{running} tasks running across {projects} projects, {queued} queued. {merged} pull requests merged today.").
6. **The checklist stays** as the first-run state, above everything, and the right panel is hidden while it shows. Unchanged copy.
7. **The eyebrow date** already matches (`en-GB` weekday, day, month), but it's in the sans face; the target sets it in Plex Mono `--faint` like a key.
8. **Amber.** Today every project with a waiting task gets an amber `Status` pill. Target: amber is a number in the Needs you column, the section's dot, and at most one filled button.
9. New message keys needed: `home.needsYou.title`, `home.needsYou.empty`, `home.openAll`, `home.allProjects`, the table heads, `home.activity.title`, `home.activity.empty`, `home.auditLog`, the per-reason lines and actions above, and the panel labels.

## Text in the picture that's wrong

All the copy in the picture is spelled right. What the build must not copy from it:

1. **The logo mark** (top-left) is drawn as a circle with a slash. It's wrong: use the real Hinge file (`../../kit/logo/export/ostra-hinge-single-color.svg`, 20px), a rounded square with a diagonal channel and a notch.
2. **`Spend, November`** is set in mono. It's a label: IBM Plex Sans 500 11px `--faint`, like `Runner pools` and `Pull requests merged, last 7 days`. Only the figure (`$4,212 of $6,000`) is mono.
3. **The pool names** (`build-fleet`, `k8s-autoscale`, `mac-minis`, `laptops`) render at about 15px. They're 13px body text.
4. **The age column** of Needs you drifts by a few pixels (`4m` sits left of the rest). Right-align it on one edge.
5. **The sidebar rows** render a little taller than 26px, and the section gaps are looser than `shell.js`. Build the sidebar from `shell.js` / `sidebar.tsx`, not from the picture.

Right as drawn, though it may look odd: `CALC-139` in mono on a sans line in Recent activity (keys are mono), and today's bar drawn darker than the rest (a partial day).
