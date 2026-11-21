# Target: the instance's preview domain (proposed 2026-11-21)

> **Committed images:** each `<name>.png` is the render at 2× (2880×1912), and each `<name>.webp` is 1440×956, one image pixel per CSS pixel. Both render from `html/instance-preview-domain.html`, a query string choosing the state, with the panel's own tokens (`apps/web/src/app/globals.css`) and fonts (`apps/web/src/fonts`). Sizes in this file are CSS px. Re-render: `node html/render.mjs <playwright's index.mjs> <name>`, then `python -I html/to-webp.py <name>`.

| Picture | State shown |
|---|---|
| `instance-preview-domain.webp` | Alex Kim, the instance admin and an admin of Acme Corp, on **Instance › Previews**. `OSTRA_PREVIEW_DOMAIN` is `preview.acme.dev`, on the panel's own site, so the page warns. The DNS record, the certificate and the WebSocket upgrades to add. The check ran at 14:32: the DNS record resolves, the certificate covers only `core.acme.dev`, and the two checks after it didn't run. Last, Acme Corp's `Allow public preview links`, off. |
| `instance-preview-domain-unset.webp` | The same page on an install with no preview domain, the default: what works without it, the four steps to turn it on, `preview.localhost` for a development machine, and the public links switch. |

- **Route:** new, `apps/web/src/app/(panel)/instance/previews/page.tsx` → `components/instance/previews-view.tsx`, for the instance admin alone, as Accounts, Storage and Email (`../m4/instance-settings.md`).
- **Shell:** the double sidebar (`app-shell.md`): the rail's **Org** space, the Organization panel's `Instance` group gains **`Previews`** (Lucide `app-window`), selected here. It's the group's fourth row, after `Email`.
- **Features:** F-144 (the preview domain: the settings page's DNS and certificate check) and F-142 (sharing: the organization's switch for public links). The milestone 8 spec names this target (`context/specs/m8-previews-and-library/spec.md`, section 13, target 9), and ticket 26 builds it, with ticket 25's check. The facts are ADR 0068 ("The native preview", "Who can open a preview") and `context/research/live-previews.md` §3 and §4.
- **Status: a proposed target, waiting for the maintainer's approval.**

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with each picture.

## Purpose

The preview domain is optional (the maintainer, 2026-11-20: "welcome but must stay OPTIONAL"). Without it, the pane streams the box's own browser, `ostra preview` serves a port on a member's `localhost`, and screenshots land in the thread. With it, the app also runs in the member's own browser on `<port>-<preview>.<domain>`, devtools and all. The self-hoster who wants that has to add three things outside ostra, and this page is where they learn which and see whether they worked:
1. **What's set,** read-only, since it's a setting (`OSTRA_PREVIEW_DOMAIN`), and whether it shares a site with the panel (Q307: allowed, with a warning).
2. **What to add,** in the self-hoster's words: one wildcard DNS record, a wildcard certificate (Let's Encrypt only through DNS-01), and WebSocket upgrades on those hosts.
3. **Whether it works:** a check with each result, and what the pane does until it passes.
4. **Whether public links are allowed** for the organization, off by default (F-142).

## Layout (`instance-preview-domain.webp`)

The page column is 1136 at 1440: the page `minmax(0, 1fr)` and the properties panel 320. Page padding `26px 36px 20px`, the content at most 744 wide.

1. **Top bar,** 46px: `Instance › Previews`; at the right a ghost `Previews in the docs` (Lucide `book-open`), which opens the docs page on the preview domain in a new tab. No primary: nothing on this page is a form to save.
2. **Title** `Previews` (Manrope 700 26px). **Lede,** 15px `--muted`, one line: `How a task's app opens in a member's own browser. Optional: without it, previews stream from the box.`
3. **`Preview domain`** (a title line: 600 15px, then the note `from ostra's settings, so it's read-only here`, 13px `--muted`), 26px under the lede:
   - one 36px key-value row between hairlines: the key `OSTRA_PREVIEW_DOMAIN` (Plex Mono 13px `--muted`, a 196px column), the value in Plex Mono 14px `--text`, then 13px `--faint` `a preview opens on` and an example host in mono `--muted`, `5173-k3f9d2….preview.acme.dev`;
   - **the site warning,** only when the domain shares a registrable domain with `OSTRA_PUBLIC_URL`: Lucide `triangle-alert` 15px `--muted`, 13.5px `--text` `preview.acme.dev is on the panel's own site, acme.dev.`, then 13px `--muted` `Previews work, but a domain of its own, such as acme-preview.dev, keeps their cookies apart.` and a teal `Why` (the docs' section). Never amber or red: it's allowed (Q307).
4. **`Add these once`,** note `at your DNS provider, and at the ingress in front of core`. A list between hairlines, each item a `26px 1fr` grid with padding `10px 0`, a 15px `--faint` icon, the item in 14px 500, and its detail in 13px `--muted`:
   - `globe` **One DNS record**, then a code line (34px, `--surface`, 1px `--line-2`, 8px radius, Plex Mono 13px): `*.preview.acme.dev`, `CNAME` in `--faint`, and core's host from `OSTRA_CORE_PUBLIC_URL` (`core.acme.dev`), with a teal `Copy` (Lucide `copy`) at its right. When core's public address is an IP, the record reads `A` and the address.
   - `lock` **A wildcard certificate for `*.preview.acme.dev`**: `Let's Encrypt issues one only through DNS-01: your ACME client needs your DNS provider's API.`
   - `arrow-left-right` **WebSocket upgrades on those hosts**: `As runners need on core's own host. A dev server's live reload rides them.`
5. **`Check`,** note `resolves a random name under the domain and opens it over HTTPS`. Four 36px rows between hairlines, a `26px 168px 1fr` grid: a 15px result icon, the check's name (14px), and its result (13px `--muted`, names and addresses in mono 12.5px `--text-2`):

   | Check | Passed | Failed | Not run |
   |---|---|---|---|
   | `DNS record` | `q7m2x9.preview.acme.dev → core.acme.dev · 203.0.113.24` | `q7m2x9.preview.acme.dev doesn't resolve.` / `… resolves to 198.51.100.7, not core.acme.dev.` | — |
   | `Certificate` | `*.preview.acme.dev, valid until 19 Feb 2027` | `The certificate covers core.acme.dev only, not *.preview.acme.dev.` (drawn) / `It expired on 3 Nov.` / `Its chain isn't trusted.` | `Not checked: it needs the DNS record.` |
   | `ostra answers on it` | `core's preview proxy answered.` | `Something else answered: the ingress sends these hosts elsewhere.` | `Not checked: it needs the certificate.` (drawn) |
   | `WebSocket upgrades` | `An upgrade went through.` | `The ingress refused the upgrade (400).` | `Not checked: it needs the certificate.` (drawn) |

   Icons: Lucide `circle-check` `--green`, `circle-x` `--red`, `circle-dashed` `--faint` (and the row's text `--faint`). A failed row's result is `--text`, so it reads first.
   - **Under the rows,** 13px `--faint`: `Checked at 14:32 by Alex Kim. Until it passes, previews stream from the box's browser.` and, at the right, `Check again` (outline, 28px, Lucide `refresh-cw`). While it runs: `Checking…` with a spinner, each row's icon a spinner in turn. It takes at most 10 s.
6. **`Public preview links`,** note `Acme Corp's setting`: a `Switch` (off), `Allow public preview links` (14px), then 13px `--faint` `off: a link expires within 7 days` (on: `on: members may make a link that doesn't expire`). Under it, 13px `--faint`: `A public link opens a preview for anyone who has it, signed in or not, until a member revokes it. Members still choose it per preview, and each change is in the audit log.` It saves at once. Turning it on asks first, in an `AlertDialog`: `Allow public preview links in Acme Corp?` / `Anyone with a public link sees that preview, and with "Allow input" clicks and types in it, until a member revokes it. Turning this off ends every public link.` / `Cancel` and `Allow public links`.

### The properties panel (320px)

Groups with a 12px 500 `--faint` label, 28px rows with a 120px key column:
1. **`Preview domain`:** `Status` (a 7px dot and a word: `--red` `Check failing`, `--green` `Working`, `--faint` `Not checked` or `Not set`); `Last check` `14:32` (mono) and `· 1 of 4 passed` (`--faint`); `In your browser` `Off until it passes` (`--muted`), or `On` once it passes; `Panel` `ostra.acme.dev` and `Core` `core.acme.dev` (mono), from `OSTRA_PUBLIC_URL` and `OSTRA_CORE_PUBLIC_URL`.
2. **`Signing in on a preview`:** `Cookie` `__Host-ostra-preview` (mono 12.5px); `Scope` `The preview's host only`; `SameSite` `Lax · the panel's site` (`None, partitioned · another site` for a domain of its own); `Lasts` `12 h at most`. Then 12.5px `--faint`: `A one-time code sets it. The panel's own cookie never reaches a preview, and only the panel may frame one.`
3. **`Without a preview domain`:** what works either way, each a 28px row with a 14px icon: `check` `--green` `The browser view` `every runner`; `ostra preview` `a member's localhost`; `Screenshots` `in the thread`; and `minus` `--faint` `The app in your browser` `needs it`. The second words are 12.5px `--faint`.

## Every state

| State | What shows |
|---|---|
| **Set, check failing** | The picture |
| **Set, never checked** | The `Check` rows all `circle-dashed` with `Not checked yet.`, and `Check` as an outline button in place of `Check again`. Status `Not checked`. The page runs the check once on its first visit after the domain changes |
| **Set, working** | Every row `circle-check`. The line under them: `Checked at 14:32 by Alex Kim. Previews open in members' own browsers.` Status `Working`, `In your browser` `On` |
| **Set, on its own site** | No warning line. `SameSite` reads `None, partitioned · another site` |
| **Not set** (the default) | `instance-preview-domain-unset.webp`: the key's value `not set` `--faint`; 14px `--muted` `Previews work without it: the pane streams the box's own browser, ostra preview serves a port on a member's own localhost, and screenshots land in the thread. With a preview domain, the app also runs in the member's own browser, with its devtools.`; then **`To turn it on`** (note `once, by whoever runs this install`), four numbered steps (a 20px ring with the number in mono 11.5px): `Pick a domain of its own` (`Such as acme-preview.dev. A name on the panel's own site, such as preview.acme.dev, works too, with a warning.`), `Add one DNS record` (the code line), `Get a wildcard certificate, and pass WebSocket upgrades`, `Set the domain, restart core, and check it here` (the code line `OSTRA_PREVIEW_DOMAIN=acme-preview.dev`). Then 13px `--faint`: `On a development machine, preview.localhost needs no record and no certificate: browsers send every *.localhost name to the machine itself.` No `Check` section. Status `Not set`, `In your browser` `Off` |
| **`preview.localhost`** | The record and certificate items read `Not needed for preview.localhost.` in `--faint`; the check runs the last two rows only, over `http` |
| **The check can't run** (core can't resolve names, a timeout) | Under the rows, 13px `--red`: `The check didn't finish: {reason}.` + `Check again`. Nothing else changes |
| **Public links on** | The switch teal, `on: members may make a link that doesn't expire`. In each preview's share menu, `Public` is no longer greyed (`preview-share.webp`) |
| **An instance admin who isn't an admin of the organization** | The `Public preview links` section reads, 13px `--muted`: `Public links are each organization's choice, on its own settings page.` with no switch |
| **Loading** | The value and the check rows as `--surface` bars; the panel's values as bars |
| **Light theme** | `../m7/light-home.md`'s tokens. Not drawn |

## Keyboard

- Tab order: the docs link, each `Copy`, `Why`, `Check again`, the switch. No new shortcut.
- `Copy` announces `Copied` (`aria-live="polite"`), as every copy button.
- The check's rows are a list (`role="list"`); while it runs, the section is `aria-busy` and each finished row is announced (`Certificate: failed. The certificate covers core.acme.dev only.`).
- The switch is a real `Switch` labelled by its text; its `AlertDialog` traps focus and returns it to the switch.

## Narrow and phone width

- **1024–1279px:** the context panel collapses (the shell's rule). The page keeps its sections.
- **Below 1024px:** the properties panel moves under the page as sections. The check's grid becomes two lines per row: the icon and name, then the result under them.
- **Phone (390px):** the shell's phone pattern: a 54px top bar whose menu button opens the rail and the panel as one sheet (`app-shell.md`). The code lines scroll sideways inside their box, with `Copy` pinned at the right, 44px. `Check again` and the switch are 44px tall.

## Components (shadcn/ui names)

- **From the repo:** the shell, `Button`, `Switch`, `AlertDialog`, `Tooltip`, `Skeleton`, the copy button (`copy-button.tsx`), `PropGroup` and `PropRow`, the instance pages' frame (`components/instance/`).
- **New:**
  - `components/instance/previews-view.tsx`: the page;
  - `preview-domain-check.tsx`: the four rows, each a union `{ state: "passed"; detail } | { state: "failed"; reason } | { state: "skipped"; needs } | { state: "running" }` with an exhaustive `switch`;
  - `public-links-setting.tsx`: the switch and its dialog, the same component on Organization › Settings.
- **Icons** (Lucide, stroke 1.75): `app-window` (the panel row), `book-open`, `triangle-alert`, `globe`, `lock`, `arrow-left-right`, `copy`, `circle-check`, `circle-x`, `circle-dashed`, `refresh-cw`, `check`, `minus`.

## Tokens

`globals.css`'s, both themes: `--bg` the page and the panel; `--surface` the code lines; `--line` hairlines; `--line-2` the code lines' and the numbers' edges; `--text` values and a failed result; `--muted` notes, keys and results; `--faint` help and skipped rows; `--green` a passed check, `--red` a failed one; `--teal` the links, `Copy` and the switch when on. No amber, and no primary.

## WCAG AA (F-081)

Computed from `html/m8.css`'s tokens (WCAG 2.x relative luminance).

| Pair | Dark | Light | Need |
|---|---|---|---|
| `--faint` on `--bg` (help, the skipped rows, the check's line) | 5.9:1 | 5.6:1 | 4.5 |
| `--muted` on `--bg` (notes, keys, results) | 9.6:1 | 8.1:1 | 4.5 |
| `--text` on `--surface` (the code lines) | 16.6:1 | 16.5:1 | 4.5 |
| `--faint` on `--surface` (`CNAME`) | 5.6:1 | 5.3:1 | 4.5 |
| `--teal` on `--surface` (`Copy`) | 8.0:1 | 5.7:1 | 4.5 |
| `--teal` on `--bg` (`Why`, a switch's track) | 8.4:1 | 6.1:1 | 4.5 |
| `--green` on `--bg` (a passed icon, with its name) | 7.4:1 | 5.5:1 | 3 |
| `--red` on `--bg` (a failed icon, the check's error) | 5.9:1 | 5.7:1 | 4.5 |
| `--control-line` on `--bg` (the switch when off) | 3.6:1 | 3.6:1 | 3 |

## Data it needs

1. **The settings, read-only:** `OSTRA_PREVIEW_DOMAIN` (unset by default), `OSTRA_PUBLIC_URL` and `OSTRA_CORE_PUBLIC_URL`, from core's config. The page never writes a setting.
2. **Whether the domain shares a site with the panel,** by the public suffix list's registrable domain (the same rule that picks `Lax` or `SameSite=None; Partitioned`, ticket 25).
3. **The check** (`instance.previewDomainCheck`, ticket 25): a random name under the domain resolved, then fetched over HTTPS; this target asks it also to report whether core's preview proxy answered and whether an upgrade passed (open point 2). Its last result, who ran it and when, kept per install.
4. **The organization's `allowPublicPreviewLinks`,** off by default, and whether the viewer is an admin of it.
5. **Audit:** the check run (no result text) is an instance audit entry; the public-links switch is the organization's (ADR 0054).

## Differences from the current code

1. **No Instance › Previews page** and no `Previews` row in the Instance group (`sidebar.tsx`; the shell's panel after ticket 10).
2. **No preview domain, check, or public-links setting** in the config, the API or the schema (tickets 04, 25, 26).
3. **Organization › Settings** gains the same `Allow public preview links` section (spec section 13, "Screens that only grow").
4. **Messages:** new keys under `instance.previews.*`.

## Open points (recommendations; the maintainer's approval settles them)

1. **Where `Allow public preview links` lives.** Ticket 26 puts it on Organization › Settings; this target also draws it here, since v1 has one organization per install and its instance admin is usually its admin. Recommended: one component on both pages, the switch only for an admin of the organization, and this page's copy says it's the organization's.
2. **The check's four rows.** Ticket 25's check reports the DNS record and the certificate. Recommended: also whether core's preview proxy answered and whether an upgrade passed, since a wrong ingress rule is the likeliest failure after the certificate.
3. **The pane while the check fails.** Recommended (drawn: `Off until it passes`): the pane keeps the browser view until the last check passed, so a half-set domain never shows members a broken frame. The alternative is to trust the setting and let the pane fail.
4. **A domain on the panel's site** warns (drawn), as Q307 settled. Recommended as drawn: a warning line, never red, never blocking.

## Wrong in the image (build from this file)

- **The example host** `5173-k3f9d2….preview.acme.dev` is cut with an ellipsis; a real preview ID is 26 characters. Build the example from a real preview of the organization when one exists, else from the pattern, never truncated in the middle.
- **The DNS record's value** is drawn as `core.acme.dev`, a host name. When `OSTRA_CORE_PUBLIC_URL` holds an IP address, build an `A` record instead.

Right as drawn: the read-only value with no field, the warning in `--muted` and not amber, the four checks with the skipped ones `--faint`, no primary, the panel's three groups.
