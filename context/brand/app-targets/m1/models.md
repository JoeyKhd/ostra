# Models: target

> **Committed image:** `models.webp`, downscaled from the 2048×1360 generation to 1440 px wide, so one image pixel is one CSS pixel. Where this file gives sizes in image px at ×1.42, read them as CSS px directly against the WebP.

Organization › Models (F-088, F-089). The target picture is `models.webp` (2048×1360, a 3:2 frame that maps to 1440×957 CSS px at about 1.42×). It shows the state most worth getting right: the add-provider form after a successful connection test, beside four connected providers and seven models. The prompts that made it are in `models.prompt.txt` (two generations, the second a constrained edit of the first).

**Status:** a target for milestone 1, waiting on the maintainer's approval (`../../app-design.md`). Build from this file and the picture. Where they disagree, this file wins.

## Purpose

An admin connects the endpoints agents use. A provider is any server with an API base URL and a token that speaks the Anthropic Messages or the OpenAI-compatible API. "Test connection" detects the format and lists the endpoint's models, matched against the models.dev catalog for names, logos, context and prices. The admin also sees every listed model, picks the default model of the built-in OpenCode profile, and edits a custom model (one the catalog doesn't know).

Only admins see this page. Anyone else gets `AdminOnly`: "Only an admin of the organization can see this page."

## Layout (CSS px at 1440 wide)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 232px, `--side` | The shared sidebar (`app-concepts/html/shell.js`), **Models** active (`--sel` background, `--text`). |
| Top bar | 44px, hairline under | Breadcrumb `Acme Corp › Models` (`Models` in `--text` 500). Right: **Add provider** with a `Plus` icon, a *secondary* button. The page's one primary button is "Save provider" in the panel, so the top-bar button is never Shell-filled while the form is open. |
| Page | `1fr`, padding 28px 40px | Title, lede, the Providers section, the Models section. |
| Properties panel | 340px (`wideProperties`), 1px `--line` on its left, padding 20px 18px | The add form, a provider's settings, a model's properties, or the hint. |

The picture's panel comes out at about 378px; build it at 340px.

### Heading

- Title **Models**, Manrope 700 24px, letter-spacing -0.015em.
- Lede, `--muted` 13.5px, max-width 720px, two lines: "Any provider with an API base URL and a token. Names, logos, limits and prices come from the models.dev catalog. Agents reach a provider through ostra's key proxy, so its token never reaches the agent."

### Providers section

- Section head (28px): **Providers** (Plex Sans 600 13px) and the count `4` (Plex Mono 500 11.5px `--faint`).
- No box. Rows 40px, a `--line` hairline above each row and under the last. Rows start at the page's left edge, the same x as the title; no indent.
- A row, left to right, gap 12px:
  1. a 15px icon, `--muted`. The picture shows each vendor's monochrome logo, but the provider view has no `logoPath` (below), so the build keeps Lucide `Server` unless that field is added.
  2. the name, 13px `--text`, ~150px column, truncated
  3. the base URL, Plex Mono 12.5px `--faint`, flex 1, truncated with the full URL in a `title`
  4. at the right: "2 models" / "1 model" in `--muted` (`models.countOne` / `countMany`)
  5. when `allowOnPersonalRunners`: an outline chip "personal runners" (Plex Sans 12px, `--muted`, 22px tall, 1px `--line-2`, radius 6px)
  6. status: a 7px `--green` dot with its 3px halo, then "Connected" in `--text`
- Hover: `--raise` background. Selected: `--sel` background, `aria-pressed`.

Demo rows in the picture:

| Name | Base URL | Models | Chip |
|---|---|---|---|
| Anthropic | `https://api.anthropic.com` | 2 models | |
| OpenAI | `https://api.openai.com/v1` | 1 model | |
| Google | `https://generativelanguage.googleapis.com/v1beta/openai` | 1 model | |
| OpenRouter | `https://openrouter.ai/api/v1` | 3 models | personal runners |

### Models section

- Section head: **Models** and the count `7` (`models.enabled` is "Models"). Shown only when at least one listed model exists.
- A table with no box. Header row 30px, labels Plex Sans 500 11.5px `--faint` (not mono): **Model**, **Provider**, **Context**, **Input $/M**, **Output $/M**; the last three right-aligned. Body rows 40px with hairlines.
- Model cell: the 15px model logo (`logoPath`, served by ostra, drawn light grey on dark), then the name. A custom model with no display name shows its endpoint ID in Plex Mono. Chips after the name: "default" (the built-in OpenCode profile's model) and "custom", both outline chips as above.
- A model with no logo shows Lucide `Cpu` in `--muted`.
- Provider cell: `--muted`. Number cells: Plex Mono 12.5px `--text`, right-aligned. A missing value is "–" (`formatTokens` / `formatPrice`).
- Whole row is the click target and sets the selection. Hover `--raise`, selected `--sel`.

Demo rows (names and prices from models.dev on 2026-11-18, as in the concepts):

| Model | Chip | Provider | Context | Input | Output |
|---|---|---|---|---|---|
| Claude Sonnet 5.5 | default | Anthropic | 1M | $2.00 | $10.00 |
| Claude Opus 5.5 | | Anthropic | 1M | $4.00 | $20.00 |
| GPT-6.2 Sol | | OpenAI | 1.05M | $2.00 | $10.00 |
| Gemini 4 Carbon | | Google | 1M | $2.00 | $10.00 |
| Kimi K3.1 Pro | | OpenRouter | 1M | $2.00 | $10.00 |
| DeepSeek V4 Flash | | OpenRouter | 1M | $0.15 | $0.60 |
| `acme/sql-coder-ft` | custom | OpenRouter | 32k | – | – |

## The properties panel: every state and its copy

Panel type: eyebrow 11px 500 `--faint`; resource title Plex Sans 600 15px `--text`; field labels 12px 500 `--muted`, 6px above the input; inputs 32px, `--surface`, 1px `--line-2`, radius 7px, 13px text; help text 12px `--faint`, 5px under the input; fields 14px apart.

### Add a provider (the picture: after a successful test)

Shown after **Add provider**, and by default when the organization has no provider.

1. Eyebrow "New provider" (`models.addEyebrow`).
2. Title "Add a model provider" (`models.addTitle`, today only an `aria-label`).
3. Lede, 12.5px `--muted`: "Test the connection first: ostra detects the API format and lists the models." (`models.addLede`)
4. **Name**: input, placeholder "anthropic". Demo value `internal-vllm`.
5. **API base URL**: Plex Mono input, placeholder `https://api.example.com/v1`. Demo `https://llm.acme.internal/v1`.
6. **Token**: password input in Plex Mono with an `Eye` / `EyeOff` toggle at the right ("Show the token" / "Hide the token"). Help: "Stored in the secret store, and never shown again."
7. **Test connection**, secondary button. While running: "Testing…", disabled. Disabled until the URL and token are filled.
8. The result:
   - **Success:** a `CircleCheck` 14px and the line in `--green`: "Connected · OpenAI-compatible · found 3 models" (`models.connected` + `foundOne/Many`). Under it a list, 30–32px rows with hairlines, max 224px tall then scrolling: endpoint ID in Plex Mono `--text`, the catalog name (or "custom") in `--faint`, the context in Plex Mono `--faint`, right-aligned. Demo: `qwen3-coder-480b` Qwen3 Coder 480B 262k; `llama-4-maverick` Llama 4 Maverick 1M; `acme-sql-7b` custom 32k.
   - **Failure:** `CircleX` and the server's message in `--red`, `role="alert"`. The format, cap and switch stay hidden. Editing the URL or token clears any result.
9. Only after a successful test:
   - **API format**: a select showing "OpenAI-compatible (detected)"; options "Anthropic Messages" and "OpenAI-compatible", "(detected)" after the detected one. Help: "Detected by the test. Correct it if the endpoint speaks the other one."
   - **Sessions at once**: numeric Plex Mono input, placeholder "No cap". Help: "The most sessions that use this provider at the same time. Empty: no cap."
   - **Allow on personal runners**: label (13px `--text`) left, a `Switch` right, off by default. Help: "Off by default. A personal runner is a member's own machine: a key the key proxy holds there can be read by that member."
10. **Save provider**: the page's one primary button (Shell fill, Abyss text, 600). "Saving…" while pending. Disabled until a name is set and the test passed. A save error shows in `--red` above it. On success the token field is cleared and the new provider is selected.

### A provider selected

1. Eyebrow "Provider"; title row: `Server` icon 15px `--muted` and the name, 600 15px.
2. Group **Endpoint** (key/value rows, 96px key column, 30px rows, 12.5px):
   - API base URL: Plex Mono, truncated, full value in `title`
   - API format: "Anthropic Messages" or "OpenAI-compatible"
   - Auth: Plex Mono (`bearer`)
   - Token: "In the secret store" in `--faint`
   - Models: Plex Mono count, then "listed 2h ago" in `--faint`
   - A small button with `RefreshCw`: "List the models again" ("Listing…" while pending); an error shows under it in `--red`.
3. Group **Limits**: "Sessions at once" input with a small **Save** beside it (enabled only when changed), the same help line; then the personal-runners switch and its help. Both save optimistically and roll back on error.

### A model selected

1. Eyebrow "Model"; the name 600 15px; the endpoint ID in Plex Mono 12.5px `--faint`.
2. Either "The built-in OpenCode profile uses this model." in `--green`, or a secondary button "Use as default model" (disabled while saving, or when the model isn't listed). A failure shows above the table in `--red`.
3. A catalog model: group **From the catalog**, read-only rows Context, Max output, Input $/M, Output $/M (values in Plex Mono).
4. A custom model: group **Custom model: not in the catalog**, a form: Name (placeholder: the endpoint ID), then a 2×2 grid of Plex Mono inputs Context, Max output, Input $/M, Output $/M, and a secondary button "Save" / "Saving…" / "Saved".

### Nothing selected

"Select a provider or a model to see its properties." in 13px `--muted`, at the top of the panel.

### Empty (no provider yet)

- Providers section count `0`, one hairline-bounded row in `--muted`: "No provider yet. Add one in the panel on the right."
- The Models section is hidden.
- The panel opens on the add form.

### Loading

Today the page renders count `0` and nothing else while loading. Target: the section heads without counts, and three 40px `Skeleton` rows (a 15px square, a 120px bar, a 240px bar) per section, in `--surface`. No spinner.

### Narrow screens

Below `xl` the properties panel moves under the page (the `PageFrame` behaviour). Below `md` the base URL column hides; the models table scrolls sideways inside its section (min-width 560px) and never the page.

## Components (shadcn/ui names)

| Where | Component |
|---|---|
| Sidebar, Models active | `Sidebar`, `SidebarMenuButton` with `isActive` |
| Breadcrumb | `Breadcrumb`, `BreadcrumbItem`, `BreadcrumbSeparator` (`ChevronRight` 13px `--faint`) |
| Add provider, Test connection, List the models again, Use as default model, Save | `Button` `variant="outline"` (the panel's secondary: `--surface` fill, `--line-2` border), `size="sm"` for the refresh button |
| Save provider | `Button` default variant restyled as the Shell primary |
| Provider rows | a `ul` of `button` rows with `aria-pressed` (not a `Table`) |
| Models table | `Table`, `TableHeader`, `TableRow`, `TableHead`, `TableBody`, `TableCell` |
| default, custom, personal runners | `Badge` `variant="outline"` |
| Connected | the panel's `Status` (dot + label) |
| Fields | `Label`, `Input`, `Select` (`SelectTrigger`, `SelectContent`, `SelectItem`), `Switch` |
| Panel groups | `PropGroup`, `PropRow` (ostra's own), `Separator` between groups |
| Loading | `Skeleton` |
| Long URL | `Tooltip` or a `title` |

Icons: Lucide 15px, stroke 1.75 (`Plus`, `Server`, `Cpu`, `Eye`, `EyeOff`, `CircleCheck`, `CircleX`, `RefreshCw`, `ChevronDown`).

## Tokens (from `../../app-concepts/html/graphite.css`)

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page and panel background |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | inputs, secondary buttons, skeletons |
| `--raise` | `#17181B` | row hover |
| `--sel` | `#1A1B1E` | selected row, active nav item |
| `--line` | `#1F2023` | hairlines, panel divider |
| `--line-2` | `#2A2C30` | control and chip borders, switch track (off) |
| `--text` | `#EDEDEE` | text |
| `--muted` | `#9A9DA3` | lede, labels, provider column, counts |
| `--faint` | `#64676D` | URLs, table headers, eyebrows, help |
| `--green` | `#4FB286` | status dot (halo `rgba(79,178,134,0.15)`), test success |
| `--red` | `#E5675C` | test failure, save errors |
| `--teal` | `#6FB8AA` | inline links (none on this screen) |
| `--amber` | `#FFB224` | only the sidebar's "Needs you" badge and project dots; never on this page |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | the primary button |

Type: body 13px/1.5 IBM Plex Sans; title Manrope 700 24px; section titles 600 13px; table headers 500 11.5px; numbers Plex Mono 12.5px; counts Plex Mono 500 11.5px. Buttons 28px tall, radius 7px, 500 12.5px (`sm`: 24px, radius 6px, 12px). Chips 22px, radius 6px, 12px.

## Differences from the current code

Checked against `apps/web/src/components/models/*.tsx` and `messages/en.json`. I didn't render the current page, so Phase 2 should screenshot it and compare it against `models.webp` side by side.

1. **Add form title.** Add "Add a model provider" (`models.addTitle`) as a visible 15px 600 title under the "New provider" eyebrow. Today it's only the form's `aria-label`, and the panel has no title.
2. **Custom model name in mono.** A model shown by its endpoint ID (no display name) uses Plex Mono in the table. Today it's sans.
3. **Model logos.** Draw them light grey (about `--muted` to `--text`), not the raw `invert` at 90% opacity, so they read as one family.
4. **Personal runners switch label.** 13px `--text`, not `text-sm` `--muted`.
5. **Loading state.** Skeleton rows instead of "0" counts and an empty page.
6. **Provider icon.** The picture shows vendor logos on provider rows. The provider view (`providerViewSchema` in `packages/api/src/routers/providers.ts`) has no `logoPath`. Either add one (from models.dev's provider logos, served by ostra, ADR 0021) or keep `Server`. That's a data change, so ask before making it.
7. **Kept as is:** the copy, the columns (no "Used by" column as in the concept: there's no data for it), the selection model, the optimistic writes, and the order of the add form.

## Text in the picture that's wrong

Use the copy above, not the pixels.

- Kimi K3.1 Pro and DeepSeek V4 Flash show OpenRouter's logo. The model cell shows the *model's* catalog logo (Moonshot, DeepSeek), never the provider's.
- Provider rows show vendor logos that the data doesn't have (difference 6).
- The "Output $/M" header is a shade brighter than the other headers. All headers are `--faint`.
- The token shows eleven dots. The count is whatever the browser draws for the value.
- The panel is about 378px wide; it's 340px.
- "Add a model provider" may be drawn in Manrope; it's IBM Plex Sans 600 15px.
- The sidebar's "AK" avatar and the counts are demo data, as in the concepts.
