# Target: repo checks on the project (`/projects/[project-id]/repos`)

- **Image:** `repo-checks.webp`, 1440×956, one image pixel per CSS pixel. Downscaled from a 2048×1360 generation (3:2), a 1440×960 layout drawn at about 1.42×.
- **Prompt:** `repo-checks.prompt.txt`. Higgsfield `gpt_image_2_6`, 3:2, 2k, high, 1 generation. The references were `m1/project-new.png`, `m1/environment.png`, `app-concepts/html/home-graphite.png` and `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Screen:** spec section 12, screen 8. Starts from `m1/project-new` and `m1/environment`.
- **Features:** F-060 (default-branch warning), F-055 (signed-commit repos). Tickets 09 (`readBranchRules`), 31 (API) and 37 (web).
- **Status:** a proposed target, not yet approved by the maintainer (ticket 32's `## Comments`).

> `app-design.md` rule 5: concepts are built as real HTML, not image-model mockups. This image is a visual target for the build, not a concept to approve as-is. Build it in real HTML/React, then screenshot that build and compare it with the image.

## Purpose

The project's repos, each with the two checks ostra runs on its default branch: is it protected (F-060), and does it require signed commits (F-055). A member answers one question at a glance: can tasks run here, and is anything about these repos worth fixing? An unprotected branch is a warning that says why it's still allowed. A repo that requires signed commits blocks every task in the project, and the page says so first. A check GitHub wouldn't answer says "Couldn't check", with the reason, and never guesses.

The same checks appear in two more places, specified below: the project's task page (the composer) and the new-task form.

## Layout (CSS px at 1440×960)

The shared shell, unchanged. Build the sidebar from `components/shell/sidebar.tsx`, never from the picture.

| Region | Size | Contents |
|---|---|---|
| Sidebar | 232px | the open project expands into `Tasks`, `Inbox`, `Environment`, `Boards`, `Repos` (selected, `--sel`) |
| Top bar | 44px, 1px `--line` below | breadcrumb `calculator › Repos`. Right: one outline `Button` with `refresh-cw`, `Check again` (28px). No primary button on this page: nothing here is a form |
| Main column | flexible, padding `28px 40px`, content `max-width: 760px` | title, lede, the blocking notice (when there is one), the repo list, the footnote |
| Properties panel | 300px, 1px `--line` on its left, padding `20px 18px` | the selected repo's checks, why a warning is allowed, how to fix it |

### Main column, top to bottom

1. **Title:** `Repos`, Manrope 700, 24px, letter-spacing −0.015em.
2. **Lede** (13.5px, `--muted`): `acme · 4 repos · checked 2 min ago`. The account login in mono `--text`; the age is the oldest `checkedAt` among the repos.
3. **The blocking notice**, only when a repo requires signed commits (18px below the lede). Not a card: `background: var(--surface)`, a 2px `--red` rule on its left, radius `0 6px 6px 0`, padding `10px 14px`, `role="alert"`. A 15px `ban` icon in `--red`, then two lines:
   - 13px, 500, `--text`: `Tasks can't start in this project.`
   - 12.5px, `--muted`: `{repo} requires signed commits, which ostra doesn't support yet.` (repo in mono `--text`). With several such repos: `{n} repos require signed commits, which ostra doesn't support yet.`
4. **The repo list** (18px below). No boxes: each repo is a block with a 1px `--line` hairline above it (and below the last), padding `12px 12px`.
   - **Header line** (28px): `git-branch` 15px `--faint`; the repo's `fullName` in Plex Mono 13px `--text`; a 13px `lock` in `--faint` for a private repo (`aria-label="Private"`); the default branch in mono 12.5px `--faint`, 12px after; on the right, the verdict in 12.5px:

| Verdict | When | Style |
|---|---|---|
| `Ready` | both checks pass | `--muted` |
| `1 warning` | the default branch isn't protected | `--text`, 500 |
| `Not supported` | signed commits are required | `--red`, 500 |
| `Couldn't check` | either check is `unknown` and nothing is failing | `--faint` |

   - **Check lines** under it, indented to the repo name's x (28px), one per check, 26px tall, 12.5px. A 15px icon, the check's text in `--text`, and its explanation **on its own line under the text**, 12px `--faint`, when it has one (see "Wrong in the image"):

| Check | Result | Icon | Text | Explanation |
|---|---|---|---|---|
| Protection | `true` | `shield-check`, `--green` | `Default branch protected` | none |
| | `false` | `triangle-alert`, `--text` | `Default branch not protected` | `Allowed: the agent holds no token, and ostra pushes only the task's own branch.` |
| | `unknown` | `circle-help`, `--faint` | `Couldn't check protection` | `{reason}` |
| Signed commits | `false` | `shield-check`, `--green` | `Signed commits not required` | none |
| | `true` | `ban`, `--red` | `Requires signed commits: ` + `not supported yet` in `--red` | `ostra's pushes aren't signed, so GitHub would refuse them.` |
| | `unknown` | `circle-help`, `--faint` | `Couldn't check signed commits` | `{reason}` |

   When both checks are `unknown` for the same reason, show one line: `circle-help`, `Couldn't check`, `{reason}`.
   - The block is a button that selects the repo for the panel. Selected: `--sel`, 6px radius. Hover: `--raise`. Focus: 2px `--muted` outline, inset. The URL carries it (`?repo=<repoId>`). The default selection is the first repo with a problem, in the order Not supported, warning, Couldn't check; else the first repo.
   - Order: as `projects.get` returns them (the order they were added).
5. **Footnote** (16px below the list), 12px `--faint`, `info` 13px: `ostra reads each default branch's rules when you open this page, at most every 10 minutes, and again when a task starts.`

### Properties panel: the selected repo

Group labels 11px, 500, `--faint`; rows 30px, grid `104px 1fr`, 12.5px; key `--muted`, value `--text`. `Separator`s with 14px of margin.

1. **Header:** the repo's `fullName`, mono 12.5px `--muted` (the group label's place).

| Key | Value |
|---|---|
| `Default branch` | `main` (mono) |
| `Visibility` | `Private` / `Public` |
| `Checked` | `2 min ago` (mono) |
| `Protected` | `Yes` / `No` / `Couldn't check` |
| `Signed commits` | `Not required` / `Required` (in `--red`) / `Couldn't check` |

2. **The explanation group**, which depends on the repo's worst result:

| Result | Label | Body (12.5px `--muted`, line-height 1.55) |
|---|---|---|
| Not protected | `Why it's allowed` | `The agent never holds a GitHub token. ostra's git proxy accepts pushes only to the task's branch and its hidden ref, so {branch} stays out of the agent's reach. Protecting {branch} still guards it from everyone else.` |
| Signed commits | `Why it's blocked` | `GitHub refuses commits that aren't signed on this branch, and ostra can't sign the agent's commits yet. Until it can, no task starts in this project.` |
| Couldn't check | `Why ostra couldn't check` | `{reason}` in full, then `ostra checks again when a task starts. A task isn't refused because of a check it couldn't make.` |
| Ready | (no group) | |

3. **The fix group:**

| Result | Label | Body |
|---|---|---|
| Not protected | `Protect {branch}` | `1  On GitHub, open the repo's Settings › Rules.` / `2  Add a ruleset for {branch} that requires a pull request.`, numbers in faint mono in a 24px column. Then a teal link with `arrow-up-right`: `Open the repo's rules on GitHub` → `https://github.com/{fullName}/settings/rules` (new tab) |
| Signed commits | `To start tasks here` | `Turn off "Require signed commits" for {branch} on GitHub, or remove this repo from the project.` Then the same teal link |
| Couldn't check | (none) | |

## States and copy

| State | What shows |
|---|---|
| **Loading** | title; the lede as a `Skeleton` line; three skeleton blocks (a header line and two check lines each); the panel as skeleton rows |
| **Every repo ready** | no notice; each block `Ready` with two green lines; the panel shows the first repo's rows and no explanation group |
| **A warning only** | no notice. The tasks page and the new-task form show the warning line (below), and tasks start |
| **Signed commits** | the notice, the block's red verdict, and the panel's `Why it's blocked`. Tasks can't start anywhere in the project (ticket 31: `tasks.create` refuses) |
| **Couldn't check** | the grey line with GitHub's reason, never `Ready` and never a refusal. Examples of `{reason}`, from `readBranchRules`' `reasons`: `GitHub refused the read (403). ostra checks again when a task starts.`, `GitHub didn't answer in time.`, `The branch {branch} doesn't exist on GitHub.` |
| **Checking again** | `Check again` reads `Checking…` with the icon spinning (`animate-spin`, reduced motion: no spin), disabled. The lede's age updates when it's done. It skips the 10-minute cache |
| **Error loading** | `role="alert"`, `--red` 13px, `errorText(error)`, where the list would be |
| **Member** | the same page; members can read the checks. `Check again` is there for everyone (it only reads) |

The demo data in the image (fixtures, not real): `acme/calculator-web` (protected, ready), `acme/calculator-api` (private, not protected), `acme/calculator-sdk` (private, signed commits required), `acme/calculator-docs` on `gh-pages` (couldn't check, 403). The real demo uses `ostra-test/test1` (protected) and `ostra-test/test2` (unprotected, then the signed-commit ruleset switched on: ticket 40).

### Elsewhere: the tasks page and the new-task form

The same checks, where a task is started (F-060: "on the project and when a task starts"). They come from `projects.get`, so no new query.

- **The composer** (`m1/project`, `components/tasks/new-task-form.tsx`), inside the box, under the bottom row, 12px, one line per problem:
  - Signed commits: `ban` `--red` 13px + `{repo} requires signed commits, which ostra doesn't support yet.` (`--muted`, repo in mono) + teal `See repos`. `Start the task` is **disabled**, with this line as its `aria-describedby`.
  - Not protected: `triangle-alert` `--muted` 13px + `{repo}'s default branch isn't protected. Tasks still start: the agent can't push to it.` + teal `Why`, which goes to `/projects/{id}/repos?repo={repoId}`. The button stays enabled.
  - Couldn't check: nothing on the composer. The check runs again at start; a repo still unknown then is not a refusal.
- **The new-task page** (`m1/task-new`): the same lines, in the same place under its form's bottom row.
- **Starting refused by the server** (a repo turned on signed commits since the page loaded): the composer's error line shows the server's message, `{repo} requires signed commits, which ostra doesn't support yet.`, and the checks refresh.
- **The project's properties panel** (`project-properties.tsx`): the `Repository` group's `Repo` row gets a 13px icon after the name, `triangle-alert` (`--muted`) or `ban` (`--red`), with the verdict as its `aria-label`, linking to this page.

## Components (shadcn/ui names)

- The shell: `Sidebar` and its parts, `Breadcrumb` (as `m1/project.md`).
- `Button` (`variant="outline"`, `Check again`)
- `Alert` (the blocking notice, restyled: no border box, the left rule only)
- The repo blocks: a `button` per block (`aria-pressed` for the selection) inside a `ul`; not a `Table`, since each row has nested lines
- `Skeleton`, `Separator`
- The repo's `PageFrame`, `PropGroup`, `PropRow`
- Icons: Lucide 15px, stroke 1.75: `git-branch`, `lock`, `shield-check`, `triangle-alert`, `ban`, `circle-help`, `info`, `refresh-cw`, `arrow-up-right`

## Tokens (`app-concepts/html/graphite.css`)

`--bg #0D0E10`, `--side #0A0B0C`, `--surface #131416` (the notice), `--raise #17181B` (hover), `--sel #1A1B1E` (selected repo), `--line #1F2023`, `--line-2 #2A2C30` (the outline button), `--text #EDEDEE`, `--muted #9A9DA3`, `--faint #64676D`, `--green #4FB286` (passing checks, always with their text), `--red #E5675C` (the signed-commit block: notice rule, icon, verdict, "not supported yet"), `--teal #6FB8AA` (links).

- **No amber.** A repo check doesn't wait on the member, so it never takes "needs you"'s colour. A warning has no colour of its own: its `triangle-alert` icon and its words carry it. Red is kept for the one case that stops tasks.
- **Type:** body 13px Plex Sans; check lines 12.5px; explanations 12px; title Manrope 700 24px; repo names, branches, ages and the account in Plex Mono.
- **Radii:** 6px selected block and the notice's right side, 7px button.

## Differences from the current code

1. **The route and its files are new:** `src/app/(panel)/projects/[project-id]/repos/page.tsx` and `src/components/projects/repo-checks.tsx` (the list), `repo-check-line.tsx` (one check, shared with the composer), `repo-properties.tsx`.
2. **`projects.get` grows** (ticket 31): each repo gains `private`, `checkedAt`, `defaultBranchProtected` and `signedCommitsRequired`, each `{ result: true | false | "unknown", reason? }`, and a `checkAgain` mutation (or `projects.get` with a `fresh` flag) for the button. Today a repo is `{ repoId, fullName, defaultBranch }` only.
3. **`ProjectNav`** gains `Repos` (`git-branch`), after `Boards` (see `project-boards.md`).
4. **The composer** (`new-task-form.tsx`) gains the check lines and disables `Start the task` on a signed-commit repo. Today its button is disabled only while pending or empty.
5. **The properties panel** (`project-properties.tsx`): the repo rows gain the problem icon. (`m1/project.md` already asks for the `Repository` group with `Repo` and `Default branch` rows.)
6. **New UI primitives:** `components/ui/` has no `alert` or `skeleton`; add them from shadcn/ui (Radix-free, no new package).
7. **Copy:** every string above is new, under `repos` in `messages/en.json`.

## Wrong in the image (use the copy and sizes above, not the pixels)

- **Explanations wrap beside the text.** In `acme/calculator-api` and `acme/calculator-sdk`, the faint explanation sits to the right of the check's text and wraps onto a second line under it. Put the explanation on its own line under the text, from the same left edge.
- **The panel is too wide:** it starts at about x=1047, about 390px. It's 300px.
- **The panel's header** `acme/calculator-api` is larger than a group label, and `Private`, `2 min ago` and `Not required` render semibold or mono. Values are Plex Sans 12.5px regular; only `main` and the age are mono.
- **The sidebar's `Linear` icon** is drawn as a `ban` sign, the same glyph as the blocking check. Use Linear's real mark, monochrome `--muted`, so no sidebar icon reads as an error.
- **The selected block** extends about 12px past the list's left and right edges. It keeps the list's width; the padding goes inside.
- **The notice** is a little tall (about 70px). With 10px padding it's about 56px.
- **The verdict `Ready`** is in `--muted`; `1 warning` should be 500 weight `--text`, as drawn. Keep `Couldn't check` in `--faint` (the image draws it `--muted`).
- **The logo** approximates the Hinge mark. Use `kit/logo/export/ostra-hinge-single-color.svg`, 20px.
- **Sidebar sizes:** rows render taller than 26px and type larger than 13px. Keep the shell's sizes.
