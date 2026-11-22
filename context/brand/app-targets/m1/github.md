# GitHub: target

> **Committed image:** `github.webp` and `github-not-connected.webp`, downscaled from the 2048×1360 generation to 1440 px wide, so one image pixel is one CSS pixel. Where this file gives sizes in image px at ×1.42, read them as CSS px directly against the WebP.

Organization › GitHub (F-006): the organization's GitHub App. Pictures:
- `github.webp` (2048×1360, the 1440×956 CSS frame at about 1.42×): the **connected** state
- `github-not-connected.webp` (2048×1360): the **not connected** state, "Create a new App" tab

Prompts: `github.prompt.txt`. Made with the `ui-taste` skill, image first, on Higgsfield `gpt_image_2_6` (3:2, 2k, high), from the graphite concepts (`../../app-concepts/html/task-b-graphite.png`, `models-graphite.png`) and the Hinge logo. Two generations.

**Status:** a target, not yet approved by the maintainer. The pictures are image-model renders: the copy and rules in this file win over the pixels, and the tokens below win over the picture's colours.

## Purpose

An organization admin connects the organization's own GitHub App, once, and later checks that it still works. The page answers, in this order:
1. Is GitHub connected? (the Connection row, or the connect form)
2. Where is the App installed, and which repos can ostra reach? (Installations, Repositories)
3. What may the App do? (Permissions, in the properties panel)

Members who aren't admins see the existing `AdminOnly` page, unchanged.

## Layout (1440 px wide, the concepts' frame)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 232px, `--side`, right hairline | The shared sidebar; **GitHub** (Lucide `git-pull-request`) is the selected row, under Organization between Models and Agent profiles |
| Top bar | 44px, bottom hairline | Breadcrumbs `Acme Corp › GitHub`. Right: connected, one secondary button `Open on GitHub` (`external-link` icon); not connected, nothing |
| Page | `1fr`, padding `28px 40px` | `h1` "GitHub", the lede, then sections 26px apart |
| Properties panel | 300px, left hairline, padding `20px 18px` | Connected: App and Permissions. Not connected: what the App asks for |

No cards. A section is a `.shead` title line (13px, 600) and `.rows` split by hairlines. The connect form is the only boxed thing (its inputs). At `< xl` the properties panel stacks under the page, as `PageFrame` does already.

### Heading (every state)
- `h1` (Manrope 700, 24px): `GitHub`
- Lede (`.lede`, 13.5px, `--muted`, max 720px, wraps to 2 lines): `A GitHub App opens every pull request, as its own bot, with the member as co-author. ostra mints a token for one repo at a time and never hands it to an agent.`
- A callback error (`?error=` on the URL), when there is one: one line under the lede, `--red`, Lucide `triangle-alert` 14px, no box, at most 300 characters of the server's message.

## States and copy

### 1. Not connected (`github-not-connected.webp`)

Section **Connect a GitHub App** (a `.shead` 13px/600 title; the picture draws it too big, see below).

Underline tabs (`.tabs`, 18px gap), in this order: **Create a new App** · **Use an existing App**. The selected tab is `--text` with a 2px `--text` underline; the other is `--muted`. Default tab: "Use an existing App" until ticket 40's browser run proves the manifest flow, then "Create a new App" (F-006 is building).

The form sits in a 460px column, left-aligned.

**Create a new App**
- Field label (`.field label`, 12px/500 `--muted`): `Organization on GitHub`
- Input, 32px, mono, placeholder `ostra-test` (demo value `acme`)
- Help (`.help`, 12px `--faint`): `Empty: the App belongs to your own GitHub account.`
- When the server's address isn't public: one line, Lucide `info` 15px `--muted`, text 12.5px `--muted`, **no box, no colour**: `This server's address isn't public, so the App is created without a webhook and receives no events. Set OSTRA_CORE_PUBLIC_URL to turn them on.` (`OSTRA_CORE_PUBLIC_URL` in mono). It shows **before** the click (see differences).
- Primary button (`.btn.primary`, Shell fill, Abyss text, 28px), icon first: `↗ Create the App on GitHub`
- Under it (`.help`): `GitHub asks you to confirm, then sends you back here.`

**Use an existing App**
- `App ID`: input, mono, digits only
- `Private key`: textarea, mono 12.5px, min 96px tall, placeholder `-----BEGIN RSA PRIVATE KEY-----`, help `The App's PEM file. Paste it or pick the file. It goes to the secret store.` Beside the help, a small outline button `Choose a .pem file` that opens the hidden file input (aria-label `The private key file`).
- `Webhook secret`: password input, mono
- Primary button: `Connect the App`, disabled until all three are filled

**Properties panel (not connected)**
- Label `The App asks for` with a faint count `7`. Rows (`.row2`, 30px): permission name mono `--muted` left, level mono `--text` right, in the manifest's order: `contents write`, `pull_requests write`, `checks write`, `actions read`, `issues read`, `statuses read`, `metadata read`.
- `.sep`, label `Not asked for`. Row `workflows` · `off`, then `.help`: `A push that touches .github/workflows/ fails, and the task says why.`
- `.sep`, label `Events`. Row `Webhook` · `On` (public address) or `Off until a public address`.

### 2. Connecting

- **Create:** on click, the input and button disable, the button reads `Preparing…` with a spinning Lucide `loader-circle`. The browser then posts the manifest to GitHub and leaves the page.
- **Back from GitHub:** the callback redirects to `/organization/github?connected=1`, which shows the connected state with a `--green` `check` 14px and faint `Just connected` at the end of the Connection row. On failure it redirects with `?error=…`, and the not-connected state shows the red line under the lede. Server messages it can carry: `GitHub didn't send the App back. Start again.`, `This sign-in with GitHub is not valid any more: start again`, `This sign-in with GitHub was started in another session`, `This sign-in with GitHub was already used: start again`, `Connecting the App failed. Start again.`
- **Existing:** on submit, the fields and button disable and the button reads `Reading the App…`. An error shows above the button: `--red`, `triangle-alert` 14px, the server's message (e.g. the missing permissions). On success the private key and secret are cleared from the page, and the connected state replaces the form.
- **Loading the page:** while `github.connection` is pending, `Skeleton` rows (38px, `--surface`) where the first section goes, never a blank page.

### 3. Connected (`github.webp`)

**Connection** (one 40px row between hairlines):
- green dot (`.dot.green`) + `Connected` in `--green`, then the slug in mono `--text` (`ostra-acme`)
- right end: nothing, or `✓ Just connected` right after the callback
- App ID and bot are **not** repeated here: they're in the properties panel (the picture repeats them, see below)

**Installations** with a faint mono count. Right of the title, a teal link `Install on another account →` (`https://github.com/apps/<slug>/installations/new`). One 40px row per installation:
- Lucide `building-2` (organization) or `user` (user), 15px `--muted`
- the account login, `--text` 500 (`acme`)
- faint `organization` or `user`
- right: `--muted` `All repositories` or `Selected repositories`, then teal `Configure →` (an org's install settings on GitHub: `https://github.com/organizations/<login>/settings/installations/<id>`; a user's: `https://github.com/settings/installations/<id>`)
- With more than one installation, the selected row (`--sel`) chooses whose repos the next section lists. The first is selected by default.
- Empty: one `--muted` row: `The App isn't installed anywhere yet. Install it on GitHub, on the org that holds your repos.` and a teal `Install on GitHub →`. No Repositories section then.

**Repositories** with a faint mono count, and faint mono `from <login>` on the right. One 38px row per repo from `github.repos`:
- Lucide `lock` (private) or `globe` (public), 15px `--muted`
- full name, mono `--text` (`acme/calculator-web`)
- at a fixed column (about 58% of the row), `git-branch` 13px + default branch, mono `--faint`
- right: `--muted` `Private` or `Public`
- Error: one red line, `GitHub did not list the installation's repos`. Pending: three `Skeleton` rows.

Demo data in the picture: `acme/calculator-web main`, `acme/billing-platform main`, `acme/web-storefront main`, `acme/mobile-app develop`, `acme/data-pipeline main` (all Private), `acme/design-tokens main` (Public).

**Properties panel (connected)**
- Label `App`. Rows: `Slug` mono (`ostra-acme`, `–` when null) · `App ID` mono (`1048213`) · `Bot` mono (`ostra-acme[bot]`, `botEmail` in its `Tooltip`) · `Secrets` with a `lock` 13px and `--muted` `In the secret store`.
- `.sep`, label `Permissions` with a faint count. Rows as in the not-connected panel, from `connection.permissions`: the manifest's order first (`contents`, `pull_requests`, `checks`, `actions`, `issues`, `statuses`, `metadata`), then any other permission A–Z. Name mono `--muted` left, level mono `--text` right, **all names on one left edge, no check icons**.
- Under the list, `.help`: `checks and actions are asked for from the start, so no install re-approves later.`

**Colour use on this page:** green only on the Connected dot/label and the Just-connected check. Teal only on links. Red only on errors. **No amber** (nothing on this page waits on the member; the sidebar keeps its own amber count and dots).

## Components (shadcn/ui names)

| Where | Component |
|---|---|
| Frame | the app's `PageFrame` (Sidebar, top bar, properties panel) |
| Breadcrumbs | `Breadcrumb` (`BreadcrumbList`, `BreadcrumbItem`, `BreadcrumbSeparator` = `chevron-right` 13px) |
| Open on GitHub, Choose a .pem file | `Button variant="outline" size="sm"` (`.btn`) |
| Create the App, Connect the App | `Button variant="default"` (`.btn.primary`, Shell) |
| Install on another account, Configure, Install on GitHub | `Button variant="link"` in `--teal`, or a plain `<a>` |
| Create / Use existing | `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`, underline style (`.tabs`, `.tab.on`) |
| Form | `Field` + `Label` + `Input` / `Textarea` + `FieldDescription` (`.help`) |
| Errors | inline text with `triangle-alert`, `role="alert"`; no `Alert` box |
| Status | the app's `Status tone="green"` (`.dot.green` + label) |
| Lists | `ul.rows`; the selected installation uses `--sel` |
| Properties | the app's `PropGroup`, `PropRow`, and `Separator` (`.sep`) |
| Loading | `Skeleton` |
| Bot email | `Tooltip` |
| Spinner | Lucide `loader-circle` with `animate-spin` |

## Tokens (from `../../app-concepts/html/graphite.css`)

> **Scale.** The sizes and colours below are `graphite.css`'s. The panel is built at the approved pictures' scale, which wins on size, spacing and contrast: body 14.5px, dense rows 14px, secondary 13px, small 12px, title 26px, `--muted` `#B4B7BB`, `--faint` `#8B8E93`, buttons 30px, a 46px top bar and a 320px properties panel (380px with a form). The measured values are in `../m1/README.md`, "Scale".

```css
--bg: #0D0E10; --side: #0A0B0C; --surface: #131416; --raise: #17181B;
--line: #1F2023; --line-2: #2A2C30;
--text: #EDEDEE; --muted: #9A9DA3; --faint: #64676D;
--sel: #1A1B1E; --teal: #6FB8AA; --green: #4FB286; --red: #E5675C;
--amber: #FFB224; --shell: #F3F0E8; --ink: #0C1D21;
```

- Body: IBM Plex Sans 400 13px/1.5. Nav, tabs, buttons 500. Section titles 600 13px. Field labels 500 12px `--muted`.
- `h1`: Manrope 700 24px/1.25, letter-spacing -0.015em, margin 6px 0. Lede 13.5px `--muted`.
- Mono (IBM Plex Mono): slugs, IDs, logins in the properties panel, repo names, branches, permission names and levels, counts (11–11.5px 500 `--faint` beside titles), env names.
- Icons: Lucide 15px, stroke 1.75 (13px in `.row2` and the top bar).
- Rows: 38px (repos), 40px (connection, installations), hairline `--line` between and under.
- Inputs: 32px, `--surface`, 1px `--line-2`, radius 7px, padding 0 10px. Buttons: 28px, radius 7px, padding 0 11px, 12.5px.
- Properties: `.row2` 84px key column, 30px rows, 12.5px; group labels 500 11px `--faint`; `.sep` 1px `--line`, 14px margins.
- Status dot: 7px, `box-shadow: 0 0 0 3px rgba(79,178,134,0.15)` for green.

## Differences from the current code

`apps/web/src/components/github/github-view.tsx` (the page file only gates on admin):

1. **Repositories section is new.** `github.repos({ installationId })` exists in the router but the panel never calls it.
2. **Installation rows:** `building-2`/`user` icon instead of `GitPullRequestIcon`; a teal `Configure →` link; a selected row when there are several; an empty row with an `Install on GitHub →` link.
3. **Top-bar action** `Open on GitHub` (`https://github.com/apps/<slug>`, hidden when the slug is null) and the `Install on another account →` link: both built from the slug, no new data.
4. **Connection row** drops nothing it has today, but adds `Just connected` beside the check after `?connected=1`.
5. **Permissions:** `Chip` cloud → key/value rows in the manifest's order (the code's `highlighted` order puts `checks` first), with the help line under them.
6. **Not-connected properties panel is new:** the permissions the App asks for, `workflows` not asked for, and the webhook state. The permission list should come from `appPermissions` in `@ostra/adapter-github` through the API, not be typed again in the panel.
7. **The no-public-address note** is muted with an `info` icon (today `text-amber`: amber is only "needs you"), and it shows before the click. Today it only appears in `startManifest`'s answer. That needs the server to say whether a webhook is possible (for example a `webhookPossible` field on a small query), which is new API.
8. **Connected and events off:** F-006 says the panel says so when the App was created without events and offers to finish it later. `github.connection` doesn't say whether the App has a webhook. Until it does, the connected state can't show it; when it does, add an `Events` row to the App group (`Off · no public address` with a teal `Turn on →`). Not drawn in the picture. *Note 2026-11-22: the API now says it, and does it: `github.connections` gives each App's `webhook.kind` (`none` until it has a secret) and `missingEvents`, and `github.turnOnWebhook` (refused until `OSTRA_CORE_PUBLIC_URL` is public) answers the webhook address, a secret shown once and the events to tick in the App's settings on GitHub. The row and the flow behind `Turn on →` still need a picture before they're built.*
9. **Tab order:** "Create a new App" first; the default stays "Use an existing App" until ticket 40 passes.
10. **PEM file:** the native `<input type="file">` becomes a hidden input behind an outline `Choose a .pem file` button.
11. **Errors** get the `triangle-alert` icon everywhere (the callback error and the create error have none today).
12. **Loading:** `Skeleton` rows instead of rendering nothing while `connection` is pending, and while installations and repos load.
13. **Bot email** in a tooltip on the Bot row (today not shown).
14. **Sidebar:** `app-design.md`'s Organization list has no GitHub row; the panel's sidebar does. The target puts it between Models and Agent profiles. Record that in `app-design.md`, or move it under Settings if the maintainer prefers.

## Text in the pictures that's wrong

The build uses the copy in this file, not the pixels.

`github.webp`:
- The Connection row repeats `App 1048213` and `Bot ostra-acme[bot]`. Drop both: they're in the properties panel.
- A short stray line under `Connected` in the Connection row: not part of the design.
- The `h1` is drawn in a sans that isn't Manrope: use Manrope 700.
- Permission names don't share a left edge (the check icons push `checks` and `actions` right, and the others are indented unevenly). Use one left edge and no check icons.

`github-not-connected.webp`:
- `Connect a GitHub App` is drawn at about 18px bold: it's a section title, 13px/600.
- The button's `external-link` icon trails the label: put it first, like every concept button.
- The input is wider than the 460px form column, and the tabs start 24px in from the page edge: both align to the column's left edge.
- The properties-panel rows are indented under their group labels: rows start at the label's left edge.
- No misspellings in either picture.
