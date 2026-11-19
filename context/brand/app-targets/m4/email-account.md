# Target: the account mails and the budget mails (milestone 4, screen 18)

> **Committed image:** `email-account.webp`, 1280×850, downscaled from the 2048×1360 generation. It holds the same mail twice: **light mode on the left (x 0–640), dark mode on the right (x 640–1280)**, each at a mail client's reading width of 640 CSS px. One image pixel is one CSS pixel. It draws the **invitation**; the verification, reset and budget mails are the variants below.

- **Prompt:** `email-account.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation, not retouched. References: the 2048 original of `app-targets/m3/email-needs-you` (the mail the spec starts this one from), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **What it is:** mails, not a panel screen. Each is rendered by a pure function in `packages/domain/src/notifications/`, next to milestone 3's needs-you renderer and on the same layout (ticket 06's "Mail templates"), and returns `{ subject, html, text }`. The account mails are sent by core's `account-mail.send` (ticket 19); the budget mails by milestone 3's fan-out from `budget.check` (ticket 13). Both go through milestone 3's Resend or SMTP adapter. There's no route and no React.
- **Features:** F-002 (accounts: the invitation, verification and reset mails), F-037 (costs and budgets: the 80% and 100% mails), F-115 (email notifications, grown). Spec section 12, screen 18. ADR 0053 ("Invitations", "Resets"), ADR 0055 (the budget's notices), ADR 0050 ("What a mail may carry", "Templates").
- **Status:** a proposed target, waiting on approval (ticket 31's `## Comments`).

> Build it as the HTML the renderer returns, then open that HTML in a browser at 640px wide, once with `prefers-color-scheme: light` and once `dark`, screenshot both, and compare them with the two halves of the picture. Then send each kind through ticket 40's mail sink and through Resend to the maintainer's address, and look at it in at least one real client (spec section 3, steps 1, 6 and 14).

## Purpose

Five mails that must read as ostra and do one thing each:

- **Invitation:** a person who isn't a member yet learns who invited them, to which organization, and joins in one click. It's the first thing they ever see of ostra, so it says in one line what ostra is.
- **Verification:** the invitee proves the address is theirs; the membership starts when they open the link (ADR 0053).
- **Reset:** a member who asked for it chooses a new password.
- **Budget warning (80%) and budget reached (100%):** an admin learns that a budget is nearly or fully spent, and what stops at 100%.

The three account mails carry a **bearer link**: whoever holds it can join as that person or set their password. So they say "don't forward this", say how long the link works, and say what happens if the reader didn't ask. They can't be turned off (ADR 0053: the person can't sign in to choose), so their footer has no Notifications link. The budget mails are moments (ticket 13): members' choices apply, and their footer has milestone 3's.

None carries task content (ADR 0050). The only member- or tracker-written text is the organization's name, the inviter's name, a username and a project's name: each HTML-escaped, stripped of line breaks in the subject, and never put in a URL.

## What every mail holds

Milestone 3's slots (`m3/email-needs-you.md`, "What every needs-you mail holds"), filled per kind. The picture is the invitation:

| Slot | The picture (invitation) |
|---|---|
| Subject | `Alex Kim invited you to Acme Corp on ostra` |
| Preheader (hidden) | `Join Acme Corp on ostra · the link works until 26 Nov 2026` |
| Top row, right | the organization: `Acme Corp` |
| Context line (no pill) | `Invitation · Acme Corp` |
| Heading | `Join Acme Corp on ostra` |
| Lede | `Alex Kim invited you to join Acme Corp as a member. ostra is where the team runs coding agents on its tickets.` The inviter and the organization in 600 |
| The block | `For` · `sam@acme.dev`: the invitation's address |
| Button | `Accept the invitation` |
| Note | `The link works once, until 26 Nov 2026, 14:05 UTC. Anyone who has it can join as you, so don't forward this mail.` |
| Link | `OSTRA_PUBLIC_URL` + `/invite/<invitation-id>`: the invitation's ID is the secret (ADR 0053), at least 128 random bits. The picture's `inv_7Hq2kX9mPz4vR8tWb3nL5c` is a demo ID |
| Footer, line 1 | `You get this because Alex Kim invited sam@acme.dev. If you didn't expect it, ignore it: nothing happens.` |
| Footer, line 2 | `ostra for Acme Corp · ostra.acme.dev` |

### The variants

| | Invitation (the picture) | Verification | Reset |
|---|---|---|---|
| Kind | `invitation` | `email_verification` | `password_reset` |
| Subject | `<inviter> invited you to <organization> on ostra` | `Confirm your address to join <organization>` | `Reset your ostra password` |
| Preheader | `Join <organization> on ostra · the link works until <date>` | `One click and you're in <organization>` | `For <address> on <host> · the link works for 24 hours` |
| Top row, right | `<organization>` | `<organization>` | the install's host, `ostra.acme.dev` (an account may belong to several organizations) |
| Context line | `Invitation · <organization>` | `Verification · <organization>` | `Password reset · ostra.acme.dev` |
| Heading | `Join <organization> on ostra` | `Confirm your address` | `Reset your password` |
| Lede | `<inviter> invited you to join <organization> as <a member / an admin>. ostra is where the team runs coding agents on its tickets.` | `You signed up as <username> to join <organization>. Confirm that this address is yours, and your membership starts.` | `Someone asked to reset the password of your ostra account at ostra.acme.dev.` |
| The block | `For` · `<invitation's address>` | `For` · `<address>` | `For` · `<address>` |
| Button | `Accept the invitation` | `Confirm my address` | `Choose a new password` |
| Note | `The link works once, until <date>, <time> UTC. Anyone who has it can join as you, so don't forward this mail.` | `The link works once, until <date>, <time> UTC. Until then you can sign in, but you won't see <organization>.` | `The link works once, for 24 hours. A new password signs you out everywhere else, the CLI included.` |
| Link | `/invite/<invitation-id>` | better-auth's verification URL (ticket 22), on `OSTRA_PUBLIC_URL` | better-auth's reset URL (ticket 22), landing on `/reset` |
| Footer, line 1 | `You get this because <inviter> invited <address>. If you didn't expect it, ignore it: nothing happens.` | `You get this because <address> signed up through an invitation to <organization>. If it wasn't you, ignore it: nothing happens.` | `You get this because a reset was asked for <address>. If it wasn't you, ignore it: your password stays as it is.` |
| Footer, line 2 | `ostra for <organization> · <host>` | the same | `ostra · <host>` |

- **The role** in the invitation's lede is `as a member` or `as an admin`. Restricted projects (ADR 0053's `projectGrants`) aren't listed: the mail says who and where, the page the link opens says the rest.
- **The verification's expiry** is better-auth's `emailVerification.expiresIn`; see "Open points".
- **The reset's 24 hours** is `OSTRA_RESET_LINK_HOURS`, written from the setting, not as a literal. Only a verified address gets the mail (ADR 0053); the page that asked answers the same either way.
- **The instance admin's reset link** (without email) is never mailed: it's shown once in the panel (`instance-settings`). No template.

### The budget mails

On milestone 3's needs-you layout, with milestone 3's footer. Amounts in dollars with cents, from `spentMicroUsd`; the share rounded down to a whole percent (so 99.6% reads `99%`, never `100%` before it is).

| | Budget warning (80%) | Budget reached (100%) |
|---|---|---|
| Kind | `budget_warning` | `budget_reached` |
| Subject | `calculator is at 91% of its budget` (the organization's: `Acme Corp is at 91% of its budget`) | `calculator reached its budget` |
| Preheader | `$91.40 of $100.00 for November 2026` | `$101.20 of $100.00 for November 2026 · new work is held` |
| Context line | no pill · `calculator · November 2026` (mono) | the `Needs you` pill · `calculator · November 2026`: work is held until an admin raises the budget or the month ends |
| Heading | `calculator is at 91% of its budget` | `calculator reached its budget` |
| Lede | `calculator has spent $91.40 of its $100.00 budget for November. At 100%, no new task or turn starts in it until the budget is raised or the month ends.` | `calculator has spent $101.20 of its $100.00 budget for November. New tasks wait and new turns are held, in order; running turns finish.` |
| The block | `Spent` · `$91.40 of $100.00 · 91%`, a neutral rule | `Spent` · `$101.20 of $100.00 · 101%`, the amber rule (it waits on the reader) |
| Button | `Open Spend` | `Raise the budget` |
| Note | `Budgets count every task's tokens at the model's prices, in UTC months.` | `Raising it lets the held turns go in the order they were held.` |
| Link | `/organization/spend?project=<project-id>` (`/organization/spend` for the organization's budget) | the same |
| Footer, line 1 | `You get this because you're an admin of calculator. Choose which moments mail you in Notifications.` (`… an admin of Acme Corp.` for the organization's) | the same |

`Raise the budget` opens the same Spend page; only admins of the budget's scope get the mail (ticket 13), so the button's word is true for every reader.

## Layout (CSS px)

**Exactly `m3/email-needs-you.md`'s layout,** one shared renderer: the 600px column, the top row (lockup and the right-hand name), the card (padding 32px, 10px radius, 1px border), the footer, the narrow rule. The differences:

1. **The context line has no pill** in the account mails and the budget warning: the line starts at the card's left edge, mono 12px secondary. Only `budget_reached` keeps milestone 3's amber `Needs you` pill.
2. **The block** is milestone 3's "one line" (44px, padding `12px 14px`, radius `0 7px 7px 0`, mono 13px/20px: the word in secondary, a space, the value in main text, `word-break: break-all`), with a **neutral left rule**: 3px Mist `#CFD8D4` in light, `--line-2` `#2A2C30` in dark. Amber only on `budget_reached`.
3. **The note** may run to two lines (13px/20px secondary, as milestone 3's).
4. **The button** fits its label (`Accept the invitation` is the longest, about 196px at 13.5px 600 with `0 20px` padding). Same colours as milestone 3.
5. **The footer's first line** has no link in the account mails.

## Colours

Milestone 3's table, unchanged (`m3/email-needs-you.md`, "Colours"), plus one row:

| Role | Light | Dark |
|---|---|---|
| The block's neutral rule | Mist `#CFD8D4` | `--line-2` `#2A2C30` |

Amber appears **only** in `budget_reached` (the pill and the block's rule). The account mails never wait on a member, and a budget warning is a heads-up, not a task for the reader. Red and green aren't used. Faint text is `#5F6B68` in light and `#7E8187` in dark (milestone 3's mail values, for 4.5:1), not the panel's `--faint`.

## HTML constraints

**Every point of `m3/email-needs-you.md`'s "HTML constraints" holds**: the document head with `color-scheme` and `supported-color-schemes`, tables for layout, inline styles carrying the light design, the one `<style>` block for dark and narrow only, `[data-ogsc]` for Outlook.com, font stacks with no web fonts, the bulletproof button, the preheader with its `&zwnj;&nbsp;` run, the two lockup images (`logo-abyss@2x.png` with the Shell background baked in, `logo-shell@2x.png` for dark) served from `OSTRA_PUBLIC_URL/email/`, absolute links with no tracking, `role="presentation"`, an `<h1>`, under 20 KB. Added for these mails:

- **The bearer link appears exactly twice in the HTML** (the button's `href` and the fallback's text and `href`) and once in the text part, and nowhere else: not in the `<title>`, the preheader, an `alt`, a comment or a data attribute. Ticket 04's contract suite checks both parts carry it; ticket 19 checks no log line, job payload, delivery row or error holds it.
- **No image beacons and no link rewriting.** A provider's click or open tracking is off for these mails (Resend: send with tracking disabled; SMTP has none). A rewritten link would send the token through a third party.
- **The context line's `Invitation`, `Verification` and `Password reset`** are words, not a pill, so nothing in an account mail is styled as an alert.
- **Headers:** no `List-Unsubscribe` on the account mails (they can't be turned off; ADR 0053). The budget mails follow milestone 3's choice for moment mails.

## The text part

Sent as the `text/plain` alternative, with the same content and nothing more, as milestone 3's: plain lines wrapped at 72 characters except URLs, no markdown.

```
Join Acme Corp on ostra
Invitation · Acme Corp

Alex Kim invited you to join Acme Corp as a member. ostra is where
the team runs coding agents on its tickets.

  For sam@acme.dev

Accept the invitation:
https://ostra.acme.dev/invite/inv_7Hq2kX9mPz4vR8tWb3nL5c

The link works once, until 26 Nov 2026, 14:05 UTC. Anyone who has it
can join as you, so don't forward this mail.

--
You get this because Alex Kim invited sam@acme.dev. If you didn't
expect it, ignore it: nothing happens.

ostra for Acme Corp · ostra.acme.dev
```

- Line 1 is the heading; line 2 the context line; then the lede; the block indented two spaces; the button's words and a colon, with the link on its own line; the note; `-- ` and the footer.
- Verification: `Confirm your address:`; reset: `Choose a new password:`; budget mails: `Open Spend:` and `Raise the budget:`, then milestone 3's footer with the Notifications link on its own line.

## States

A mail has no interactive states. What varies:

| Case | What changes |
|---|---|
| Invitation (the picture) | as above |
| Verification, reset, budget warning, budget reached | the rows of "The variants" and "The budget mails" |
| An admin invitation | `as an admin` in the lede |
| Long organization or inviter name | wraps in the heading and the lede; the subject is cut at 120 characters with `…` |
| The organization's budget | `Acme Corp` in place of the project, the footer's `an admin of Acme Corp`, the link without `?project=` |
| Images off | the lockup's alt text `ostra` |
| A client that strips `<style>` | the light mail at 600px, in either mode |
| A client that inverts | the light mail, inverted by the client; the lockup on its baked-in Shell background |
| Narrow (a phone) | full width, 12px outer and 20px card padding; the URL wraps (`break-all`) |
| Revoked, accepted or expired before the job ran | no mail: `account-mail.send` checks the record first (ticket 19). Nothing in the template |
| Email off | no account mail at all: the panel's copy-link path (ticket 22), and the instance admin's reset link |

## Differences from the current code

Checked against `main` (2026-11-19):

1. **Nothing exists.** `packages/domain` has no `notifications/` folder yet; milestone 3's ticket 07 adds it with the needs-you renderer, and milestone 4's ticket 06 adds these five templates beside it, sharing its layout helpers. Snapshot tests per kind, light HTML and text.
2. **The lockups:** `apps/web/public/email/` doesn't exist yet; milestone 3 adds `logo-abyss@2x.png` and `logo-shell@2x.png` (`m3/email-needs-you.md`, difference 2). These mails reuse them.
3. **The links' pages:** `/invite/[invitation-id]` and `/reset` are new (ticket 32, targets `accept-invite` and `reset-password`); `/organization/spend` is new (ticket 36, target `spend-budgets`).
4. **`Notification.kind`** gains the five kinds and `category` (ticket 04).

## Wrong in the image

Build from this file, not these:

- **Everything is drawn about 1.15× the spec,** as in milestone 3's picture: the heading about 27px (build 24px), the block about 49px tall (44px), the button about 44px tall and 238px wide (40px, and about 196px from its padding), the lockup about 27px tall (20px), the header strip about 83px. The column and card widths (600px, 20px margins at 640) are right.
- **The note's date** reads `26 Nov 2026.` without the time. Build `26 Nov 2026, 14:05 UTC.`: an expiry needs its hour and zone.
- **The dark block** has a faint 1px border all round. It has only the 3px left rule, like the light one.
- **The light block's rule** is drawn very pale. It's Mist `#CFD8D4`, as the card's border.
- **The lockup** approximates the Hinge mark. Use the scripted `logo-abyss@2x.png` / `logo-shell@2x.png`.
- **The header strip** is the client's, drawn so the subject and the from line can be checked. Nothing in the HTML renders it.
- **The picture shows only the invitation.** The other four mails are in the tables above.

All visible copy is spelled right; the demo invitation ID reads the same in both halves.

## Open points for the maintainer

- **How long a verification link works.** ADR 0053 sets the invitation (7 days) and the reset link (24 hours) but not the verification. better-auth's default is one hour, which is short for someone who signed up and walked away. Recommended: 24 hours, as `OSTRA_RESET_LINK_HOURS`'s value, through better-auth's `emailVerification.expiresIn`, and a "Send it again" on the "Check your inbox" page (`accept-invite`). The alternative keeps one hour.
- **The budget mails' button.** `Raise the budget` assumes the reader can, which holds for the audiences of ticket 13 (admins of the budget's scope). If milestone 6's audiences add non-admins, their mail says `Open Spend` instead.
