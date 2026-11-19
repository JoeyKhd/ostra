# Target: Reset a password (milestone 4, screen 4)

> **Committed images:** `reset-password.webp` ("Forgot your password?", the request) and `reset-password-link.webp` (the page a reset link opens), each downscaled from its 2048×1360 generation to 1200×797, so one image pixel is one CSS pixel at the sign-in frame's 1200×800 viewport. The right column of both is the real sign-in illustration and tagline, composited exactly as on `../m1/change-password.webp`.

- **Prompt:** `reset-password.prompt.txt` (both pictures). GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation each. Each is an edit of `../m1/change-password.png` (the approved 2048 original this screen starts from, spec section 12), with `../../app-concepts/html/home-graphite.png` and the Hinge logo `../../kit/logo/export/ostra-hinge-single-color-2048.png` as references. The generated right column (m1's old task glimpse) was then replaced by `../../files/web/sign-in-illustration.webp` and the tagline, with the script m1 used.
- **Routes (new):** `/reset` (the request) and `/reset/new` (the link's page): `apps/web/src/app/reset/page.tsx` and `apps/web/src/app/reset/new/page.tsx`, outside the `(panel)` layout, in `components/auth/auth-frame.tsx`. Forms: `components/auth/reset-request-form.tsx` and `components/auth/reset-password-form.tsx`.
- **Features:** F-002 (self-service resets by mail when email is set up, the instance admin's reset link without it, one use, 24 hours, every reset signs out the other sessions). Spec section 3 step 14, section 4 ("A reset"), section 12 screen 4. Ticket 22 (the reset request, `accounts.createResetLink`, `ResetLinkGrant`), ticket 32 (these pages and the sign-in link). ADR 0053 ("Resets"), ADR 0003 (the sink).
- **Status:** a proposed target, waiting on approval (ticket 31's `## Comments`). Ticket 32 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5) inside the existing `AuthFrame`, then screenshot the build at 1200×800 and compare it with the pictures.

## Purpose

Two pages for a member who can't sign in:

1. **The request** (`/reset`): they give their address and get a link by mail. The page answers the same whether or not the address has an account, so it can't be used to find accounts (ADR 0053). It only exists when email is set up; without email, the instance admin makes the link (`instance-settings`, "Accounts") and this page says so.
2. **The link's page** (`/reset/new`): they choose a new password, in the change-password form they already know, and every session of the account ends, CLI sessions included. A link that's expired or used says which, and what to do next.

The pictures show Sam: the request filled in and ready to send, and the link's page filled in and valid.

## Route and flow

- **Getting there.** On `/sign-in` with email set up, the help line under the button becomes a link: `Forgot your password?`, 12px, teal 500, to `/reset`. Without email it stays the faint line `../m1/sign-in.md` specifies: `Forgot your password? Ask your instance admin for a reset link.` The same applies under "Sign in to accept" on `/invite/[id]` (`accept-invite.md`). Whether email is set up comes from the server (the instance's email settings, milestone 3), never a client guess.
- **The request.** `/reset` posts the address to better-auth's reset request (`requestPasswordReset`). Its mail callback (ticket 22) writes a `ResetLinkGrant` (`self_service`, the token's hash, `expiresAt` = now + `OSTRA_RESET_LINK_HOURS`) and enqueues an `account-mail.send`, **only for an account with a verified address**. The endpoint returns the same 200 either way, and the page shows the same "Check your inbox". A removed member's account still resets: the account stays (ADR 0053); it just has no organization.
- **The link.** ostra's mail callback builds the link itself from the token better-auth hands it: `<OSTRA_PUBLIC_URL>/reset/new?token=<token>`, not better-auth's `/api/auth/reset-password/<token>` redirect, so the page can tell an expired link from a used one (below). The instance admin's link (`accounts.createResetLink`, through ADR 0003's sink) is the same URL with an `admin_link` grant.
- **Opening it.** The server component reads `accounts.resetPreview(token)` (new, see "Data"): by the token's hash, `valid` with the account's address, `used`, `expired` or `unknown`, rate-limited by IP. The client then drops the token from the address bar (`history.replaceState` to `/reset/new`) and keeps it in memory for the submit, so it doesn't sit in the history or on screen. The page sends `Referrer-Policy: no-referrer` and `noindex`, as `/invite` does.
- **Saving.** better-auth's `resetPassword({ newPassword, token })`. The server sets the hash, marks the grant used, revokes **every** session of the account (`revokeSessionsOnPasswordReset`; the link's page has none of its own) and its CLI sessions, and records the audit entry in each of the account's organizations (ticket 22). The page shows "Password changed" and sends the member to sign in. It doesn't sign them in: the link is a bearer secret, and the new password is the proof.
- **Signed in already.** Both pages work for a signed-in visitor too; `/reset/new`'s save signs out this browser as well, and the success copy says so.

## Layout

The sign-in frame (`../m1/sign-in.md`), unchanged and shared through `AuthFrame`. Only the block in the middle changes. Compare the build at **1200×800**; the sizes below are CSS px there. The message block (tile, title, lede, hairline, help lines, or a button) is `accept-invite.md`'s, built once as `AuthMessage`.

### The request (the first picture; 360px wide)

| Element | Spec | In the picture (y) |
|---|---|---|
| Title | `Forgot your password?`, `<h1>`: Manrope 700 24px/1.25, −0.015em, `--text` | 250 |
| Lede | 6px below. `Enter the email on your account. We'll send it a link to choose a new password.` Plex Sans 13.5px `--muted`, two lines | 280–310 |
| Field | 28px below. Label `Email`. Input 36px (`fieldClass`), `type="email"`, `autoComplete="email"`, `autoCapitalize="none"`, `spellCheck={false}`, `autoFocus`. Starts empty: carrying the address over from sign-in would put it in a URL, and so in access logs | 337, input 352–388 |
| Error line | only in the error states, 6px below the input (`FormMessage`) | |
| Button | 20px below. Full width, 36px, primary: `Send reset link` | 406–441 |
| Back line | 16px below. `Back to sign in`, 12px teal 500, a `Link` to `/sign-in` | 457 |

### The link's page (the second picture; 360px wide)

The change-password form (`../m1/change-password.md`), with its own copy. Everything not listed here (inputs, the rule line, the mismatch check and when it shows, the hidden `username` input for password managers, the submitting look) is change-password's, through the same `new-password.ts` helpers.

| Element | Spec | In the picture (y) |
|---|---|---|
| Title | `Choose a new password` | 250 |
| Lede | `For sam@acme.dev. Saving it signs you out everywhere else, CLI sessions included.` The address is the account's (from `resetPreview`), in `--text` weight 500; the rest `--muted` | 280–310 |
| Field 1 | `New password`, `autoComplete="new-password"`, `autoFocus` | 334, input 352–388 |
| Rule line | `At least 12 characters.` (`MIN_PASSWORD_LENGTH`), green `check` once met | 397–406 |
| Field 2 | `Confirm the new password` | 428, input 445–481 |
| Button | `Save new password` (`Saving…` while it runs) | 501–537 |
| Back line | `Back to sign in`, 12px teal 500 | 552 |

The hidden `username` input carries the account's address, so a password manager stores the new password against it.

## States and copy

Copy lives in `apps/web/messages/en.json` under `reset.*`; straight apostrophes. `24` is `OSTRA_RESET_LINK_HOURS`, never typed into the copy. `sam@acme.dev` is data.

### The request (`/reset`)

| State | When | What it shows |
|---|---|---|
| **Empty** | first load | the field empty and focused; `Send reset link` disabled until the field holds something with an `@` |
| **Filled** (the picture) | an address typed | button enabled |
| **Not an address** | a submit with a value the browser's `type="email"` check or the schema refuses | the input `aria-invalid`, red; `FormMessage`: `That isn't an email address.` |
| **Sending** | after submit, until the reply | the input `readOnly`; button `Sending…`, disabled, `loader-circle` spinning |
| **Sent** | any 200, whether or not the address has an account | the message block: icon `mail`; title `Check your inbox`; lede `If sam@acme.dev belongs to an account here, a link to reset its password is on its way. It works once, within 24 hours.` (the address `--text` 500); hairline; help `Nothing after a few minutes? Check spam, or ask your instance admin for a reset link.`; then `Back to sign in` (teal) · `Use another address` (teal, back to the empty form) |
| **Too many requests** | 429 | `FormMessage` without a red border: `Too many requests. Wait a minute and try again.` |
| **Server error** | network or 5xx | `FormMessage`: `That didn't work. Try again.` (`errors.unknown`) |
| **Email off** | the install has no email set up (also when `/reset` is opened by URL) | the message block, no form: icon `key-round`; title `Ask your instance admin`; lede `This install doesn't send email, so an instance admin makes reset links. Ask yours for one: it works once, within 24 hours.`; hairline; help `Back to sign in` (teal) |

The **Sent** copy never changes with the address: the same words, the same timing (the server does the same work, and the page shows the state only after the reply), for an unknown address, an unverified one, a removed member's and a real one.

### The link's page (`/reset/new`)

| State | When | What it shows |
|---|---|---|
| **Valid, empty** | `resetPreview` is `valid` | the form; `Save new password` disabled until both fields are filled and the rule is met |
| **Valid, filled** (the picture) | rule met, both fields filled | button enabled |
| **Too short / too long / mismatch / rejected by the policy / server error** | as change-password | change-password's lines and borders, unchanged |
| **Saving** | after submit | inputs `readOnly`; `Saving…` with the spinner |
| **Saved** | 200 | the message block: icon `check`; title `Password changed`; lede `Sign in with your new password. Every session of this account has been signed out, CLI sessions included.`; button `Sign in` (primary, to `/sign-in`). The `check` stays `--muted` like every tile icon; green is for the rule line |
| **Expired** | `resetPreview` is `expired`, or the save is refused as expired | icon `clock`; title `This reset link has expired`; lede (email on) `Reset links work for 24 hours. Request a new one.` with button `Request a new link` (primary, to `/reset`); (email off) `Reset links work for 24 hours. Ask your instance admin for a new one.` with the help line `Back to sign in` |
| **Used** | `resetPreview` is `used`, or the save is refused as used | icon `key-round`; title `This reset link has been used`; lede (email on) `Each link works once. If you didn't just change your password, request a new link.` with `Request a new link`; (email off) `Each link works once. If you didn't just change your password, ask your instance admin for a new one.` with `Back to sign in` |
| **Unknown** | no token, or a token with no grant | icon `link-2-off`; title `This link doesn't work`; lede `Check that you copied all of it, or request a new one.` (email off: `…or ask your instance admin for a new one.`); the same action as Expired |
| **Too many tries** | 429 on the preview | icon `clock`; title `Too many tries`; lede `Wait a minute, then open the link again.` |

A link used or expired while the form was open shows the matching state on submit, and the typed passwords are dropped.

## Components (shadcn/ui names)

| Part | Component | Notes |
|---|---|---|
| Frame | `AuthFrame` | as is |
| Forms | `Form` pattern, `Field` / `FieldLabel` / `FieldDescription` / `FieldError` | the link's page is change-password's form with other copy: share one `NewPasswordFields` component between the two |
| Inputs | `Input` at 36px | |
| Labels | `Label` | Plex Sans 500 12px `--muted` |
| Buttons | `Button variant="primary"` | sign-in's 36px size |
| Links | `Link` (Next) styled as `Button variant="link"` | `--teal`, 12px (12.5px in help lines), 500 |
| Message block | `AuthMessage` (`accept-invite.md`) | |
| Error line | `FormMessage` | as is |
| Icons | Lucide, stroke 1.75 | `check`, `circle-alert`, `loader-circle`, `mail`, `clock`, `key-round`, `link-2-off` |

## Tokens (`../../app-concepts/html/graphite.css`)

> **Scale.** Inside `AuthFrame`, so `.auth-scale` holds it at the sign-in frame's scale (`../m1/README.md`, "Scale").

| Token | Hex | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | form column |
| `--side` | `#0A0B0C` | illustration column, under the image |
| `--surface` | `#131416` | input fill, the message tile |
| `--line` | `#1F2023` | column hairline, the message hairline |
| `--line-2` | `#2A2C30` | input borders, the tile's border |
| `--text` | `#EDEDEE` | titles, input values, the address in ledes |
| `--muted` | `#9A9DA3` | ledes, labels, tile icons |
| `--faint` | `#64676D` | rule line text, help lines, focus border |
| `--green` | `#4FB286` | the rule line's check |
| `--red` | `#E5675C` | invalid borders, error lines and icons |
| `--teal` | `#6FB8AA` | `Forgot your password?`, `Back to sign in`, `Use another address` |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | the primary buttons; `--shell` at 70% for the tagline |
| `--amber` | `#FFB224` | **not used** |

Type: Manrope 700 (titles), IBM Plex Sans 400/500/600 (everything else, addresses included), IBM Plex Mono only in the version footer.

## Responsive

As `../m1/sign-in.md`: the illustration column and the tagline hide under 960px; the block stays 360px and centred; under 420px it takes the full width with 16px gutters and no horizontal scroll. A long address wraps in the lede (`overflow-wrap: anywhere`).

## Data these pages need beyond ticket 22

- **`accounts.resetPreview(token)`** (public, rate-limited by IP): by the token's SHA-256 hash in `ResetLinkGrant`, `{ state: "valid", address }`, `{ state: "used" }`, `{ state: "expired" }` or `{ state: "unknown" }`. Never the account's username, organizations or anything else. Ticket 22's grant already holds `expiresAt` and `usedAt`; this read is new.
- **The link's URL** is built by ostra's mail callback and by the sink from the token (`/reset/new?token=`), not better-auth's redirect URL (above).
- **Whether email is set up**, as one server-read boolean for `/sign-in`, `/reset`, `/reset/new` and `/invite/[id]`.
- **`OSTRA_RESET_LINK_HOURS`** for the copy, read on the server.

## Differences from the current code

Checked against `apps/web` on `main` (2026-11-19):

1. **New routes.** No `/reset` or `/reset/new` exists.
2. **The sign-in help line** isn't rendered today (`../m1/sign-in.md`: it ships with reset links). Add it under the button: the teal `Forgot your password?` link with email set up, the faint `Ask your instance admin` line without. New key `signIn.forgot` and `signIn.forgotNoEmail`.
3. **Change-password's form** becomes a shared `NewPasswordFields` (the two inputs, the rule line, the mismatch check), used by `/change-password` and `/reset/new`. `new-password.ts` already holds the rules; its copy keys move to `password.*` (`accept-invite.md`, item 4).
4. **`AuthMessage`** comes from `accept-invite`.
5. **Messages.** New keys under `reset.*`.

## Wrong in the image

Build from this file, not these:

- **Lockup:** approximated. Use `lockup-horizontal-shell.svg`.
- **Text brightness:** labels and ledes render brighter than `--muted`; the tokens win.
- **`Back to sign in`** is drawn at about 14px on the request and 13px on the link's page; it's 12px on both.
- **Curly apostrophe** in `We’ll`; `en.json` uses straight ones.
- **Dots:** sixteen in each password input. Harmless.
- **`sam@acme.dev`** in the link page's lede is drawn at 600; it's 500.
- Right as drawn: the copy and order of both forms, no red and no amber, the green check with faint text, the teal back links, and the whole right column.

## Open points for the maintainer

1. **No sign-in after a reset.** The member types the new password once more on `/sign-in`. Signing them in straight away would save a step but makes the link (a bearer secret in a mailbox) worth a session on its own; this spec keeps the step.
2. **"Sent" names the address it was given** (`If sam@acme.dev belongs to an account here…`). It repeats only what the visitor typed, so it reveals nothing, and it catches a typo.
