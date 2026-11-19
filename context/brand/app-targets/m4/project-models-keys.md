# Target: a project's Models and keys (milestone 4, screen 20)

> **Committed image:** `project-models-keys.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Prompt:** `project-models-keys.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation, kept as made. References: the approved `app-targets/m4/project-access` 2048 original (the screen this one starts from, spec section 12), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route (new):** `apps/web/src/app/(panel)/projects/[project-id]/settings/models/page.tsx` → `components/projects/project-models-view.tsx`. A settings tab between `Repos` and `Access`.
- **Features:** F-135 (keys per project), F-087 (project access, for who sees what). ADR 0065, "Keys per project" and "Where it's enforced". Spec section 3 steps 16 and 17. Tickets 45 (`planProviderChange`, `setProjectProviders`, `chooseModelProvider`), 50 (`projects.providers`, `.previewProviders`, `.setProviders`, `.chooseModelProvider`), 53 (this screen).
- **Status:** approved 2026-11-19 by the lead on the maintainer's delegation, pending the maintainer's review (ticket 52's `## Comments`).

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

Which keys this project's tasks may use, and which key serves each model its profiles name. Only an organization admin changes it (ADR 0065, Q277): a key is billed to whoever issued it. Everyone who can open the project reads it, by name, so a member knows which key every task here runs on. No token appears anywhere, for anyone.

The picture shows Alex Kim, an organization admin, on `northwind-portal`: its own list, with `spare-openai` just ticked and `globex-openrouter` just unticked, **before saving**. The panel is the save's preview: what moves, and what is left with no key.

## Layout (CSS px at 1440 wide)

| Region | Size | Contents |
|---|---|---|
| Sidebar | the shell's | the project expanded, `Settings` selected |
| Top bar | 46px | breadcrumb `northwind-portal › Settings › Models and keys`. Right, **only while the list has unsaved changes** (organization admins): outline `Discard`, 8px, primary `Save list`. Otherwise nothing: a choice (`Change`) applies on its own |
| Main column | padding `28px 40px`, content `max-width: 760px` | tabs, title, lede, Keys it may use, Models its profiles use, the token line |
| Properties panel | 320px, 1px `--line` on its left | the preview while there are unsaved changes; otherwise the project's summary |

### Main column, top to bottom

1. **Settings tabs** (`project-access`'s row): `Ticket template`, `Repos`, `Models and keys`, `Access`, `Audit log`. `Models and keys` is shown to everyone who can open the project (it's read-only for all but organization admins), so a project member sees `Models and keys` and `Access`.
2. **Title** `Models and keys`. **Lede** (`--muted`): `Which keys northwind-portal's tasks may use, and which key serves each model.` (the project's name in mono).
3. **Keys it may use** (26px below). `h2` 13px 600. A `RadioGroup` of two 48px rows, `project-access`'s form (label 500 `--text`, description 13px `--muted` on the same line; the chosen row `--sel`, 6px radius):

| Option | Label | Description |
|---|---|---|
| follow | `Follow the organization's default` | `Today: acme-anthropic.` (the default list's names in mono, comma-joined; empty: `Today: no key.`) |
| own | `Use this project's own list` | `Only the keys ticked below.` |

   Under the own row, indented 28px, one 40px checkbox row per organization provider, hairlines between: a 16px `Checkbox`, the name in mono `--text` (a 220px column), then `api.openai.com · 1 model` in 13px `--muted`; right-aligned, `added` or `removed` in 12px `--faint` against the saved list. Choosing `Follow` hides the checkboxes and shows the default list's keys as plain rows (no checkbox). Switching to `own` starts from a copy of the default list (ADR 0065).
4. **Models its profiles use** (28px below). `h2` + count. A `Table`, no box, header 30px 12px `--faint`: `Model`, `Served by`, `Profiles`, and an empty last column. Rows 44px. One row per model name any profile this project may use names (its default profiles, and profiles usable here):
   - Model: the logo and the name (a custom model: its endpoint ID in mono).
   - Served by: the key's name in mono `--text`. With unsaved changes, a model whose key changes shows the old key struck through in `--faint`, `→`, and the new key, or `No key` in `--red`. A model with no key at all, saved: `No key` in `--red` with Lucide `triangle-alert` 13px.
   - Profiles: the profile names, comma-joined, `--muted`.
   - Last column: teal `Change` (organization admins only): a `Popover` with the providers on the list that list the model, as radios, and `Save choice` (`projects.chooseModelProvider`, applies at once, an audit entry). Only one provider on the list lists it: `Change` is replaced by `only key` in `--faint`.
5. **The token line** (14px below), 13px `--faint`, Lucide `lock` 13px: `Members and project admins see the key names here. Nobody sees a token.`

### Properties panel

**With unsaved changes (the picture):** label `Before you save`; title (15px 600) `This save changes 2 models` (`Nothing moves` when nothing does). One row per model, 44px, a 15px icon and two lines (the name 14px `--text`; the effect 13px):
- `arrow-right` `--muted`: `moves to spare-openai` (`--muted`, the key in mono)
- `circle-slash` `--red`: `has no key here` (`--red`)
- `check` `--faint`: `stays on northwind-anthropic` (`--muted`)

Then `Separator`, label `What happens`, 13px `--muted`: `1 idle box holding globex-openrouter's key is released now. 2 tasks using Kimi K3.1 Pro wait queued until an organization admin picks a key.` (each clause only when its count isn't 0; ADR 0065: a running turn finishes first, and its box is released after it). The preview is `projects.previewProviders`; `Save list` sends the preview's version, and a `CONFLICT` shows `Someone changed the lists since this preview. Check it again.` in `--red` and reloads it.

**Without changes:** label `northwind-portal`; rows `Keys` (`Own list` / `The default list`), `Changed by` (the name), `Last change` (mono date). For organization admins, a teal `Audit log →` to the project's audit tab filtered to `project.providers-changed` and `project.model-choice-changed`.

## States and copy

| State | What shows |
|---|---|
| **Own list, unsaved changes** (the picture) | as above |
| **Following the default** | the `Follow` row chosen; the default's keys as plain rows; the models table; no Change on a model whose choice is the organization's (`Change` there reads `Set in Models` and links to the organization's Models page) |
| **Read-only: a project admin or member** | the same page with no radios (the chosen label and description as text), no checkboxes (the keys on the list as plain rows: name, host, model count), no `Change`, no top-bar buttons, and under the lede, 13px `--faint`: `Only an organization admin changes this project's keys.` The token line stays |
| **A model with no key, saved** | `No key` in `--red` in its row; above the table, one line, `triangle-alert` 15px `--text`, 14px `--text`: `No key for Kimi K3.1 Pro in northwind-portal.` then `--muted` `Tasks on it wait until an organization admin picks one.` (for an organization admin: `Tick a key that lists it, or change the profile's model.`) |
| **An empty own list** | the checkbox rows all unticked; every model's row reads `No key`; the preview says so |
| **Saving** | `Save list` disabled with a 12px `Loader`; on success a 4s status line under the title, Lucide `check`: `Saved. 1 model moved, 1 has no key.` |
| **Loading** | tabs, title and lede at once; two radio rows with skeleton descriptions; three `Skeleton` rows in the table |
| **Error** | `role="alert"`, `--red`: `errorText(error)` under the section |
| **Narrow** | the panel drops under the page; below 640px, `Profiles` moves under the model's name |

Demo data (fixtures): `northwind-portal`'s own list `northwind-anthropic` + `spare-openai` (added) − `globex-openrouter` (removed); profiles `Builder`, `Careful`, `Reviewer`, `Fast`.

## Components

`Tabs` as links, `RadioGroup`, `Checkbox` (`components/ui/checkbox.tsx`), `Table`, `Popover` + `RadioGroup` (a choice), `Button`, `Skeleton`, `Separator`, `PageFrame`, `PropGroup`, `PropRow`. Icons: `lock`, `arrow-right`, `circle-slash`, `check`, `triangle-alert`, `loader`.

## Tokens

The approved pictures' scale (`../m1/README.md`, "Scale"). `--red` only for `No key` and `has no key here`; `--teal` for `Change` and `Audit log →`; no amber, no green on the page.

## Open points (settled by recommendation, 2026-11-19; recorded in ticket 53's `## Comments`)

1. **Where the tab sits.** Settled: a settings tab, between `Repos` and `Access`, visible to everyone who can open the project. `project-access` and `project-repos` draw four tabs; their row gains this one.
2. **The follow row's description.** The picture reads `acme-anthropic, today`. Settled: `Today: acme-anthropic.`
3. **Which models the table lists.** Settled: the model names of every profile usable in this project (default profiles first), so a member sees the key behind any profile they can pick.
4. **Choosing a model's key on a project that follows the default.** Settled: not here. The project uses the organization's choices; `Set in Models` links to them.

## Differences from the current code

1. New route and view; `settings/layout.tsx`'s tab row gains `Models and keys`.
2. No new primitive: `Checkbox`, `Popover`, `RadioGroup` and `UnderlineTabs` are in `components/ui/`.
3. Messages: a `projectModels` namespace, with plurals.

## Wrong in the image

- **The panel** starts at about x=1090, about 350px. It's 320px.
- **The panel's group labels** `What happens` and `northwind-portal` are drawn bold; they're 12px 500 `--faint`. `Before you save` is right.
- **The radio labels** are 600; they're 500 (`project-access`).
- **The follow row's description** reads `acme-anthropic, today`; it's `Today: acme-anthropic.` (open point 2).
- **The checkbox rows** don't share one x for the name: `acme-anthropic` sits 4px right. One grid.
- **The top bar's `Discard`** is drawn heavier than an outline button; it's the outline `Button`.
- **The sidebar** comes from the shell.
- The picture shows no read-only, follow, no-key, saving, loading or narrow states: they're in the table above.

All other visible copy is spelled right.
