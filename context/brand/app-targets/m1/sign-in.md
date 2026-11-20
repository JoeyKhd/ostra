# Sign in: target

> **Committed image:** `sign-in.webp`, downscaled from the 2048×1360 generation to 1200 px wide, so one image pixel is one CSS pixel. Where this file gives sizes in image px at ×1.42, read them as CSS px directly against the WebP.

Sign-in (F-002), the screen at `/sign-in`: a member signs in with their username or email, and their password. Picture: `sign-in.webp` (2048×1360). Prompt: `sign-in.prompt.txt`. Made with the `ui-taste` skill, image first, on Higgsfield `gpt_image_2_6` (3 generations; the third is the target), from the graphite concepts (`../../app-concepts/html/task-b-graphite.png`, `home-graphite.png`) and the Shell lockup (`../../files/logo/lockup-horizontal-shell-1600.png`, composited on `#0D0E10`). The right column was then replaced: it's the sign-in illustration (`../../files/web/sign-in-illustration.webp`, B-017 in `../../assets.md`) and the tagline, composited onto the generation at the placement below.

**Status:** approved by the maintainer on 2026-11-19, the right column included: they chose the "Deep water" illustration from three directions ("deep water is nice"). The picture is an image-model render: the copy in this file wins over the copy in the picture, and the tokens below win over its colours (see "Errata in the picture").

**Scale.** The picture's controls are a little larger than the prompt asked for. It matches a **1200×800 viewport at ×1.707** (inputs and button measure 36–37px there, the lockup 22px, the title 24px). Compare the build at 1200×800, not 1440. The numbers in this file are CSS pixels at that viewport.

## Purpose

The first thing every member sees, on every visit after a sign-out or an expired session. It must:
1. Let them sign in in one step, with whichever identifier they remember.
2. Fail calmly: one line that doesn't say which half was wrong.
3. Feel like ostra, without a word of marketing: the brand's illustration and one quiet line about what it is.

Who sees it: anyone signed out, once the first admin exists. Unchanged from today: `setup.state.needsFirstAdmin` redirects to `/setup`, a signed-in member goes to `/`, and `?next=` (through `safeNext`) decides where a successful sign-in lands.

## Layout

Two columns, one hairline between them, full viewport height (`min-h-dvh`). No card, no box around the form, no top bar, no sidebar.

| Region | Size | Background | Contents |
|---|---|---|---|
| Form column | `41%` of the width, min 440px, max 600px | `--bg` `#0D0E10` | lockup top-left, the form, the version footer |
| Hairline | 1px | `--line` `#1F2023` | the vertical split (`border-right` on the form column) |
| Illustration column | the rest (`1fr`) | `--side` `#0A0B0C`, under the image | the illustration, the tagline |

The form column is a flex column with three rows: a top row (32px inset), a middle that grows, a bottom row (32px inset).

- **Form guide.** The form block sits in a 300px-tall box, vertically centred in the middle row, content aligned to the box's top, so the "Sign in" title starts at y 252 at 1200×800. The version footer and the tagline share one baseline: y 747 at 1200×800, 53px above the bottom edge, as in the picture.
- **Form column:**
  - Top row, at 32px from the top and left: the lockup, `lockup-horizontal-shell.svg` (copy it to `public/brand/`), 22px tall, `alt="ostra"`. Never type the wordmark live (`brief.md`).
  - Middle: the form block, **360px wide**, centred horizontally in the column (the picture sits it ~25px right of centre; centring is the rule).
  - Bottom row, at 32px from the left: `ostra v0.1.0`, Plex Mono 400 11.5px `--faint`. The version comes from the server's package version at build time; omit the line if it isn't available, never hard-code it.
- **Illustration column:** see "The illustration" below.

### The form block (top to bottom)

| Element | Spec |
|---|---|
| Title | `Sign in`, `<h1 class="page-title">`: Manrope 700 24px/1.25, letter-spacing -0.015em, `--text` `#EDEDEE` |
| Lede | 6px below. `Use your username or email, and your password.` Plex Sans 13.5px (`text-lede`), `--muted` `#9A9DA3` |
| Field 1 | 28px below the lede. Label `Username or email` (Plex Sans 500 12px, `--muted`, 6px above the input). Input 36px, full width |
| Field 2 | 14px below field 1. Label `Password`. Input 36px, `type="password"` |
| Error line | Only in the error states; 6px below field 2 (see States) |
| Button | 20px below the last field or error line. Full width (360px), 36px, primary |
| Help line | 16px below the button. `Forgot your password? Ask your instance admin for a reset link.` Plex Sans 12px `--faint`. Ships with reset links (F-002, milestone 4); until then leave it out |

**Input** (`fieldClass`, at 36px): radius 7px, fill `--surface` `#131416`, 1px border `--line-2` `#2A2C30`, padding 0 10px, Plex Sans 13px `--text`, no placeholder. Focus-visible: border `--faint` `#64676D` (already in `fieldClass`). Invalid (`aria-invalid`): border `--red` `#E5675C`, which also wins over focus.

**Button** (`variant="primary"`, a new 36px height): fill and border `--shell` `#F3F0E8`, text `--ink` `#0C1D21`, Plex Sans 600 13px, radius 7px, hover `#E6E2D8`. The page's one primary button.

### The illustration (decorative)

A machined, matte stone in the shape of the Hinge, split by a diagonal seam with light inside, in deep water, graded to the panel's neutral graphite (2026-11-20; it was blue-green). It's a picture, not markup, and it carries no information, so screen readers skip it.

- **The file:** `../../files/web/sign-in-illustration.webp` (1792×2240) and `sign-in-illustration-1200.webp` (960×1200). Copy both to `apps/web/public/`, served as `/sign-in-illustration.webp` and `/sign-in-illustration-1200.webp`.
- **The fades are baked in.** The asset already carries its grade: darkened so the form stays the brightest thing on the screen, its colour taken down to graphite, a soft fade into `--bg` along its left edge (so it meets the hairline as graphite, not as a panel of its own), and the bottom fade the tagline sits on, which ends on `--bg`. The build adds no CSS gradients, overlays or filters.
- **The column:** `position: relative; overflow: hidden; background: var(--side)`. The background only shows while the image loads.
- **The image fills the column:** `object-fit: cover; object-position: 50% 8%`. At 1200×800 the column is about 705px wide, the image scales to about 705×881 and loses 7px at the top and 74px at the bottom, which puts the stone's centre at about x 843, y 367 of the viewport, beside the form. On a wider column the crop takes more off the bottom, the darkest part, and the stone sits lower (its centre about 60% down at 1920×1080), still well clear of the tagline. On a narrower, taller one the crop takes the sides instead, and the stone stays whole and centred.
- **As Next code:** `<Image src="/sign-in-illustration.webp" alt="" aria-hidden fill sizes="60vw" className="object-cover object-[50%_8%]" />`. Without the image optimizer, a plain `<img alt="" aria-hidden="true" loading="lazy">` with `srcset="/sign-in-illustration-1200.webp 960w, /sign-in-illustration.webp 1792w"` and `sizes="60vw"`, or a CSS `background: var(--side) url(/sign-in-illustration-1200.webp) 50% 8% / cover no-repeat`, gives the same picture.
- **Empty `alt` and `aria-hidden`.** It's decorative: no caption, no title, no link, nothing focusable.
- **The tagline:** `Self-hosted cloud agents for your team.`, real text above the image: `position: absolute; left: 48px; bottom: 48px; z-index: 1`, IBM Plex Sans 400 `13px/20px`, colour `--shell` at 70% (`color-mix(in srgb, var(--shell) 70%, transparent)`, `rgb(243 240 232 / 0.7)`). That puts its baseline at y 747 at 1200×800, on the version footer's, with its left edge 48px from the hairline. One size at every width; it's drawn in the picture at the same 13px ×1.707. It isn't `aria-hidden`: it's the page's one line about the product. Copy: `signIn.tagline`.
- **No amber anywhere on this screen:** nothing here needs the member yet.

## States (all on the same layout; only the form block changes)

| State | When | Fields | Button | Message |
|---|---|---|---|---|
| **Empty** | first load | both empty; `autoFocus` on field 1 | `Sign in`, disabled (`disabled:opacity-50`) | none |
| **Filled** | both fields non-empty | values shown, password masked | `Sign in`, enabled | none |
| **Submitting** | after submit, until the reply | both `readOnly` (keep their look, don't dim them) | `Signing in…`, disabled, with a Lucide `loader-circle` 14px spinning before the label (`motion-safe:animate-spin`) | none |
| **Wrong credentials** | 401 from better-auth | **both** inputs `aria-invalid`, red border; values kept | `Sign in`, enabled | Lucide `circle-alert` 13px + `That username or email and password don't match.` |
| **Too many attempts** | 429 | no red borders (not the member's input at fault) | `Sign in`, enabled | Lucide `circle-alert` 13px + `Too many sign-in attempts. Wait a minute and try again.` |
| **Other failure** | network or 5xx | no red borders | `Sign in`, enabled | Lucide `circle-alert` 13px + `That didn't work. Try again.` (`errors.unknown`) |

- The message line: 6px below field 2, flex with a 6px gap, Plex Sans 12.5px `--red` `#E5675C`, icon `--red`. `role="alert"`, and both inputs carry `aria-describedby` pointing at it.
- Editing either field clears the red borders and the message.
- Success: `router.replace(next)` then `router.refresh()`, as today. No success state is drawn.

Copy comes from `apps/web/messages/en.json` (`signIn.*`). Two keys change, `signIn.lede` (below) and a new `signIn.forgot` for the help line once it ships, and one is new: `signIn.tagline`.

## Components (shadcn/ui names)

| Part | Component | Notes |
|---|---|---|
| Page frame | none (a two-column `grid` in the page) | Replaces `AuthCard` for this page. `setup.md` takes `/setup` off `AuthCard` too, so `AuthCard` can go once both ship |
| Lockup | `<img>` | `lockup-horizontal-shell.svg`, 22px tall |
| Form | `Form` pattern, `Field` / `FieldLabel` / `FieldError` | The repo's `Field` (`components/ui/field.tsx`) needs an `error` slot that renders an icon. The message belongs to the form, not to one field, so render it once under field 2 |
| Inputs | `Input` | at 36px (`h-9`) |
| Label | `Label` | Plex Sans 500 12px `--muted` |
| Button | `Button` `variant="primary"` | a new `size` of 36px (`h-9`, 13px, `px-3.5`), or `size="lg"` raised to 36px |
| Illustration | `next/image` (`Image`, `fill`) | see "The illustration" |
| Split | `Separator orientation="vertical"` or a `border-r` | `--line` |
| Icons | Lucide | `circle-alert`, `loader-circle` (stroke 1.75) |

## Tokens (from `../../app-concepts/html/graphite.css`, already in `globals.css` as `--color-*`)

> **Scale.** This page keeps the sizes and colours below: its picture was matched at `graphite.css`'s scale, and `.auth-scale` holds it there while the panel moved to the pictures' larger scale (`README.md`, "Scale").

| Token | Hex | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | form column |
| `--side` | `#0A0B0C` | illustration column, under the image (the asset's fades end in `--bg`, since 2026-11-20) |
| `--surface` | `#131416` | input fill |
| `--line` | `#1F2023` | column hairline |
| `--line-2` | `#2A2C30` | input border |
| `--text` | `#EDEDEE` | title, input values |
| `--muted` | `#9A9DA3` | lede, labels |
| `--faint` | `#64676D` | version, help line, focus border |
| `--red` | `#E5675C` | invalid borders, error line and icon |
| `--shell` | `#F3F0E8` | primary button fill, lockup, the tagline at 70% |
| `--ink` | `#0C1D21` | primary button text |
| `--amber` | `#FFB224` | **not used on this screen** |

Type: Manrope 700 (the title), IBM Plex Sans 400/500/600 (everything else, the tagline included), IBM Plex Mono 400 (the version).

## Responsive

- **≥ 960px:** two columns as above.
- **< 960px:** the illustration column is hidden (`hidden min-[960px]:block` or similar), and with it the tagline. The form column takes the full width; the form block stays 360px and centred; the version footer stays at the bottom. Keep the image lazy (`next/image`'s default; no `priority`), so a hidden column costs a phone no download.
- **Phone (< 420px):** 16px side gutters, the form block is `100%` wide, the lockup row 16px from the top, no horizontal scroll.
- Very short viewports: the middle row scrolls; the form never overlaps the lockup or the footer. The illustration column stays the viewport's height and crops.

## Differences from the current code

1. **Frame:** today `AuthCard` floats a 400px column at 12vh on a black page, with the bare mark (`ostra-mark.svg`, 28px) above the title. The target is a two-column page: the lockup (mark + wordmark) top-left, the form vertically centred, the illustration on the right, and footers on a shared baseline.
2. **Illustration column:** new. The `aria-hidden` sign-in illustration and the tagline `Self-hosted cloud agents for your team.`
3. **Lede:** `Sign in with your username or email.` becomes `Use your username or email, and your password.` (no "Sign in" said twice in a row).
4. **Sizes:** the inputs go from 32px (`h-8`) to 36px, and the button from 32px (`size="lg"`) to 36px. Both stay full width (360px, down from 400px).
5. **Error:** today the message is a bare red line in the password `Field`, and only the password input is `aria-invalid`, which hints that the password was the wrong half. In the target, both inputs turn red, and the message gets a `circle-alert` icon. A 429 and other failures show the line without red borders. Editing a field clears the error.
6. **Submitting:** today only the label changes to `Signing in…`. In the target, a spinner joins it, and the inputs go `readOnly` while the request runs.
7. **Footer:** new, `ostra v0.1.0` (the real version).
8. **Help line:** new, `Forgot your password? Ask your instance admin for a reset link.`, shipped with reset links in milestone 4, not before.
9. **Unchanged:** the redirects, `safeNext`, username-vs-email detection (`@`), lowercasing the username, the copy of every message, and the disabled button while a field is empty.

## Errata in the picture

The image model got these wrong; build from this file instead. The right column is right as drawn: it's the real asset and the real tagline, composited at the placement above.

- **Lockup:** the mark's top-left notch and channel are approximated, and the wordmark looks typed. Use `lockup-horizontal-shell.svg` exactly.
- **Text halos:** the title and the button have a soft dark shadow, and the button has a faint texture. Real text has no shadow, and the button is flat `#F3F0E8`.
- **Labels:** `Username or email` and `Password` render near `#B5B7BB`; they're `--muted` `#9A9DA3`.
- **Error borders:** only the password input is red in the picture; both inputs are red in this state.
- **Form position:** the form sits slightly right of the column's centre; centre it.
- All copy in the picture is spelled correctly: `Sign in`, `Use your username or email, and your password.`, `Username or email`, `Password`, `sam.rivera`, `That username or email and password don't match.`, `Forgot your password? Ask your instance admin for a reset link.`, `ostra v0.1.0`, `Self-hosted cloud agents for your team.`

## Open points for the maintainer

- Whether `ostra v0.1.0` belongs on a public page of a self-hosted install. It helps support; some admins hide versions. It could become a setting later.
