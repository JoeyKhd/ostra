# Targets for four ledger gaps

Design targets for the visible part of four features whose API and domain are built, or, for the environment, whose option the lead recommends. Each keeps an approved target's layout and adds only the new part.

**Status: a proposal, 2026-11-22.** Nothing is built from these until the maintainer approves them. The choices to settle are at the end, each with its recommendation; the pictures follow the recommendations.

| # | Gap | Feature | Builds on |
|---|---|---|---|
| 1 | A project's "Make a ticket for every prompt task" | F-097/c2 (Q31) | `../m2/project-boards`, `../m9/new-task-attachments` |
| 2 | Organization › Spend: Keys | F-135/c13, ADR 0055 "Spend per key" | `../m4/spend-budgets`, `../m4/models-keys` |
| 3 | Organization › GitHub: turning on events later | F-006/c4, ADR 0040 (note of 2026-11-22) | `../m4/github-organizations`, `../m1/github` |
| 4 | Environment: a new repo's draft beside the saved setup | F-112/c1, Q345 option (b) | `../m1/environment`, `../m8/environment-app-processes`, `../m6/environment-proposal` |

## How they're made

As milestone 9's and milestone 10's (`../m9/README.md`, `../m10-thread/README.md`): real HTML on the panel's own CSS and fonts, not image-model pictures (`../../app-design.md`, rule 5).

- **Loaded, not copied:** each page in `html/` loads `../../m8/html/m8.css` (the panel's tokens for both themes, IBM Plex Sans and Mono and Manrope from `apps/web/src/fonts/`, the shell's styles) and `../../m8/html/shell.js` (the double sidebar). New task also loads `../../m9/html/m9.css` and `m9.js`, being milestone 9's page. Icons are Lucide 0.460; the model and key logos are models.dev's, fetched at render time as the panel's `/model-logos/` serves them.
- **This set's parts:** `html/gaps.css` (every new part, tokens only, no new colour) and `html/gaps.js` (the parts as HTML and the demo data). Pages: `boards.html`, `new-task.html`, `spend.html`, `github.html`, `environment.html`, `states.html` (a board of states per gap), `phone.html`.
- **Built on the live pages,** not only the older targets: each page follows what the components on `main` draw today (`boards-view.tsx`, `new-task-view.tsx`, `spend-view.tsx`, `github-orgs.tsx`, `environment-view.tsx`, read on 2026-11-22; the panel itself wasn't run), in milestone 8's shell, so what differs from the running panel should be only the new parts.
- **The render:** Playwright's Chromium (`playwright@1.65.1` from the repo's `node_modules`) at each target's viewport and 2×, to `<name>.png`; `html/to-webp.py` writes `<name>.webp` at one image pixel per CSS pixel:

  ```
  node html/render.mjs <path to playwright/index.mjs> [name ...]
  python -I html/to-webp.py [name ...]
  ```

- **No Higgsfield credits were used.**
- **All data is demo data:** Acme Corp, `calculator` and its sibling projects, `CALC-…`, Alex Kim, the keys and Apps of milestone 4's targets (`acme-anthropic`, `northwind-anthropic`, `globex-openrouter`, `spare-openai`, `ostra-acme`, `northwind-ostra`), the repos and the numbers.

## Screens

| Gap | Targets | Build spec |
|---|---|---|
| 1. The Boards page with **Prompt tasks** between Attached and Status mapping: on, two boards, the board picker; dark and light | `prompt-tickets`, `prompt-tickets-light` | `prompt-tickets.md` |
| 1. The setting's states: one board off and on, several (picking), none attached, a member's, Linear's connection inactive, a failed save, the Detach dialog | `prompt-tickets-states` | `prompt-tickets.md` |
| 1. New task in that project: the `It gets a ticket on Calculator` line and the panel's `Ticket` row | `prompt-tickets-new-task` | `prompt-tickets.md` |
| 1. Boards on a phone | `prompt-tickets-phone` | `prompt-tickets.md` |
| 2. Spend with **Keys** between Projects and Models, a key selected and its month in the panel; dark and light | `spend-keys`, `spend-keys-light` | `spend-keys.md` |
| 2. Keys' states: loading, nothing spent yet, a past month with a removed key, below 1100px, a key with unpriced tokens, nothing selected | `spend-keys-states` | `spend-keys.md` |
| 2. Keys on a phone | `spend-keys-phone` | `spend-keys.md` |
| 3. GitHub with an App made without a webhook: `Events off`, the note, the panel's **Events** row with `Turn on →` | `github-events` | `github-events.md` |
| 3. Turn on's result, shown once: the webhook URL and secret, the ten events, the links to General and Permissions; dark and light | `github-events-turn-on`, `github-events-turn-on-light` | `github-events.md` |
| 3. The Events row in each state, the section line's words, New webhook secret's result, its confirm and the leave-without-copying dialog | `github-events-states` | `github-events.md` |
| 3. Turn on's result on a phone, as a bottom sheet | `github-events-phone` | `github-events.md` |
| 4. Environment's Setup tab with a new repo's draft: the band, what detection found, the diff Apply makes, Apply, Edit first, Dismiss; dark and light | `environment-repo-draft`, `environment-repo-draft-light` | `environment-repo-draft.md` |
| 4. After Edit first: the lines in the editor, marked, unsaved | `environment-repo-draft-edit` | `environment-repo-draft.md` |
| 4. The draft's states: a plain saved script, nothing found, a member's, two new repos, dismissed, applied, the new repo's marked rows | `environment-repo-draft-states` | `environment-repo-draft.md` |
| 4. The draft on a phone | `environment-repo-draft-phone` | `environment-repo-draft.md` |

## Files

- **Build specs:** `prompt-tickets.md`, `spend-keys.md`, `github-events.md`, `environment-repo-draft.md`.
- **Pictures:** each desktop target a 2880×1912 `.png` and a 1440×956 `.webp`; the phone targets 780×1688 and 390×844.
- **Sources** in `html/`: `boards.html`, `new-task.html`, `spend.html`, `github.html`, `environment.html`, `states.html`, `phone.html`, `gaps.css`, `gaps.js`, `render.mjs`, `to-webp.py`.

## Rules

The earlier milestones' rules hold (`../m1/README.md` to `../m10-thread/README.md`): the build spec wins on copy, states and behaviour; the picture wins on size, spacing and contrast, and here a picture is HTML, so its sizes are exact CSS px; real data only in the build; check each screen by eye against its picture at its viewport after the build. And for this set:

- **Only the new part changes.** Each page is the approved one as `apps/web` draws it; nothing else on it is restyled here.
- **No amber on any of the four.** None waits on a person the way "needs you" means: a setting, a figure, an admin's own settings on GitHub, and a draft beside a setup that keeps working.
- **Settings apply where they're shown.** The prompt-tickets switch saves at once, as the Boards page's other switch does; nothing here adds a second primary button to a page.

## The choices to settle

Each with the recommendation the pictures follow.

| # | Gap | Choice | Recommended | The alternative |
|---|---|---|---|---|
| 1 | 1 | Where the setting lives | The Boards page, a **Prompt tasks** section between Attached and Status mapping: it names one of the boards just above it, and members can read the page | Settings › Ticket template, which only admins see |
| 2 | 1 | How it saves | At once, from the switch and the picker, as `Start from Linear` does; `Save mapping` stays the mapping's | Held until `Save mapping` |
| 3 | 1 | The board turning it on picks, with several | The board selected on the page, else the first attached | Always the first attached, or ask with the picker open |
| 4 | 1 | New task says so | One `What happens next` line and a `Ticket` row in the panel, for Code tasks only | Nothing on New task |
| 5 | 1 | Linear's connection down | Show `On, but … until it is` with `Reconnect Linear →`: `boards.get` adds each board's `ticketsForPromptTasks` (the row has it) | Show Off while `promptTicketBoardId` is null |
| 6 | 2 | Where Keys sits | Between Projects and Models: money by client project, by client key, then by model, and on the first screen at 1440×956 | After Models |
| 7 | 2 | What a row opens | Selects the key in Spend's panel (its month, its models, the projects on it, budgets stay per project) with `The key on Models →` | Goes to Models › that key |
| 8 | 2 | Every key at $0.00 | `spend.month` lists every provider, zero-filled (removed ones in a past month they spent in) | The page merges `providers.list` |
| 9 | 2 | The host on a row | Gives way first, as on Models: logo and name on the row, the host in the tooltip and the panel; shown from 1600px wide | Always shown, cut with `…` |
| 10 | 3 | The section line for an App with no webhook | `Events off` | Today's `No events yet` |
| 11 | 3 | A note under the App in the main column | Yes, with `Turn them on →`, while its events are off | Only the panel's row |
| 12 | 3 | Turn on's result | In the App's panel (380px), two numbered steps by GitHub page, each event on its own row, shown once with the leave dialog | One block of text to copy |
| 13 | 3 | No public address | No button; the row names `OSTRA_CORE_PUBLIC_URL` | A disabled `Turn on` |
| 14 | 3 | A lost secret | `New webhook secret` on the On and Waiting rows (milestone 4's settled name), asking first because deliveries fail until it's pasted | No confirm |
| 15 | 4 | Q345 | (b): the saved environment keeps running; the new repo's draft waits for review | (a): the environment goes back to Draft with the new repo merged in |
| 16 | 4 | Where the draft shows | On the Setup tab, a band above the setup script, as the App tab's `Found in the repo, not added`; the other tabs carry a one-line pointer | The Proposal tab, as a proposal from detection |
| 17 | 4 | What Apply does | Saves at once (scanned, audited, a new version; the snapshot rebuilds); `Edit first` is the unsaved path | Apply only fills the editors |
| 18 | 4 | A plain saved script | Apply makes it a `case`: the old script under the repos that had it, the new lines under the new repo | Append the new lines to the plain script, for every repo |
| 19 | 4 | Needs-you | None, no amber: the setup keeps working, the admin who added the repo is told on Settings › Repos, members see the band | An amber dot and a needs-you row for project admins, as an onboarding proposal |
| 20 | 4 | Services found in the new repo | Listed in the panel with `Add it on Services and checks`; Apply adds only setup lines, variables and secrets | Apply adds them too |

## What the build needs beyond the pictures

1. **Prompt tickets:** `boards.get` returns each board's `ticketsForPromptTasks` (choice 5); `boards.promptTickets.*` and New task's two strings in `apps/web/messages/en.json`.
2. **Keys:** `spend.month`'s `byProvider` zero-filled (choice 8); the panel reads `providers.list` for host, format, tasks and projects; `KeyLogo` shared from `components/models/keys-sections.tsx`.
3. **GitHub:** nothing new in the API; `github-orgs.tsx`'s `WebhookState` reads `none` as `Events off` and a missing event as `Waiting for events`; the App panel gains the Events row and the result.
4. **Environment:** Q345 settled; the `EnvironmentRepoDraft` row, detection on `projects.addRepo` for a saved environment, and `environments.get`'s `repoDrafts`, `applyRepoDraft`, `dismissRepoDraft` (`environment-repo-draft.md`, "Data"). Until then, F-112/c1 stays unproved for a saved environment.
