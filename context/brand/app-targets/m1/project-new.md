# Target: Create a project (`/projects/new`)

> **Committed image:** `project-new.webp`, downscaled from the 2048×1360 generation to 1440 px wide, so one image pixel is one CSS pixel. Where this file gives sizes in image px at ×1.42, read them as CSS px directly against the WebP.

- **Image:** `project-new.webp`, 2048×1360 px, a 1440×960 CSS px viewport at about 1.42×. Generated with Higgsfield `gpt_image_2_6` (3:2, 2k, high), the graphite concepts (`task-b`, `environment`, `home`) and the Hinge logo as references. Prompt: `project-new.prompt.txt`.
- **Status:** a candidate target for milestone 1, not yet approved by the maintainer (`app-design.md`: a target needs the maintainer's yes).
- **Features:** F-086 (projects), F-112 (environment detection). Data: `apps/web/src/components/projects/new-project-view.tsx`, `packages/api/src/routers/projects.ts`, `github.ts`, `environments.ts` (`detectionViewSchema`).

## Purpose

An organization admin makes a project: a name, the repos it works on (from the GitHub App's installation), an optional tracker, and, before committing, a look at what ostra will draft for its environment. Creating it lands on the environment page with the draft (`/projects/{id}/environment?created=1`). Nothing runs yet.

## Layout

The shared shell, unchanged (`app-concepts/html/shell.js`): 232px sidebar with no item selected, a 44px top bar. Build the sidebar from the shell component, not from the image (see "Wrong in the image").

| Region | Size | Contents |
|---|---|---|
| Top bar | 44px, hairline under | Breadcrumbs `Projects › Create a project` (last crumb `--text`, weight 500). Right: one quiet `Button` (outline) `Cancel` → back to `/projects` or `/`. No primary button in the bar: the page's one primary is the form's submit. |
| Page column | `1fr`, padding `28px 40px 20px` | Heading, then the form as three sections and a footer. Form content `max-width: 680px`. |
| Properties panel | 340px (it pairs with a form), `border-left: 1px var(--line)`, padding `20px 18px` | The environment draft preview for the selected repo. |

### Page column, top to bottom

1. **Heading.** `h1` "Create a project" (Manrope 700, 24px, `letter-spacing: -0.015em`). Lede, `--muted`, 13.5px, max 720px:
   "A project is its repos, an optional tracker and one environment. Tasks run against it and open their pull requests there."
2. **Name** (margin-top 20px). `Label` "Name" (12px, 500, `--muted`), `Input` 32px tall, **360px wide**, value in IBM Plex Sans. Help under it, 12px `--faint`:
   - empty: "Lowercase letters, digits and hyphens make its slug."
   - typed: "Slug: {slug}" (slug in IBM Plex Mono).
   - Picking the first repo fills an empty name with the repo's short name (current behaviour, keep it).
3. **Repositories** (`.section`, margin-top 26px). Section line (`.shead`): `h2` "Repositories" (13px, 600), count "{n} selected" in faint mono 11.5px, right: teal link "Manage on GitHub ↗" (opens the installation's settings on GitHub, new tab).
   - One line of two controls, 8px gap: a `Select` for the installation (GitHub mark + account login + chevron, ~200px; hidden when there's only one installation, replaced by the login as plain muted text) and an `Input` with a search icon, placeholder "Filter repositories", filling the rest. The filter is client-side over the listed repos.
   - The list: plain rows, no box. 38px rows, `border-top: 1px var(--line)`, last row also `border-bottom`. Each row is one `<label>`: a 14px `Checkbox`, `full_name` in mono 12.5px, a 12px `lock` icon (`--faint`, `aria-label` "Private") after private repos, the default branch in faint mono 12px right-aligned. The selected row has `background: var(--sel)`; hover is `--raise`. Checked checkbox: filled `--shell` with an `--ink` tick (never amber, never teal). The list scrolls inside `max-height: 360px` (about 9 rows).
   - Help under the list, 12px `--faint`: "The GitHub App sees {n} repositories in {account}."
4. **Tracker** (`.section`). Section line: `h2` "Tracker", then "optional" in faint 11.5px. A `RadioGroup` as two 38px hairline rows: the radio, the label (13px, `--text`), then a faint description:
   - `None` (default, checked): "Tasks start from prompts typed in ostra."
   - `Linear`: "Tickets on a team's board become tasks." Right: teal link "Connect Linear →" when the organization has no Linear connection. When it has one, the row's right side becomes a `Select` of the Linear teams ("Team: {name}").
5. **Footer** (margin-top 26px, one hairline above, 20px padding-top): the page's single primary `Button` "Create the project" (32px, `--shell` fill, `--ink` text, 600), and beside it, 12.5px `--muted`: "Nothing runs yet. You review the environment next."

### Properties panel: Environment draft

Group labels all use the `.props h5` style (11px IBM Plex Sans 500, `--faint`, never bold or white), with counts right-aligned in faint mono. Groups are split by `.sep` hairlines (14px margin).

1. **Header:** "Environment draft", right: the repo's `full_name` in faint mono.
2. **Key/value rows** (`.row2`, 84px key column, 30px rows, 12.5px; keys `--muted`, values mono `--text`):
   - `Base image` → `ostra/base:node22` (or "ostra's base image" when `baseImage` is null)
   - `Tools` → each `tool version`, joined with ` · ` (`node 22.11 · pnpm 9.12`)
   - `Found in` → "{n} files"
   - Under it, the files from `reasons[].file`, one per line, mono 12px `--faint`, on the same left edge as the keys. Each file's `title` attribute carries its `finding`.
3. **Setup script:** label, then a `.code` block (`--surface`, 1px `--line`, radius 8px, mono 12px/1.75) with faint line numbers, from `setupLines`.
4. **Variables** {count}: 28px rows with a hairline between, name in mono 12.5px, `source` (e.g. `.env.example`) right-aligned in faint mono. A variable with `secret: true` gets a 12px `lock` icon before its source.
5. **Services** {count}: rows with a grey `.dot` (`--faint`), `image ?? name` in mono, right: faint "not on host". `title`/tooltip: "A service needs a container runtime, so a personal runner (host) doesn't start it. Services come with milestone 3." (`environment.servicesHelp`).
6. **Note** (12px `--faint`, `info` icon 13px): "Read from the repo's files. No agent, no model."

With several repos selected, the panel shows one draft per repo, stacked, each under its own "Environment draft · {full_name}" header; the most recently checked repo is first.

## States

| State | What shows |
|---|---|
| Not an admin | `AdminOnly`: page title "Create a project" and "Only an admin of the organization can see this page." Unchanged. |
| Loading the GitHub connection | The shell and the heading; the form area shows three 38px `Skeleton` rows. No blank page. |
| GitHub not connected | Under the lede, a `.section` "Connect GitHub first", body `--muted` "A project's repo comes from the GitHub App's installation.", primary `Button` "Connect GitHub" → `/organization/github`. The properties panel is not rendered (page uses `.content.full`). |
| Repos loading | Five `Skeleton` rows in the list; the filter is disabled. |
| Installations or repos error | An inline error line in `--red` 12.5px with a `circle-alert` icon, under the section line: `errorText(error)`. The list keeps its last data if it had any. |
| No repos in the installation | One faint line in place of the list: "The App sees no repository in this installation. Add one on GitHub." The "Manage on GitHub ↗" link stays. |
| Filter matches nothing | One faint 38px row: "No repository matches "{query}"." |
| No repo selected | Primary button disabled. Panel: header "Environment draft", then faint 12.5px "Pick a repository to see what ostra finds in it." |
| Reading the selected repo | Panel header with the repo name, then three `Skeleton` key/value rows and the faint line "Reading {full_name}…". |
| Detection found nothing | Panel: `Base image` row only, then faint "Nothing to go on: the repo has no lockfile or setup file ostra knows." (`environment.nothingFound`). Creating still works. |
| Detection failed | Panel: `--red` line `errorText(error)`, and faint "You can still create the project and fill in the environment by hand." Creating still works. |
| Ready (the image) | Name filled, one repo checked, tracker None, draft shown. |
| Creating | Primary button disabled, label "Reading the repo…" (`projects.creating`), with a 13px spinning `loader-circle` icon. Form controls disabled. |
| Create failed | `--red` line with `circle-alert` above the footer: `errorText(error)`. Form re-enabled. |
| Created | Redirect to `/projects/{id}/environment?created=1` (unchanged). |

## Components (shadcn/ui names)

`Button` (variants `default` = Shell primary, `outline` = Cancel), `Input`, `Label`, `Select` (installation; later the Linear team), `Checkbox`, `RadioGroup` + `RadioGroupItem`, `Skeleton`, `Tooltip` (service help, file findings), `Separator` (panel hairlines). Breadcrumbs: `Breadcrumb`. Icons: Lucide 15px, stroke 1.75: `search`, `lock`, `chevron-down`, `arrow-up-right`, `arrow-right`, `info`, `circle-alert`, `loader-circle`; the GitHub mark is the one brand glyph.

## Tokens (`app-concepts/html/graphite.css`)

> **Scale.** The sizes and colours below are `graphite.css`'s. The panel is built at the approved pictures' scale, which wins on size, spacing and contrast: body 14.5px, dense rows 14px, secondary 13px, small 12px, title 26px, `--muted` `#B4B7BB`, `--faint` `#8B8E93`, buttons 30px, a 46px top bar and a 320px properties panel (380px with a form). The measured values are in `../m1/README.md`, "Scale".

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page and panel background |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | inputs, select, code block |
| `--raise` | `#17181B` | row hover |
| `--sel` | `#1A1B1E` | selected repo row |
| `--line` | `#1F2023` | row hairlines, panel border, separators |
| `--line-2` | `#2A2C30` | input, select, checkbox and outline-button borders |
| `--text` | `#EDEDEE` | values, repo names, labels of radio rows |
| `--muted` | `#9A9DA3` | lede, field labels, panel keys, footer note |
| `--faint` | `#64676D` | help text, counts, branches, sources, group labels, service dots |
| `--teal` | `#6FB8AA` | "Manage on GitHub ↗", "Connect Linear →" |
| `--red` | `#E5675C` | errors |
| `--shell` | `#F3F0E8` | primary button fill, checked checkbox fill |
| `--ink` | `#0C1D21` | text on the primary button, checkbox tick |
| `--amber` | `#FFB224` | **not used on this page** (nothing here needs the member); only the shell's own "Needs you" count and project dots |

Type: Manrope 700 24px (title); IBM Plex Sans 13px body, 12px labels and help, 13px/600 section titles, 500 for buttons; IBM Plex Mono 12.5px for repo names, slugs, branches, files, variable names, images, commands. Radii: 7px controls, 8px code, 6px small buttons. Control height 32px, rows 38px, panel rows 30px.

## Differences from the current code

`new-project-view.tsx` today:

1. **No properties panel.** The page is a single 520px form on `PageFrame`. Target: the two-column `.content` grid with a 340px panel.
2. **No detection preview before creating.** Detection only runs inside `projects.create` and is shown on the environment page afterwards. Target needs a new admin query that runs `detectRepoEnvironment` for `{ installationId, fullName }` without creating anything, returning `detectionViewSchema` (cache it per repo and default-branch head so selecting is cheap). The project page still owns the editable draft.
3. **One repo, by radio.** Target: `Checkbox` rows and "{n} selected". F-086 builds one repo in milestone 1, so until several repos land, build the same row look with single selection (checking one unchecks the other) and the count reading "1 selected"; the schema and `projects.create` input change when several repos ship.
4. **No tracker section.** Target adds "Tracker (optional)" with None and Linear. Linear is milestone 2 (`checklist.linear.later`): in milestone 1 render the section with `None` checked and the Linear row disabled, its right side reading "milestone 2" in faint text instead of "Connect Linear →"; or leave the section out until F-005 starts. The maintainer picks.
5. **Installation as a bare `<select>`** with label "Installation". Target: a shadcn `Select` with the GitHub mark, on one line with a new client-side filter `Input`.
6. **Name input full form width (520px)**, placeholder "test1". Target: 360px, no placeholder needed beyond the help line.
7. **Repo rows** use `px-1`, a native radio tinted teal. Target: no side padding beyond the checkbox's 12px inset, Shell-filled checkbox, lock after the name, branch right-aligned.
8. **Footer help under the button** ("ostra reads the repo's files and drafts its environment. Nothing runs yet."). Target: beside the button, new copy "Nothing runs yet. You review the environment next."
9. **Loading shows an empty frame** (`{null}`). Target: heading plus `Skeleton` rows.
10. **Lede copy** changes from "A project is one repo and its environment. …" to the target's, once several repos and the tracker exist; in milestone 1 keep the current lede, which is true today.
11. **Top bar** has no action. Target adds `Cancel`.

New message keys this needs in `apps/web/messages/en.json`: `projects.reposSelected`, `projects.filterRepos`, `projects.noMatch`, `projects.reposSeen`, `projects.manageOnGitHub`, `projects.tracker`, `projects.optional`, `projects.trackerNone`, `projects.trackerNoneHelp`, `projects.trackerLinear`, `projects.trackerLinearHelp`, `projects.connectLinear`, `projects.draftTitle`, `projects.draftEmpty`, `projects.draftReading`, `projects.draftNote`, `projects.draftFailed`, `projects.foundIn`, and a new `projects.createHelp`.

## Wrong in the image (build the copy and shell from this file)

The image's text is correct and legible everywhere; no garbled words. These visual details differ from what to build:

- **Sidebar:** the project rows lost their amber "needs you" dots, and the `Models` icon is a cube instead of `cpu`. Build the sidebar from the shared shell, not from this image.
- **Sidebar type** renders a little larger than the concepts' 13px; use the shell's sizes.
- **Double hairline** above the footer: the tracker list's bottom border and the footer's top border sit 40px apart. Keep only the footer's top border, or drop it and use 26px of space.
- **Found-in file list** sits 2–4px right of the key column. Align it to the keys.
- **Variables:** the image shows no secret marker. `STRIPE_SECRET_KEY` is `secret: true` in this demo and gets the `lock` icon (above).
- **Name input value** is in IBM Plex Sans; that's intended (it's a name, not an ID). The slug in the help line is mono.
