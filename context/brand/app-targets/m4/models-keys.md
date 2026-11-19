# Target: Models, a provider as a key (milestone 4, screen 19)

> **Committed image:** `models-keys.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Prompt:** `models-keys.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation, kept as made. References: the approved milestone 1 original `app-targets/m1/models.png` (the screen this one starts from, spec section 12), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route (existing):** `apps/web/src/app/(panel)/organization/models/page.tsx` → `components/models/models-view.tsx`, grown. The selection is in the URL (`?provider=<id>`, `?model=<id>`, `?add=1`).
- **Features:** F-135 (keys per project), F-088 (providers and models), F-037 (spend). ADR 0065, "Keys per project"; ADR 0033. Spec section 3 step 16, section 5.5. Tickets 45 (domain), 50 (`providers.list` with projects and spend, `providers.setDefaultList`, `providers.confirmChoice`), 53 (this screen).
- **Status:** approved 2026-11-19 by the lead on the maintainer's delegation, pending the maintainer's review (ticket 52's `## Comments`).

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

An organization admin holds several keys that may serve the same models, one per client. The page answers, at a glance:

1. **Which keys are there, and who uses each?** Each provider is one key (a base URL and a token). Its line names every project that uses it, through the default list or its own list. A key on no list says so: nothing uses it.
2. **What does a new project get?** The organization's default list, and the projects that follow it.
3. **Is anything waiting on me?** The upgrade's choices to confirm (ADR 0065, "The upgrade"): a model that existing profiles named on two keys, where ostra kept the oldest profile's.

The models table of milestone 1 stays below these sections (scrolled out of the picture), unchanged except for its Provider column, which now reads the key's name.

Only organization admins see the page (`AdminOnly` as today).

## Layout (CSS px at 1440 wide)

The shared shell, unchanged. Build the sidebar from `components/shell/sidebar.tsx`, never from the picture.

| Region | Size | Contents |
|---|---|---|
| Sidebar | the shell's | `Models` selected (`--sel`) |
| Top bar | 46px, 1px `--line` below | breadcrumb `Acme Corp › Models`. Right: outline `Button` `Add provider` (`plus`). No primary button on the page unless the add form is open (then `Save provider` in the panel, as milestone 1) |
| Main column | flexible, padding `28px 40px`, content `max-width: 760px` | title, lede, Default list, Keys, To confirm, Models (milestone 1's table) |
| Properties panel | 320px, 1px `--line` on its left, padding `20px 18px`; 380px when a form is in it | the selected key, the add form, or a model |

### Main column, top to bottom

1. **Title** `Models` (Manrope 700, the title size). **Lede** (lede size, `--muted`, max 720px): `Each provider is one key: a base URL and a token. A project uses only the keys on its list, so one client's work never runs on another client's key.`
2. **Default list** (26px below). Section line: `h2` `Default list` (13px 600) and, at its right, a teal link `Edit` (organization admins; it's the only audience). One 40px row between hairlines: Lucide `list` 15px `--faint`, then each provider on the list as an outline chip (mono 12.5px `--text`, 24px tall, 1px `--line-2`, radius 6px), then `Followed by 3 projects: calculator, web-storefront, data-pipeline` (secondary size `--muted`; the names in mono `--text`, each a link to the project's `Models and keys` tab). More than four names: the first three and `and {n} more`. None: `Followed by no project.` An empty list: the chips' place reads `Empty: a new project has no key until an admin picks one.` in `--faint`.
   Under the row, 13px `--faint`: `A new provider joins no list until an admin ticks one.` (ADR 0065: the organization's first provider is the exception; on an organization with one provider, the line reads `Your first provider is on it, so new projects can start tasks.`)
   **Edit** opens the same checkbox list as `project-models-keys` (every provider, ticked or not) inline in place of the row, with `Cancel` and a primary `Save list`; the save shows the same preview in the panel (`projects.previewProviders` for each following project, summed by `providers.previewDefaultList`, see "Data") before it applies.
3. **Keys** (28px below). Section line `Keys` and the count in faint mono. One block per provider, a 1px `--line` hairline above each and under the last, padding `14px 12px`, no box. Sorted by name.
   - **Line 1** (28px): the provider's logo when its base URL's host is a known vendor's (`api.anthropic.com`, `api.openai.com`, `openrouter.ai`, `generativelanguage.googleapis.com`; else Lucide `server`), 15px `--muted`; the name in mono 14px `--text` (a 180px column, cut with `…`); the base URL's **host** in mono 12.5px `--faint` (the full URL is in the panel); the format (`Anthropic Messages` / `OpenAI-compatible`) in `--muted`; `2 models` in `--muted`; then right-aligned: the month's spend in mono `--text` + ` this month` in `--faint`; `8 at once` in `--faint` when the provider has a cap of sessions at once; the outline chip `personal runners` when `allowOnPersonalRunners`.
   - **Line 2** (24px, indented to the name's x, secondary size): `Used by` in `--faint`, then each project as its 8px colour square and its name in mono `--text`, then `· default list` or `· own list` in `--faint`. A provider on the default list and on some projects' own lists shows two runs on the same line: `calculator, web-storefront · default list   northwind-portal · own list`. On no list: `On no list. Nothing uses it.` in `--muted`.
   - Hover `--raise`, selected `--sel` with a 6px radius inside the list's width; the block is a `button` with `aria-pressed`. Default selection: none (the panel shows milestone 1's hint) unless the URL names one.
   - A provider whose last test failed keeps milestone 1's status on line 1 (`Couldn't connect` in `--red`, before the spend).
4. **To confirm** (28px below), only while an upgrade choice has `needsConfirm`. Section line `To confirm` and the count. One 44px row per choice, a 2px `--amber` rule on its left (it is a needs-you for organization admins), Lucide `hand` 15px `--amber`, then two lines: `Claude Sonnet 5.5 on the default list` (13.5px `--text` 600; `on northwind-portal's list` for a project's own) and `Profiles named it on 2 keys. The upgrade kept acme-anthropic, from the oldest profile.` (secondary `--muted`, the key in mono). Right: outline `Change` (opens the choice's picker in the panel: the providers on that list that list the model, as radios, and `Save choice`) and outline `Confirm` (`providers.confirmChoice`, applies at once; the row leaves with a 4s status line `Kept on acme-anthropic.`).
5. **Models** (milestone 1's section and table), below. Its Provider column is the key's name in mono; nothing else changes.

### Properties panel: a selected key

`PropGroup` labels 12px 500 `--faint`; rows 30px, key column 112px, `--muted` keys, `--text` values.

1. Label `Key`, then the name as the panel title (mono 15px 600). Rows: `Base URL` (mono 12.5px, cut with `…`, the full URL in `title`), `Format`, `Token` (`lock` 13px + `In the secret store`; never a token, never its last four), `At once` (`4 sessions`, or `No cap`), `Personal runners` (`On` / `Off`).
2. Label `Projects` + count. One 30px row per project: the colour square, the name in mono, `own list` / `default list` right-aligned in `--faint`. Then 12.5px `--faint`: `Only an organization admin changes which projects use a key.` None: `No project uses it. Add it to the default list or to a project's list.`
3. Label `Models it lists` + count. Rows: the model logo and name; right-aligned, `--faint`: `serves northwind-portal` (the projects where this key is the one serving it, comma-joined) or `serves no project` (another key serves it there, or no project uses this key).
4. Label `This month`. Rows `Spent` (mono, right-aligned) and `Tasks` (mono): spend by key from ticket 27's grouping (ADR 0065, "Spend").
5. Outline `Button` `Edit provider`: milestone 1's provider settings form in the panel (380px). Removing a provider that a list holds asks first: `AlertDialog` `Remove northwind-anthropic?`, body `northwind-portal loses it. Claude Opus 5.5 and Claude Sonnet 5.5 have no key there until an admin picks one.` (the preview, below), buttons `Cancel` and a destructive `Remove provider`.

### Add provider

Milestone 1's add form, unchanged but for one line under `Save provider`, 12px `--faint`: `It joins no list. Tick it on the default list or a project's list to use it.` (the organization's first provider: `It joins the default list, so every project can use it.`).

## States and copy

| State | What shows |
|---|---|
| **Keys, the picture** | as above |
| **One provider, fresh install** | Default list holds it; its line 2 reads `Used by` and every project; no To confirm |
| **No provider** | milestone 1's empty state and the add form, unchanged |
| **Editing the default list** | the inline checkbox list, `Cancel` and `Save list` (the page's one primary); the panel shows the preview: `This save changes {n} models`, one row per model (`moves to {key}`, `has no key in {project}` in `--red`, `stays on {key}`), then `What happens` (`{n} idle boxes holding {key}'s key are released now. {n} tasks wait queued until an organization admin picks a key.`). Nothing changes: `Nothing moves. Every model keeps its key.` A `CONFLICT` from the save (the lists changed since the preview): `Someone changed the lists since this preview. Check it again.` in `--red`, and the preview reloads |
| **Confirming a choice** | the row's buttons disable with a 12px `Loader`; then the status line |
| **Loading** | title and lede at once; the Default list row and three key blocks as `Skeleton` lines |
| **Error** | under the section that failed, `role="alert"`, `--red`: `errorText(error)` |
| **Narrow (below 1280px)** | the panel drops under the page (`PageFrame`). Below 640px, line 1 keeps the logo, name and spend; host, format and counts move to a third line in `--faint` |

The demo data in the image (fixtures): Acme Corp, an agency; `acme-anthropic` (default list; `calculator`, `web-storefront`, `data-pipeline`), `northwind-anthropic` (`northwind-portal`'s own list), `globex-openrouter` (`globex-shop`'s own list, personal runners on), `spare-openai` (no list). The demo of spec step 16 uses `client-a` and `client-b`.

## Components (shadcn/ui names)

The shell, `Breadcrumb`, `Button` (outline, ghost), `Badge` (the chips), `Checkbox` (editing a list; `components/ui/checkbox.tsx` exists), `RadioGroup` (a choice's picker), `AlertDialog`, `Skeleton`, `Separator`, `PageFrame`, `PropGroup`, `PropRow`. Icons, Lucide 15px stroke 1.75: `plus`, `list`, `server`, `lock`, `hand`, `check`, `loader`, `arrow-right`, `circle-slash`.

## Tokens

The approved pictures' scale (`../m1/README.md`, "Scale"): body 14.5px, dense rows 14px, secondary 13px, small 12px, title 26px, `--muted` `#B4B7BB`, `--faint` `#8B8E93`, buttons 30px, a 46px top bar and a 320px panel (380px with a form).

| Token | Used for |
|---|---|
| `--bg` `#0D0E10` / `--side` `#0A0B0C` | page and panel / sidebar |
| `--sel` `#1A1B1E` / `--raise` | the selected key / hover |
| `--line` `#1F2023` / `--line-2` `#2A2C30` | hairlines / chip and control borders |
| `--text`, `--muted`, `--faint` | names and money / formats, counts, lede / hosts, `this month`, `Used by` |
| `--teal` `#6FB8AA` | `Edit`, project links in the panel |
| `--amber` `#FFB224` | only the To confirm rule and hand, and the sidebar's Needs you count |
| `--red` `#E5675C` | `has no key in …` in a preview, errors |

No green on the page except milestone 1's connected dot in the models table's section.

## Data this screen needs (ticket 50)

- `providers.list`: per provider, its host, format, model count, the month's spend and task count (ticket 27's grouping per provider), its cap, `allowOnPersonalRunners`, whether it's on the default list, and **the projects that use it** with `via: "default" | "own"`. Never a token.
- `providers.setDefaultList` and a **preview of it**: ticket 50 previews a project's list only. Recommended (open point 1): `providers.previewDefaultList`, the sum of `planProviderChange` over every project that follows the default, in the same shape as `projects.previewProviders`.
- The upgrade's choices with `needsConfirm` (`ModelChoice`), with the providers that list the model on that list; `providers.confirmChoice`.

## Open points (settled by recommendation, 2026-11-19; the build records them in ticket 53's `## Comments`)

1. **The default list's preview.** Ticket 50 has a preview for a project's list only. Settled: add `providers.previewDefaultList`, so editing the default list shows what moves before the save, as ADR 0065 asks of every save.
2. **Where the upgrade's choices live.** Settled: on this page, as a "To confirm" section and a needs-you row for organization admins on Home (`no_provider_for_model`'s audience, `organization_admins`); not a banner on every page.
3. **Amber on To confirm.** Settled: kept. It's something only an organization admin can settle, the meaning amber has (`brief.md`).
4. **Vendor logos on keys.** Settled: by the base URL's host, from a fixed list of four, else `server`. The model logos stay models.dev's.

## Differences from the current code

Checked against `apps/web` on `main` (2026-11-19):

1. `models-view.tsx` lists providers as one-line rows with the full base URL and `Connected`; the key's two lines, `Used by`, spend and the Default list and To confirm sections are new.
2. `provider-settings.tsx` gains the `Projects`, `Models it lists` and `This month` groups.
3. `add-provider-form.tsx` gains the line under `Save provider`.
4. The models table's Provider column already shows the provider's name; it switches to mono.
5. Messages: grow the `models` namespace in `messages/en.json` (plurals for `{n} models`, `Followed by {n} projects`, `This save changes {n} models`).

## Wrong in the image

Build the copy and details in this file, not these:

- **The panel** starts at about x=1062, about 378px. It's 320px (380px only with a form).
- **The panel's group labels** `Projects`, `Models it lists` and `This month` are drawn 15px bold white. They're 12px 500 `--faint` labels, the counts in faint mono.
- **Mono where it shouldn't be:** `Anthropic Messages`, `Off` and `sessions` in the panel. Only the base URL, the name, numbers and money are mono.
- **The sidebar** comes from the shell, not the picture (its `Linear` icon is a bar chart, and its rows aren't milestone 4's list).
- **The Default list row** sets the project names a step larger than the rest of the line; they're 13px mono.
- **The models table** (milestone 1's) isn't in the frame: it stays below To confirm.
- **The logo** approximates the Hinge mark. Use `kit/logo/export/ostra-hinge-single-color.svg`, 20px.
- The picture has no editing, preview, empty, loading or narrow states: they're in the table above.

All visible copy in the image is spelled right.
