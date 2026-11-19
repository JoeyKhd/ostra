# Target: email settings (milestone 3, screen 11)

> **Committed image:** `email-settings.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel.

- **Prompt:** `email-settings.prompt.txt`. GPT Image 2.6 through Higgsfield, 1 generation. References: the 2048 original of `app-targets/m2/storage-settings` (the screen the spec starts this one from), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route (new):** `apps/web/src/app/(panel)/organization/email/page.tsx` → `components/organization/email-view.tsx`.
- **Features:** F-115 (email notifications), F-036 (notifications). Spec section 12, screen 11. ADR 0050 ("Email is set per install, by the instance admin, in the panel or by `OSTRA_EMAIL_*` settings, which lock the panel's fields"), ADR 0007 (Resend first, SMTP second). Ticket 21 (`saveEmailSettings`, the test mail), ticket 37 (`email.settings.get`, `.save`, `email.sendTest`, `email.status`), ticket 45 (this screen).
- **Status:** a proposed target, waiting on approval (ticket 41's `## Comments`). Ticket 45 builds its data and tests until then, not its UI.

> Build it in real HTML/React (app-design.md, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

The instance admin decides whether ostra sends mail, and through what: Resend (an API key) or any SMTP server. They set the address mail comes from, send themselves a test mail and see what the provider said. Mail is optional: with it off, the panel and the ticket still carry every needs-you moment, and members' notification pages say "Mail is off on this install" (screen 10).

When `OSTRA_EMAIL_PROVIDER` is set, the settings own the choice and the page is read-only, naming the settings that lock it. The test mail still works then, since it's how an admin checks a settings-made setup.

The picture shows SMTP through Resend's relay, saved, right after a test mail the server accepted.

## Layout (CSS px at 1440 wide)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 232px, `--side`, 1px `--line` on its right | the shared sidebar. Organization: Runners, Models, GitHub, Linear, Storage, **Email** (Lucide `mail`, selected, `--sel`), Agent profiles. Email sits after Storage: both are instance settings. Build it from `components/shell/sidebar.tsx`, not from the picture |
| Top bar | 44px, 1px `--line` below | breadcrumb `Acme Corp › Email`; on the right the page's one primary button, `Save settings`, disabled (`opacity-50`) until the form differs from the saved settings |
| Page | `1fr`, padding `28px 40px`, content max 720px | title, lede, Provider, the provider's section, Sender, Test |
| Properties panel | **300px** (no form in it), 1px `--line` on its left, padding `20px 18px` | Status, Configuration, Last test, Last change |

The picture draws the sidebar at about 235px and the panel at about 396px. Build 232px and 300px.

### Heading

- Title `Email`, Manrope 700 24px, letter-spacing −0.015em. No eyebrow.
- Lede, 13.5px `--muted`, one line: `How ostra mails members when a task needs them. The panel and the ticket work without it.`

### Provider

1. **Title** `Provider` (600 13px), as storage's `Retention`. No lede under it: the options say it.
2. **`RadioGroup`**, 32px rows, 16px radios (`--line-2` ring; selected: `--text` fill, `--bg` centre), 10px before the label (13px `--text`), then 10px and a hint in 13px `--faint`:
   - `Off` · `no mail is sent`
   - `Resend` · `an API key`
   - `SMTP` · `any mail server`

   The order is the spec's (ADR 0007: Resend first). Choosing one swaps the section under it at once; nothing is saved until `Save settings`.

### The provider's section

Form rows, no box: 44px rows, a 1px `--line` hairline above each and under the last. The label sits in a 180px column (13px `--muted`, vertically centred, a real `<label>`); the control starts at 180px. Inputs are 32px (`h-8`), `--surface`, 1px `--line-2`, 7px radius, 10px padding; host names, ports, user names and addresses in Plex Mono 12.5px.

**SMTP** (the picture), title `SMTP server` (600 13px), 28px above:

| Label | Control (the picture) | Rules |
|---|---|---|
| `Host` | `Input` 320px, `smtp.resend.com` | required; a host name or IP, no scheme |
| `Port` | `Input` 88px, `587` | 1 to 65535; default `587` |
| `Security` | `Select` 200px: `STARTTLS` (`starttls`, the default), `TLS` (`tls`), `None, this machine only` (`none`) | `none` only with a loopback host (ticket 13) |
| `Username` | `Input` 320px, `resend` | optional: an empty user means no `AUTH` |
| `Password` | a secret (below) | |

Under the rows, 10px down, 12.5px `--faint`: `Port 587 with STARTTLS, or 465 with TLS, works with most providers.` (The picture leaves this line out; add it.)

**Resend**, title `Resend` (600 13px), 28px above, one row:

| Label | Control | Rules |
|---|---|---|
| `API key` | a secret (below) | required to save `Resend` the first time; Resend keys start with `re_`, and a key that doesn't is refused with the line below |

Under the row, 10px down, 12.5px `--faint`: `A key with sending access, from your Resend account. The from address's domain must be verified there.`

**Off:** no provider section. In its place, 10px under the radios, 12.5px `--muted`: `Members see what needs them in the panel and on the ticket. Their notification pages say mail is off.` Sender and Test are hidden too.

**A secret** (the SMTP password, the Resend key), following ticket 37 ("each secret shown only as set or not set"):
- **Set:** Lucide `check` 14px `--green`, `Set` in 13px `--text`, 12px gap, then `Replace`, a teal text button (`--teal`, no underline; the picture underlines it, which is wrong). `Replace` turns the row into an empty `type="password"` input with `autocomplete="new-password"` and a teal `Cancel` after it.
- **Not set:** the empty password input directly, with `Not set` as its `aria-describedby` hint in `--faint` after it.
- A secret is never sent back to the browser: the input is always empty, and leaving it empty keeps the stored one.

### Sender

Title `Sender` (600 13px), 28px above, the same rows:

| Label | Control (the picture) | Rules |
|---|---|---|
| `From address` | `Input` 320px, `ostra@acme.dev`, `type="email"` | required for Resend and SMTP |
| `From name` | `Input` 320px, `ostra` | optional; empty means `ostra` (`OSTRA_EMAIL_FROM_NAME`'s default) |

Under the rows, 10px down, 12.5px `--faint`: `Use an address on a domain your mail provider has verified, or mail may be refused.`

### Test

1. Title `Test` (600 13px), 28px above.
2. A secondary `Button` (32px, `--surface`, 1px `--line-2`, 13px `--text`, Lucide `send` 14px before the label): `Send a test mail`. Then 12px right, 12.5px `--faint`: `to alex@acme.dev` (the signed-in admin's address).
3. The result line, 10px under the button, 12.5px, `role="status"` (see the states). The picture: Lucide `circle-check` 13px and `Accepted by smtp.resend.com at 14:02. Check alex@acme.dev for it.` in `--green`.

The test sends the `test` kind (ticket 21) with the **saved** settings. While the form has unsaved changes the button is disabled and the hint reads `Save your changes to test them.`

4. **Footnote,** 24px down, 12px `--faint`: `Secrets go to the secret store and are never shown again. Changes are recorded in the audit log.`

### Properties panel

`PropGroup`s with an 11px 500 `--faint` label, 30px `PropRow`s, 12.5px, with storage's `labelWidth` of 150px.

1. **Status:** `Mail` · a 7px `Status` dot and `On, through SMTP` (`On, through Resend`; off: a `--faint` dot and `Off`). `Delay` · `2 min` in sans (the picture draws it in mono): `OSTRA_EMAIL_DELAY_SECONDS` or the instance setting, shown in minutes when it divides by 60, else seconds (`45 s`). `0` reads `none`.
2. **Configuration:** Plex Mono 12px keys in `--muted`, values in Plex Mono `--text`, `unset` in `--faint`:
   - `OSTRA_EMAIL_PROVIDER` · `unset`
   - `OSTRA_EMAIL_FROM` · `unset`

   Only these two: the secrets' settings never show a value, and the lock line in the page names the rest.
3. **Last test:** `When` · `today, 14:02` (sans; relative day, then the time); `Result` · `Accepted` in `--text`, or `Failed` in `--red`. Never tested: one line, 12.5px `--muted`, `No test mail yet.`
4. **Last change:** one line, 12.5px `--muted`, from the latest email audit entry: `Switched to SMTP by Alex Kim, 19 Nov` (`Set to Resend by …`, `Turned off by …`, `Sender changed by …`). Never saved: `Never changed. Mail is off by default.`

## States and copy

| State | What changes |
|---|---|
| Loading | the radios disabled, every control and panel value a `Skeleton` bar (120–200px) |
| Off (the default) | `Off` selected; the off line; no Sender, no Test; Status `Off`; `Save settings` disabled |
| Resend, saved | the `Resend` section with the key `Set`; Sender; Test |
| SMTP, saved (the picture) | as drawn |
| Edited | any control differs from the saved settings: `Save settings` enabled; `Send a test mail` disabled with `Save your changes to test them.` |
| Invalid | the field gets a `--red` border and, under its row, 12px `--red`, `role="alert"` on the first: Host `A host name, like smtp.example.com.`; Port `A port from 1 to 65535.`; Security `Without TLS, only a mail server on this machine is allowed.`; From address `An email address, like ostra@example.com.`; API key `A Resend API key starts with re_.` and, for a missing one, `Enter the API key.`. `Save settings` disabled |
| Saving | `Save settings` reads `Saving…`, disabled, with Lucide `loader-circle` spinning |
| Saved | `Save settings` disabled again; under the footnote, `role="status"`, 12.5px `--green` with `check`: `Saved.`; Last change updates. No confirm dialog: nothing is deleted, and turning mail off loses no setting |
| Save failed | under the footnote, `role="alert"`, 12.5px `--red`: the error text (`errorText`) |
| Sending a test | the button reads `Sending…`, disabled, with `loader-circle` |
| Test accepted (the picture) | `circle-check` `--green`: `Accepted by <host> at <time>. Check <address> for it.` (`Accepted by Resend at 14:02. …` for Resend) |
| Test failed | `circle-alert` `--red`, the provider's reason in words from the adapter, never a secret: e.g. `The server refused the login (535). Check the username and password.`, `Resend refused the key. Check that it has sending access.`, `No answer from smtp.resend.com:587.`; Last test `Failed` |
| No address | the admin's account has no address: the button is disabled and the hint reads `Your account has no email address.` |
| Locked by settings | `OSTRA_EMAIL_PROVIDER` is set (`resend`, `smtp` or `off`). Under the lede, 16px down, a block with a 2px `--line-2` left rule and 12px left padding (storage's deletion block; never amber), Lucide `lock` 13px `--muted` and 12.5px `--muted`: `Set by OSTRA_EMAIL_PROVIDER, OSTRA_EMAIL_FROM and OSTRA_SMTP_HOST on this install. Change them there and restart ostra.` (every setting that's set, in Plex Mono, from `lockedBySettings`). The radios and inputs are disabled, showing the settings' values; secrets show `Set` with no `Replace`; `Save settings` is hidden. `Send a test mail` still works. The panel's Configuration shows the values (`OSTRA_EMAIL_PROVIDER` · `smtp`) |
| Read-only, organization admin | an organization admin who isn't the instance admin (ticket 45): the page as in the locked state, with the block reading `Only the instance admin can change email.`, and no `Send a test mail` |
| Not an admin | `AdminOnly` (the page isn't in their sidebar either) |
| Load failed | the error alert in place of the sections |
| Narrow (below 1280px) | the panel drops under the page (`PageFrame`); below 640px the label column shrinks to 120px and inputs take the rest of the row (`min-w-0 flex-1`), the Test hint wraps under the button |

## Components (shadcn/ui names)

`Sidebar` (existing, plus the Email row), `PageFrame` with `Breadcrumb` and `properties`, `PageHeading`, `Section`, `PropGroup` / `PropRow` (with storage's `labelWidth`), `Button` (default = the Shell primary; `variant="secondary"` for the test), `RadioGroup` / `RadioGroupItem` (in `components/ui/radio-group.tsx`), `Input`, `Label`, `Select` (in `components/ui/select.tsx`), `Skeleton`, the `Status` dot. Lucide 15px, stroke 1.75: `mail`, `send`, `check`, `circle-check`, `circle-alert`, `lock`, `loader-circle`.

## Tokens (`app-concepts/html/graphite.css`)

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page, panel, the selected radio's centre |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | inputs, select, the test button, skeletons |
| `--line` | `#1F2023` | row hairlines, panel edge, group lines |
| `--line-2` | `#2A2C30` | input, select, radio and button borders, the lock block's rule |
| `--text` | `#EDEDEE` | values, radio labels, `Set` |
| `--muted` | `#9A9DA3` | labels, lede, the off line, the lock block |
| `--faint` | `#64676D` | hints, help, `unset`, the footnote |
| `--sel` | `#1A1B1E` | the selected Email row |
| `--green` | `#4FB286` | `Set`'s check, the On dot, an accepted test, `Saved.` |
| `--red` | `#E5675C` | invalid fields, a failed test, errors |
| `--teal` | `#6FB8AA` | `Replace`, `Cancel` |
| `--amber` | `#FFB224` | only the sidebar's Needs you count. Nothing on this page is amber |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | `Save settings` |

Type: Manrope 700 24px (title); IBM Plex Sans 13px body, 12.5px secondary, 11px panel labels, 600 for section titles, 500 for buttons; IBM Plex Mono for hosts, ports, user names, addresses and setting names.

## Data this screen needs beyond ticket 37

Ticket 37's `email.settings.get` returns the provider, the from address and name, the key or the SMTP fields with secrets as set or not set, `lockedBySettings` with the setting names, and the last test's time and result. The picture also shows these; add them to that query or drop the row:

- **The delay** in effect (`emailDelaySeconds` or `OSTRA_EMAIL_DELAY_SECONDS`), for Status.
- **The values of the two non-secret settings** that are set, for Configuration and the locked fields.
- **The last email audit entry** (who, what, when), for Last change.
- **The admin's own address,** for `to alex@acme.dev` (already on the session).

## Differences from the current code

Checked against `apps/web` on `main` (2026-11-19):

1. **New route and view.** Nothing exists: add `organization/email/page.tsx` and its view (ticket 45 names `src/app/(panel)/organization/email/`).
2. **Sidebar.** `components/shell/sidebar.tsx` lists Runners, Models and GitHub; Linear and Storage come with milestone 2's screens. Add Email (`mail`) after Storage, for instance admins and, read-only, organization admins.
3. **`RadioGroup`, `Select` and `Skeleton`** exist in `components/ui/`. `PropRow` (`components/shell/page-frame.tsx`) still has a fixed key column: storage's target (milestone 2) adds `labelWidth`; reuse it, or add it here if storage hasn't shipped.
4. **A secret row** (`Set` · `Replace`) is new; make it one component (`SecretField`), since agent profiles' MCP secrets (screen 2) show the same thing.
5. **`AdminOnly`** needs the instance wording here too (storage's difference 5).
6. **Messages.** New keys under `email.*` in `messages/en.json`.
7. **`app-design.md`'s sidebar list** names Storage but not Email; add it after Storage when this ships.

## Wrong in the image

Build the copy and details in this file, not these:

- The sidebar is about 235px and the panel about 396px. Build 232px and 300px.
- The form rows are about 41px and the inputs about 29px. They're 44px and 32px. The Host input is about 343px wide; it's 320px.
- `Replace` is underlined. It's a teal text button with no underline.
- `Port`'s `587` is drawn in sans. It's Plex Mono, like the other values.
- `Delay` · `2 min` and the Last test values (`today, 14:02`, `Accepted`) are drawn in mono. They're sans.
- The SMTP section has no help line under its rows. Add `Port 587 with STARTTLS, or 465 with TLS, works with most providers.`
- The picture has no loading, edited, invalid, saving, test-failed, Resend, off, locked or read-only states: they're in the table above.

All visible copy in the image is spelled right.
