# Choose a new password: target

> **Committed images:** `change-password.webp`, downscaled from the 2048×1360 generation to 1200 px wide like `sign-in.webp`, and `home-banner.webp`, downscaled to 1440 px wide like `home.webp`. One image pixel is one CSS pixel in both.

Two pieces of F-001's default first admin (the maintainer, 2026-11-19: a fresh install seeds `demo@demo.com` / `demo` unless `OSTRA_ADMIN_*` says otherwise):
1. **Choose a new password**, the screen at `/change-password`: the forced step after the first sign-in while the account still uses the default password. Picture: `change-password.webp`, in the "passwords don't match" state.
2. **The default-password banner**, a slim band at the top of every panel page while the default password is in use. Picture: `home-banner.webp`, the banner on Home.

Prompts: `change-password.prompt.txt` (both). Made with the `ui-taste` skill, image first, on Higgsfield `gpt_image_2_6` (3:2, 2k, high). Each picture is an edit of the committed target it belongs to: `change-password` of the sign-in original (with `../../app-concepts/html/home-graphite.png` and the Shell lockup composited on `#0D0E10`), `home-banner` of the Home original (with `home-graphite.png` and the Hinge logo). One generation each.

**Status:** a target, not yet approved by the maintainer. The pictures are image-model renders: the copy and rules in this file win over the pixels, and the tokens below win over the pictures' colours (see "Wrong in the image").

## Purpose

The seeded admin's password is public: it's in the docs, the configuration reference and this repo. Until it changes, anyone who can reach the install can sign in as its admin. The screen must:
1. Stop the member before the panel, once, and say why in one sentence, without alarm.
2. Take a new password in one step, with the rule in view and both mistakes (too short, not matching) caught before the request.
3. Hand them to where they were going, with nothing left to do.

The banner is the reminder for as long as the default password stays in use (see "The banner", including the `OSTRA_ALLOW_DEFAULT_PASSWORD` case and an open point about it).

## Route and flow

- **Route:** `/change-password`, outside the `(panel)` layout, in the same frame as `/sign-in`. It takes `?next=`, checked by `safeNext` as on sign-in.
- **Who sees it:** a signed-in account whose password is still the default and for whom the change is forced (the account's `mustChangePassword` column, added by the in-progress migration `user_must_change_password`).
- **How they get there:** sign-in succeeds as today, then the `(panel)` layout, on the server, sends a forced account to `/change-password?next=<where they were going>`. The tRPC procedures refuse a forced account too (the gate is on the server, not only a client redirect), except `auth.signOut` and the change itself.
- **Signed out:** `/change-password` sends them to `/sign-in?next=/change-password`.
- **Not forced:** a signed-in account that isn't forced and opens `/change-password` from the banner's `Change it` sees the same screen (with the same lede while the default password is in use). Once the password is the account's own, the route sends them to `/`: changing a password at will is the account page's job (milestone 4, F-002).
- **No current-password field.** The member typed the default password a moment ago and it's public. The server accepts the change only for an account that still uses the default password, on its own session. better-auth's `changePassword` needs the current password; the build either passes the default from the server or uses its server-side password update. That's the build's call; the form doesn't ask.
- **After the change:** the server stores the new hash, clears `mustChangePassword` and the default-password marker, revokes the account's other sessions (anyone else who signed in with `demo` is out), and keeps this one. The page then does `router.replace(next ?? "/")` and `router.refresh()`.

## Layout

The sign-in frame (`sign-in.md`), unchanged: two columns, the form column (`41%`, min 440px, max 600px, `--bg`) and the glimpse column (`--side`) with the same read-only task glimpse and footers, one `--line` hairline between them. Only the form block changes. Keeping the frame means the move from sign-in to this step changes the form and nothing else, so it reads as the next step of signing in, not a new place.

Compare the build at **1200×800**, like sign-in. Sizes below are CSS px at that viewport.

### The form block (360px wide, top to bottom)

| Element | Spec | In the picture (y) |
|---|---|---|
| Title | `Choose a new password`, `<h1>`: Manrope 700 24px/1.25, -0.015em, `--text`. One line | 258 |
| Lede | 6px below. `This install still uses the default password. Choose your own before you go on.` Plex Sans 13.5px `--muted`, wraps to two lines in 360px | 279–311 |
| Field 1 | 28px below the lede. Label `New password` (Plex Sans 500 12px `--muted`, 6px above the input). Input 36px, `type="password"`, `autoComplete="new-password"` | 339, input 352–388 |
| Rule line | 6px below input 1, 12px: a 13px icon slot, 6px gap, `At least 12 characters.` (the number from `MIN_PASSWORD_LENGTH` in `@ostra/domain`, never typed into the copy). States below | 401 |
| Field 2 | 14px below the rule line. Label `Confirm the new password`. Input 36px, `type="password"`, `autoComplete="new-password"` | 432, input 445–481 |
| Error line | Only in the error states; 6px below field 2 | 495 |
| Button | 20px below the last line. Full width, 36px, primary: `Save and continue` | 524–560 |
| Account line | 16px below the button. Plex Sans 12px `--faint`: `Signed in as demo@demo.com · Sign out`, the email being the account's real email, `Sign out` a teal (`--teal`) button styled as a link, 500 | 580 |

- The title sits on the same guide as the glimpse's `CALC-161 · from Linear` line, as on sign-in. This block is taller than sign-in's, so it grows downwards from that guide; it doesn't move up.
- A visually hidden `<input type="text" name="username" autoComplete="username" value="<email>" readOnly hidden>` sits in the form, so password managers save the new password against the right account.
- **Inputs, button, label, error line:** exactly sign-in's (`fieldClass` at 36px, the 36px primary button, the 12.5px `--red` line with a `circle-alert` icon, `role="alert"`, `aria-describedby`).
- **The rule line is the field's help text** (`aria-describedby` on input 1), not a validation badge. Its icon slot is always 13px wide, so the text never shifts when the icon appears.
- **No amber on this screen.** It's a step to finish, not a waiting item, and red is only for what's wrong.

## States

| State | When | New password | Rule line | Confirm | Error line | Button |
|---|---|---|---|---|---|---|
| **Empty** | first load | empty, `autoFocus` | no icon, `--faint` | empty | none | `Save and continue`, disabled (`disabled:opacity-50`) |
| **Typing, short** | 1–11 characters, still focused | value | no icon, `--faint` | as typed | none | disabled |
| **Rule met** | 12 or more characters | value | Lucide `check` 13px `--green`, text stays `--faint` | as typed | none | enabled once confirm is non-empty |
| **Too short** | input 1 loses focus with 1–11 characters, or a submit with them | `aria-invalid`, red border | Lucide `circle-alert` 13px + `At least 12 characters.` both `--red` | unchanged | none (the rule line is the message) | disabled until fixed |
| **Too long** | over 256 characters (`MAX_PASSWORD_LENGTH`) | `aria-invalid`, red border | `circle-alert` + `At most 256 characters.` `--red` | unchanged | none | disabled |
| **Mismatch** (the picture) | confirm loses focus, or a submit, while the two differ | unchanged (valid) | `check`, `--faint` text | `aria-invalid`, red border | `circle-alert` + `The two passwords don't match.` | enabled; a submit re-shows the error and focuses confirm |
| **Submitting** | after submit, until the reply | `readOnly`, look kept | unchanged | `readOnly` | none | `Saving…`, disabled, `loader-circle` 14px spinning before the label (`motion-safe:animate-spin`) |
| **Server error** | network or 5xx | values kept | unchanged | values kept | `circle-alert` + `That didn't work. Try again.` (`errors.unknown`), no red borders | `Save and continue`, enabled |
| **Rejected by the policy** | 400 from the server's password rule (a check the client missed) | `aria-invalid`, red border | the server's rule line, `--red` | unchanged | none | enabled |
| **Session gone** | 401 | | | | | redirect to `/sign-in?next=/change-password` |
| **Success** | 200 | | | | | `router.replace(next ?? "/")`, then `router.refresh()`. No success state is drawn: Home, without the banner, is the confirmation |

- The mismatch check waits for confirm's blur or a submit, so the member isn't told off while typing. Once shown, it clears the moment the two match.
- Editing a field clears that field's red border and its message; editing either clears the mismatch.
- The copy is plain and calm: no "insecure", no "warning", no exclamation marks.

Copy lives in `apps/web/messages/en.json` under `changePassword.*`: `title`, `lede`, `newPassword`, `confirm`, `rule` (`At least {n} characters.`), `ruleMax` (`At most {n} characters.`), `mismatch`, `submit`, `busy`, `signedInAs` (`Signed in as {email}`), `signOut`. Straight apostrophes, as in the rest of `en.json`.

## The banner

Picture: `home-banner.webp`, on Home. It belongs to the panel's shell, so it's on every `(panel)` page, not only Home.

**Placement.** Directly under the 44px top bar, across the whole main column: the page and the properties panel, from the sidebar's edge to the viewport's right edge. Everything under it moves down; the sidebar doesn't. It isn't inside the page's padding and doesn't scroll away: it's part of the shell's fixed top.

| Part | Spec |
|---|---|
| Band | 36px tall, fill `--raise` `#17181B`, 1px `--line` hairline at the bottom. No radius, no side borders, no shadow |
| Icon | Lucide `key-round` 15px, stroke 1.75, `--text`. Its left edge on the page's text edge (40px into the main column, the x of the eyebrow date and title) |
| Lead | 10px after the icon. `The default password is still in use.` Plex Sans 500 13px `--text` |
| Detail | One space after. `Anyone who knows it can sign in as you.` Plex Sans 400 13px `--muted` |
| Action | Right-aligned on the top bar's right edge (18px in, under `New task`). `Change it`, Plex Sans 500 13px `--teal`, a `Link` to `/change-password?next=<this path>`. Hover: underline. No button box |

- **No close button.** It stays until the password changes. It's one line, not a modal, so the panel stays fully usable.
- **Who sees it:** only the signed-in account that still uses the default password. Never other members: telling them the admin's password is guessable would be the leak itself. Other instance admins don't see it either in milestone 1 (they can't reset another account's password until reset links ship, milestone 4).
- **Where it doesn't show:** `/sign-in`, `/change-password`, `/device` (outside the panel shell).
- **When it disappears:** on the request after the password changes (`router.refresh()` after the change, or the next navigation). The server decides on each render from the session; the client never caches it.
- **Accessibility:** a `<div role="region" aria-label="Default password">`, before `<main>` in reading order, so a screen reader meets it once per page and not as an interruption (no `role="alert"`, no live region).
- **Narrow widths:** under 640px the detail sentence drops and the band shows the icon, the lead and `Change it`. The band never wraps to two lines and never scrolls sideways; the lead truncates with an ellipsis first, the action never does.

Copy: `banner.defaultPassword.lead`, `banner.defaultPassword.detail`, `banner.defaultPassword.action`.

### When it shows

| Setting | First sign-in | Banner |
|---|---|---|
| Default password, `OSTRA_ALLOW_DEFAULT_PASSWORD` unset (`false`) | the forced step | while the default is in use. In practice the forced step comes first, so the banner is the fallback for any panel render the step didn't catch (it costs one check per render, and it's the same signal) |
| `OSTRA_ADMIN_PASSWORD` set | no forced step | never: the password is the operator's own |
| Default password, `OSTRA_ALLOW_DEFAULT_PASSWORD=true` | no forced step | **as briefed: off.** See open point 1 |

The server exposes one boolean on the session, "this account still uses the default password", separate from "the change is forced" (`mustChangePassword`): the banner reads the first, the redirect reads the second, and the flag only affects the second.

### Why the banner isn't amber

Amber is Buoy, the one signal for "this needs you" (`brief.md`, `app-design.md`), and the rule is one thing at a time. The banner doesn't qualify:
- **It would be permanent.** A band on every page would make amber constant. On Home it would sit above the Needs you dot, the sidebar's `5` and the one amber `Approve`, so the eye would no longer find the waiting task first.
- **It isn't work in the queue.** "Needs you" means a task waits on a person: an approval, a question, a draft. A default password is an account notice; it doesn't belong in the Needs you count or view.
- **It isn't red either.** Red means an error or a deletion. Nothing failed.

So the band is neutral: a raised graphite fill, a white lead sentence, the teal of every other inline action (`Take over`, `Copy`). It gets its weight from where it sits (the top of every page, full width, never dismissible), not from colour.

## Components (shadcn/ui names)

| Part | Component | Notes |
|---|---|---|
| Page frame | the sign-in frame | Share it with `/sign-in` (an `AuthFrame` with the lockup, the glimpse and the footers; the form is its child) instead of copying it |
| Form | `Form` pattern, `Field` / `FieldLabel` / `FieldDescription` / `FieldError` | The rule line is `FieldDescription` with an icon slot; the mismatch and server lines are the form's error, under field 2 |
| Inputs | `Input` | 36px (`h-9`), `type="password"` |
| Labels | `Label` | Plex Sans 500 12px `--muted` |
| Button | `Button` `variant="primary"` | sign-in's 36px size |
| Sign out | `Button` `variant="link"` | `--teal`, 12px, 500; calls better-auth's `signOut`, then `/sign-in` |
| Banner | none (a plain `div` in the shell, `components/shell/default-password-banner.tsx`) | shadcn `Alert` is a rounded, bordered card; this is a full-bleed band, so it isn't an `Alert` |
| Banner action | `Link` (Next) with the `.lk` style | |
| Icons | Lucide | `check`, `circle-alert`, `loader-circle` (14px), `key-round` (15px), stroke 1.75 |

## Tokens (from `../../app-concepts/html/graphite.css`)

| Token | Hex | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | form column, page |
| `--side` | `#0A0B0C` | glimpse column |
| `--surface` | `#131416` | input fill |
| `--raise` | `#17181B` | the banner's fill |
| `--line` | `#1F2023` | column hairline, the banner's bottom hairline |
| `--line-2` | `#2A2C30` | input borders |
| `--text` | `#EDEDEE` | title, input values, the banner's icon and lead |
| `--muted` | `#9A9DA3` | lede, labels, the banner's detail |
| `--faint` | `#64676D` | rule line text, account line, focus border |
| `--green` | `#4FB286` | the rule line's check |
| `--red` | `#E5675C` | invalid borders, error lines and icons |
| `--teal` | `#6FB8AA` | `Sign out`, `Change it` |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | the primary button |
| `--amber` | `#FFB224` | **not used** on the screen or the banner |

Type: Manrope 700 (the title), IBM Plex Sans 400/500/600 (everything else, the email included), IBM Plex Mono only in the glimpse and the version footer.

## Responsive

As `sign-in.md`: the glimpse column hides under 960px, the form block stays 360px and centred, and on a phone (< 420px) it takes the full width with 16px gutters and no horizontal scroll. The banner's narrow rule is above.

## Wrong in the image

**`change-password.webp`**
- **Text brightness:** the labels, the lede, the rule line and the account line render brighter than their tokens (labels near `#CBCAD3`, the rule text near `#C6C4C5`). They're `--muted` and `--faint` as specified above; the title and the input values are the only `--text` in the form.
- **Apostrophe:** `don’t` is curly; `en.json` uses straight apostrophes (`don't`), as sign-in does.
- **Dots:** sixteen and thirteen masked dots, not the prompt's fourteen and eleven. Harmless: the input shows what the member typed.
- **Lockup and glimpse:** the same errata as `sign-in.md` (an approximated lockup, glimpse names and paths near `--text` instead of `--muted`). Use the real `lockup-horizontal-shell.svg` and sign-in's glimpse component.
- Right as drawn: the copy, the order, the green check with faint text, the red border on confirm only, the teal `Sign out`, and the title on the glimpse's guide.

**`home-banner.webp`**
- **Icon position:** the key sits about 20px left of the page's text edge, and the lead starts at about x 287. The icon's left edge goes on the text edge (x 272 at 1440), the lead 25px after it.
- **Icon:** drawn like Lucide `key`; use `key-round`.
- **Height:** the band measures 35px; it's 36.
- **Home's own errata** carry over unchanged (`home.md`, "Text in the picture that's wrong"): the logo mark, `Spend, November` in mono, the pool names' size.
- Right as drawn: the fill (`#17181B` exactly), the bottom hairline, the band spanning both the page and the properties panel, `Change it` in teal on the `New task` edge, no amber in the band, and the page moved down intact.

## Open points for the maintainer

1. **`OSTRA_ALLOW_DEFAULT_PASSWORD` and the banner.** As briefed, the flag turns off both the forced step and the banner. With the flag off, the forced step runs before the panel, so the banner is almost never seen; with the flag on, it's turned off. Under those rules it has nearly no case to show in. The build in progress describes the flag as "no forced change at sign-in, but the panel's warning stays until it changes", which gives the banner its job: the reminder on a demo install that kept `demo`. Recommended: that reading. Decide one, and this file's table follows.
2. **Other admins.** Should a second instance admin see a banner like `The demo account still uses the default password.`, without an action? Left out of milestone 1 because they couldn't act on it until reset links ship.
