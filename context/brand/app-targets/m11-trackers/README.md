# Targets for Trackers and Jira

Design targets for a tracker-neutral organization page, **Trackers**, and for **Jira Cloud** beside Linear: several tracker connections per organization, of any kind, and a project's Boards attaching boards from any of them. They follow the maintainer's decisions of 2026-11-23:

- "Our UI looks like Linear is a section on its own." The tracker settings become neutral.
- Several connections per organization, of any kind, one per client, the way model keys work.
- The page is called **Trackers** and replaces Organization › Linear.
- Jira is built now: Jira Cloud only, a service account with a scoped API token, and an admin webhook signed with a shared secret (ADR 0047, `../../../research/trackers.md` §2).
- Trello and Notion show in the picker as **Coming soon** (the maintainer, 2026-11-23, for Notion; Trello by the same rule, see choice 1).
- Each tracker's real logo wherever a tracker shows (the maintainer, 2026-11-23: "show the logo of each one jira etc, that looks nicer").

**Status: approved 2026-11-23 by the maintainer** ("yes to all"). Every choice at the end is settled as recommended; see "Approval" below. Build from these targets, with `../../../specs/m11-trackers-jira/spec.md` and its tickets.

## How they're made

As milestone 10's gaps (`../m10-gaps/README.md`): real HTML on the panel's own CSS and fonts, not image-model pictures (`../../app-design.md`, rule 5).

- **Loaded, not copied:** each page in `html/` loads `../../m8/html/m8.css` (the panel's tokens for both themes, IBM Plex Sans and Mono and Manrope from `apps/web/src/fonts/`, the shell), `../../m10-gaps/html/gaps.css` (select, menu, dialog, board rows, mapping rows, copy fields) and `../../m8/html/shell.js` (the double sidebar). The organization panel's `Linear` row is drawn as `Trackers` by `tr.js`. Icons are Lucide 0.460.
- **This set's parts:** `html/tr.css` (the new parts, tokens only) and `html/tr.js` (the parts as HTML, the marks and the demo data). Pages: `trackers.html`, `connection.html`, `boards.html`, `home.html`, `chips.html`, `states.html`, `phone.html`.
- **Built on the live pages:** `components/linear/linear-view.tsx` and `linear-panel.tsx` (the Linear connection's content, re-homed), `components/boards/boards-view.tsx` and `prompt-tickets.tsx`, `components/home/setup-steps.tsx`, `components/inbox/inbox-view.tsx`, and `apps/web/messages/en.json`'s `linear.*`, `agentMode.*` and `checklist.*` copy, read on 2026-11-23. The panel itself wasn't run.
- **The render:** Playwright's Chromium (`playwright@1.65.1` from the repo's `node_modules`) at each target's viewport and 2×, to `<name>.png`; `html/to-webp.py` writes `<name>.webp` at one image pixel per CSS pixel. Every desktop target renders dark and `-light`.

  ```
  node html/render.mjs <path to playwright/index.mjs> [name ...]
  python -I html/to-webp.py [name ...]
  ```

- **No Higgsfield credits were used.**
- **All data is demo data:** Acme Corp and its clients Globex and Northwind; the connections Acme Linear (`acme`), Globex Jira (`globex.atlassian.net`), Acme Ops Jira and Northwind Linear; `calculator`, `globex-shop`; `CALC-…`, `PROJ-…`, `SHOP`, `OPS`; Alex Kim; the service account `ostra-bot`.

## The marks

Every place a tracker shows carries its kind's mark: the Trackers list, the picker, a connection's header, the Boards rows and the attach picker, and the ticket chips. The panel draws them as inline SVG, as it already draws GitHub's mark (`components/github/github-mark.tsx`); they aren't fetched at run time like models.dev's model logos, since there are four and they're fixed.

| Mark | File in `html/logos/` | From | Brand colour | One-colour version |
|---|---|---|---|---|
| Linear | `linear.svg` | Simple Icons 16.30.0 (`simple-icons` on npm), which takes it from linear.app | `#5E6AD2` (Simple Icons' value) | the same path in `currentColor` |
| Jira | `jira.svg`, `jira-mono.svg` | Atlassian's own, `@atlaskit/logo` 23.3.3 (Apache-2.0), `jira/icon`: the 2024 tile | tile `#1868DB`, glyph white | Atlassian's "custom theme" cut-out, `currentColor` |
| Trello | `trello.svg`, `trello-mono.svg` | `@atlaskit/logo` 23.3.3, `trello/icon` | tile `#1558BC`, glyph white | Atlassian's cut-out, `currentColor` |
| Notion | `notion.svg` | Simple Icons 16.30.0, from notion.so | black on light, so `--text` in either theme | `currentColor` |

**Usage terms.** The marks are the vendors' trademarks. Simple Icons' SVG data is CC0, but its disclaimer says the marks stay their owners' and their guidelines apply (`github.com/simple-icons/simple-icons/blob/develop/DISCLAIMER.md`); `@atlaskit/logo`'s code is Apache-2.0, and the Atlassian marks stay Atlassian's. ostra uses each one only to name the integration (nominative use): unaltered, in the vendor's own colours or its own one-colour version, never as ostra's mark, and never implying endorsement. Before the build ships them, check each vendor's guidelines: Linear's at `linear.app/brand`, Atlassian's (Jira and Trello) at `atlassian.design/foundations/logos/`, Notion's at `notion.so/brand` (that page refuses automated reads, so its terms are **unverified** here). The build copies the files into `apps/web/public/tracker-logos/` or a `TrackerMark` component, with this table's sources in a comment. No new package: the files are copied, not installed.

**Where each treatment goes** (choice 9): the brand colour where the mark names a tracker once (a Trackers row, the picker, a connection's header, a board row, the attach picker, a task's header, its Ticket group, New task's line); the one-colour version, in the key's own `--faint`, where it repeats down a list or sits in running text (Inbox rows, the sidebar's live tasks, the thread's meta lines, search). Sizes: 20px in the Trackers list, 18px on a board row, 32px in the picker, 36px in a connection's header, 14–16px in panels and chips, 12–13px in meta lines.

## Screens

| # | Screen | Targets | Build spec |
|---|---|---|---|
| 1 | **Organization › Trackers:** four connections (two Linear, two Jira; connected, pending, failed), Globex Jira selected and its detail in the panel | `trackers`, `trackers-light` | `trackers.md` |
| 1 | **Connect a tracker:** the picker, Linear and Jira to pick, Trello and Notion "Coming soon", Jira picked | `trackers-picker`, `trackers-picker-light` | `trackers.md` |
| 1 | **No connection yet:** the kinds on the page itself | `trackers-empty`, `trackers-empty-light` | `trackers.md` |
| 1 | Every row status, Disconnect, Home's step by state, a member, a site already connected | `trackers-states` | `trackers.md` |
| 1 | The list on a phone | `trackers-phone` | `trackers.md` |
| 2 | **Connecting Jira, step 2:** the service account's scoped token, its scopes, and what ostra read back | `jira-connect`, `jira-connect-light` | `jira-connect.md` |
| 2 | **Step 3:** the admin webhook's URL, secret, events and optional JQL, waiting for the first delivery | `jira-connect-webhook`, `jira-connect-webhook-light` | `jira-connect.md` |
| 2 | **No public address:** step 3 becomes polling, with the line about the delay | `jira-connect-polling`, `jira-connect-polling-light` | `jira-connect.md` |
| 2 | Each step's failure: no site, a refused token, a partial read-back, a wrong signature; connected; token near its date; Rotate | `jira-connect-states` | `jira-connect.md` |
| 2 | Step 3 on a phone | `jira-connect-phone` | `jira-connect.md` |
| 3 | **Globex Jira's settings:** site, service account, webhook, re-check, rotate, disconnect | `connection-jira`, `connection-jira-light` | `connection-settings.md` |
| 3 | **Acme Linear's settings:** today's Linear page re-homed, with Agent mode as a Linear-only section | `connection-linear`, `connection-linear-light` | `connection-settings.md` |
| 4 | **A project's Boards with a Linear team and a Jira project,** the Jira board selected: its mapping by transitions, the warning, Done moved by ostra | `boards-mixed`, `boards-mixed-light` | `boards-mixed.md` |
| 4 | **Attaching a Jira project:** the attach picker grouped by connection, the Linear board selected | `boards-attach`, `boards-attach-light` | `boards-mixed.md` |
| 4 | A disconnected connection's board, the target-status picker, Done by Jira automation, prompt tasks on a Jira board | `boards-states` | `boards-mixed.md` |
| 4 | Boards on a phone | `boards-phone` | `boards-mixed.md` |
| 5 | **Home's checklist:** step 4 is "Connect a tracker", Linear or Jira, skippable | `setup-checklist`, `setup-checklist-light` | `setup-checklist.md` |
| 6 | **Ticket chips:** the Inbox, a task's header, its Ticket group, What the agent got, the sidebar, search, New task, and the alternative not taken | `ticket-chips`, `ticket-chips-light` | `ticket-chips.md` |

## Files

- **Build specs:** `trackers.md`, `jira-connect.md`, `connection-settings.md`, `boards-mixed.md`, `setup-checklist.md`, `ticket-chips.md`.
- **Pictures:** each desktop target a 2880×1912 `.png` and a 1440×956 `.webp`; the phone targets 780×1688 and 390×844.
- **Sources** in `html/`: the seven pages, `tr.css`, `tr.js`, `render.mjs`, `to-webp.py`, and `logos/`.

## Rules

The earlier milestones' rules hold (`../m1/README.md` to `../m10-gaps/README.md`): the build spec wins on copy, states and behaviour; the picture wins on size, spacing and contrast, and here a picture is HTML, so its sizes are exact CSS px; real data only in the build; check each screen by eye against its picture at its viewport after the build. And for this set:

- **Adapter parity is visible.** A capability shows only where the connection's adapter declares it (`TrackerAdapter`'s capabilities): agent mode and magic words on Linear; workflow transitions and the JQL filter on Jira; sub-issues and sub-tasks on both, each under its own word. A missing capability is not drawn as a disabled control.
- **No amber.** None of these waits on a person the way "needs you" means. A failed connection or a token near its date opens a needs-you item for the organization's admins, as Linear's does today; the item carries the amber, and these pages use red on the icon only.
- **The marks are the only new colours,** inside the marks themselves, plus Jira's three status-category colours (grey, blue, green squares) beside a Jira status's name, which is how Jira itself tells its categories apart. Every mark and square has its words beside it (`../../app-design.md`, rule 4).
- **One primary per page.** Connect a tracker on the list; the current step's button while connecting; none on a connected connection's page.

## The choices to settle

Each has a recommendation; the pictures follow it. **All fifteen are settled as recommended** (the maintainer, 2026-11-23, "yes to all").

| # | Choice | Recommended | The alternative |
|---|---|---|---|
| 1 | **Trello and Notion in the picker** | **Settled by the maintainer (2026-11-23):** shown with their real logos, disabled, with one quiet `Coming soon` chip: no link, no form, no marketing line. The maintainer asked it for Notion; Trello is added by the same rule, since `../../../research/trello-and-notion.md` puts Trello next after Jira and Notion later | Not shown until an adapter ships |
| 2 | **A connection's name** | Yes: the admin types one in step 1, prefilled from the kind and the workspace or site (`Globex Jira`), renamable from the connection's header. Boards, tickets' panels and the attach picker show it, so two connections of one kind stay apart | No name: the site or workspace is the label |
| 3 | **One site or workspace, one connection** | A second connection to the same Jira site or Linear workspace is refused, naming the existing one (`trackers-states`) | Allow duplicates, e.g. two service accounts with different reach |
| 4 | **Polling-only Jira** | Allowed, as Linear's polling: with no public address step 3 becomes `Events: polling` (every 60 s, a change up to a minute late), and `Finish` connects it | Refuse Jira without a public address |
| 5 | **The scoped token's scopes** | Four: `read:jira-work`, `write:jira-work`, `read:jira-user`, and `read:workflow:jira` for the mapping's transition check. A token without the fourth saves with a warning; the mapping then can't warn. The adapter's spec fixes the exact list (S-12, whether the workflow graph is readable with service-account scopes, is still open) | Three, no workflow read: the mapping learns transitions only per ticket |
| 6 | **The token's expiry** | Asked for in step 2 (Atlassian shows it when the token is made; the API doesn't give it back). The page warns 14 days before, and the connection fails on the day | Not asked: the connection fails when Jira first refuses the token |
| 7 | **Jira's status mapping** | Per ostra step, the admin picks a **target status**; ostra moves a ticket by whatever transition reaches it from where it stands, and shows which (`by Start progress, from To Do or Backlog`). A status with no way there gets a red-icon warning naming it; a ticket there stays put and ostra says so in its comment | Pick a **transition** per step: exact, but a transition belongs to its from-status, so one step needs several picks |
| 8 | **Done is moved by**, for Jira | **ostra**, by default: Jira's GitHub integration links the PR but moves nothing without a Jira automation rule, which ostra can't see. `Jira automation` stays a choice, with a line saying so | Jira by default, as Linear's integration is |
| 9 | **The marks' treatment** | Brand colour where a mark names a tracker once; one colour, in the key's colour, where it repeats (Inbox rows, sidebar, thread meta, search). The chips board shows the alternative beside it | Brand colour everywhere, Inbox rows included |
| 10 | **Inbox rows' mark** | Always shown before the key, so a mixed Inbox reads at a glance and the position never shifts | Only when the project's boards span more than one kind, as the Board column shows only with several boards |
| 11 | **Agent mode, Linear only** | A section on the Linear connection's page, titled `Agent mode` with a faint `Linear only`; a Linear board's panel shows `Agent mode · Takes delegations`. A Jira connection's panel lists `Agent mode – not in Jira` among what Jira does here, and nothing else mentions it | A disabled Agent mode section on Jira's page |
| 12 | **Disconnecting** | The connection's boards stay attached but **paused**: read-only, nothing moves, marked on Boards with a link to Trackers. Connecting the same site or workspace again resumes them. The dialog says so, and that ostra can't delete Jira's admin webhook | Detach every board on disconnect |
| 13 | **Where a connection's detail lives** | The list's properties panel holds the detail (status, mode, last event, sign-in, token, boards, what the tracker does); `Open Globex Jira →` goes to its page, `/organization/trackers/<id>`, for the steps while pending and the settings once connected. `/organization/linear` redirects to the first Linear connection's page | Everything in the panel, no page |
| 14 | **The setup step's button** | `Connect a tracker →` goes to Trackers, whose empty state is the picker on the page; the step's body names Linear and Jira with their marks. Pending, failed, done and skipped name the connection | Two buttons, `Linear` and `Jira`, in the row |
| 15 | **The webhook secret** | ostra makes it and shows it until the first delivery arrives; then only `Rotate the secret`, with a confirm, since deliveries fail until it's pasted in Jira | Shown once, as GitHub's |

## What the build needs beyond the pictures

1. **Several connections per organization:** the schema's `Connection` (kind, state, webhook mode, workspace fields) gains a `name` and a `jira` kind with its site and cloud ID, nullable columns first; `Board` already keys to a connection. The live Linear page and its procedures (`linear.status` and the rest) assume one Linear connection per organization, and become per connection.
2. **Jira's adapter** (F-008): the service account's sign-in through `api.atlassian.com/ex/jira/{cloudId}`, the read-back (`/myself`, project search, `/mypermissions`, workflow search), the admin webhook's HMAC check and dedupe, transitions, ADF, sub-tasks, remote links; the contract suite on the Jira fake already covers much (ADR 0047, m2 ticket 03, m6 ticket 02).
3. **The routes:** `/organization/trackers`, `/organization/trackers/<id>`, the redirect from `/organization/linear`; the setup checklist's `linear` step becomes `tracker` (copy keys `checklist.tracker.*`).
4. **Copy:** `linear.*` keys move under `trackers.*`, with `trackers.jira.*` for Jira's steps and settings; this set's `.md` files list them.
5. **The marks:** `TrackerMark({ kind, size, mono })` with the four marks from `html/logos/`, sources in a comment (see "The marks").

## Approval

**Approved 2026-11-23.** The maintainer, shown every picture and the fifteen choices with their recommendations, answered "yes to all". So:

- **Every choice above is settled as recommended,** and the pictures, the six build specs and `html/` are the build's contract on copy, states and sizes.
- **"What the build needs beyond the pictures" is the build's contract too:** milestone 11's spec (`../../../specs/m11-trackers-jira/spec.md`) turns each item into a ticket's "Done when", ADR 0071 records the data model (several connections per organization, paused boards, one connection per site), and the ledger's F-008 and F-152 hold the tested conditions.
- **Choice 5's scopes wait on S-12** (whether a service account's scoped token reads the workflow graph): the Jira adapter's read-back ticket fixes the list against the maintainer's test site, and a token without the workflow scope saves with the warning the targets draw.
- **The marks' usage terms** are checked against each vendor's guidelines before the build ships them (the web ticket for the marks, and the maintainer's ticket for Notion's page, which refuses automated reads).
