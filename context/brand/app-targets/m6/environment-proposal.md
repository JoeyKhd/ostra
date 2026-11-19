# Target: the environment proposal (milestone 6, screen 12)

> **Committed image:** `environment-proposal.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Prompt:** `environment-proposal.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation, kept. References: the approved 2048 original of `app-targets/m3/environment-services` (the screen this one starts from, spec section 12), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route:** the environment page, `apps/web/src/app/(panel)/projects/[project-id]/environment/page.tsx` → `components/projects/environment-view.tsx`, with a third tab `?tab=proposal` in `components/projects/environment-proposal.tsx`. The tab shows only while a proposal is open, or was decided in the last 7 days (read-only then).
- **Features:** F-113 (the onboarding task). Spec section 4 ("The onboarding task"), section 11 item 19; ADR 0038 (amended for milestone 6: the onboarding task in practice), ADR 0011 (nothing acted on before it's saved). Ticket 21 (`startOnboarding`, `proposeEnvironment`, `decideEnvironmentProposal`), ticket 29 (`environments.startOnboarding`, `.proposal`, `.decideProposal`), ticket 36 (this screen).
- **Status:** a proposed target, waiting on approval (ticket 30's `## Comments`). Ticket 36 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

Milestone 1 drafts a project's environment from its repos' files; nobody knows it works until a task fails on it. **"Test this environment"** starts an onboarding task: an agent runs the setup script, the services and the checks on a box from the base image (no snapshot), fixes what fails, and hands in a **proposal**: the corrected setup, checks, variable names and services. Nothing changes until a project admin decides (ADR 0011): **Accept** saves it as the environment's next version, **Edit and accept** opens it in the editors first, **Reject** drops it.

The agent may also write an `AGENTS.md` where a repo has none, and that's the only file it may commit: the runner commits nothing else (`commitPaths`), so the onboarding task's one PR adds only `AGENTS.md`, and the page says what it left out.

The page must make the proposal **reviewable like a diff**: per repo, what would change against the current version, and why (the agent's notes). Values never appear: the proposal holds variable **names** only, and the secret scan has passed before it's shown.

The picture shows `calculator` after Alex Kim pressed "Test this environment": `CALC-190` ran on `build-01` and proposed version 5 (corepack in the setup, a `test` check, `DATABASE_URL`, a `db` service), and opened `AGENTS.md` PR #97 on `calculator-api`.

## Layout (CSS px at 1440×960)

The panel's measured scale (`../m1/README.md`, "Scale"): body 14.5px, dense rows 14px, secondary 13px, small labels 12px, lede 15px, title 26px, buttons 30px, rows 40px (diff rows 20px).

| Region | Size | Contents |
|---|---|---|
| Sidebar | 234px, the shared shell | Built from `sidebar.tsx`. The project's **Environment** row selected |
| Top bar | 46px | Crumbs `calculator › Environment`. Right: outline `Button` with Lucide `flask-conical`, `Test this environment` (below). On the Setup tab, milestone 1's `Save environment` sits after it as the primary; on this tab the primary is `Accept`, in the page |
| Main column | `1fr`, padding `28px 36px`, content max 780px | Eyebrow, title, lede, tabs, the task line, the proposal, the decision row |
| Properties panel | 320px (read-only here; the Setup tab keeps its 340px), 1px `--line` on its left, padding `20px 18px` | Proposal, AGENTS.md, Not committed |

### Heading

1. **Eyebrow,** Plex Mono 12px `--faint`: `Version {n} · saved {age}` (milestone 1's eyebrow grows the version, since the proposal is against one).
2. **Title** `Environment`, **lede** milestone 3's.
3. **Tabs:** `Setup`, `Services and checks`, `Proposal` (milestone 3's underline tabs). While a proposal is open, `Proposal` carries a 6px `--amber` dot after its word for project admins only (it's their needs-you, `environment_proposal`), and a plain `--faint` dot for other members.
4. **The proposal's banner on the other tabs** (`../m1/environment` growing): while a proposal is open, a 36px row under the tabs on `Setup` and `Services and checks`, Lucide `flask-conical` 15px `--muted`, 14px `--text` `The onboarding task proposed version {n+1}.` + teal `Review the proposal`. Project admins see the amber dot before it.

### The task line

One 36px row, 16px under the tabs, no box, 14px; the parts joined by ` · ` in `--faint`:

- Lucide `git-branch` 15px `--faint`, the task's key as a teal Plex Mono link to the task page, then its title `Test this environment` in `--text`.
- Its state, 13px `--muted`: `onboarding task · running {duration} on {runner}` (with a spinning `loader-circle` 13px), `onboarding task · done {age} on {runner}`, `onboarding task · stopped`, `onboarding task · failed`; the runner in Plex Mono.
- The `AGENTS.md` PR when there is one: teal `AGENTS.md PR #{n}` with `arrow-up-right` 12px (several repos: `AGENTS.md PRs #97, #41`).
- **While the task runs** (no proposal yet), the line is all the tab shows, with under it 13px `--muted`: `It runs the setup, the services and the checks on a clean box, fixes what fails, and proposes the result here. Nothing changes until you accept it.` and a teal `Watch it run`.

### The proposal

1. **Header,** 24px under the task line, a hairline above: `Proposed by the onboarding task` 15px weight 600 `--text`, then 13px `--faint` ` · against version {n}`.
2. **Notes,** 14px/1.6 `--muted`, max 680px, plain text, the agent's `notes` (never markdown). Over 6 lines: folded with a teal `Show all`.
3. **The diff, per repo,** in the project's repo order, then the environment-wide parts. Each repo's block, 24px apart, a hairline above each but the first:
   - **Repo heading,** 32px: the repo's `fullName` Plex Mono 14px weight 500 `--text`, then 13px `--faint` `{n} changes`. A repo with no change: the heading and `No changes` `--faint`, nothing under it.
   - **Parts,** each with a small label 12px weight 500 `--faint` and 8px under it its rows. Only parts that change are drawn:
     - **Setup script:** a code block (`--surface`, 1px `--line`, radius 7px, overflow hidden), the script's unified diff, 20px rows, Plex Mono 12.5px: a 20px `+`/`−` column, then the line; added rows `--add-bg` with a `--green` `+`, removed `--del-bg` with a `--red` `−`, context plain. More than 3 unchanged lines between changes fold to milestone 3's `{n} unchanged lines` row. A long script scrolls inside the block from 320px.
     - **Checks:** rows 36px, one per added, removed or changed check, in the block style above: the `+`/`−`/`~` column, the check's name Plex Mono 13px `--text`, its command Plex Mono 12.5px `--muted`, its timeout Plex Mono 12.5px `--faint` at the right. A changed check shows `~` in `--muted`, the old command struck in `--faint` above the new one. An order change: 12px `--faint` under the rows `The order changed: {names in the new order}.`
     - **Variable names:** rows 36px: the sign column, the name Plex Mono 13px `--text`, then 13px `--faint` `name only · set its value in Setup after you accept` (added) or `removed` (removed). Secrets the same, with Lucide `lock` 12px `--faint` before `name only`. **Never a value**: the proposal schema has none (ticket 21), and the scan refused any.
   - **Services**, after the repos, heading `Services` 14px weight 600 `--text` + 13px `--faint` ` for every repo` (services belong to the environment, not a repo, `../m3/environment-services.md`): rows 36px, the sign column, the name Plex Mono 13px `--text`, the image Plex Mono 12.5px `--faint`, the port Plex Mono 12.5px `--text`, the health check Plex Mono 12.5px `--muted`.
   - A row is one box per part (the code block, or the rows' block), never a box inside it.

### The decision row

A hairline above, 16px padding; buttons 30px, 8px apart:

- `Accept`, the page's one primary (Shell fill, Abyss text): `environments.decideProposal({ decision: "accept" })`. One transaction with the audit entry (ADR 0038): the environment becomes version `{n+1}`; a snapshot rebuild is queued as for any save; running tasks keep theirs.
- `Edit and accept` (outline): opens the proposal in the Setup and Services editors, the changed fields marked with a 2px `--teal` left rule and the eyebrow reading `Editing the proposal · not saved yet`; the top bar's primary becomes `Accept as version {n+1}` and a ghost `Cancel` returns here with nothing saved. The save is scanned (milestone 4's scan); a hit refuses it with milestone 4's refusal line (`memory-note.md`, "The secret refusal") and saves nothing.
- `Reject` (ghost, `--muted`, `--red` on hover): opens a `Popover` with an optional `Textarea` (`Why, for the audit log`) and `Reject proposal` (outline, `--red` text). The task isn't stopped by it; its `AGENTS.md` PR stays for the project to merge or close.
- At the row's right, 12px `--faint`: `Accepting saves version {n+1}. Running tasks keep theirs.`
- **Not a project admin:** no buttons; in their place 13px `--muted` `A project admin of calculator decides this proposal.`
- **The proposal is against an old version** (someone saved the environment since): the buttons stay, and a 13px `--text` line with Lucide `triangle-alert` 15px above them: `The environment changed since the onboarding task started. Accepting replaces version {m} with this proposal.` + teal `Compare with version {m}`. (Not red, not amber: a fact to weigh.)

### "Test this environment"

The top bar's outline button, on every tab, for project admins (hidden for others):

- **Enabled** when no onboarding task is open and no proposal is open: pressing it calls `environments.startOnboarding` and the page switches to `?tab=proposal` with the task line in its running form. While starting: `Starting…`, disabled.
- **Disabled** while an onboarding task is open or a proposal waits (the picture), with the `Tooltip` `A proposal is waiting for a decision.` or `CALC-190 is still testing this environment.`
- **Refused** by the API (the spend cap, no runner online that can start the services): 12px `--red` under the top bar's row in the page: `errorText(error)`.

### Properties panel

`PropGroup`/`PropRow` (120px key column, 30px rows, 14px), groups apart by hairlines:

1. **Proposal:** `State` · `Proposed` / `Accepted as version 5` / `Rejected` / `Superseded`; `Task` · teal Plex Mono key; `Against` · `Version {n}`; `Secret scan` · a 7px `--green` dot + `No values found` (a proposal that failed the scan is never stored, so this never shows a failure); `Proposed` · age.
2. **AGENTS.md:** one row per project repo (the key is the repo's short name, Plex Mono): `has one already` (`--muted`), teal `#97` + ` · open` / ` · merged` / ` · closed`, or `not written` (`--faint`, the agent chose not to).
3. **Not committed:** 13px `--muted` `The onboarding task commits only AGENTS.md. It left these out:`, then up to 10 paths, Plex Mono 13px `--muted`, one per 26px row; more: `and {n} more` `--faint`. From `commit.filtered` (spec 5.1; at most 50 paths kept per event). None: the group isn't drawn.

## States

| State | What shows |
|---|---|
| **A proposal waiting, viewer a project admin** (`environment-proposal.webp`) | As above |
| Onboarding task running | The tab with the task line in its running form and its explanation; the panel's Proposal group `State` · `Running`; `Test this environment` disabled |
| The task failed or stopped without a proposal | The task line `failed` / `stopped`, and 13px `--muted` `It ended without a proposal. Its thread says why.` + teal `Open CALC-190`; `Test this environment` enabled again |
| Nothing to change | The proposal header, the notes, and one 14px `--muted` line `The environment worked as it is. Nothing to change.`; the decision row offers one outline button, `Close`, which marks the proposal accepted without saving a new version (open point 1) |
| Accepted | The decision row becomes a 13px `--green` line with `check`: `Accepted by Alex Kim as version 5 · {age}.` + teal `Open Setup`; the diff stays read-only for 7 days |
| Rejected | `Rejected by Alex Kim · {age}` in `--muted`, with the reason under it in `--faint` |
| Superseded (a new test started) | `Superseded by CALC-196's proposal.` + teal link |
| Lost the race (another admin decided) | `role="alert"` 13px `--red`: `Dana Ortiz decided this first: accepted as version 5.`; the row hides |
| Loading | The tabs at once; the task line and three repo blocks as `Skeleton` |
| Error loading | `role="alert"` `--red` `errorText(error)` with teal `Retry` |
| Narrow / phone | The panel drops under the decision row; the code blocks scroll sideways inside themselves, never the page; the decision buttons stack full width with `Accept` first |

## Components (shadcn/ui names)

- **From the repo:** `PageFrame` (with `properties`), `PageHeading`, `PropGroup`, `PropRow`, `Button`, `Tooltip`, `Popover`, `Textarea`, `Skeleton`; milestone 3's `UnderlineTabs` and its `unchanged lines` row; milestone 1's Setup editors for `Edit and accept`.
- **New:** `components/projects/environment-proposal.tsx`, `proposal-repo-block.tsx`, `script-diff.tsx` (a line diff of two scripts, computed in `packages/domain` and shared with the API's response, not in the browser), `onboarding-task-line.tsx`.
- **Icons** (Lucide 15px, stroke 1.75): `flask-conical`, `git-branch`, `loader-circle`, `arrow-up-right`, `lock`, `check`, `triangle-alert`.

## Tokens

The measured tokens (`apps/web/src/app/globals.css`, as `review-screen.md`), plus milestone 3's `--add-bg` and `--del-bg`. Amber only on the sidebar's count and, for project admins, the `Proposal` tab's dot and the banner's dot. Red only for removed lines and the reject button's hover. Green for added lines and the secret scan's dot.

## Data this screen needs beyond ticket 29

- **`environments.proposal`** returns, per repo, the parts that changed, each already diffed by the server against the current version: the setup script's hunks, checks added / removed / changed with old and new values, variable names added / removed with `secret`, and the environment-wide services the same way; the notes; the task (key, title, state, runner, start and end); the `AGENTS.md` state per repo with the PR; the `commit.filtered` paths; `againstVersion` and the environment's current version.
- **`canDecide`** (project admin) and **`canStartOnboarding`** with the reason it can't.

## Differences from the current code

1. **The environment page has no tabs on `main`** if milestone 3's `environment-services` hasn't landed; the Proposal tab needs that tab row. Ticket 36 adds it if it's missing.
2. **Everything else is new:** `EnvironmentProposal`, the onboarding template, the `Test this environment` button, the tab, the banner, the needs-you row (`environment_proposal`) on Home and Needs you for project admins.
3. **Messages:** new keys under `environment.proposal.*` and `environment.onboarding.*`.

## Open points (recommendations; ticket 36 records the answer)

1. **A proposal with nothing to change.** Recommended: `Close` records the test as passed without a new version, so the environment's eyebrow can say `Tested {age}`.
2. **Edit and accept, then cancel.** Recommended: nothing is kept; the proposal stays open, unchanged.
3. **Who sees the Proposal tab.** Recommended: every member who can open the environment, read-only for non-admins, since the notes explain why tasks may have failed.

## Wrong in the image (build from this file)

- **The repo headings are drawn at about 22px.** Build Plex Mono 14px weight 500, and `Services` as 14px weight 600 sans: section headings, not titles.
- **`build-01` in the task line is sans.** Build Plex Mono.
- **The panel's group labels (`Proposal`, `AGENTS.md`, `Not committed`) are bold or white.** Build the small `--faint` labels; the repo keys in the AGENTS.md group in Plex Mono.
- **The variable and service rows** stretch their columns wider than the checks'. Build one grid for the three kinds of rows (sign, name, then the rest).
- **The `Proposal` tab has no dot.** Build the amber dot for project admins (Alex is one).
- **The sidebar** shows other milestones' rows and no Memory row. Build it from `sidebar.tsx`.
- **`Test this environment` disabled** reads as a lighter outline; build the `Button`'s disabled state (50% opacity) with its tooltip.

Right as drawn: the task line with its teal key and PR link, the notes in the agent's words, one diff block per part with green and red rows, names without values, `Services` apart from the repos, one primary `Accept`, an outline `Edit and accept` and a ghost `Reject`, and the panel's three groups.
