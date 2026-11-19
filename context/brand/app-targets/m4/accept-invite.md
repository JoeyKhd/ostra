# Target: Accept an invitation (milestone 4, screen 3)

> **Committed images:** `accept-invite.webp` (the sign-up form) and `accept-invite-inbox.webp` ("Check your inbox"), each downscaled from its 2048×1360 generation to 1200×797, so one image pixel is one CSS pixel at the sign-in frame's 1200×800 viewport. The right column of both is the real sign-in illustration and tagline, composited exactly as on `../m1/sign-in.webp`.

- **Prompt:** `accept-invite.prompt.txt` (both pictures). GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation each. Each is an edit of `../m1/sign-in.png` (the approved 2048 original this screen starts from, spec section 12), with `../../app-concepts/html/home-graphite.png` and the Hinge logo `../../kit/logo/export/ostra-hinge-single-color-2048.png` as references. The generated right column (m1's old task glimpse) was then replaced by `../../files/web/sign-in-illustration.webp` and the tagline, with the script m1 used.
- **Route (new):** `apps/web/src/app/invite/[invitation-id]/page.tsx`, outside the `(panel)` layout, in `components/auth/auth-frame.tsx` like `/sign-in` and `/change-password`. The form is a new `components/auth/accept-invite-form.tsx`.
- **Features:** F-002 (invitations by link, sign-up through it, joining with an existing account, one use, 7 days, revocable, the address verified when email is set up). Spec section 3 step 1, section 4 ("An invitation"), section 12 screen 3. Ticket 22 (`invitations.preview`, the sign-up hook, `invitations.accept`, verification), ticket 32 (this page). ADR 0053 ("Invitations"), ADR 0003.
- **Status:** a proposed target, waiting on approval (ticket 31's `## Comments`). Ticket 32 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5) inside the existing `AuthFrame`, then screenshot the build at 1200×800 and compare it with the pictures.

## Purpose

The page an invitation link opens, for someone who may never have seen ostra. It must:

1. Say in one line where they're going and who sent them: the organization's name and the inviter's name, nothing else about the organization.
2. Let them join in one step: an account with the invited address, a username and a password. Someone who already has an account signs in instead and joins without a second account.
3. With email set up, hold the membership until the address is proven ("Check your inbox"), so a pasted link alone never makes a stranger a member (ADR 0053).
4. When the link can't be used (expired, revoked, used, unknown), say which it is and who to ask, and show nothing of the organization beyond its name and the inviter.

The pictures show Sam, invited by Alex Kim to `Demo` as a member, on an install with email set up: the form, filled and valid, and the step after it.

## Route and flow

- **Route:** `/invite/[invitation-id]`. The ID is the secret (at least 128 random bits, ADR 0053): it never appears in a log line, an analytics call or a `Referer` (`<meta name="referrer" content="no-referrer">` on this page), and the page is `noindex`.
- **The read:** the page's server component calls `invitations.preview(id)` (ticket 22): the organization's name, the inviter's name, the address, whether it's locked, and the state (`pending`, `accepted`, `revoked`, `expired`), nothing more; an unknown or malformed ID is `not-found`. It's rate-limited by IP; a 429 is its own state below.
- **The session:** the same server component reads the session, so a signed-in visitor gets the signed-in states below instead of the form.
- **Sign-up:** better-auth's `/sign-up/email` with the address, the username (also sent as `name`), the password and the invitation's ID. ostra's `before` hook lets it through for a pending, unexpired invitation, and creates the account, the membership, the project grants and the acceptance in one transaction (ticket 22).
  - **Email set up:** the address is the invitation's, locked; the membership starts `pending_verification`, no session is made, better-auth mails the verification link (as an account mail, ticket 19), and the page shows "Check your inbox" (the second picture). The verification link's callback is `/invite/[id]?verified=1`: better-auth activates the account, ostra's hook moves the membership to `active` and records `member.verified`, the member is signed in (`autoSignInAfterVerification`) and lands on `/` with `Demo` active.
  - **No email:** the address field is a normal input, prefilled with the invitation's address and editable (taken as written, unverified, ADR 0053). The membership is `active` at once, better-auth signs the account in, and the page does `router.replace("/")` then `router.refresh()`, with `Demo` as the active organization.
- **Existing account:** "Sign in to accept" switches the form to sign-in on the same page (state below). After a successful sign-in, the page calls `invitations.accept(id)` and lands on `/` in `Demo`.
- **After joining,** Home is the confirmation. No success state is drawn on this page.

## Layout

The sign-in frame (`../m1/sign-in.md`), unchanged and shared through `AuthFrame`: the form column (`clamp(440px, 41%, 600px)`, `--bg`), the lockup top-left, the version footer, the hairline, and the illustration column with the tagline. Only the block in the middle changes. Compare the build at **1200×800**, like sign-in; the sizes below are CSS px there.

### The sign-up block (the first picture; 360px wide, top to bottom)

| Element | Spec | In the picture (y) |
|---|---|---|
| Title | `Join Demo on ostra`, `<h1>`: Manrope 700 24px/1.25, −0.015em, `--text`. The organization's name is data: one line, ellipsis past 360px, the full name in `title` | 251 |
| Lede | 6px below. `Alex Kim invited you to Demo as a member. Choose a username and a password to join.` Plex Sans 13.5px `--muted`, the organization's name in `--text` weight 500 (the picture draws it so; keep it). The role reads `as a member` or `as an admin`. Wraps to two lines | 281–310 |
| Field 1 | 28px below. Label `Email`. **Locked** (email set up): a read-only input, 36px, radius 7px, **no fill** (`--bg` shows), 1px `--line` border, the address in Plex Sans 13px `--muted`, Lucide `lock` 13px `--faint` 12px from the right edge. `readOnly`, `aria-readonly`, `autoComplete="email"`, still focusable and selectable. Hover and focus don't change the border. **Not locked** (no email): a normal input (`fieldClass`), prefilled, `type="email"` | 340, input 356–391 |
| Field 2 | 14px below. Label `Username`. Normal input, 36px, `autoComplete="username"`, `autoCapitalize="none"`, `spellCheck={false}`, `autoFocus` (the first editable field). The value is lowercased as typed, as sign-in does | 407, input 422–457 |
| Field 3 | 14px below. Label `Password`. Input 36px, `type="password"`, `autoComplete="new-password"`, with a show/hide toggle inside its right end: a ghost icon button, Lucide `eye` 15px `--faint` (`eye-off` while shown), 12px from the edge, `aria-label` `Show password` / `Hide password`, `aria-pressed`. The input's right padding grows to 36px so the dots never run under it | 472, input 488–522 |
| Rule line | 6px below field 3: the change-password rule line, unchanged (`ruleLineOf` in `components/auth/new-password.ts`): a 13px icon slot, 6px gap, `At least 12 characters.` (`MIN_PASSWORD_LENGTH`), green `check` once met | 531 |
| Error line | only in the error states, 6px below the rule line (`FormMessage`) | |
| Button | 20px below. Full width, 36px, primary: `Join Demo` | 563–600 |
| Switch line | 16px below. Plex Sans 12px `--faint`: `Already have an account? ` then `Sign in to accept`, a teal (`--teal`) 500 button styled as a link (`Button variant="link"`) | 616 |

There's **no confirm field.** The form already has three fields, and a fourth would push it into the version footer at 1200×800; the show toggle covers a mistyped password, and a reset covers the rest (`reset-password.md`).

### The message block (the second picture, and every state that isn't a form)

One pattern for "Check your inbox" and for every link that can't be used, so the page has two shapes, not seven.

| Element | Spec | In the picture (y) |
|---|---|---|
| Tile | 32px square, radius 8px, `--surface` fill, 1px `--line-2` border, a centred Lucide icon 16px, stroke 1.75, `--muted`. Decorative (`aria-hidden`). The icon is the state's (table below) | 254–284 |
| Title | 20px below the tile. `<h1>`, Manrope 700 24px, `--text` | 309 |
| Lede | 6px below, Plex Sans 13.5px `--muted`, up to three lines. An address in it is `--text`, weight 500 | 338–367 |
| Hairline | 28px below the lede, 1px `--line`, 360px. Only when help lines follow | 394 |
| Help lines | 16px below the hairline, 12.5px `--faint`, 8px apart; an action in them is a teal 500 link button | 414, 433 |
| Button | instead of the hairline and help, when the state has one main action: 20px below the lede, full width, 36px, primary | |

The message block starts on the same guide as the form (y 251–254), so switching between the two moves nothing else.

## States and copy

Copy lives in `apps/web/messages/en.json` under `acceptInvite.*`; straight apostrophes. `Demo`, `Alex Kim`, `sam@acme.dev` and `member` are the invitation's data; `7` is `OSTRA_INVITATION_DAYS`, never typed into the copy.

### The pending invitation, signed out

| State | When | What changes |
|---|---|---|
| **Empty** | first load | the locked address shown; username and password empty; `autoFocus` on username; rule line plain; `Join Demo` disabled (`disabled:opacity-50`) until the username matches the domain's `usernameSchema` and the password meets the rule |
| **Valid** (the picture) | username valid, password 12 or more | rule line met; button enabled |
| **Username invalid** | username loses focus, or a submit, while it breaks `usernameSchema` | the username input `aria-invalid`, red border; under it a `FormMessage`-style line: `Use lowercase letters, digits and hyphens, 2 to 39 characters.` (the help text owned by `usernameSchema`'s rule, never retyped) |
| **Username taken** | the server refuses the username | the username input red; the line `That username is taken.`; focus moves to the username |
| **Password too short / too long** | as change-password's rule line | the rule line red with `circle-alert`, the input red (`ruleLineOf`) |
| **Address in use** | email set up, and the address already has an account | the page switches to **Sign in to accept** with the identifier prefilled with the address, and in place of its lede a `role="status"` line, 12.5px `--muted`: `sam@acme.dev already has an ostra account. Sign in to accept.` |
| **Submitting** | after submit, until the reply | inputs `readOnly`, look kept; button `Joining…`, disabled, `loader-circle` 14px spinning before the label (`motion-safe:animate-spin`) |
| **Server error** | network or 5xx | values kept; `FormMessage`: `That didn't work. Try again.` (`errors.unknown`); no red borders |
| **Link became unusable** | the hook refuses because the invitation expired or was revoked while the page was open | the page re-reads the preview and shows that state's message block |
| **Check your inbox** (second picture) | after a successful sign-up, email set up | the message block: icon `mail`; title `Check your inbox`; lede `We sent a link to sam@acme.dev. Open it to finish joining Demo.`; hairline; `Didn't get it? ` + `Send it again`; `Wrong address? Ask Alex Kim for a new invitation.` |
| **Sent again** | `Send it again` pressed | better-auth's `sendVerificationEmail`; the link reads `Sending…` (disabled), then the line becomes `Sent again. Check spam if it's still not there.` with a 13px `check` `--muted`, `role="status"`; the link comes back after 60 seconds. A 429 shows `Wait a minute before sending another.` in the same place, `--muted`, not red |
| **Verification link expired** | the verification callback comes back with an error (`?error=…`) | the inbox block, its lede `That link has expired. Send a new one to finish joining Demo.`, the help lines unchanged |

The inbox state is a page of its own, not only client state: it renders for a reload of `/invite/[id]` while the account exists and its membership is `pending_verification`, so closing the tab loses nothing. It never shows the organization's projects, members or anything else of it.

### Sign in to accept

`Sign in to accept` swaps the form in place; the title stays.

| Element | Copy |
|---|---|
| Lede | `Sign in with your ostra account to accept Alex Kim's invitation to Demo.` |
| Field 1 | `Username or email`, prefilled with the invitation's address when it's locked |
| Field 2 | `Password`, `autoComplete="current-password"`, the same show toggle |
| Button | `Sign in and join` (`Signing in…` while it runs) |
| Switch line | `New to ostra? ` + `Create an account` (teal), back to sign-up |
| Errors | sign-in's, unchanged: `That username or email and password don't match.` (both inputs red), the 429 and the unknown failure (`../m1/sign-in.md`, States) |
| Address mismatch | email set up, and the account's address isn't the invitation's: no membership; the block becomes the message `This invitation is for sam@acme.dev`, icon `user-x`, lede `You signed in as alex@acme.dev. Sign out, then sign in with the invited account or create it.`, button `Sign out` (primary). Without email any account may accept by the link (ADR 0053), so this state doesn't exist there |

The `Forgot your password?` line of `reset-password.md` sits under the switch line in this mode, when email is set up.

### Signed in already

| State | What it shows |
|---|---|
| **Signed in, can accept** | the message block: icon `user-plus`; title `Join Demo on ostra`; lede `Alex Kim invited you as a member. You're signed in as sam@acme.dev.`; button `Join Demo` (`Joining…`); a help line under the button, 16px down, 12px `--faint`: `Not you? ` + `Sign out` (teal) |
| **Signed in, another address** (email set up) | the address-mismatch message above |
| **Already a member** | icon `check`; title `You're already in Demo`; button `Open Demo`, which makes `Demo` the active organization and goes to `/`. The invitation is left as it is |

### A link that can't be used

Each is the message block. None shows a form, the organization's members or its projects. The help line `Already have an account? ` + `Sign in` (teal, to `/sign-in`) sits under the hairline in each.

| State | Icon | Title | Lede |
|---|---|---|---|
| **Expired** | `clock` | `This invitation has expired` | `Invitations work for 7 days. Ask Alex Kim for a new one.` |
| **Revoked** | `link-2-off` | `This invitation was revoked` | `An admin of Demo withdrew it. Ask Alex Kim if you still need to join.` |
| **Used** | `user-check` | `This invitation has been used` | `Someone has already joined Demo with it. If that was you, sign in.` |
| **Unknown** | `link-2-off` | `This link doesn't work` | `Check that you copied all of it, or ask for a new invitation.` (no organization, no inviter: there's none to name) |
| **Too many tries** | `clock` | `Too many tries` | `Wait a minute, then reload this page.` |
| **Load failed** | `circle-alert` | `That didn't work` | `Reload the page to try again.` |

The icons stay `--muted` in every state: nothing here is the visitor's error (red) and nothing waits on them in the panel (amber).

## Components (shadcn/ui names)

| Part | Component | Notes |
|---|---|---|
| Frame | `AuthFrame` (`components/auth/auth-frame.tsx`) | as is |
| Form | `Form` pattern, `Field` / `FieldLabel` / `FieldDescription` / `FieldError` | the rule line is `FieldDescription`; the username's line is its `FieldError` |
| Inputs | `Input` at 36px (`h-9`) | the locked one adds `readOnly` and a `locked` look (`bg-transparent border-line text-muted`), plus the `lock` icon in an absolutely placed slot |
| Show toggle | `Button variant="ghost" size="icon"` inside an `InputGroup` (or a relative wrapper) | 24px hit area at least, `tabIndex` 0 |
| Labels | `Label` | Plex Sans 500 12px `--muted` |
| Button | `Button variant="primary"` | sign-in's 36px size |
| Links in lines | `Button variant="link"` | `--teal`, 12px (12.5px in help lines), 500 |
| Message block | a new `AuthMessage` (`components/auth/auth-message.tsx`): `icon`, `title`, `children` (the lede), `action?`, `help?` | shared with `reset-password` |
| Error line | `FormMessage` (`components/auth/form-message.tsx`) | as is |
| Status line | a `role="status"` sibling of `FormMessage`, `--muted`, Lucide `check` 13px | new, shared with `reset-password` |
| Icons | Lucide, stroke 1.75 | `lock`, `eye`, `eye-off`, `check`, `circle-alert`, `loader-circle`, `mail`, `clock`, `link-2-off`, `user-check`, `user-plus`, `user-x` |

## Tokens (`../../app-concepts/html/graphite.css`)

> **Scale.** The page sits in `AuthFrame`, so `.auth-scale` holds it at the sign-in frame's scale, like `/sign-in` and `/change-password` (`../m1/README.md`, "Scale").

| Token | Hex | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | form column, the locked input's fill |
| `--side` | `#0A0B0C` | illustration column, under the image |
| `--surface` | `#131416` | input fill, the message tile |
| `--line` | `#1F2023` | column hairline, the locked input's border, the message hairline |
| `--line-2` | `#2A2C30` | input borders, the tile's border |
| `--text` | `#EDEDEE` | title, input values, the organization's name and addresses in ledes |
| `--muted` | `#9A9DA3` | ledes, labels, the locked address, tile icons, status lines |
| `--faint` | `#64676D` | rule line text, switch and help lines, the lock and eye icons, focus border |
| `--green` | `#4FB286` | the rule line's check |
| `--red` | `#E5675C` | invalid borders, error lines and icons |
| `--teal` | `#6FB8AA` | `Sign in to accept`, `Send it again`, `Create an account`, `Sign out`, `Sign in` |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | the primary button; `--shell` at 70% for the tagline |
| `--amber` | `#FFB224` | **not used** |

Type: Manrope 700 (titles), IBM Plex Sans 400/500/600 (everything else, addresses included), IBM Plex Mono only in the version footer.

## Responsive

As `../m1/sign-in.md`: the illustration column and the tagline hide under 960px; the block stays 360px and centred; under 420px it takes the full width with 16px gutters and no horizontal scroll. A long organization name truncates in the title and wraps in the lede. The message block's lede wraps; its tile never shrinks.

## Data this screen needs beyond ticket 22

- `invitations.preview(id)` returns the organization's name, the inviter's name, the address, `addressLocked` and the state. The page also needs the **organization role** (`member` or `admin`) for the lede, and the **invitation's length in days** (`OSTRA_INVITATION_DAYS`) for the expired copy. Neither reveals the organization; add both to the output.
- The **inbox state on reload** needs the preview to say the invitation is accepted *by an account still pending verification* (a `pending_verification` state, or `accepted` plus `verificationPending: true`), without saying by whom.
- The inviter's **name** is the account's display name (`user.name`); an account created by sign-up has its username there until a later milestone adds display names, so `Alex Kim` will often read `alex` in practice. The copy works either way.
- `Send it again` is better-auth's `sendVerificationEmail` for the locked address, rate-limited per address (60 seconds) as well as by better-auth's own limiter.

## Differences from the current code

Checked against `apps/web` on `main` (2026-11-19):

1. **New route.** No `/invite` exists. Add `src/app/invite/[invitation-id]/page.tsx` (server: preview and session) and `components/auth/accept-invite-form.tsx` (client: the two modes).
2. **`AuthFrame`** is reused as is. Its children change from a form to "a form or a message block", which it already allows.
3. **`AuthMessage`** is new, and `reset-password` uses it too.
4. **The rule line** (`new-password.ts`, `ruleLineOf`, `ruleText`) moves from `changePassword.*` copy keys to a shared `password.rule` / `password.ruleMax`, used by change-password, this page and the reset page.
5. **The show toggle** is new to the auth pages; `/sign-in` and `/change-password` don't get it in this ticket.
6. **Sign-up is refused today** ("invitations come in a later release"); ticket 22 opens it through the hook. Until 22 lands this page can't submit.
7. **Messages.** New keys under `acceptInvite.*`.

## Wrong in the image

Build from this file, not these:

- **Lockup:** approximated, as on every auth picture. Use `lockup-horizontal-shell.svg`.
- **Text brightness:** labels, the lede and the help lines render brighter than `--muted` and `--faint`; the tokens above win.
- **The locked address** is drawn near `--text`; it's `--muted`. The locked input's border is drawn as `--line-2`; it's `--line`. Its missing fill is right.
- **Dots:** fifteen, not fourteen. Harmless.
- **Curly apostrophe** in `Didn’t get it?`; `en.json` uses straight ones.
- **The tile** is drawn at about 30px; build 32px with a 16px icon.
- **`sam@acme.dev`** in the inbox lede is drawn at 600; it's 500.
- Right as drawn: the copy and order of both blocks, the lock and eye icons and their places, the green check with faint text, the teal links, no red, no amber, and the whole right column.

## Open points for the maintainer

**Decided 2026-11-19** by the recommendation, under `## Decided 2026-11-19` in tickets 22 and 32.

1. **"Address in use" says the address has an account.** Only someone holding the invitation's link sees it, and the address is on the invitation, so it tells them nothing about any other address. The alternative is a generic refusal, which leaves a real invitee stuck. This spec picks the helpful line.
2. **No confirm field** on sign-up, with a show toggle instead (above). Change-password and the reset page keep their confirm field, since there the password replaces one that worked.
