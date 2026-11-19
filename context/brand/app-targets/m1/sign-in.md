# Sign in: target

> **Committed image:** `sign-in.webp`, downscaled from the 2048×1360 generation to 1200 px wide, so one image pixel is one CSS pixel. Where this file gives sizes in image px at ×1.42, read them as CSS px directly against the WebP.

Sign-in (F-002), the screen at `/sign-in`: a member signs in with their username or email, and their password. Picture: `sign-in.webp` (2048×1360). Prompt: `sign-in.prompt.txt`. Made with the `ui-taste` skill, image first, on Higgsfield `gpt_image_2_6` (3 generations; the third is the target), from the graphite concepts (`../../app-concepts/html/task-b-graphite.png`, `home-graphite.png`) and the Shell lockup (`../../files/logo/lockup-horizontal-shell-1600.png`, composited on `#0D0E10`).

**Status:** a target, not yet approved by the maintainer. The picture is an image-model render: the copy in this file wins over the copy in the picture, and the tokens below win over its colours (see "Errata in the picture").

**Scale.** The picture's controls are a little larger than the prompt asked for. It matches a **1200×800 viewport at ×1.707** (inputs and button measure 36–37px there, the lockup 22px, the title 24px). Compare the build at 1200×800, not 1440. The numbers in this file are CSS pixels at that viewport.

## Purpose

The first thing every member sees, on every visit after a sign-out or an expired session. It must:
1. Let them sign in in one step, with whichever identifier they remember.
2. Fail calmly: one line that doesn't say which half was wrong.
3. Say, without a word of marketing, what this product is: a glimpse of a task the way the panel shows it, from ticket to PR.

Who sees it: anyone signed out, once the first admin exists. Unchanged from today: `setup.state.needsFirstAdmin` redirects to `/setup`, a signed-in member goes to `/`, and `?next=` (through `safeNext`) decides where a successful sign-in lands.

## Layout

Two columns, one hairline between them, full viewport height (`min-h-dvh`). No card, no box around the form, no top bar, no sidebar.

| Region | Size | Background | Contents |
|---|---|---|---|
| Form column | `41%` of the width, min 440px, max 600px | `--bg` `#0D0E10` | lockup top-left, the form, the version footer |
| Hairline | 1px | `--line` `#1F2023` | the vertical split (`border-right` on the form column) |
| Glimpse column | the rest (`1fr`) | `--side` `#0A0B0C` | a read-only task fragment, the tagline footer |

Both columns are a flex column with three rows: a top row (32px inset), a middle that grows, a bottom row (32px inset).

- **Shared guides.** The form block and the glimpse block both sit in a 300px-tall box, vertically centred in the middle row, content aligned to the box's top. The "Sign in" title and the `CALC-161 · from Linear` line therefore start on the same y (252px at 1200×800). The two footers share one baseline, 32px above the bottom edge.
- **Form column:**
  - Top row, at 32px from the top and left: the lockup, `lockup-horizontal-shell.svg` (copy it to `public/brand/`), 22px tall, `alt="ostra"`. Never type the wordmark live (`brief.md`).
  - Middle: the form block, **360px wide**, centred horizontally in the column (the picture sits it ~25px right of centre; centring is the rule).
  - Bottom row, at 32px from the left: `ostra v0.1.0`, Plex Mono 400 11.5px `--faint`. The version comes from the server's package version at build time; omit the line if it isn't available, never hard-code it.
- **Glimpse column:**
  - Middle: the glimpse block, left edge 48px from the hairline, right edge 64px from the viewport's right edge, max width 640px.
  - Bottom row: on the left (48px in) `Self-hosted cloud agents for your team.` Plex Sans 13px `--muted`; on the right (64px in, right-aligned) `ticket → task → pull request`, Plex Mono 12px `--faint`.

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

### The glimpse (decorative, `aria-hidden="true"`, not interactive)

A fragment of a task page, built from the panel's real timeline styles with fixed copy: not a screenshot, not an image. It's one step quieter than the form: no text in it is `--text`, so the form is always the brightest thing on screen.

| Row | Copy | Style |
|---|---|---|
| Key line | `CALC-161 · from Linear` | Plex Mono 500 12px `--faint` |
| Title | `Add history panel` | Manrope 700 20px `--muted`, 4px below |
| Tabs | `Activity`, `Changes 3`, `Checks 1/2`, `Events` | 18px below. The `.tabs` style, gap 18px, Plex Sans 500 13px. `Activity` `--muted` with a 2px `--muted` underline; the others `--faint`; counts Plex Mono 500 11px `--faint`. A 1px `--line` hairline under the whole row |
| Message 1 | avatar (user icon) · `Sam Rivera` · `14:02` / `Pick up CALC-161. Keep the last 50 results.` | 20px below the tabs |
| Message 2 | avatar (bot icon) · `OpenCode` · `14:03 · Claude Sonnet 5.5` / `I'll add a history panel that keeps the last 50 results.` | 18px below message 1 |
| Tool row | `file-text` · `Read` · `src/calculator/state.ts` | rows 27px tall, indented to the message text |
| Tool row | `pencil` · `Edited` · `src/history/panel.tsx` · `+118` | `+118` Plex Mono 500 12px `--green` |
| Tool row | `play` · `Ran` · `pnpm test history` · `check` `12 passed` | check and `12 passed` `--green` |
| Tool row | `git-pull-request` · `Opened` · `PR #483` · `calc-161-add-history` | `PR #483` `--teal` `#6FB8AA`; the branch Plex Mono `--faint` |

- Avatars: 28px circles, 1px `--line-2` border, a Lucide `user` or `bot` icon 14px `--faint`, 12px gap to the text.
- Names: Plex Sans 600 13px `--muted`. Times and model: Plex Mono 12px `--faint`.
- Message lines: Plex Sans 13px `--muted`, 4px under the name line.
- Tool rows: icon 15px `--faint`, verb Plex Sans 13px `--faint`, path or command Plex Mono 13px `--muted`, 12px gaps.
- **No amber anywhere on this screen:** nothing here needs the member yet. No `>_` icon: `Ran` uses Lucide `play` (the brief bans the terminal prompt).
- The copy is demo data, the same story as `task-b-graphite`. It's an illustration of what ostra does, not a claim about this install. It never reads real tasks.

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

Copy comes from `apps/web/messages/en.json` (`signIn.*`). Two keys change: `signIn.lede` (below) and a new `signIn.forgot` for the help line once it ships.

## Components (shadcn/ui names)

| Part | Component | Notes |
|---|---|---|
| Page frame | none (a two-column `grid` in the page) | Replaces `AuthCard` for this page. `setup.md` takes `/setup` off `AuthCard` too, so `AuthCard` can go once both ship |
| Lockup | `<img>` | `lockup-horizontal-shell.svg`, 22px tall |
| Form | `Form` pattern, `Field` / `FieldLabel` / `FieldError` | The repo's `Field` (`components/ui/field.tsx`) needs an `error` slot that renders an icon. The message belongs to the form, not to one field, so render it once under field 2 |
| Inputs | `Input` | at 36px (`h-9`) |
| Label | `Label` | Plex Sans 500 12px `--muted` |
| Button | `Button` `variant="primary"` | a new `size` of 36px (`h-9`, 13px, `px-3.5`), or `size="lg"` raised to 36px |
| Glimpse tabs | `Tabs` look only | Plain markup with the `.tabs`/`.tab` styles; not a real `Tabs`, because nothing in the glimpse is interactive |
| Glimpse avatars | `Avatar` + `AvatarFallback` | holding the Lucide icon |
| Split | `Separator orientation="vertical"` or a `border-r` | `--line` |
| Icons | Lucide | `circle-alert`, `loader-circle`, `user`, `bot`, `file-text`, `pencil`, `play`, `check`, `git-pull-request` (15px, stroke 1.75 unless noted) |

## Tokens (from `../../app-concepts/html/graphite.css`, already in `globals.css` as `--color-*`)

| Token | Hex | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | form column |
| `--side` | `#0A0B0C` | glimpse column |
| `--surface` | `#131416` | input fill |
| `--line` | `#1F2023` | column hairline, tab hairline |
| `--line-2` | `#2A2C30` | input border, avatar ring |
| `--text` | `#EDEDEE` | title, input values (form only) |
| `--muted` | `#9A9DA3` | lede, labels, tagline, all glimpse text |
| `--faint` | `#64676D` | version, help line, glimpse key line, times, icons, verbs, inactive tabs, focus border |
| `--red` | `#E5675C` | invalid borders, error line and icon |
| `--green` | `#4FB286` | `+118`, `12 passed` (glimpse only) |
| `--teal` | `#6FB8AA` | `PR #483` (glimpse only) |
| `--shell` | `#F3F0E8` | primary button fill, lockup |
| `--ink` | `#0C1D21` | primary button text |
| `--amber` | `#FFB224` | **not used on this screen** |

Type: Manrope 700 (titles), IBM Plex Sans 400/500/600 (everything else), IBM Plex Mono 400/500 (key, times, model, paths, command, branch, version, counts).

## Responsive

- **≥ 960px:** two columns as above.
- **< 960px:** the glimpse column is hidden (`hidden lg:flex` or similar). The form column takes the full width; the form block stays 360px and centred; the version footer stays at the bottom.
- **Phone (< 420px):** 16px side gutters, the form block is `100%` wide, the lockup row 16px from the top, no horizontal scroll.
- Very short viewports: the middle row scrolls; the form never overlaps the lockup or the footer.

## Differences from the current code

1. **Frame:** today `AuthCard` floats a 400px column at 12vh on a black page, with the bare mark (`ostra-mark.svg`, 28px) above the title. The target is a two-column page: the lockup (mark + wordmark) top-left, the form vertically centred, a glimpse of a task on the right, and footers on a shared baseline.
2. **Glimpse column:** new. A static, `aria-hidden` task fragment and the tagline `Self-hosted cloud agents for your team.` / `ticket → task → pull request`.
3. **Lede:** `Sign in with your username or email.` becomes `Use your username or email, and your password.` (no "Sign in" said twice in a row).
4. **Sizes:** the inputs go from 32px (`h-8`) to 36px, and the button from 32px (`size="lg"`) to 36px. Both stay full width (360px, down from 400px).
5. **Error:** today the message is a bare red line in the password `Field`, and only the password input is `aria-invalid`, which hints that the password was the wrong half. In the target, both inputs turn red, and the message gets a `circle-alert` icon. A 429 and other failures show the line without red borders. Editing a field clears the error.
6. **Submitting:** today only the label changes to `Signing in…`. In the target, a spinner joins it, and the inputs go `readOnly` while the request runs.
7. **Footer:** new, `ostra v0.1.0` (the real version).
8. **Help line:** new, `Forgot your password? Ask your instance admin for a reset link.`, shipped with reset links in milestone 4, not before.
9. **Unchanged:** the redirects, `safeNext`, username-vs-email detection (`@`), lowercasing the username, the copy of every message, and the disabled button while a field is empty.

## Errata in the picture

The image model got these wrong; build from this file instead.

- **Lockup:** the mark's top-left notch and channel are approximated, and the wordmark looks typed. Use `lockup-horizontal-shell.svg` exactly.
- **Text halos:** the title, the button and some glimpse text have a soft dark shadow, and the button has a faint texture. Real text has no shadow, and the button is flat `#F3F0E8`.
- **Labels:** `Username or email` and `Password` render near `#B5B7BB`; they're `--muted` `#9A9DA3`.
- **Error borders:** only the password input is red in the picture; both inputs are red in this state.
- **Glimpse brightness:** `Sam Rivera`, `OpenCode`, both message lines and the paths render close to `--text`. They're all `--muted`; only the title came out right.
- **Form position:** the form sits slightly right of the column's centre; centre it.
- All copy in the picture is spelled correctly: `Sign in`, `Use your username or email, and your password.`, `Username or email`, `Password`, `sam.rivera`, `That username or email and password don't match.`, `Forgot your password? Ask your instance admin for a reset link.`, `ostra v0.1.0`, and the glimpse copy in the table above.

## Open points for the maintainer

- The glimpse shows demo data (`CALC-161`, `Sam Rivera`) on every install. The alternative is a quiet version with only the tagline, at the cost of the product presence the screen is meant to have.
- Whether `ostra v0.1.0` belongs on a public page of a self-hosted install. It helps support; some admins hide versions. It could become a setting later.
