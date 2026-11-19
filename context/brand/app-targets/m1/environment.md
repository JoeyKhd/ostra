# Target: the environment screen (milestone 1)

> **Committed image:** `environment.webp`, downscaled from the 2048×1360 generation to 1440 px wide, so one image pixel is one CSS pixel. Where this file gives sizes in image px at ×1.42, read them as CSS px directly against the WebP.

- **Image:** `environment.webp`, 2048×1360 (3:2). It's a 1440×960 layout drawn at about 1.42×, so divide a measurement by 1.42 to get CSS px.
- **Prompt:** `environment.prompt.txt`. GPT Image 2.6 through Higgsfield, 2 generations. The first was right in layout and copy but drawn about 35% too large. The second, kept here, is the first redrawn at the concepts' density. The references were `app-concepts/html/environment-graphite.png`, `task-b-graphite.png`, `home-graphite.png` and `kit/logo/export/ostra-hinge-single-color-2048.png`, plus the first generation for the second.
- **Route:** `apps/web/src/app/(panel)/projects/[project-id]/environment/page.tsx` → `components/projects/environment-view.tsx`.
- **Features:** F-050 (environments), F-112 (environment detection). Ticket 32 (routers), ticket 37 (the setup screens), demo step 5 in `spec.md`.
- **Status:** a proposed target. The maintainer hasn't approved it yet (`app-design.md`).

> app-design.md rule 5 says concepts are built as real HTML, not image-model mockups. This image is a visual target for the build, not a concept to approve as-is. Build it in real HTML/React, then screenshot that build and compare it with the image.

## Purpose

What every task of a project gets before its agent starts: the setup script, and each repo's variables, secrets and files. A new project lands here on its **draft**, which ostra made from the repo's files (F-112). The admin checks it, fills in the secrets and saves. The image shows that draft, because it's the state with the most on it and the one the milestone 1 demo walks through.

**Scope (milestone 1, `spec.md`):** the concept `environment-graphite` also shows a snapshot, running services, a box size, pools, network rules and checks. None of them exist in milestone 1: snapshots, services and checks are F-051, F-094 and F-054 (milestone 3). They are left out on purpose. Services appear only as what detection **found**, marked `not on host`. When F-051 ships, a **Snapshot** group goes at the top of the properties panel (status, built, from, size), as in the concept.

## Layout (CSS px at 1440×960)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 232px, `--side`, 1px `--line` on its right | the organization switcher (logo, `Acme Corp`, chevrons), `+ New task`, Home, Needs you (amber count); **Projects**: `calculator` expanded (Tasks `4`, **Environment** selected), `billing-platform`, `+ New project`; **Organization**: Runners, Models, GitHub; the member (`AK` Alex Kim) at the bottom. This is the milestone 1 sidebar (`components/shell/sidebar.tsx`), not the concept's full one |
| Top bar | 44px, 1px `--line` below | breadcrumb `calculator › Environment`; on the right the page's one primary button, `Save environment` (admins only) |
| Main column | flexible, padding `28px 40px`, content max about 720px | heading, Setup script, one section per repo, Base image, footnote |
| Properties panel | **340px** (`wideProperties`), 1px `--line` on its left, padding `20px 18px` | Environment; then, on a draft, Found in, Tools, Services |

The image draws the sidebar at about 246px and the panel at about 405px. Build them at 232px and 340px.

### Main column, top to bottom

1. **Eyebrow:** Plex Mono 12px, `--faint`. Draft: `Draft · not saved yet`. Saved: `Saved 2h ago` (`environment.savedAgo`).
2. **Title:** `Environment`, Manrope 700, 24px, letter-spacing −0.015em.
3. **Lede:** 13.5px, `--muted`, one line, max 720px.
   - Just created (`?created`): `ostra drafted this from the repo's files. Check it, fill in the secrets, and save.`
   - Otherwise: `What every task of this project gets before its agent starts: the setup script, and each repo's variables, secrets and files.`
4. **Status line** (only after a save, `role="status"`), 12.5px, under the lede: a green `check` icon and `Saved.` in `--green`. Each save warning on its own line with a `triangle-alert` icon, in `--muted` (never amber).
5. **Setup script** (`Section`, 26px above):
   - Title line: `Setup script` (Plex Sans 600, 13px), then the inline note `runs with bash in the task's workspace, before the agent starts` (12.5px, `--muted`).
   - Under it a code editor: `--surface`, 1px `--line-2`, 8px radius, padding `10px 14px`, Plex Mono 12.5px / line-height 1.75. A gutter of line numbers in `--faint`, right-aligned, about 24px wide, 14px before the code. Grows with its text; at least 3 lines. Placeholder `pnpm install --frozen-lockfile`.
   - Content shown: `corepack enable` / `pnpm install --frozen-lockfile` / `pnpm prisma generate`.
6. **One section per repo** (milestone 1 has one):
   - Title line: the repo's `owner/name` in **Plex Mono 600, 13px** (`acme/calculator-web`), its entry count in mono 11.5px `--faint` (`5`). On the right: `Written to` (12.5px `--muted`) and a small mono input, 26px tall, about 82px wide, holding the env file path (`.env`).
   - A `Table`. Header row 30px, 11.5px `--faint`, weight 500, 1px `--line` under it: `Name` · `Value` · `During setup` · (remove). Body rows **40px**, 1px `--line` under each.

| Column | Width | Contents |
|---|---|---|
| Kind | 28px | Lucide 15px, `--faint`: `variable` for a variable, `key-round` for a secret, `file` for a file. It carries an `aria-label` (`Variable` / `Secret` / `File`) |
| Name | about 210px | Plex Mono 13px, `--text`: `NODE_ENV`, `API_URL`, `DATABASE_URL`, `STRIPE_TEST_KEY`, the path `config/local.json` |
| Value | flex | variable: the value in Plex Mono 13px (`development`, `http://localhost:4000`). Secret: a password input, 240×28px, `--surface`, 1px `--line-2`, 7px radius, placeholder in `--faint` (`No value yet`, or `Set: type to replace it` when one is stored), then a `secret` `Badge` (outline, lock icon 12px, 22px tall). File: `3 lines` in mono `--faint`, then a teal `Edit` link (no underline) |
| During setup | 96px, centred | a 14px `Checkbox`; checked is filled `--teal` with an `--ink` tick. Tooltip: `Also available while the setup script runs.` |
| Remove | 28px, right | ghost icon button, Lucide `x` 14px, `--faint`, `--red` on hover. `aria-label="Remove"` |

   - Variable names and values are inputs that read as text: no border and no fill at rest, 1px `--line-2` and `--surface` on hover and focus. A secret without a value keeps its border, because it's the thing left to fill in.
   - Under the table, 8px down: three ghost buttons, 24px tall, `--muted` text, `plus` icon 13px, no border: `Variable`, `Secret`, `File`.
   - No entries yet: one 40px row in `--faint`: `No variables, secrets or files yet.`
7. **Base image** (`Section`): title `Base image` and the inline note `docker executor only`. Under it a mono input, 320×32px, placeholder `ostra's base image`. The full sentence (`environment.baseImageHelp`) is its `Tooltip` and its `aria-describedby`.
8. **Footnote,** 22px below: Lucide `shield-check` 13px `--faint`, then 12.5px `--muted`: `For dev and test credentials, never production ones. A secret reaches only its own repo's checkout.` (F-050 requires the panel to say this.)

### Properties panel

Groups with a 11px `--faint` label (weight 500), key/value rows 30px (`PropRow`, key column 96px, 12.5px), a 1px `--line` between groups (`PropGroup`).

1. **Environment** (always):
   - `Status`: a 7px dot and the word. Draft: `--faint` dot, `Draft`. Saved: green dot with its ring, `Saved`, then ` · 2h ago` in `--muted`.
   - `Repo`: `acme/calculator-web` in mono. With several repos, one row each.
   - `Entries`: `2 variables · 2 secrets · 1 file`, counted from the rows. Leave out a kind that has none.
2. **Found in acme/calculator-web** (draft only, from `environments.detect`): one item per reason, 6px apart: the file in Plex Mono 12.5px `--text`, the finding under it in 12.5px `--muted`.
   - `pnpm-lock.yaml` / `pnpm 9, install with --frozen-lockfile`
   - `.nvmrc` / `Node 22`
   - `.env.example` / `4 variables, 2 look like secrets`
   - `docker-compose.yml` / `2 services`
3. **Tools:** outline `Badge`s in mono 12px, 22px tall: `node 22.11`, `pnpm 9.12`.
4. **Services:** one 30px row each: the name in mono `--text` (`postgres`, `redis`), the image in mono `--faint` (`postgres:16`, `redis:7`), and on the right an outline `Badge`, mono 11px, `--muted`: `not on host`. Under them, 12px `--faint`: `A personal runner doesn't start services. They come with milestone 3.`

## States and copy

| State | What changes |
|---|---|
| Loading | eyebrow and sections replaced by `Skeleton` lines (title stays); the panel shows the Environment group with skeleton values |
| Draft, detecting | as the image, but the panel's detection groups show one faint line: `Reading the repo's files…` |
| Draft, detected | the image |
| Draft, nothing found | `Found in …` holds one line in `--muted`: `Nothing to go on: the repo has no lockfile or setup file ostra knows.` No Tools or Services group |
| Saved | eyebrow `Saved 2h ago`, the ordinary lede, Status `Saved · 2h ago`. No detection groups (detection runs only on a draft) |
| Saving | the top-bar button reads `Saving…` and is disabled |
| Saved just now | the status line `Saved.`, plus any warnings (above) |
| Save failed | under the lede, `role="alert"`, 12.5px `--red`: the error text (`errorText`) |
| Load failed | the same alert in place of the sections |
| Not an admin | no `Save environment`, no remove buttons, no add buttons; every field read-only. A stored secret reads `set` in `--muted`, an empty one `No value yet` in `--faint`. Checkboxes disabled |
| Editing a file | `Edit` opens a `Sheet` on the right, 420px: `Path in the repo` (mono `Input`), `Content` (mono `Textarea`, at least 12 lines), `During setup` (`Checkbox`), and `Done` (primary). Saving still happens with `Save environment` |
| Several repos | one repo section each, in the repos' order; the properties panel has a `Found in <repo>` group each |
| Narrow (below 1280px) | the panel drops under the main column (`PageFrame` already does this); the table's `During setup` column becomes a checkbox labelled `during setup` under the value |

## Components (shadcn/ui names)

`Sidebar` (existing `components/shell/sidebar.tsx`), `Breadcrumb` (in `PageFrame`), `Button` (`default` = the Shell primary; `ghost` for the add and remove buttons), `Input`, `Textarea`, `Checkbox` (new: today a native `<input type="checkbox">`), `Badge` (outline; today `Chip` in `ui/status.tsx`), `Table` / `TableHeader` / `TableRow` / `TableHead` / `TableCell`, `Separator` (the panel's group lines, via `PropGroup`), `Tooltip` (new), `Sheet` (existing `ui/sheet.tsx`), `Skeleton` (new). Lucide icons: `box`, `variable`, `key-round`, `file`, `lock`, `plus`, `x`, `shield-check`, `check`, `triangle-alert`.

## Tokens (`app-concepts/html/graphite.css`)

> **Scale.** The sizes and colours below are `graphite.css`'s. The panel is built at the approved pictures' scale, which wins on size, spacing and contrast: body 14.5px, dense rows 14px, secondary 13px, small 12px, title 26px, `--muted` `#B4B7BB`, `--faint` `#8B8E93`, buttons 30px, a 46px top bar and a 320px properties panel (380px with a form). The measured values are in `../m1/README.md`, "Scale".

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | code editor, inputs, Badge fill |
| `--raise` | `#17181B` | row hover |
| `--line` | `#1F2023` | hairlines, panel and sidebar edges |
| `--line-2` | `#2A2C30` | control borders |
| `--text` | `#EDEDEE` | names, values, titles |
| `--muted` | `#9A9DA3` | lede, inline notes, keys, findings |
| `--faint` | `#64676D` | eyebrow, headers, icons, placeholders, line numbers |
| `--sel` | `#1A1B1E` | the selected nav row |
| `--teal` | `#6FB8AA` | `Edit` link, checked checkbox |
| `--green` | `#4FB286` | `Saved` dot, `Saved.` |
| `--red` | `#E5675C` | errors, remove on hover |
| `--amber` | `#FFB224` | only the sidebar's Needs you count. Nothing on this page is amber |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | the primary button |

Type: Manrope 700 24px (title); IBM Plex Sans 13px body, 12.5px secondary, 11–11.5px labels, 600 for section titles, 500 for buttons; IBM Plex Mono for names, values, paths, the env file, images, tools and code. Radii: 7px controls, 8px the code editor, 6px badges.

## Wrong in the image

Build the copy and details in this file, not these:

- The variable icon is drawn as the text `{x}`. Use Lucide `variable`.
- `Edit` is underlined. It's a teal link with no underline (underline on hover only).
- The checked checkbox is a green-teal; use `--teal` exactly.
- The sidebar is about 246px and the properties panel about 405px. Build 232px and 340px.
- The section gaps are a little tight (about 22px). Use the `Section` spacing, 26px.
- The image has no tooltips, loading, saved or error states: they're in the table above.

All the visible copy in the image is spelled right.

## Differences from the current code

`environment-view.tsx` as of 2026-11-19:

1. **Eyebrow:** `Draft` → `Draft · not saved yet` (new key, e.g. `environment.draftEyebrow`).
2. **Created lede:** `environment.createdLede` → `ostra drafted this from the repo's files. Check it, fill in the secrets, and save.`
3. **Setup script help** moves from a paragraph under the title to an inline note on the title line, shortened to `runs with bash in the task's workspace, before the agent starts`. Its second sentence (`Its output shows on the task page.`) is dropped. The plain `Textarea` becomes a code editor with a line-number gutter.
4. **Entries are a table** with a header row (`Name`, `Value`, `During setup`) instead of a wrapping row of bordered inputs. Names and values read as text until hovered or focused; only an empty secret keeps a visible box. Each secret gets a `secret` badge.
5. **Files** collapse to one row (`config/local.json · 3 lines · Edit`) and are edited in a `Sheet`, instead of a path input and a textarea in the list.
6. **Env file:** `Variables and secrets go to` → `Written to`, moved to the right of the repo's section title. The section title is the repo name in mono.
7. **Add buttons:** the same three ghost buttons, under the table, 24px.
8. **Base image:** the help paragraph becomes the inline note `docker executor only`, with the full sentence as a tooltip. Input 320px instead of 420px.
9. **New footnote** with the dev-and-test-credentials line (F-050 asks for it; the code doesn't show it).
10. **Properties panel:** a new **Environment** group (Status, Repo, Entries) that's always there, so the panel isn't empty on a saved environment. Detection's groups stay, restyled: findings as mono file over muted text; tools as mono badges.
11. **`not on host`** chips are neutral (`--muted`), not amber: they don't need the member. The services help is shortened to `A personal runner doesn't start services. They come with milestone 3.`
12. **Save warnings** are `--muted` with an icon, not amber.
13. **Checkbox** becomes a shadcn `Checkbox` filled `--teal`, in its own column, with the help as a tooltip instead of a `title` attribute.
14. **Loading** shows skeletons instead of an empty page.
