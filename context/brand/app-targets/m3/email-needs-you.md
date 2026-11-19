# Target: the needs-you mail (milestone 3, screen 12)

> **Committed image:** `email-needs-you.webp`, 1280×850, downscaled from the 2048×1360 generation. It holds the same mail twice: **light mode on the left (x 0–640), dark mode on the right (x 640–1280)**, each at a mail client's reading width of 640 CSS px. One image pixel is one CSS pixel.

- **Prompt:** `email-needs-you.prompt.txt`. GPT Image 2.6 through Higgsfield, 1 generation. References: the 2048 original of `app-targets/m1/sign-in` (the screen the spec starts this one from), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`. **Retouched once:** the model wrote `aclculator` in the mono line of both halves; the first two glyphs were swapped to read `calculator`. Nothing else was changed.
- **What it is:** a mail, not a panel screen. It's rendered by a pure function in `packages/domain/src/notifications/` (ticket 07), sent by the email adapters (tickets 12, 13) through core's delivery (ticket 21). There's no route and no React.
- **Features:** F-115 (email notifications), F-036 (notifications), F-026 (approvals), F-063 (plan first), F-024 (questions). Spec section 12, screen 12. ADR 0050 ("What a mail may carry", "Templates").
- **Status:** a proposed target, waiting on approval (ticket 41's `## Comments`).

> Build it as the HTML the renderer returns, then open that HTML in a browser at 640px wide, once with `prefers-color-scheme: light` and once `dark`, screenshot both, and compare them with the two halves of the picture. Then send it to Resend's test recipient and look at it in at least one real client (ticket 50).

## Purpose

A member who isn't looking at the panel learns that a task waits on them, and gets to it in one click. The mail says which organization, project and task, what kind of moment it is, and one line about it; the link does the rest. It carries nothing else of the task (ADR 0050: "Never ticket text, agent output, a plan's text, a diff, check output or a comment"), and it has no button that answers: every answer is made signed in, on the page the link opens.

It must read as ostra in any client, light or dark, with or without images, and degrade to a plain text part that says the same thing.

## What every needs-you mail holds

The renderer's input is exactly ADR 0050's fields. Each kind of mail fills the same slots:

| Slot | Source | The picture (approval) |
|---|---|---|
| Subject | `<moment> · <key> <title>`; without a ticket, `<moment> · <title>` | `An approval is waiting · CALC-161 Add history panel` |
| Preheader | `<project> · <key> · <the one line>` (hidden, see below) | `calculator · CALC-161 · Edit config/settings.json` |
| Organization | the organization's name | `Acme Corp` |
| Context line | `<project> · <key>`, or the project alone | `calculator · CALC-161` |
| Heading | the moment | `An approval is waiting` |
| Lede | one sentence per kind, naming the task's title in 600 | `The agent on Add history panel asks before it edits a file.` |
| The one line | per kind, at most 200 characters, cut with `…` | `Edit` · `config/settings.json` |
| Button | per kind | `Open the approval` |
| Note | per kind | `Answer it signed in, on the task page. Any member of calculator can answer.` |
| Link | `OSTRA_PUBLIC_URL` + `/tasks/<task-id>`, which opens on the pending item | `https://ostra.acme.dev/tasks/tsk_8f2kq0r4` (demo ID) |
| Why | from the audience (ADR 0050) | `You get this because you drive this task.` |

The title, the key and the project are the only member- or tracker-written text in a mail. They're HTML-escaped and never put in a URL; the subject has line breaks stripped.

### The three kinds this target covers

| | Approval (the picture) | Plan | Question |
|---|---|---|---|
| Subject's moment | `An approval is waiting` | `A plan to approve` | `A question for you` |
| Heading | `An approval is waiting` | `A plan to approve` | `A question for you` |
| Lede | `The agent on <title> asks before it edits a file.` The verb follows the subject: `runs a command`, `edits a file`, `reaches a website`, `uses a tool` | `The agent on <title> proposed a plan, and waits for it before it changes anything.` | `The agent on <title> has a question, and waits for your answer.` |
| The one line | the approval's subject: `Edit` + path, `Run` + the command, `Fetch` + the host, `Use` + the tool's name (Plex Mono) | `Plan first` · `6 steps`: the plan's step count, never its text | `Asked at 14:03` · `waits until answered`. Never the question's text |
| Button | `Open the approval` | `Review the plan` | `Answer the question` |
| Note | `Answer it signed in, on the task page. Any member of <project> can answer.` | `Approve it, edit it or ask for changes, signed in, on the task page.` | `Answer it signed in, on the task page.` |
| Why | `You get this because you drive this task.`; with no driver, `You get this because you're a member of <project>.` | the same | the same |

The other kinds (`pr_ready`, `no_changes`, `stalled`, `spend_cap`, `crashed`, `setup_failed`, `ticket_closed`, `test`) use the same layout, with their own heading, lede, line and button in ticket 07; the `test` mail's heading is `Mail works`, its lede `This is a test from ostra at <address>. Nothing needs you.`, no pill and no one line, and its button `Open ostra`.

## Layout (CSS px)

The client's pane is 640px wide in the picture. Everything sits in **one centred 600px column**; under 620px it becomes the client's full width (see "Narrow").

| Part | Size | Contents |
|---|---|---|
| Header strip | 76px | **The mail client's, not ostra's:** the subject, `ostra <ostra@acme.dev> to alex@acme.dev`, the time. It's drawn to show the subject and the from line; nothing in the HTML makes it |
| Outer | the full width | the mail's background: Shell in light, `--side` in dark |
| Top row | 600px, 24px above, 20px below | the lockup left, the organization's name right |
| Card | 600px, 10px radius, 1px border, padding 32px | pill and context line, heading, lede, the one line, button, note, hairline, the fallback link |
| Footer | 600px, 24px above, padding 0 32px | the why line and the install line |
| Below | | the outer background, 40px |

### Top row

- **The lockup,** left, 93×20px: an `<img>` from the install's own address (`OSTRA_PUBLIC_URL/email/logo-abyss@2x.png`, `alt="ostra"`, `width="93" height="20"`, `border="0"`, `style="display:block"`). In dark mode the Shell lockup instead (below). The picture draws it at about 24px tall; build 20px.
- **The organization,** right-aligned, 12.5px secondary: `Acme Corp`.

### Card, top to bottom

1. **Pill and context,** one line: the pill `Needs you` (amber fill `#FFB224`, Abyss `#0C1D21` text, 11px 600, 20px tall, padding 0 8px, radius 4px), then 10px and the context line `calculator · CALC-161` in mono 12px secondary. The `test` mail has no pill.
2. **Heading,** 16px down: Manrope 700 **24px**/30px, letter-spacing −0.01em, main text. (The panel's title size. The picture draws it at about 27px.)
3. **Lede,** 10px down: 15px/24px, main text, the title in 600.
4. **The one line,** 20px down: a full-width block, 44px tall (a single line; a long one wraps, and the block grows), a 3px amber left border, fill as below, radius `0 7px 7px 0`, padding `12px 14px`. Mono 13px/20px: the verb in secondary, a space, the subject in main text. `word-break: break-all` so a long path never widens the mail. This is the panel's approval idiom (an amber left rule, not a card). The `test` mail has none.
5. **Button,** 24px down: 40px tall, padding `0 20px`, radius 7px, 13.5px 600 (the picture draws it larger, about 46px tall and 234px wide). Light: Abyss fill, Shell text. Dark: Shell fill, Abyss text. It's a link, never a form.
6. **Note,** 16px down: 13px/20px secondary.
7. **Hairline,** 24px down, 1px, the card's line colour.
8. **Fallback,** 16px down: 12px faint `If the button doesn't work, open this link:`, then on its own line the URL in mono 12px, as a link (light: main text, underlined; dark: teal, no underline). `word-break: break-all`.

### Footer

12px/18px faint, two lines:
- `You get this because you drive this task. Choose which moments mail you in Notifications.` `Notifications` links to `OSTRA_PUBLIC_URL/account/notifications` (screen 10), underlined in light, teal in dark (the picture underlines it in dark too; don't).
- `ostra for Acme Corp · ostra.acme.dev` (the install's host, no scheme).

No unsubscribe banner, no social links, no tracking pixel, no images but the lockup.

## Colours

Light is the HTML's own colours (inline styles). Dark is a `prefers-color-scheme: dark` override that clients may ignore. Both come from the brand palette (`brief.md`) and the panel's graphite (`app-design.md`).

| Role | Light | Dark |
|---|---|---|
| Outer background | Shell `#F3F0E8` | `--side` `#0A0B0C` |
| Card | `#FFFFFF`, border Mist `#CFD8D4` | `--surface` `#131416`, border `--line` `#1F2023` |
| Main text | Abyss `#0C1D21` | `--text` `#EDEDEE` |
| Secondary text | Kelp `#2F4A47` | `--muted` `#9A9DA3` |
| Faint text | `#5F6B68` (4.9:1 on Shell, 5.5:1 on white) | `#7E8187` (4.7:1 on the card, 5.0:1 on the outer). Not the panel's `--faint` `#64676D`, which is 3.3:1 on `#131416`: too faint for 12px text in a mail |
| The one line's fill | Shell `#F3F0E8` | `--bg` `#0D0E10` |
| Card hairline | `#E3E7E4` | `--line` `#1F2023` |
| Button | Abyss fill, Shell text | Shell fill, Abyss text |
| Links | Abyss, underlined | teal `#6FB8AA`, no underline |
| Pill and the one line's rule | Buoy Amber `#FFB224` (Abyss text on the pill) | the same |
| Lockup | `logo-abyss@2x.png` | `logo-shell@2x.png` |

Amber is a fill and a rule, never text, in both modes (`brief.md`: never amber text on Shell). Nothing else in the mail is amber. Red and green aren't used: a needs-you mail is never an error.

## HTML constraints

The renderer returns one string; these hold for every kind.

- **Document:** `<!doctype html>`, `<html lang="en">`, `<meta charset="utf-8">`, `<meta name="viewport" content="width=device-width, initial-scale=1">`, `<meta name="color-scheme" content="light dark">` and `<meta name="supported-color-schemes" content="light dark">`, and a `<title>` equal to the subject.
- **Tables for layout:** an outer `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">` with the outer colour as both `bgcolor` and inline `background-color`, holding a centred `<table role="presentation" width="600" style="width:100%;max-width:600px">`. Rows are `<tr><td>`; no flexbox, no grid, no `position`, no CSS variables, no `margin` on tables (padding on cells instead).
- **Inline styles on every element** carry the light design whole. A single `<style>` in `<head>` holds only what can't be inline, with classes on the elements it touches: the dark overrides and the narrow layout. A client that strips `<style>` shows the light mail at 600px, which is correct.
- **Dark mode:** `@media (prefers-color-scheme: dark) { … }` sets the dark column of the colour table with `!important` on classes (`.o-outer`, `.o-card`, `.o-text`, `.o-muted`, `.o-faint`, `.o-line`, `.o-code`, `.o-button`, `.o-link`), and swaps the lockups: the Shell `<img>` is in the HTML with `style="display:none;mso-hide:all"` and the class `.o-logo-dark`, shown by the media query, which hides `.o-logo-light`. Add the same overrides under `[data-ogsc]` for Outlook.com. Clients that invert colours on their own (Gmail's apps, Outlook) ignore all of it; for them, `logo-abyss@2x.png` has a Shell `#F3F0E8` background baked in rather than transparency, so the mark never disappears on a dark page, and every text and background colour is set explicitly so the inversion has something to work from.
- **Fonts:** stacks, no web fonts loaded (nothing is fetched from a third party, and a mail shouldn't wait on fonts). Heading `Manrope, 'Helvetica Neue', Helvetica, Arial, sans-serif`; body `'IBM Plex Sans', -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`; mono `'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`. Most clients show the fallbacks; the picture shows the brand fonts, which members with them installed see.
- **The button** is a bulletproof link: a `<table role="presentation">` with one `<td>` whose `bgcolor` and inline background are the fill and whose radius is 7px, holding an `<a>` with `display:inline-block; padding:10px 20px; line-height:20px` and the text colour inline. No VML: Outlook for Windows gets square corners, which is fine.
- **The preheader:** the first element in `<body>`, a `<div>` with `display:none; max-height:0; overflow:hidden; mso-hide:all` holding the preheader text, then `&zwnj;&nbsp;` repeated about 80 times so the client's preview doesn't run into the mail's first words.
- **Images:** only the lockup, `width` and `height` attributes set, `alt="ostra"`. Images off, the alt text sits where the lockup was, in main text, 14px 600 (set on the `<img>`'s style). Served from `OSTRA_PUBLIC_URL/email/`, so a mail fetches nothing from outside the install. If `OSTRA_PUBLIC_URL` is `localhost`, the lockup won't load outside the machine: the alt text covers it.
- **Links:** absolute, built from `OSTRA_PUBLIC_URL`, no tracking parameters, no redirect through anything.
- **Accessibility:** `role="presentation"` on every layout table; the heading is an `<h1>` (margins reset inline); `lang="en"`; every text colour meets 4.5:1 on its background in both modes (the two faint colours were chosen for it; the picture draws the dark faint text at the panel's `#64676D`, which doesn't).
- **Size:** under 20 KB of HTML, well under Gmail's 102 KB clipping.
- **Narrow (under 620px):** a `@media (max-width: 620px)` rule sets the column to `width:100% !important`, the outer padding to 12px and the card padding to 20px. The button stays its own width. The one line wraps.

## The text part

Sent as the `text/plain` alternative of every mail, with the same content and nothing more. Plain lines, wrapped at 72 characters except URLs, no markdown, no ASCII boxes:

```
An approval is waiting
calculator · CALC-161 Add history panel · Acme Corp

The agent on Add history panel asks before it edits a file.

  Edit config/settings.json

Open the approval, and answer it signed in on the task page:
https://ostra.acme.dev/tasks/tsk_8f2kq0r4

Any member of calculator can answer.

--
You get this because you drive this task.
Choose which moments mail you:
https://ostra.acme.dev/account/notifications

ostra for Acme Corp · ostra.acme.dev
```

- Line 1 is the heading; line 2 the context line with the organization; then the lede; the one line indented two spaces; the button's words as a sentence, with the link on its own line; the note; `-- ` and the footer.
- A plan's text part says `Review the plan, and approve it signed in on the task page:`; a question's `Answer the question signed in on the task page:`.
- Ticket 21's test: "a mail's HTML and text both carry the link" (ticket 04's contract suite).

## States

A mail has no interactive states. What varies:

| Case | What changes |
|---|---|
| Approval (the picture) | as above |
| Plan, question | the rows of "The three kinds" |
| No ticket | the context line is the project alone (`calculator`); the subject drops the key |
| No driver | the why line: `You get this because you're a member of calculator.` |
| Long title | wraps in the lede; the subject is cut at 120 characters with `…` |
| Long one line | cut at 200 characters with `…`, wraps inside its block |
| Images off | the lockup's alt text `ostra` |
| A client that strips `<style>` | the light mail at 600px, in either mode |
| A client that inverts | the light mail, inverted by the client; the lockup on its baked-in Shell background |
| Narrow (a phone) | full width, 12px outer and 20px card padding |
| Answered before the delay | no mail: core skips it (ticket 21). Nothing in the template |

## Headers (set by core and the adapters, listed here so the mail is whole)

- `From: <OSTRA_EMAIL_FROM_NAME or ostra> <from address>`; `To:` the member's account address, one recipient per message.
- `Subject:` as above.
- `Message-ID` from the notification's key (ticket 13); Resend's idempotency key (ticket 12).
- No `List-Unsubscribe` in milestone 3: these are a member's own notifications, turned off per moment in Notifications. See the open point.

## Differences from the current code

Checked against `main` (2026-11-19):

1. **Nothing exists.** `packages/domain` has no `notifications/` folder and no templates; ticket 07 adds the renderers and their snapshot tests.
2. **Assets:** `context/brand/files/web/email-logo@2x.png` (B-015) is the Abyss lockup at 400×86 with a transparent background. This mail needs it **with a baked-in Shell background** (for inverting clients), plus a **Shell twin** for dark mode: two files, `logo-abyss@2x.png` and `logo-shell@2x.png`, 186×40 at 2× each, made by script from `files/logo/lockup-horizontal-*.svg`. Record them in `assets.md` (B-015 grows, or a new row) and serve them from `apps/web/public/email/`.
3. **The panel's routes the links point at:** `/tasks/<task-id>` exists. `/account/notifications` is new (screen 10, ticket 45). The task page opening on the pending item is ticket 43's.

## Wrong in the image

Build from this file, not these:

- **Everything is drawn about 1.15× the spec:** the heading about 27px (build 24px), the pill about 27px tall (20px), the one-line block about 51px (44px), the button about 234×46px (about 176×40px, from its padding), the lockup about 24px tall (20px), the header strip 83px. The column and card widths (600px, 20px margins at 640) are right.
- The dark half's faint text (the fallback line, the footer) is the panel's `#64676D`. In the mail it's `#7E8187`, for contrast.
- The dark half underlines `Notifications`. In dark mode links are teal with no underline, like the fallback URL drawn above it.
- The light half's underline on `Notifications.` runs under the full stop. Only the word is the link.
- The header strip is the client's, drawn so the subject and from line can be checked. Nothing in the HTML renders it.
- The context line read `aclculator` in the generation; it was retouched to `calculator` (see the prompt's header). If the retouch shows at a zoom, the copy here wins.
- The picture shows only the approval. The plan, question and test mails are in the tables above.

All other visible copy is spelled right.

## Open points for the maintainer

- **`List-Unsubscribe`.** Gmail and Yahoo require one-click unsubscribe from bulk senders; a small install's notifications aren't bulk, but a large one might cross the threshold. Recommended: add `List-Unsubscribe` and `List-Unsubscribe-Post` pointing at a signed, per-member, per-kind endpoint in milestone 4, with F-002's mails. Until then, the footer's Notifications link.
- **Web fonts in mail.** Recommended: none (above). The alternative is an `@font-face` from the install's own address in the `<style>` block, which Apple Mail would use; it's one more request per open, for a visual gain few readers would see.
