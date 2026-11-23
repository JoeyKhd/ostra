# Targets for Trello

Design targets for Trello as a tracker, after v1: Trello enabled in the Trackers picker, its two connect steps and consent hand-off, a connection's settings, a board's attach, prefix and list mapping, and Trello's mark everywhere a card shows. They follow `../../../specs/post-v1-trello/spec.md` (§13 names this set) and milestone 11's tracker targets (`../m11-trackers/README.md`), whose shell, marks and pages they reuse.

**Status: design targets, 2026-11-23.** Drawn from the spec, not yet approved by the maintainer. Trello's ticket 07 may not start before these pictures and the choices below are approved (spec §13).

## What changes from milestone 11

- **The picker** has three enabled tiles: Linear, Jira and Trello. Only **Notion** says `Coming soon`, and it isn't focusable.
- **Connecting Trello takes two steps**, not Jira's three: the organization's own app (key and secret), then a dedicated **bot member's** never-expiring token. The consent page is the hand-off; a pasted token is the fallback.
- **A Trello connection's page** has Trello's own rows: the bot member, the app key and secret, one webhook per attached board, Re-register webhooks, Replace the token, Replace the app secret, Check again, Rename and Disconnect.
- **A project's Boards** attach a Trello board beside Linear teams and Jira projects. A Trello board needs a **prefix** (`TR`), and each **list** gets a category and, where it maps, one of ostra's steps.
- **Every ticket surface** carries Trello's mark, and the task's `On Trello` rows name the list each move wrote, not a transition.

## How they're made

As milestone 11's targets: real HTML on the panel's own CSS and fonts, not image-model pictures (`../../app-design.md`, rule 5).

- **Loaded, not copied:** each page loads `../../m8/html/m8.css` (the panel's tokens, fonts and the double sidebar), `../../m10-gaps/html/gaps.css` (select, menu, dialog, board rows, mapping rows, copy fields), `../../m11-trackers/html/tr.css` and `../../m11-trackers/html/tr.js` (the connection list, steps, read-back, settings, the marks and the demo data), then this set's `html/tl.css` and `html/tl.js` (the Trello parts). Icons are Lucide 0.460.
- **Pages:** `trackers.html`, `connection.html`, `boards.html`, `chips.html`, `states.html`, `phone.html`.
- **The render:** Playwright's Chromium (`playwright@1.65.1` from the live checkout's `node_modules`) at each target's viewport and 2×, to `<name>.png`; `html/to-webp.py` writes `<name>.webp` at one image pixel per CSS pixel.
  ```
  node html/render.mjs <path to playwright/index.mjs> [name ...]
  python -I html/to-webp.py [name ...]
  ```
- **Demo data:** Acme Corp and its clients Globex and Northwind; Acme Linear, Globex Jira, Acme Trello (`ostra-acme`, full name `ostra Acme`), Northwind Trello (`ostra-northwind`) and Acme Ops Jira; the boards `Calculations` (`TR`) and `Retail` (`RT`); the lists `Backlog`, `To Do`, `Doing`, `Review`, `Done`, `Won't do`; `CALC-…`, `PROJ-…`, `TR-12`, `TR-14`; Alex Kim.
- **No Higgsfield credits were used.**

## Screens

| # | Screen | Pictures | Build spec |
|---|---|---|---|
| 1 | **Organization › Trackers with Trello:** five connections, Acme Trello selected, its bot member, boards and capabilities in the panel | [png](trackers-trello.png) · [webp](trackers-trello.webp) · [light png](trackers-trello-light.png) · [light webp](trackers-trello-light.webp) · [phone png](trackers-trello-phone.png) · [phone webp](trackers-trello-phone.webp) · [phone light png](trackers-trello-phone-light.png) · [phone light webp](trackers-trello-phone-light.webp) | `trackers-trello.md` |
| 1 | **Connect a tracker:** Linear, Jira and Trello enabled; only Notion `Coming soon`; Trello picked | [png](trello-picker.png) · [webp](trello-picker.webp) · [light png](trello-picker-light.png) · [light webp](trello-picker-light.webp) · [phone png](trello-picker-phone.png) · [phone webp](trello-picker-phone.webp) · [phone light png](trello-picker-phone-light.png) · [phone light webp](trello-picker-phone-light.webp) | `trackers-trello.md` |
| 2 | **Connecting Trello, step 1:** the organization's app key, secret and name | [png](trello-connect-app.png) · [webp](trello-connect-app.webp) · [light png](trello-connect-app-light.png) · [light webp](trello-connect-app-light.webp) · [phone png](trello-connect-app-phone.png) · [phone webp](trello-connect-app-phone.webp) · [phone light png](trello-connect-app-phone-light.png) · [phone light webp](trello-connect-app-phone-light.webp) | `trello-connect.md` |
| 2 | **Step 2, the consent hand-off:** authorize the bot member on Trello, or paste a token | [png](trello-connect-consent.png) · [webp](trello-connect-consent.webp) · [light png](trello-connect-consent-light.png) · [light webp](trello-connect-consent-light.webp) · [phone png](trello-connect-consent-phone.png) · [phone webp](trello-connect-consent-phone.webp) · [phone light png](trello-connect-consent-phone-light.png) · [phone light webp](trello-connect-consent-phone-light.webp) | `trello-connect.md` |
| 2 | **Step 2, the token read back:** the bot member and every board it sees | [png](trello-connect-token.png) · [webp](trello-connect-token.webp) · [light png](trello-connect-token-light.png) · [light webp](trello-connect-token-light.webp) · [phone png](trello-connect-token-phone.png) · [phone webp](trello-connect-token-phone.webp) · [phone light png](trello-connect-token-phone-light.png) · [phone light webp](trello-connect-token-phone-light.webp) | `trello-connect.md` |
| 2 | **Step 2 with polling:** no public address, so `Events: polling` and `Finish` | [png](trello-connect-polling.png) · [webp](trello-connect-polling.webp) · [light png](trello-connect-polling-light.png) · [light webp](trello-connect-polling-light.webp) · [phone png](trello-connect-polling-phone.png) · [phone webp](trello-connect-polling-phone.webp) · [phone light png](trello-connect-polling-phone-light.png) · [phone light webp](trello-connect-polling-phone-light.webp) | `trello-connect.md` |
| 3 | **Acme Trello's settings:** connection, events and webhooks, the bot member, disconnect | [png](connection-trello.png) · [webp](connection-trello.webp) · [light png](connection-trello-light.png) · [light webp](connection-trello-light.webp) · [phone png](connection-trello-phone.png) · [phone webp](connection-trello-phone.webp) · [phone light png](connection-trello-phone-light.png) · [phone light webp](connection-trello-phone-light.webp) | `connection-trello.md` |
| 4 | **A project's Boards with Trello:** the board selected, its prefix, the steps and every list's category | [png](boards-trello.png) · [webp](boards-trello.webp) · [light png](boards-trello-light.png) · [light webp](boards-trello-light.webp) · [phone png](boards-trello-phone.png) · [phone webp](boards-trello-phone.webp) · [phone light png](boards-trello-phone-light.png) · [phone light webp](boards-trello-phone-light.webp) | `boards-trello.md` |
| 4 | **Attaching a Trello board:** the picker grouped by connection, the prefix beside Attach | [png](boards-attach-trello.png) · [webp](boards-attach-trello.webp) · [light png](boards-attach-trello-light.png) · [light webp](boards-attach-trello-light.webp) · [phone png](boards-attach-trello-phone.png) · [phone webp](boards-attach-trello-phone.webp) · [phone light png](boards-attach-trello-phone-light.png) · [phone light webp](boards-attach-trello-phone-light.webp) | `boards-trello.md` |
| 5 | **Ticket marks:** the Inbox, a task's header, the Ticket group, `On Trello`, What the agent got, the sidebar, search, New task, and the mark at each size | [png](ticket-chips-trello.png) · [webp](ticket-chips-trello.webp) · [light png](ticket-chips-trello-light.png) · [light webp](ticket-chips-trello-light.webp) · [phone png](ticket-chips-trello-phone.png) · [phone webp](ticket-chips-trello-phone.webp) · [phone light png](ticket-chips-trello-phone-light.png) · [phone light webp](ticket-chips-trello-phone-light.webp) | `ticket-chips-trello.md` |
| — | **States:** a bot member already connected, a refused token, polling, a revoked token, a paused board, a prefix already taken | [png](trello-states.png) · [webp](trello-states.webp) | `trello-connect.md`, `boards-trello.md` |

## Files

- **Build specs:** `trackers-trello.md`, `trello-connect.md`, `connection-trello.md`, `boards-trello.md`, `ticket-chips-trello.md`.
- **Pictures:** each desktop target a 2880×1912 `.png` and a 1440×956 `.webp`; each phone target 780×1688 and 390×844; the states sheet 1440×956. Every core screen is rendered dark and light at both viewports.
- **Sources** in `html/`: the six pages, `tl.css`, `tl.js`, `render.mjs`, `to-webp.py`.

## The marks

The marks are milestone 11's (`../m11-trackers/README.md`, "The marks"), unchanged: Trello's tile and its one-colour cut-out from `@atlaskit/logo` 23.3.3; Linear and Notion from Simple Icons 16.30.0; Jira from `@atlaskit/logo`. All are the vendors' trademarks, used only to name the integration, unaltered and never as ostra's mark.

**Where Trello's mark goes:** brand colour where it names the tracker once (a Trackers row, the picker, a connection's header, a board row, the attach picker, a task's header, its Ticket group, New task's line); the one-colour cut-out, in the key's own `--faint`, where it repeats (Inbox rows, the sidebar's live tasks, the thread's meta lines, search). Sizes: 20px in the Trackers list, 18px on a board row, 32px in the picker, 36px in a connection's header, 16px in the Ticket group, 14px in the Inbox and a header, 12–13px in meta lines.

## Rules

Milestone 11's rules hold (`../m11-trackers/README.md`), and for this set:

- **The words follow the capability.** Trello's statuses are lists and its tickets are cards in the copy that names them (`Lists on Calculations`, `It gets a card on`); a capability Trello doesn't declare is never drawn as a disabled control: no Agent mode, no sub-tasks, no mentions, no magic word, no transitions.
- **No amber.** The pages use red on the icon only; a failed connection opens the admins' needs-you item, which carries the amber.
- **One primary per page:** `Connect a tracker` on the list; the current step's button while connecting; none on a connected connection's page.
- **The prefix is visible on both surfaces:** the attach and the mapping. It is required for a Trello board and unique among the project's boards.
- **A list always takes a card,** so Trello's mapping has no unreachable status and no warning. What Linear and Jira draw as `by <transition>` becomes `writes <list> directly`.

## The choices to settle

Each has a recommendation; the pictures follow it.

| # | Choice | Recommended | The alternative |
|---|---|---|---|
| 1 | **Trello in the picker** | Enabled beside Linear and Jira; only Notion is `Coming soon` (spec §2, F-153) | Keep Trello disabled until its adapter ships |
| 2 | **The connect steps** | Two: the organization's app, then the bot member's token, with the consent page as the hand-off and a pasted token as the fallback (spec §4) | One step that asks for the key, secret and token together |
| 3 | **The consent page** | A primary `Authorize on Trello` and a `Paste a token instead` fallback; the panel reads the token from the URL fragment and never logs it | Only a pasted token |
| 4 | **A bot member's token** | No expiry date anywhere; the settings read `Healthy · never expires` (spec §5.1) | Show a "no expiry" warning as if it were unusual |
| 5 | **The app secret** | Lives with the connection and is replaceable in place; `Replace the app secret`, since deliveries fail until it's pasted at Trello | Rotate only from step 1 again |
| 6 | **The webhook** | One per attached board, registered by ostra; the settings show `1 on Calculations` and `Re-register webhooks`, never a per-board list until there are several | One webhook per connection |
| 7 | **The prefix** | Required at attach, shown at the attach line and in the mapping, 2–8 `[A-Z0-9]`, unique in the project | Derive it from the board's name |
| 8 | **The list mapping** | One category per list, and a list for Started, In review and Done; `Won't do` is `Cancelled` and maps to no step | Map only the three steps and leave every other list uncategorised |
| 9 | **`Done is moved by`** | A fixed `ostra`, with a line that Trello has no GitHub integration; no control to disable it | Offer the Jira-style `Trello automation` choice, which doesn't exist |
| 10 | **The words** | `Lists` and `Cards` wherever the copy names them (`Lists on Calculations`, `It gets a card on`); `ticket` stays the general word | Keep `status` and `ticket` everywhere as the other trackers do |
| 11 | **A disconnected connection's boards** | Paused, marked on Boards with `Trackers →`, resumed by connecting the same bot member; the disconnect dialog says the webhook and token go (spec §4) | Detach the boards |
| 12 | **The status categories' squares** | Reuse Jira's three category squares beside each list's category, since ostra's four categories are the same here | No squares; the category's word alone |

## What the build needs beyond the pictures

1. **Trello in the domain and the API:** the `trello` kind, `Trello` in `trackerKindNames`, the `TrackerConnection` arm with the bot member and no token date, and the capability map (`spec §5.4`, `§5.5`).
2. **The connect use cases and their routes:** `saveApp`, `authorizeUrl`, `checkToken`, `saveToken`, `replaceToken`, `replaceAppSecret`, `recheck`, `reregisterWebhooks`, `rename`, `disconnect`; the callback page reads `#token=` (`spec §5.4`).
3. **The board's settings:** `boards.attach({ keyPrefix })`, `boards.mapping({ statusCategories })`, and `boardRefOf` passing `keyPrefix` and `statusCategories` to every adapter call (`spec §5.2`, `§5.4`).
4. **The words and keys:** `trackers.trello.*`, `boards.trello.*`, and Trello's arm in every ticket payload (`spec §5.5`); this set's `.md` files list the copy.
5. **The marks:** milestone 11's `TrackerMark` already draws Trello; the only change is enabling its picker tile (`spec §5.5`).

## Open product decisions

1. **The prefix on a second board with the same initials.** The spec requires uniqueness in the project; these pictures don't settle whether the panel suggests `RT2` or makes the admin type another. Recommended: refuse with the message on `trello-states`, no suggestion.
2. **A token granted to a member ostra can't see in `/1/members/me/boards`.** The read-back would say `Sees 0 boards`; the spec refuses a token that sees no board only at save. Recommended: show the red line in step 2 and refuse the save, as Jira does for "sees no project".
3. **`Won't do` and a card that already sits there.** The spec maps it to `cancelled` and no step; a task whose card is there can still run. The task page should say `On Trello: TR-12 is in Won't do; ostra will move it to Done when the PR merges` — not drawn; the build spec leaves the sentence to ticket 07.
