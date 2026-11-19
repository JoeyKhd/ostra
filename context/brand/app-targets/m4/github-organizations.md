# Target: GitHub, several organizations (milestone 4, screen 23)

> **Committed image:** `github-organizations.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Prompt:** `github-organizations.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation, kept as made. References: the approved milestone 1 original `app-targets/m1/github.png` (the screen this one starts from, spec section 12), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route (existing):** `apps/web/src/app/(panel)/organization/github/page.tsx` → `components/github/github-view.tsx`, grown. The selection is in the URL (`?installation=<id>`, `?app=<connectionId>`, `?add=org`, `?add=app`).
- **Features:** F-136 (repos from several GitHub organizations), F-006 (the organization's GitHub App). ADR 0065, "Repos from several GitHub organizations" (Q279 to Q283). Spec section 3 step 15. Tickets 46 (contracts), 47 (`public`, `removeInstallation`, the App's owner), 49 (core), 51 (`github.connections`, `.linkInstallation`, `.unlinkInstallation`, `.removeInstallation`, `.connectExisting` beside another App), 54 (this screen).
- **Status:** approved 2026-11-19 by the lead on the maintainer's delegation, pending the maintainer's review (ticket 52's `## Comments`).

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

The organization's own App is installed on its clients' GitHub organizations too (a public App), and a client may connect an App of its own. ostra acts only through installations an organization admin linked. The page answers:

1. **Which Apps, owned by whom, and is each one's webhook arriving?**
2. **Where is each App installed, and which installations can ostra use?** Linked, waiting to be linked, or removed.
3. **How do I bring in a client's GitHub organization?** The install link to send, and, for a private App, why it can't be installed elsewhere and where GitHub changes that, one way.

A stranger's installation is shown **calmly**: a fact with two buttons, not a warning. It reaches nothing until linked (ADR 0065, Q280), and the page says so once.

Only organization admins see the page (`AdminOnly` as today). Not connected at all: milestone 1's `github-not-connected` (grown with the visibility question, ticket 54).

## Layout (CSS px at 1440 wide)

| Region | Size | Contents |
|---|---|---|
| Sidebar | the shell's | `GitHub` selected |
| Top bar | 46px | breadcrumb `Acme Corp › GitHub`. Right: outline `Connect another App`, 8px, primary `Add a GitHub organization` (`plus`) |
| Main column | padding `28px 40px`, content `max-width: 760px` | title, lede, one section per App, the strangers line |
| Properties panel | 320px (380px with a form), 1px `--line` on its left | the selected installation, then Add a GitHub organization and Private Apps; or the selected App; or a form |

### Main column

1. **Title** `GitHub`. **Lede** (`--muted`, max 720px): `Each App opens pull requests as its own bot. ostra mints a token only for an installation an admin has linked, and never hands it to an agent.`
2. **One section per connected App**, the organization's own first, then by slug, 28px apart. The section line (40px, a hairline under it): Lucide `github` 15px, the slug in mono 15px 600 `--text`, then 13px `--muted`: `owned by acme · public` (the owner's login in mono; `private` or `public`); right-aligned, the webhook state: a 7px `--green` dot + `Webhook receiving` (`--muted`), a 7px `--faint` dot + `No events yet`, or `triangle-alert` 13px `--text` + `Webhook failing` (the last delivery's error in a `Tooltip`). The section line is a button that selects the App for the panel.
3. **Its installations**, rows 42px, hairlines, one grid: account 200px, kind 120px, repos 1fr, state 170px, actions auto.
   - account: Lucide `building-2` (organization) or `user` (user) 15px `--faint`, the login in mono 14px `--text`;
   - kind: `organization` / `user`, 13px `--faint`;
   - repos: `All repositories`, `2 repositories`, `1 repository` (`--muted`);
   - state and actions:

| State | State cell | Actions |
|---|---|---|
| linked, the owner's own | `check` 14px `--green` + `Linked` (`--muted`) | `owner` in `--faint` (it can't be unlinked: it's linked when seen) |
| linked, another account | `check` `--green` + `Linked` | teal `Unlink` |
| waiting | `clock` 14px `--muted` + `Waiting to be linked` (14px `--text`, 500) | outline `Link` and outline `Remove`, 28px |
| removed | `Removed 3 Nov` in `--faint` | none; the whole row `--faint` |
| suspended on GitHub | `pause` 14px `--muted` + `Suspended on GitHub` | none (it's GitHub's) |

   Order: linked (owner's first), waiting, suspended, removed. Removed rows older than 30 days fold under a `{n} removed` toggle in `--faint`. The row is a `button` selecting it for the panel; selected `--sel`, 6px radius inside the section's width.
4. **The strangers line** (16px under the last section), 13px `--faint`, Lucide `info` 13px: `A stranger who installs a public App reaches nothing: ostra drops its events and lists none of its repos until you link it.` Shown when any App is public.

### Properties panel

**A selected installation (the picture):**
1. Label `Installation`; title the login (mono 15px 600). Rows: `Account` (`dana-dev · user`), `App` (mono slug), `Installed` (mono `18 Nov` + ` by dana-dev`, the GitHub sender), `Repos` (each repo in mono, one per line, at most 5 then `and {n} more`; `All repositories` for that selection).
2. 13px `--muted`, by state:
   - waiting: `Someone installed ostra-acme on this account. Link it if it's a client's, and its repos can join projects. Remove it to uninstall the App there.`
   - linked: `Its repos can join projects. Unlinking stops new tasks on them, with the reason; running tasks finish.` and, when projects hold its repos, a `Used by` row with the projects.
   - removed: `Removed by Alex Kim on 3 Nov. The App is no longer installed there.`
3. `Separator`, label `Add a GitHub organization`: 13px `--muted` `Send this link to the organization's owner. They pick the repos; the installation waits here until you link it.`, then a read-only mono field (`--surface`, 32px) with the App's install URL (`github.com/apps/ostra-acme/installations/new`) and the `CopyButton` (`components/ui/copy-button.tsx`). For several public Apps, a `Select` above it picks the App.
4. `Separator`, label `Private Apps` (only when an App is private): 13px `--muted`: `GitHub lets only its owner install a private App, so northwind-ostra stays on northwind-co. Making an App public is one way: once another account installs it, it can't be made private again.` and a teal link `The App's settings on GitHub ↗` (`https://github.com/settings/apps/<slug>/advanced` for a user-owned App, `https://github.com/organizations/<owner>/settings/apps/<slug>/advanced` for an organization's: GitHub's "Danger zone"). The organization's own App private, with no public App at all: this group comes first, and `Add a GitHub organization`'s link is replaced by it (a private App's install link would 404 for anyone else).

**Add a GitHub organization** (the top-bar button) selects nothing and puts groups 3 and 4 at the top of the panel.

**A selected App:** milestone 1's `App` and `Permissions` groups for that App, plus `Owner` (mono login) and `Visibility`, and `Webhook` (`/webhooks/github/<connectionId>` in mono for a connected App, the App-wide address for the organization's own).

**Connect another App** (`?add=app`, a 380px form in the panel): milestone 1's existing-App fields `App ID` and `Private key` (no webhook secret field: ostra generates it). `Connect the App` (primary). On success, a **shown-once** group replaces the form: label `Set these in the App's settings on GitHub`; `Webhook URL` in a mono field with `CopyButton` (`https://ostra.acme.dev/webhooks/github/<connectionId>`); `Webhook secret` in a mono field with `CopyButton`; 12.5px `--muted` with `lock` 13px: `The secret is shown once. Copy it now: ostra keeps it in the secret store and never shows it again.`; then outline `Done`. Leaving the panel without `Done` asks `Leave without copying the secret?` (`AlertDialog`; leaving means generating a new one from the App's panel: `New webhook secret`). The App's own installation is linked when seen.

### Dialogs

- **Link:** no dialog; it applies (`github.linkInstallation`), with a 4s status line `dana-dev is linked. Its repos can join projects.`
- **Unlink:** `AlertDialog` `Unlink globex?`, body `New tasks on its 2 repos stop with the reason, in 2 projects. Running tasks finish. The App stays installed there.`, `Cancel` and `Unlink`.
- **Remove:** `AlertDialog` `Remove ostra-acme from dana-dev?`, body `This uninstalls the App from dana-dev on GitHub. To use it again, they install it again and you link it.`, `Cancel` and a destructive `Remove` (`--red` text on `--surface`).
- Each is an audit entry (`installation.linked`, `installation.unlinked`, `installation.removed`).

## States and copy

| State | What shows |
|---|---|
| **One App, one installation** (most teams) | one section, one `Linked · owner` row; no strangers line (private); the panel shows the App |
| **A waiting installation** (the picture) | as above; no needs-you row (open point 2) |
| **Webhook failing** | the section line's state; the App's panel shows the last delivery's time and error |
| **Linking, unlinking, removing** | the row's buttons disable with a 12px `Loader`; then the status line |
| **Loading** | title and lede at once; one section line and three `Skeleton` rows |
| **Error** | `role="alert"`, `--red`, `errorText(error)` under the section |
| **Narrow** | the panel drops under the page; below 640px, an installation's kind and repos move to a second line |

Demo data (fixtures): `ostra-acme` (owner `acme`, public; `acme` linked, `globex` linked with 2 repos, `dana-dev` waiting with `dana-dev/size-guide`, `initech` removed 3 Nov) and `northwind-ostra` (owner `northwind-co`, private, its own installation linked). Spec step 15 uses `ostra-test` and `ostra-test-b`.

## Components and tokens

`Button` (primary, outline, ghost), `AlertDialog`, `Select`, `CopyButton`, `SecretField` (`components/ui/secret-field.tsx`, for the shown-once secret), `Tooltip`, `Skeleton`, `Separator`, `PageFrame`, `PropGroup`, `PropRow`. Icons: `github`, `building-2`, `user`, `check`, `clock`, `pause`, `info`, `copy`, `arrow-up-right`, `triangle-alert`, `loader`, `lock`. The approved pictures' scale. `--green` only for `Linked`'s check and the receiving dot; no amber and no red on the page, except errors and the Remove dialog.

## Open points (settled by recommendation, 2026-11-19; recorded in ticket 54's `## Comments`)

1. **The waiting row's tone.** Settled: calm. No amber, no warning icon: a stranger's installation reaches nothing, and the strangers line says so once.
2. **A needs-you row for a waiting installation.** Settled: none in v1. The page is where an admin sends the install link, so they come back to it; a stranger's install would otherwise page every admin.
3. **The webhook secret of a connected App.** Settled: ostra generates it and shows it once (ticket 51), with a `New webhook secret` action on the App's panel for a lost one.
4. **Making the organization's own App public from the panel.** Settled: no. GitHub's settings page only, linked, since it's one way (ADR 0065, Q281).

## Differences from the current code

1. `github-view.tsx` reads one `github.connection`; it reads `github.connections` (ticket 51) and draws a section per App. Milestone 1's `Connection`, `Installations` and `Repositories` sections fold into it: the repositories list moves into a selected installation's panel (`Repos`).
2. The top bar's `Open on GitHub` moves into the App's panel.
3. The existing-App form drops the webhook secret field (ostra generates it) and gains the shown-once group.
4. Messages: grow the `github` namespace (`connections`, `installation.*`, `addOrg.*`, `privateApps.*`, `connectAnother.*`).

## Wrong in the image

- **`dana-dev`'s icon** is a lock; a user account is Lucide `user`.
- **`Waiting to be linked`** is drawn 600; it's 500.
- **The panel** starts at about x=1085, about 355px. It's 320px.
- **The panel's group labels** `Add a GitHub organization` and `Private Apps` are 14px `--muted`; they're 12px 500 `--faint`, like `Installation`.
- **The removed row's state** sits left of the state column; one grid for every row.
- **The sidebar** comes from the shell.
- The picture has no App panel, Connect another App, shown-once secret, dialog, loading or narrow states: they're above.

All visible copy is spelled right.
