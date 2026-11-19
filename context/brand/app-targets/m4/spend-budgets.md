# Target: Spend and budgets (milestone 4, screen 12)

> **Committed images:** `spend-budgets.webp` (a project's budget form) and `spend-budgets-price.webp` (an unpriced model's four-price form), each downscaled from a 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Prompts:** `spend-budgets.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 2 generations, both kept:
  - `spend-budgets.webp`: generation 1. References: the approved milestone 1 original `app-targets/m1/models.png` (the screen this one starts from, spec section 12), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
  - `spend-budgets-price.webp`: generation 2, a constrained edit of generation 1 (generation 1's output first, then `m1/models.png` and the logo): the models row selected and the panel swapped for the price form. Everything else is generation 1's.
- **Route (new):** `apps/web/src/app/(panel)/organization/spend/page.tsx` → `components/spend/spend-view.tsx`. The month is in the URL (`?month=2026-11`), and so is the selection (`?project=<id>` or `?model=<id>`).
- **Features:** F-037 (costs and budgets). ADR 0042 (budgets, metering at the key proxy), ADR 0055 ("Spend", "Budgets"); spec section 3 step 6, section 4 ("Spend and the gate"), section 11 item 9. Tickets 12 (rollups and the gate), 13 (notices and release), 27 (`spend.*`, `budgets.*`, `models.setPrice`), 36 (this screen).
- **Status:** a proposed target, waiting on approval (ticket 31's `## Comments`). Ticket 36 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the pictures.

## Purpose

An organization admin sees what agents spent this month, against the organization's budget and each project's, and acts on it: sets or raises a budget, and gives a model with no price its four prices so budgets can count it. Every figure reads the one rollup, `SpendDaily`, so the organization's total is the sum of its projects', and the projects' the sum of their models'. The page says plainly when a budget is reached, how far past the line the spend went (the overshoot: turns already running finish, ADR 0042), and which spend isn't in the figures because its model has no price.

`spend-budgets.webp` shows November 2026 on the 19th: the organization at 74% of $2,500, `billing-platform` past its budget (selected, its form open with a raise typed), `calculator` warned at 81%, `mobile-app` with no budget, and the custom `acme/sql-coder-ft` with no price. `spend-budgets-price.webp` shows the same month with that model selected and its price being entered.

Only organization admins see the page (budgets are theirs to set, ADR 0055). Anyone else gets `AdminOnly`: "Only an admin of the organization can see this page." A member sees a project's month on its own page (`../m1/project`, growing in milestone 4) and a task's spend on the task.

## Layout (CSS px at 1440 wide)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 234px, the shared shell | Build it from `components/shell/sidebar.tsx`. Organization gains **Spend** (Lucide `wallet`), admins only, selected here (`--sel`, `--text`). Its place, per spec section 12: Members, Spend, Insights, Memory, Audit log |
| Top bar | 46px, hairline under | Breadcrumb `Acme Corp › Spend` (`Spend` in `--text` 500). Right: the **month picker**, an outline `Select` (30px, 1px `--line-2`) with a 15px `calendar` icon and `November 2026`: the current month and every earlier month with spend, newest first. No primary button in the top bar: the panel holds the page's one primary |
| Page | `1fr`, padding `28px 36px` | Title, lede, the month summary, Projects, the no-price warning, Models |
| Properties panel | **380px** (it holds a form), 1px `--line` on its left, padding `20px 18px` | The budget form, the price form, or the hint |

### Heading

- Title **Spend** (`PageHeading`).
- Lede (`text-lede`, `--muted`), max-width 720px, two lines: `What agents spent, counted at the key proxy and priced per model. Budgets run by calendar month in UTC: at 80% admins are told, and at 100% new tasks and turns wait while running turns finish.` The `80%` reads `OSTRA_BUDGET_WARN_PERCENT`.

### The month summary

No box. 24px under the lede.

1. Label, 12.5px `--faint` mono: `This month, Nov 1 – 19` (a past month: `November 2026`, the whole month).
2. **The figure line:** the month's spend, IBM Plex Mono 600 28px `--text` (`$1,842.17`); 10px gap; `of the organization's $2,500.00 budget` in `text-body` `--muted` (the amount in mono); at the right, the share in mono 600 18px `--text` (`74%`). With no organization budget: `this month · no organization budget` and no share.
3. **The bar**, 10px under, full width, **8px** tall, radius 4px: track `--line`, fill `--chart` (Mist `#CFD8D4`) to the share, and a 1px `--faint` tick at the warn percent. At or past 100% the fill is `--red` across the whole track, the track's scale becomes the spend instead of the budget, and a 1px `--text` tick marks the budget, at `budget ÷ spend` of the width: what's right of the tick is the spend past the budget. No budget: no bar.
4. **The meta line**, 8px under, 12.5px mono `--faint`: `186.7M tokens · 2,431 turns · resets Dec 1`. At the right, a teal `Set budget` (`Change budget` when one is set), which selects the organization's budget in the panel.

### Projects section

- Section head, 28px above: **Projects** (Plex Sans 600 `text-body`) and the count `5` (mono `--faint`): the projects with spend this month, or a budget.
- A `Table` with no box, as Models' tables. Header row 30px, labels Plex Sans 500 12px `--faint`. Body rows **40px**, a 1px `--line` hairline under each.

| Column | Width | Contents |
|---|---|---|
| Project | ~170px | the project's 8px colour square, 10px gap, the name `text-ui` `--text`, truncated |
| Spent | 96px, right-aligned | mono `--text`, `$612.40` |
| Budget | 96px, right-aligned | mono `--text`; none: `No budget` in `--faint` (sans) |
| Used | `1fr`, min 200px | the bar, **6px** tall, radius 3px, as the summary's (track `--line`, fill Mist; at 100% and past, `--red` with the budget's tick), then the share in mono `--text` 48px wide, right-aligned. `--red` at 100% and past. No budget: the empty track and no share |
| Status | 150px | under the warn line: `–` `--faint`. Warned: 13px `triangle-alert` `--muted` + `Warned 16 Nov` `--muted`. Reached: `--red` `Reached · $12.40 over`. No budget: a teal `Set budget` |

- **The overshoot** is the spend counted after the budget was reached this month: the turns already running and the messages already handed to a runner (ADR 0055). It isn't the spend minus the budget once an admin lowers a budget below what's spent: then the line is crossed at the change, and only spend after it counts. The cell's `Tooltip`: `Spent after the budget was reached on 18 Nov: the turns that were already running.`
- **Order:** by spend, highest first. Under the table, 12.5px `--faint`: `13 projects spent nothing this month.` (hidden when it's none).
- The whole row is the click target and selects the project's budget in the panel (`aria-pressed`). Hover `--raise`, selected `--sel`.

### The no-price warning

Shown when a model with spend this month, or a model a project's default profile uses, has no price. 28px under Projects. **No box, no fill:** a 2px `--red` left rule, padding `2px 0 2px 14px`, `role="status"`.

- Line 1: a 15px `circle-alert` in `--red`, then `text-ui` `--text` 500: `acme/sql-coder-ft has no price, so budgets can't count it.` Several: `2 models have no price, so budgets can't count them.`
- Line 2, `text-sm` `--muted`: `3.4M tokens this month aren't in these figures, and 1 task in data-pipeline waits for a price.` The second half is there only when a task waits (a project with a budget, ADR 0055); `{n} tasks in {project}` or `{n} tasks in {k} projects`. Then a teal `Enter its price`, which selects the model in the panel (several: `See the models`, which scrolls to them).

### Models section

- Section head, 20px under the warning: **Models** and the count `5`: the models with spend or tokens this month.
- A `Table` with no box. Header labels as above; the number columns right-aligned.

| Column | Width | Contents |
|---|---|---|
| Model | `1fr` | the 15px catalog logo (light grey, as Models), the name `text-ui` `--text`; a custom model shows its endpoint ID in mono and an outline chip `custom`. No logo: Lucide `cpu` `--muted` |
| Fresh input | 96px | mono `--text`, tokens (`48.1M`); none: `–` `--faint` |
| Output | 96px | the same |
| Cache read | 96px | the same |
| Cache write | 96px | the same |
| Spent | 96px | mono `--text` (`$972.40`); no price: `No price` in `--red` (sans), with the tokens still counted in the four columns |

- Order: by spend, highest first, then the unpriced models. The whole row selects the model's price form in the panel.

Demo rows in the pictures (the projects sum to the organization's `$1,842.17`, and so do the models):

| Project | Spent | Budget | Used | Status |
|---|---|---|---|---|
| billing-platform | $612.40 | $600.00 | 102% | Reached · $12.40 over |
| calculator | $488.10 | $600.00 | 81% | Warned 16 Nov |
| web-storefront | $402.55 | $800.00 | 50% | – |
| mobile-app | $221.90 | No budget | | Set budget |
| data-pipeline | $117.22 | $300.00 | 39% | – |

| Model | Fresh input | Output | Cache read | Cache write | Spent |
|---|---|---|---|---|---|
| Claude Opus 5.5 | 48.1M | 3.9M | 71.2M | 6.4M | $972.40 |
| Claude Sonnet 5.5 | 22.7M | 2.6M | 18.3M | 2.1M | $611.25 |
| GPT-6.2 Sol | 1.9M | 0.4M | 3.8M | – | $188.60 |
| DeepSeek V4 Flash | 1.1M | 0.2M | 0.6M | – | $69.92 |
| `acme/sql-coder-ft` `custom` | 2.8M | 0.6M | – | – | No price |

## The properties panel: every state and its copy

Panel type: eyebrow 12px 500 `--faint`; resource title Plex Sans 600 15px `--text`; field labels 12.5px 500 `--muted`, 6px above the input; inputs **34px**, `--surface`, 1px `--line-2`, radius 7px, mono 14px; help `text-sm` `--faint`, 5px under the input; `PropRow`s 30px with a 120px key column.

### A project's budget (`spend-budgets.webp`)

1. Eyebrow `Project budget`; title row: the project's 8px square and its name.
2. Status line, `text-sm` `--muted`, one of:
   - reached: `Spent $612.40 this month. Reached on 18 Nov: new tasks and turns wait.`
   - warned: `Spent $488.10 this month, 81% of its budget.`
   - under: `Spent $402.55 this month, 50% of its budget.`
   - none: `Spent $221.90 this month, with no budget. The organization's budget still covers it.`
3. **Monthly budget:** an `Input` with a `$` prefix in `--faint` and `USD` at its right in `--faint`; the value in mono, two decimals. Empty when there's none, placeholder `No budget`. Help: `Each calendar month in UTC. A raise above what's spent lets the held work go, in the order it was held.` A value at or below what's spent adds, in 12.5px `--red`: `That's below this month's $612.40, so the budget is reached at once and its admins are told.`
4. Hairline, then the group **Waiting on this budget** (only when it's reached): `Held turns` · mono `3`; `Queued tasks` · mono `2`; `After the raise` · mono `82% used` (from the typed value; `Still reached` in `--red` when it's not above the spend). Each count is a teal link to the tasks, filtered.
5. Hairline, then 12.5px `--faint`: `Set by Alex Kim on 2 Nov · $600.00` (from the budget's last audit entry: who, when, the value before this one). Never set: nothing.
6. **Save budget**: the page's one primary button (Shell fill, Ink text, 600, 30px). Disabled until the value changes and parses. `Saving…` while pending; an error shows above it in `--red`, `role="alert"`. Beside it, when a budget exists, an outline **Remove budget**: it asks first in an `AlertDialog` (`Remove billing-platform's budget? Its held work goes at once, and its spend stops being limited.`, `Remove budget` / `Cancel`).
7. On save: the row, the bar and the summary update at once; a raise above the spend releases the held work (`budget.release`), and the Waiting group empties as it goes.

### The organization's budget

The same form with the eyebrow `Organization budget`, the title `Acme Corp`, and the help line adding `It covers every project's spend, with or without its own budget.` Selected by the summary's `Set budget` / `Change budget`.

### A model's price (`spend-budgets-price.webp`)

1. Eyebrow `Model price`; title row: the logo (or `cpu`), the name (mono for an endpoint ID) and the `custom` chip.
2. A `text-sm` `--muted` line: the provider, then where the price comes from: `OpenRouter · neither the endpoint nor models.dev lists a price.`; `Anthropic · the price comes from models.dev.`; `internal-vllm · the endpoint lists its price.`; `… · an admin set this price on 3 Nov.`
3. Rows: `Price source` · `Endpoint` / `models.dev` / `Admin` / `None yet` (`--faint`); `Unpriced this month` · mono `3.4M tokens` (shown only when there are some).
4. Hairline, group label `Price per million tokens, in USD`, then a **2×2 grid** (12px gap) of labelled inputs with the `$` prefix, mono: `Fresh input`, `Output`, `Cache read`, `Cache write`. A source price fills them read-only (`--muted` text, no border change) with an outline `Override` button under the grid; the admin's own price is editable. An empty field means that kind has no price; fresh input and output are required to save.
5. Help: `Applies from when you save. Spend already counted is never repriced, so these 3.4M tokens stay unpriced.` (the tokens half only when there are some).
6. When tasks wait for it, a `text-sm` `--muted` line with a 13px `info` icon: `The waiting task in data-pipeline starts once this is saved.` (`The 3 waiting tasks…`).
7. **Save price**: the page's one primary button, left-aligned. `Saving…`, then the row's Spent and the warning update, and the panel's source reads `Admin`. An override of a source price adds an outline `Use the catalog price` once saved.

### Nothing selected

`Pick a project, a model or the organization's budget.` in `text-sm` `--muted`, at the top of the panel. The page selects nothing by default unless a budget is reached: then the first reached project is selected, so the admin lands on the form that releases it.

## States and copy

| State | What changes |
|---|---|
| A reached budget selected (`spend-budgets.webp`) | As above |
| An unpriced model selected (`spend-budgets-price.webp`) | As above |
| Loading | The summary's figure, bar and meta as `Skeleton` bars; five 40px skeleton rows per table; the panel's group labels with skeleton values. No spinner |
| No spend yet this month | The summary reads `$0.00` with the budget, if any, and an empty bar; Projects and Models show one hairline-bounded row in `--muted`: `Nothing spent in November yet.` The warning shows if a default model has no price |
| No spend ever (a fresh install) | No summary figure: under the lede, `text-ui` `--muted` `Spend shows here once agents run. Prices come from each provider and models.dev; a model with no price is counted in tokens until it has one.` and a teal `Models` link. The panel opens on the organization's budget form |
| A past month | The month picker shows it; the label reads the whole month (`October 2026`); budgets show as they stood at the month's end (from the audit), and every form is read-only with `Budgets change only for this month.` in `--faint`. Status reads `Reached 28 Oct` / `Warned 21 Oct` |
| Warned (80%) | The project's status cell; the 80% notice reached the project's and the organization's admins in the panel and by mail (`../m3/needs-you`, growing) |
| Reached (100%) | `--red` bar and share, the overshoot, the status cell; the panel's Waiting group. The summary's bar does the same for the organization's budget |
| No organization budget | The summary line and meta without the share and bar, and `Set budget` as above |
| A model with no price, no budget anywhere | The warning's second line reads `3.4M tokens this month aren't in these figures.` with no waiting tasks: without a budget, its tasks run and are counted in tokens (ADR 0055) |
| Save failed | `role="alert"`, 12.5px `--red`, `errorText(error)`, above the panel's button; the inputs keep the typed values |
| A member (not an admin) | `AdminOnly`, as Models |
| Narrow (below `xl`) | The panel opens as a right `Sheet` (380px) on a row's click. Below 1100px the Models table drops the four token columns into one `Tokens` column (their sum) and the panel lists the four |
| Phone (F-075) | One column: the summary, then each project as a 52px two-line row (name and share; the bar under it full width), then models as two-line rows. Forms open as a bottom sheet |

## Components (shadcn/ui names)

`Sidebar` (plus Spend), `PageFrame` with `wideProperties` (380px), `Breadcrumb`, `PageHeading`, `Select` (month picker), `Table` / `TableHeader` / `TableRow` / `TableHead` / `TableCell` (existing `ui/table.tsx`), `Badge` outline (`custom`; today `Chip` in `ui/status.tsx`), `Progress` (new, restyled: 8px and 6px, the budget's tick as a child), `Tooltip`, `Input` with a prefix and suffix, `Label`, `Button` (default = the Shell primary; outline), `AlertDialog` (existing), `PropGroup` / `PropRow`, `Separator`, `Skeleton`. Lucide 15px stroke 1.75 (13px in the panel): `wallet`, `calendar`, `chevron-down`, `triangle-alert`, `circle-alert`, `info`, `cpu`.

## Tokens (`app-concepts/html/graphite.css`)

> **Scale.** The sizes and colours below are `graphite.css`'s. The panel is built at the approved pictures' scale, which wins on size, spacing and contrast: body 14.5px, dense rows 14px, secondary 13px, small 12px, title 26px, `--muted` `#B4B7BB`, `--faint` `#8B8E93`, buttons 30px, a 46px top bar and a 320px properties panel (380px with a form). The measured values are in `../m1/README.md`, "Scale".

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page and panel |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | inputs |
| `--raise` | `#17181B` | row hover |
| `--sel` | `#1A1B1E` | selected row, the Spend nav row |
| `--line` | `#1F2023` | hairlines, bar tracks, panel divider |
| `--line-2` | `#2A2C30` | control and chip borders |
| `--text` | `#EDEDEE` | figures, names, values, the end tick |
| `--muted` | `#9A9DA3` | lede, status lines, `Warned`, keys |
| `--faint` | `#64676D` | headers, meta line, `No budget`, `–`, `$` and `USD`, help, the warn tick |
| `--chart` | `#CFD8D4` (Mist) | bar fills under 100% (`app-design.md`, "Charts") |
| `--red` | `#E5675C` | a reached budget's bar, share, status and overshoot; `No price`; the warning's rule and icon; errors |
| `--teal` | `#6FB8AA` | `Set budget`, `Enter its price`, the Waiting counts |
| `--amber` | `#FFB224` | only the sidebar's Needs you count and project dots. Nothing on this page is amber: a reached budget is a notice in Needs you, but here it's a state, in red |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | `Save budget`, `Save price` |

Type: Manrope 700 26px (title); IBM Plex Sans for labels, names and copy; IBM Plex Mono for every amount, share, token count, date in the meta line and month label, and endpoint IDs. Radii: 7px controls, 6px chips and the selected row, 4px and 3px bars.

## Data this screen needs beyond ticket 27

- `spend.month({ month })`: the organization's total, tokens and turns; per project (ID, name, colour, spent, budget, share, state `under` | `warned` | `reached`, warned and reached dates, overshoot); per model (ID, name, logo, custom, the four token counts, spent or `null`, unpriced tokens); the count of projects with no spend; the unpriced models with their waiting tasks per project.
- `budgets.get({ projectId | null })`: the value, the last change (who, when, the value before), held turns and queued tasks for it. `budgets.set` / `budgets.remove` (organization admins; each writes an audit entry, `budget.*`).
- `models.price({ modelId })` and `models.setPrice({ modelId, fresh, output, cacheRead, cacheWrite })`: the four prices with `priceSource` and `priceChangedAt` (spec section 5.3); `null` per kind.
- All of it reads `SpendDaily`, `Budget`, `BudgetNotice` and `HeldTurn`; nothing sums events on the page.

## Differences from the current code

Checked against `apps/web` and `packages/api` on `main` (2026-11-19):

1. **New route and view.** Nothing exists under `organization/spend/` or `components/spend/`.
2. **Spend today** is summed per request in `packages/api/src/routers/home.ts` (`sessionCost`, `spendOf`) from sessions and the model's input and output prices only. Milestone 4 replaces that with `SpendDaily` reads, so Home, the project page and this page agree (ticket 12); Home's right panel keeps its figure, now from the rollup.
3. **`Model`** has `inputPricePerMTok` and `outputPricePerMTok`. The cache prices, `priceSource` and `priceChangedAt` come with ticket 05. The Models page's custom-model form (`components/models/`) edits input and output only; it moves to the four-price form here, and Models shows the price and its source with `Edit price` linking to `/organization/spend?model=<id>` (spec section 12, "Screens that only grow").
4. **`components/ui/`** has no `Progress`. Add shadcn/ui's (`radix-ui` already in use), restyled; or a plain `div` bar with `role="meter"`, `aria-valuenow`, `aria-valuemax` and a label, which needs no new primitive.
5. **Sidebar.** `sidebar.tsx` gains **Spend** (`wallet`) for organization admins.
6. **Messages.** New keys under `spend.*` (`title`, `lede`, `monthLabel`, `of`, `noOrgBudget`, `meta`, `setBudget`, `changeBudget`, `projects`, `models`, the column heads, `noBudget`, `warned`, `reached`, `over`, `overTooltip`, `idle`, `noPrice`, `warnOne`, `warnMany`, `warnTokens`, `warnWaiting`, `enterPrice`, `seeModels`, `nothingSpent`, `noSpendEver`), `budgets.*` (`eyebrowProject`, `eyebrowOrg`, the four status lines, `monthly`, `help`, `helpOrg`, `belowSpend`, `waiting`, `heldTurns`, `queuedTasks`, `afterRaise`, `stillReached`, `setBy`, `save`, `saving`, `remove`, `removeConfirm`, `pastMonth`), `prices.*` (`eyebrow`, the source lines, `source`, `sourceNone`, `unpriced`, `group`, `fresh`, `output`, `cacheRead`, `cacheWrite`, `help`, `helpTokens`, `waiting`, `override`, `useCatalog`, `save`), `shell.spend`.

## Wrong in the images (build from this file)

All visible copy in both pictures is spelled right, and the numbers add up. These details differ from what to build:

- **The summary sentence** `of the organization's $2,500.00 budget` is drawn in mono. It's Plex Sans `--muted`, with only the amount in mono.
- **The reached bar's tick** sits at about 90% of the track. At 102% it belongs at `600 ÷ 612.40`, 98% of the track: the overshoot is a sliver. Build it from the numbers, not the picture.
- **The panel** is about 380px (from x 1061), which is right.
- **The models' logos** are the image model's: Kimi and DeepSeek carry OpenRouter's mark in `../m1/models`, and here DeepSeek still does. A model shows its own catalog logo.
- **The sidebar** is drawn from the image's own shell: Linear's and GitHub's icons are guesses, and Spend's `wallet` is right. Build it from `sidebar.tsx`.
- **`spend-budgets-price.webp`:** the price fields are drawn 30px; they're 34px. The help line's `3.4M` matches the row above, which is right.
- **The pictures have no loading, empty, past-month, member, error or narrow states:** they're in the table above.
