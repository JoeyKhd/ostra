# Target: Organization › GitHub, turning on events later

- **Pictures:** `github-events` (the App selected, events off, `Turn on →`), `github-events-turn-on` and `github-events-turn-on-light` (Turn on's result, shown once), `github-events-states` (the Events row in each state, the section line's words, New webhook secret's result and both dialogs), `github-events-phone` (390×844). Desktop: a 2880×1912 `.png` and a 1440×956 `.webp`; the phone: 780×1688 and 390×844.
- **Sources:** `html/github.html?view=off|once`, `html/states.html?sheet=github`, `html/phone.html?scene=github`; the parts in `html/gaps.js` (`appSections`, `appPanel`, `eventsRow`, `onceGroup`, `replaceDialog`, `leaveDialog`).
- **Route (existing):** `/organization/github` → `components/github/github-view.tsx` and `github-orgs.tsx`, grown. The selection stays `?app=<connectionId>`; the result is a state of the App's panel, never in the URL.
- **Feature:** F-006/c4 ("the webhook and its events are added only once a public address exists… the panel says so and offers to finish it later"). ADR 0040's note of 2026-11-22. API, built: `github.appRequest` → `webhookPossible`; `github.connections` → each App's `webhook.kind` (`none` | `receiving` | `failing`) and `missingEvents`; `github.turnOnWebhook({ connectionId })` → `webhookUrl`, `webhookSecret` (this once), `events`, `replaced`.
- **Builds on:** `../m4/github-organizations.md` and `../m1/github.md` (point 8 asked for this row), as the live page draws them, in milestone 8's shell.
- **Status:** a proposal, 2026-11-22. Nothing is built from it until the maintainer approves.

## Purpose

An App made while ostra had no public address has no webhook: GitHub refused a loopback hook URL, so the manifest left it out. Without events ostra learns of PR changes only on its periodic check, and never sees `@ostra` in a PR comment. GitHub has no API that adds a webhook or events to an App, so once the address is public an organization admin pastes three things into the App's settings on GitHub. The page says which App is missing them, gives the address and a fresh secret once, lists the ten events to tick, links to the two GitHub pages, and says when it's done.

## Layout (CSS px at 1440×956)

The live page: `PageFrame` with the 320px panel (380px while the result shows, as it holds copy fields).

### Main column: the App's section

- **The section line's state** (right-aligned, 13.5px `--muted`), one more word than today. `webhook.kind` `none` → a 7px `--faint` dot + `Events off` (today it reads `No events yet`, which sounds like a healthy quiet App). A secret set while `missingEvents` isn't empty → Lucide `clock` 14px + `Waiting for events`. `receiving` with nothing missing → green dot + `Webhook receiving`; `failing` → `triangle-alert` + `Webhook failing`, as today.
- **A note under the App's installations,** only while its events are off: 10px under the last row, 13.5px `--muted`, Lucide `info` 14px `--faint`: `Made while this server had no public address, so GitHub sends it no events.` + teal `Turn them on →` while `webhookPossible` (it selects the App and starts Turn on, as the panel's link). No public address: the sentence alone.

### The App's panel: the Events row

The `App` group (`PanelLabel` 12px, `PropRow` 30px with the 112px key column) gains **Events** after **Webhook**. Its value, then a line under the row spanning the panel (12.5px / 1.5, `--faint`, 1px above, 6px below):

| State | Value | The line under it |
|---|---|---|
| **No public address** (`webhookPossible` false) | `Off · no public address` (`--muted`) | `GitHub can't reach this server. Set OSTRA_CORE_PUBLIC_URL to a public address and restart core, then turn them on here.` (the setting in a code chip). No action |
| **Off** (a public address, `webhook.kind` `none`) | `Off` (`--muted`) and, right-aligned, teal `Turn on →` | `Without them, ostra learns of PR changes only on its periodic check, and never sees @ostra in a PR comment.` |
| **Waiting for events** (a secret, `missingEvents` not empty) | `clock` 14px + `Waiting for events` (`--text`) | `Subscribe to 10 events in the App's settings on GitHub.` + teal `Which ones` (opens the result's events list again, without a new secret) ` · ` teal `Permissions and events ↗` |
| **On** (`receiving`, nothing missing) | green dot + `On` + ` · 10 events` (13px `--faint`) | teal `New webhook secret` |
| **Couldn't check** (`missingEvents` null) | `Couldn't check` (`--muted`) | `GitHub didn't say which events the App takes.` + teal `Check again` (refetches `github.connections`) |

While the webhook isn't public (`nopublic`), the `Webhook` row shows the address ostra has, `http://localhost:4000/…`, as today.

### Turn on's result, shown once (`github-events-turn-on`)

`Turn on →` calls `github.turnOnWebhook`; while it runs the link reads `Turning on…`, disabled. The panel then widens to 380px and shows, in place of the App's groups:

1. Eyebrow `Turn on events` (12px 500 `--faint`); title `ostra-acme` (mono 15px 600); 13.5px `--muted`: `Set these in the App's settings on GitHub: it has no call that does it for ostra.`
2. **Step 1** (a 20px ring with `1` in mono 11.5px; the step's head 14px 500): `Webhook, under General`, right-aligned teal `General ↗` (the App's settings page: `https://github.com/organizations/{owner}/settings/apps/{slug}`, or `https://github.com/settings/apps/{slug}` for a user's App). Under it 13px `--muted`: `Tick Active, then paste both.` Then two labelled copy fields (label 13px 500 `--muted`, 10px above; field 32px, `--surface`, 1px `--line-2`, mono 12.5px, cut with `…`; a 32px `CopyButton` beside, which shows a green `check` for 2s once copied): `Webhook URL` (`https://ostra.acme.dev/webhooks/github/<connectionId>`) and `Webhook secret`. Under them the lock line (12.5px `--muted`, Lucide `lock` 13px): `The secret is shown once. Copy it now: ostra keeps it in the secret store and never shows it again.`
3. **Step 2:** `Events, under Permissions`, teal `Permissions ↗` (`…/settings/apps/{slug}/permissions`). `Tick these 10 under Subscribe to events, then save.` Then the events, one per 25px row with a hairline under each, mono 13px `--text`, in `appEvents`' order: `pull_request`, `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread`, `issue_comment`, `check_run`, `check_suite`, `status`, `push`, `workflow_run`. Only the ones in `missingEvents` when some are already ticked.
4. An outline `Done` and 12.5px `--faint` `Events reads On once GitHub lists all ten.` `Done` returns to the App's panel, whose row now reads `Waiting for events` until GitHub's `GET /app` lists them; the page refetches `github.connections` every 15s while it waits.

Leaving the result any other way (another row, another page, the panel's close) before `Done` asks first:

- `AlertDialog` `Leave without copying the secret?` / `ostra shows it only now. Without it in the App's settings, GitHub's deliveries can't be checked and ostra drops them. You'd make another with New webhook secret.` / `Stay` (outline), `Leave` (outline, `--red` text).

### New webhook secret

For a lost secret, from the On or Waiting row. It asks first:

- `AlertDialog` `Replace the webhook secret?` / `GitHub keeps signing with the old secret until you paste the new one in ostra-acme's settings. Until then every delivery fails and ostra drops it: PR changes wait for its periodic check, and @ostra comments are missed.` / `Cancel`, `Replace the secret` (outline, `--red` text).
- Then the same result with eyebrow `New webhook secret`, the line `Paste it in the App's settings on GitHub. Until you do, deliveries fail.`, step 1 only (no events step unless some are missing), and `Done once it's pasted and saved on GitHub.`

Every Turn on and every new secret is an audit entry (`github.webhook-secret-set`, built).

## States and copy (the rest)

| State | What shows |
|---|---|
| **Turn on refused** (`PRECONDITION_FAILED`: the address stopped being public) | under the Events row, 13.5px `--red`, `role="alert"`: the server's message, `This server's address isn't public, so GitHub can't deliver to it. Set OSTRA_CORE_PUBLIC_URL to a public address first.`; the row goes back to `Off · no public address` |
| **Another error** | the same line, `errorText(error)` |
| **A client's App** (connected with "Use an existing App") | it got its secret when it connected (`connectExisting`), so it has a webhook; its row is Waiting or On. Its links name its own owner |
| **Loading** | the row as a `Skeleton` with the App's other rows |
| **Phone** (`github-events-phone`) | the panel drops under the page; Turn on's result opens as a bottom sheet (top 64px, radius 14px, a grab handle, a 44px close): 44px copy fields and copy buttons, a full-width 44px `Done`. The leave dialog guards the sheet's close and its swipe down |

## Data

All built (`packages/api/src/routers/github.ts`, `github-organizations.ts`):
- `github.appRequest` → `webhookPossible: boolean` (is `OSTRA_CORE_PUBLIC_URL` public).
- `github.connections` → per App `webhook.kind`, `webhookUrl`, `missingEvents: string[] | null`, `ownerLogin`, `ownerKind`, `slug`.
- `github.turnOnWebhook({ connectionId })` → `{ webhookUrl, webhookSecret, events, replaced }`; refused with `PRECONDITION_FAILED` while the address isn't public. Called again it replaces the secret (`replaced: true`).
- The settings links are built from `ownerKind`, `ownerLogin` and `slug`; with `slug` null, `Open on GitHub` and both links are left out and the steps name the pages in words.

## Keyboard

- `Turn on →`, `Which ones`, `Check again` and `New webhook secret` are buttons; `General ↗`, `Permissions ↗`, `Permissions and events ↗` open GitHub in a new tab (`rel="noreferrer"`).
- The result moves focus to its eyebrow's heading; `Tab` goes URL copy → secret copy → General → Permissions → Done. `CopyButton` announces `Copied` through a polite live region.
- `Esc` on the result is "leave": it opens the leave dialog. Both dialogs are Radix `AlertDialog`s: focus starts on the safe button (`Stay`, `Cancel`).

## Components

`PropRow`, `CopyButton` and `SecretField` (`components/ui/`), `AlertDialog`, `Sheet` (phone), `Skeleton`, `Button` (outline). Icons, Lucide 0.460: `github`, `info`, `clock`, `lock`, `copy`, `check`, `arrow-right`, `arrow-up-right`, `triangle-alert`.

## Tokens

`--muted` (Off), `--faint` (the lines, the dot), `--green` (On's dot, the copied check), `--teal` (every link and action), `--red` (the dialogs' confirm, errors), `--surface` / `--line-2` (copy fields). **No amber,** as milestone 4 settled for this page.

## Copy (new keys under `githubOrgs.events.*`)

`label` `Events` · `offNoPublic` `Off · no public address` · `noPublicLine` `GitHub can't reach this server. Set {setting} to a public address and restart core, then turn them on here.` · `off` `Off` · `turnOn` `Turn on` · `turningOn` `Turning on…` · `offLine` `Without them, ostra learns of PR changes only on its periodic check, and never sees @ostra in a PR comment.` · `waiting` `Waiting for events` · `waitingLine` `Subscribe to {n} events in the App's settings on GitHub.` · `whichOnes` `Which ones` · `permissionsLink` `Permissions and events` · `on` `On` · `count` `{n} events` · `newSecret` `New webhook secret` · `unknown` `Couldn't check` · `unknownLine` `GitHub didn't say which events the App takes.` · `checkAgain` `Check again` · section line: `githubOrgs.webhook.off` `Events off`, `githubOrgs.webhook.waiting` `Waiting for events` · the note: `madeWithout` `Made while this server had no public address, so GitHub sends it no events.`, `turnThemOn` `Turn them on` · the result: `once.eyebrow` `Turn on events`, `once.eyebrowNew` `New webhook secret`, `once.lede` `Set these in the App's settings on GitHub: it has no call that does it for ostra.`, `once.ledeNew` `Paste it in the App's settings on GitHub. Until you do, deliveries fail.`, `once.step1` `Webhook, under General`, `once.step1Help` `Tick Active, then paste both.`, `once.general` `General`, `once.step2` `Events, under Permissions`, `once.step2Help` `Tick these {n} under Subscribe to events, then save.`, `once.permissions` `Permissions`, `once.doneHelp` `Events reads On once GitHub lists all {n}.`, `once.doneHelpNew` `Done once it's pasted and saved on GitHub.` (the URL and secret labels, the lock line and `Done` reuse `githubOrgs.connectAnother.*`) · the dialogs: `leave.title`, `leave.body`, `leave.stay`, `leave.leave`, `replace.title`, `replace.body`, `replace.confirm`, as above.

## Not in the pictures

- `Turning on…` and the refused line.
- `Which ones` reopening the list.
- A user-owned App's links (`github.com/settings/apps/{slug}`).
