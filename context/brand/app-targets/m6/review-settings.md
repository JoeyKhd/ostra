# Target: a project's Review settings (milestone 6, screen 11)

> **Committed image:** `review-settings.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Prompt:** `review-settings.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation, kept. References: the approved 2048 original of `app-targets/m4/project-repos` (milestone 2's `repo-checks`, which spec section 12 names as the start, grown and moved under Settings, so it's the closest approved picture of a Settings tab), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route (new):** `apps/web/src/app/(panel)/projects/[project-id]/settings/review/page.tsx` → `components/projects/review-settings-view.tsx`. One of the project's settings tabs (`../m4/project-repos.md`, "Settings tabs"): `Ticket template`, `Repos`, `Access`, `Review`, `Audit log`.
- **Features:** F-100 (the AI review, its switch and profile), F-101 (the round limits), F-040 (outside tasks wait for approval), with F-035's CI verdict shown per repo. Spec section 4, section 5.4 ("Settings": `OSTRA_CI_ROUNDS`, `OSTRA_REVIEW_ROUNDS`, `OSTRA_AUTOMATIC_TURNS`), section 11 items 9, 13 and 15; ADR 0041, ADR 0057, ADR 0058. Ticket 28 (`projects.reviewSettings`, `projects.setAiReview`), ticket 26 or 27's `setOutsideApproval` (the outside-task switch), ticket 35 (this screen).
- **Status:** a proposed target, waiting on approval (ticket 30's `## Comments`). Ticket 35 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

One page that says what happens to a task's pull request in this project, and lets a project admin change the one thing a project owns: **whether the AI reviews it**. Everything else on the page is shown so nobody has to guess:

- which profiles the review and refine tasks run on (the built-in ones by default, F-099/F-100);
- the round limits, which the install sets in v1 and a project can't change (spec section 5.4: "a project's Review settings show them and change only the AI review switch");
- whether tasks started in Linear by non-members wait for approval, a switch only an organization admin may turn off (ADR 0057, spec item 9);
- each repo's CI as ostra last saw it, so a project admin sees at once that a repo has no CI (and so no CI rounds) before wondering why the loop skipped it.

The picture shows `calculator` to Alex Kim, a project admin who isn't an organization admin: AI review on, the built-in profiles, the install's default limits, outside approval on and locked, and three repos (one passing, one with no CI, one failing).

## Layout (CSS px at 1440×960)

The panel's measured scale (`../m1/README.md`, "Scale"): body 14.5px, dense rows 14px, secondary 13px, small labels 12px, lede 15px, title 26px, inputs 34px, rows 40px.

| Region | Size | Contents |
|---|---|---|
| Sidebar | 234px, the shared shell | Built from `sidebar.tsx`. The project's **Settings** row selected |
| Top bar | 46px | Crumbs `calculator › Settings › Review` (`Review` `--text` 500). Nothing on the right: each control saves on its own, so there's no Save button and no primary on the page |
| Main column | `1fr`, padding `28px 36px`, content `max-width: 760px` | Settings tabs, title, lede, five sections |
| Properties panel | 320px, 1px `--line` on its left, padding `20px 18px` | How a pull request goes; This project |

### Main column, top to bottom

1. **Settings tabs,** milestone 4's (`project-repos.md`), with `Review` added after `Access`. Who sees it: every member who can open the project (it's read-only to them, below).
2. **Title** `Review` (`PageHeading`), then the **lede**, 15px `--muted`: `What happens after a task's pull request opens: CI, an AI review, and how often ostra sends problems back to the agent by itself.`
3. **Sections.** No boxes: each section has a 1px `--line` hairline above it and 20px padding top and bottom. A section title is 15px weight 600 `--text`; its description 13px `--muted`, max 600px.

#### AI review

- Left: the title `AI review`, under it `After CI passes, a read-only agent reviews each pull request and posts its findings on GitHub as comments. It never approves.`
- Right, aligned with the title: a `Switch` (36×20, on: `--shell` track and `--ink` knob; off: `--line-2` track, `--muted` knob), `aria-label="AI review"`. It saves at once (`projects.setAiReview`), with an optimistic state; while saving it's disabled; a failure flips it back and shows 12px `--red` under the description: `errorText(error)`.
- **Turning it off** asks nothing, but says under the description, 12px `--faint`, for 6 s: `Off. Open pull requests go straight to their reviewers after CI. A review already running finishes.` Turning it on: `On. The next push on an open pull request gets a review.`
- **Not a project admin:** the switch is disabled, with the `Tooltip` `A project admin of calculator can change this.`

#### Profiles

- Title `Profiles`. Two 40px rows, a 1px `--line` between them, the key 14px `--muted` in a 360px column, the value a 34px `Select` (`--surface`, 1px `--line-2`, radius 7px) holding the profile's name, then a 20px outline chip `built-in` (Plex Mono 11px `--muted`) for the built-in ones, then `chevron-down`:
  - `Review` · the project's default profile for the review kind
  - `Refine` · the project's default profile for the refine kind
- The `Select` lists the organization's profiles of that kind (milestone 3's agent profiles, the built-in one first). Choosing one saves at once (milestone 3's project default profile per kind, Q28).
- Under the rows, 12px `--faint`: `Both are read-only: they fetch the code and never push.` (ADR 0031, F-099/F-100; a refine or review profile can't be given push.)
- Each profile's name links to its editor (`../m3/agent-profile`) on hover, teal.

#### Rounds

- Title `Rounds`, then Lucide `lock` 13px `--faint` and 12px `--faint` `set by the install`.
- Three 40px rows, hairlines between: the key 14px `--muted`, the value Plex Mono 14px `--text` at x 360, the setting's name Plex Mono 12px `--faint` at x 600:
  - `CI rounds` · `2` · `OSTRA_CI_ROUNDS`
  - `Review rounds` · `2` · `OSTRA_REVIEW_ROUNDS`
  - `Automatic turns` · `4` · `OSTRA_AUTOMATIC_TURNS`
- Under them, 12px `--faint`: `Counted since a person last acted on the task. At a limit, the driver decides.` and, for an instance admin only, a teal `Where to change them` linking to `docs/configuration.md`'s section on the hosted docs.
- When the project's AI review is off, `Review rounds` shows `2` in `--faint` and `not used while AI review is off` 12px `--faint` in place of the setting's name.

#### Outside tasks need approval

- Left: title `Outside tasks need approval`, under it `A task someone starts in Linear who isn't a member of calculator waits until a member approves it.`
- Right: a `Switch`, on by default (`Project.outsideApproval`).
- **Only an organization admin** can turn it off (spec item 9, ADR 0057). For everyone else the switch is disabled, and under the description, 12px `--faint` with Lucide `lock` 12px: `Only an organization admin can turn this off.`
- **An organization admin** turning it off gets an `AlertDialog`: title `Start outside tasks at once?`, body `Anyone in Linear who delegates a ticket to ostra on calculator's boards starts a task without a member's approval. It runs on calculator's pools, on its default profile, never on a personal runner.`, buttons `Cancel` and `Start them at once` (outline, `--red` text). Turning it back on asks nothing.
- When off, the description reads `Tasks someone starts in Linear who isn't a member of calculator start at once, on its pools.` and 12px `--faint`: `Turned off by {member} · {date}` (`outsideApprovalChangedByMemberId`).
- No board has "Start from Linear" on (`../m2/project-boards` growing): the whole section is drawn, with 12px `--faint` `No board of calculator starts tasks from Linear, so this applies once one does.`

#### CI as ostra last saw it

- Title `CI as ostra last saw it`. One 40px row per project repo, hairlines between, in the project's repo order:

| Column | Width | Contents |
|---|---|---|
| Repo | 300px | Plex Mono 14px `--text` `fullName` |
| Verdict | 150px | a 15px icon and 14px word: `circle-check` `--green` `Passed`; `circle-x` `--red` `Failed`; `circle-dashed` `--faint` `No CI` (`--muted` word); `loader-circle` (spinning) `--muted` `Running`; `clock` `--muted` `Timed out` |
| Detail | rest | 13px `--faint` sans, with check names and the SHA in Plex Mono: `{checks} · on {sha7} · {age}` (`build, test, lint · on 4f1c2ab · 6 min ago`); for a failure, the failing checks only (`e2e · on 9a03d1e · 1 h ago`); `No CI`: `nothing reported within 2 minutes of a push`; never run: `No task has pushed here yet.` |

- The SHA links to the task whose head it was (`title`: `CALC-182's head`).
- Footnote, 14px under the rows, Lucide `info` 13px + 12px `--faint`: `ostra reads check runs and commit statuses on each pull request's head, leaving out its own.`

### Properties panel

1. **How a pull request goes** (label 12px weight 500 `--faint`): an `ol` of four steps, Plex Mono 12px `--faint` numbers in a 24px column, 14px `--muted` text, wrapping, 8px apart:
   1. `CI runs. A failure goes back to the agent with its logs.`
   2. `The AI review posts findings. Blocking ones go back to the agent.` (With AI review off: `The AI review is off here, so this step is skipped.` in `--faint`.)
   3. `At a limit, the task needs its driver.`
   4. `The reviewers approve on GitHub.`
2. **This project** (`PropGroup`, 120px key column): `AI review` · `On` / `Off`; `Review profile` · the profile's name; `Model` · the profile's model; `Outside tasks` · `Need approval` / `Start at once`; `Changed by` · avatar and name of whoever last changed the outside switch (hidden when nobody has).

## States

| State | What shows |
|---|---|
| **A project admin, all defaults** (`review-settings.webp`) | As above |
| A member (not a project admin) | Both switches and both `Select`s disabled, each with its `Tooltip`; the page reads the same |
| An organization admin | The outside switch enabled, the lock line gone |
| AI review off | The switch off; `Review rounds` marked unused; the panel's step 2 in `--faint` |
| Install limits changed (`OSTRA_CI_ROUNDS=3`) | The new values; nothing else changes |
| A repo with no task yet | `circle-dashed` `--faint`, `Not seen yet`, `No task has pushed here yet.` |
| Loading | Tabs and title at once; each section's controls as `Skeleton`; CI rows as three skeleton rows |
| Error loading | `role="alert"` `--red` `errorText(error)` under the lede, teal `Retry` |
| Narrow / phone | The panel drops under the sections; switches stay at the right of their titles; the CI rows become two lines (repo and verdict, then the detail) |

## Components (shadcn/ui names)

- **From the repo:** `PageFrame` (with `properties`), `PageHeading`, `PropGroup`, `PropRow`, `Select`, `Tooltip`, `AlertDialog`, `Skeleton`, `Avatar`; milestone 4's settings tab row.
- **New:** `Switch` from shadcn/ui on `radix-ui` if it isn't on `main` yet; `components/projects/review-settings-view.tsx`, `ci-seen-rows.tsx`. `Badge` (outline) for `built-in`.
- **Icons** (Lucide 15px, stroke 1.75): `lock`, `circle-check`, `circle-x`, `circle-dashed`, `loader-circle`, `clock`, `info`, `chevron-down`.

## Tokens

The measured tokens (`apps/web/src/app/globals.css`, as `review-screen.md`). No amber on this page. Red only for a failed CI verdict and the dialog's confirming button. Green only for a passed verdict. The switches' on state is `--shell`, the brand's off-white, never green: on isn't a health state.

## Data this screen needs beyond ticket 28

- **`projects.reviewSettings`** returns `aiReview`, the two default profiles (id, name, `builtInKind`, model), the three limits with their setting names, `outsideApproval`, `outsideApprovalChangedBy` (member and date), `canEdit` (project admin), `canEditOutside` (organization admin), whether any board has agent mode on, and per repo the latest `CiRun` across the project's tasks (state, checks' names, head SHA, the task's key, `completedAt` or `firstSeenAt`).
- **The setting names** come from the server's settings module, never typed again in the panel.

## Differences from the current code

1. **Everything is new:** no `settings/review` route, no `reviewSettings` procedure; `Project.aiReview` and `Project.outsideApproval` arrive with ticket 05's migration.
2. **The settings tabs** gain `Review`; a member who isn't a project admin sees it too (read-only), unlike `Ticket template`.
3. **`Switch`** may not exist in `components/ui/` yet.
4. **Messages:** new keys under `projectSettings.review.*`.

## Open points (recommendations; ticket 35 records the answer)

1. **Per-project round limits.** v1 keeps them per install (spec section 5.4). Recommended: keep the read-only rows, so the place for a per-project value already exists when it comes.
2. **Where the outside switch lives.** Recommended: here, since it's about what happens to tasks of this project; the organization admin who flips it does it per project, and the audit log records it (milestone 4).
3. **The CI section's source.** Recommended: the latest `CiRun` per repo across the project's tasks. A repo whose default branch has CI but no task has pushed yet reads `Not seen yet`, never a guess.

## Wrong in the image (build from this file)

- **The CI rows' detail is all Plex Mono.** Build sans 13px `--faint`, with only the check names and the SHA in mono. `No CI` is sans too.
- **`This project` is drawn as a bold white title.** Build the panel's small `--faint` group label, like `How a pull request goes`; the panel's values are 14px regular, not bold.
- **The rounds' values sit at different x from the profile selects.** Build both at the 360px value column.
- **The Profiles' selects stretch to the column's edge.** Build them 320px wide.
- **The lede wraps to two lines** at this width; that's fine, keep its copy.
- **The sidebar** shows rows from other milestones and no Memory row. Build it from `sidebar.tsx`.
- **`Changed by Dana Ortiz`** with outside approval on: the row shows only after someone changed the switch; Dana is demo data.

Right as drawn: no primary button, no amber, the ON switch in off-white, the disabled switch dimmed with its lock line, the three locked rows with their setting names, and the three CI verdicts with green, faint and red icons beside words.
