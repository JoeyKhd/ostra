# Target: Organization › Spend, Keys

- **Pictures:** `spend-keys` and `spend-keys-light` (a key selected), `spend-keys-states` (loading, nothing spent, a past month, below 1100px, a key with unpriced tokens, nothing selected), `spend-keys-phone` (390×844). Desktop: a 2880×1912 `.png` and a 1440×956 `.webp`; the phone: 780×1688 and 390×844.
- **Sources:** `html/spend.html`, `html/states.html?sheet=spend`, `html/phone.html?scene=spend`; the parts in `html/gaps.js` (`keysTable`, `keyPanel`, `projectsTable`).
- **Route (existing):** `/organization/spend` → `components/spend/spend-view.tsx`, grown. The selection joins the URL's: `?provider=<providerId>` beside `?project=` and `?model=`.
- **Feature:** F-135/c13 (spend shown per provider, per project and per organization), ADR 0055 "Spend per key" (from ADR 0065). Data, built: `spend.month`'s `byProvider` (each provider's four token kinds, unpriced tokens and spend, highest first).
- **Builds on:** `../m4/spend-budgets.md` (Spend) and `../m4/models-keys.md` (a key's logo and name), as the live pages draw them, in milestone 8's shell.
- **Status:** a proposal, 2026-11-22. Nothing is built from it until the maintainer approves.

## Purpose

An agency's organization admin holds one key per client. Spend already answers "which project spent what" and "which model"; Keys answers "what did each client's key spend this month", which is the figure a client is billed against. A key that spent nothing is listed too, so a key nobody uses is visible.

## Layout (CSS px at 1440×956)

The live page, unchanged but for the new section, the panel's new state and the hint: `PageFrame` with `wideProperties` (380px panel), so the main column is 684px at 1440.

**Order:** title, lede, the month summary, **Projects**, **Keys**, the no-price warning, **Models**. Keys sits between the two: money by client project, by client key, then by model; at 1440×956 it's on the first screen.

| Part | Size and style |
|---|---|
| Section head | `Section` `Keys` (Plex Sans 600, 15px), the count in mono 13px `--faint`, then `one per model provider` in 13px `--faint`. 22px above it (under the idle line) |
| Table | the Models table's (`ModelsTable`): no box, header 30px (Plex Sans 500, 12.5px, `--faint`), rows **40px** with a 1px `--line` under each, `table-layout: fixed` |
| Columns | `Key` 1fr · `Fresh input` 92px · `Output` 72px · `Cache read` 90px · `Cache write` 94px · `Spent` 104px. Numbers right-aligned, mono 13.5px, 16px right padding (6px on the last) |
| Key cell | the key's logo, 15px (its vendor's by the base URL's host, from `/model-logos/`, as Models' `KeyLogo`; else Lucide `server` `--muted`), 10px gap, the key's name in mono 14px `--text`. The host isn't on the row at this width: it gives way first, as on Models, and is the cell's `title` and the panel's subtitle. From 1600px wide, or with the panel closed, it shows after the name in mono 12.5px `--faint`, cut with `…` |
| Token cells | `52.1M` (the panel's `formatTokenCount`); none: `–` in `--faint` |
| Spent cell | `$1,170.85`; nothing: `$0.00` in `--faint`. A key with unpriced tokens this month: Lucide `circle-alert` 13px `--red` before the amount, its `title` `3.4M tokens on acme/sql-coder-ft have no price and aren't in this figure` |
| Order | spend, highest first; ties (every `$0.00`) by name |
| Row | the whole row is the target, as Projects and Models: hover `--hover`, selected `--sel` with 6px outer radii, `aria-pressed` |

### The panel: a key selected (`spend-keys`)

Spend's panel type (`spend-forms.tsx`): eyebrow 12px 500 `--faint`, title 15px 600, `PropRow`s 28px with a 104px key column, groups split by a hairline with 16px above and below.

1. Eyebrow `Key`; title the key's name in mono 15px 600; under it 13.5px `--muted`: the host in mono 13px, ` · `, the format (`Anthropic Messages` / `OpenAI-compatible`).
2. Group `November 2026` (the month the picker shows): `Spent` (mono), `Share` (`22%` mono + ` of the organization's` 13px `--faint`), `Tasks` (mono, from `providers.list`). With unpriced tokens: `Unpriced` · `circle-alert` `--red` + `3.4M` mono + ` tokens`, and under the rows, 13px `--faint`: `acme/sql-coder-ft has no price, so its tokens aren't in $258.52.` + teal `Enter its price.` (selects the model's price form, as the warning does).
3. Group `Models on this key` + count: one 30px row per model row this key served this month (`byModel` where `providerId` is this key's): the model's logo 15px, its name (mono for a custom model's endpoint ID), its spend right-aligned in mono (`No price` in `--red` for one without).
4. Group `Used by` + count: each project that uses the key (`providers.list`'s `projects`): the 8px colour square, the name in mono, right-aligned 13px `--faint` `own list` / `default list`, ` · ` and the project's spend this month in mono when it has one. Under them, 13px `--faint`: `Budgets stay per project: northwind-portal's is $800.00. A key has no budget of its own.` (one project with a budget; several: `Budgets stay per project. A key has no budget of its own.`; none: the second sentence alone).
5. A teal link `The key on Models →` (`/organization/models?provider=<id>`).

Read-only: a key has no budget in v1 (ADR 0055), so there's no form and no primary button here.

## States and copy

| State | What shows |
|---|---|
| **A key selected** (the pictures) | as above |
| **Nothing selected** | the panel's hint grows: `Pick a project, a key, a model or the organization's budget.` (`spend.pick`) |
| **Loading** | the section head without its count; four 40px rows of `Skeleton` bars (a name and each number), as Projects' and Models' |
| **Nothing spent yet this month** | every key, each at `$0.00` with `–` tokens, by name; under the table 13px `--faint` `Nothing spent in November yet: keys are in name order until they spend.` |
| **No provider at all** | no Keys section (the page's never-spent text, `Spend shows here once agents run…`, already points at Models) |
| **A past month** | the month picker names it, the head's note reads the month (`October 2026`) instead of `one per model provider`. A key removed since keeps its row: its logo, its name in `--faint`, an outline chip `removed 12 Nov`; it opens nothing (no hover, no `aria-pressed`) |
| **Unpriced tokens** | the Spent cell's `circle-alert`; the panel's `Unpriced` row and its line |
| **Below 1100px** | the four token columns fold into one `Tokens` (their sum, 96px), as Models; the panel lists the four |
| **Below 1280px** | the panel opens as a right `Sheet` (380px) on a row's click, as today |
| **Phone** (`spend-keys-phone`) | each key a two-line row, 10px padding: the logo, the name in mono 15px, the spend in mono 15px at the right; under the name, 12.5px mono `--faint`: the host ` · ` the tokens' sum + ` tokens` (`nothing this month` for none). A tap opens the panel as a bottom sheet, as Projects' rows do |
| **Load failed** | the page's own `role="alert"` line, as today |

## Data

- `spend.month({ month })` → `byProvider: { providerId, name, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, unpricedTokens, spentMicroUsd }[]` (built), sorted highest first. It lists only the keys that spent this month.
- **Every key, `$0.00` for none:** recommended, `spend.month` lists every provider of the organization, zero-filled, in `byProvider` (and, for a past month, the removed ones that spent then, with `removedAt`). The alternative is the page merging `providers.list` in. Either way, the page needs per key: the host and format (for the logo and the subtitle), and the task count and projects (for the panel), which `providers.list` already has.
- `Models on this key` reads `byModel` filtered by `providerId` (built). `Used by`'s spend per project and key isn't in `spend.month` (its `byProject` isn't split by key); for a project on its own list the project's spend is the key's. Recommended: show the project's spend only when the project uses this one key, else no figure; no new API.
- Formatting: `formatUsd`, `formatTokenCount` (`spend-words.ts`), as the other two tables.

## Keyboard

- Each row is a `button`-like row (`tabIndex=0`, `aria-pressed`): `Enter` or `Space` selects it, as Projects' and Models' rows. `Esc` in the Sheet (below 1280px) closes it.
- `The key on Models →` is a link; `Enter its price.` a button that selects the model.

## Components

`Table` (`ui/table.tsx`), the page's `Section`, `Skeleton`, `PropRow`, `Chip` (`removed`), `Tooltip` (the unpriced mark), `Sheet` (narrow). `KeyLogo` from `components/models/keys-sections.tsx`, shared. Icons, Lucide 0.460: `server`, `circle-alert`, `cpu`, `arrow-right`.

## Tokens

`--text` (names, money), `--faint` (headers, `–`, `$0.00`, the note), `--sel` / `--hover` (rows), `--line` (hairlines), `--red` (unpriced), `--teal` (links). No amber; no green.

## Copy (new keys under `spend.keys.*`)

`title` `Keys` · `note` `one per model provider` · `col` `Key` · `nothingYet` `Nothing spent in {month} yet: keys are in name order until they spend.` · `removed` `removed {date}` · `unpricedTitle` `{tokens} tokens on {models} have no price and aren't in this figure` · panel: `eyebrow` `Key` · `share` `of the organization's` · `tasks` `Tasks` · `unpriced` `Unpriced` · `unpricedLine` `{model} has no price, so its tokens aren't in {amount}.` · `models` `Models on this key` · `usedBy` `Used by` · `budgetsOne` `Budgets stay per project: {project}'s is {amount}. A key has no budget of its own.` · `budgetsMany` `Budgets stay per project. A key has no budget of its own.` · `noBudget` `A key has no budget of its own.` · `onModels` `The key on Models`. `spend.pick` becomes `Pick a project, a key, a model or the organization's budget.`

## Demo data

Acme Corp, November 2026 to the 22nd: `acme-anthropic` (the default list: billing-platform, calculator, data-pipeline) $1,170.85; `northwind-anthropic` (northwind-portal's own list) $412.80; `globex-openrouter` (globex-shop's own list) $258.52 with acme/sql-coder-ft's 3.4M unpriced tokens; `spare-openai` (no list) $0.00. They sum to the month's $1,842.17, as the five projects do, and their tokens to its 186.7M. The Projects rows are milestone 4's, re-cut to match these keys.

## Not in the pictures

- The Models section under the warning, unchanged (the phone shows its first row).
- The panel as a Sheet below 1280px.
