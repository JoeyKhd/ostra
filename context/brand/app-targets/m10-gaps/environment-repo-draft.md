# Target: Environment, a new repo's draft beside the saved setup

- **Pictures:** `environment-repo-draft` and `environment-repo-draft-light` (the draft waiting on a project admin), `environment-repo-draft-edit` (after `Edit first`), `environment-repo-draft-states` (a plain saved script, nothing found, a member's view, two new repos, dismissed, applied, the new repo's marked rows), `environment-repo-draft-phone` (390×844). Desktop: a 2880×1912 `.png` and a 1440×956 `.webp`; the phone: 780×1688 and 390×844.
- **Sources:** `html/environment.html?view=draft|edit`, `html/states.html?sheet=env`, `html/phone.html?scene=env`; the parts in `html/gaps.js` (`repoDraft`, `diffBlock`, `varRows`, `scriptEditor`, `envPanel`).
- **Route (existing):** `/projects/[project-id]/environment` (the Setup tab) → `components/projects/environment-view.tsx`, grown.
- **Feature:** F-112/c1 ("when a project is created or a repo is added to it, ostra drafts the environment…") and c2 ("a project admin reviews and edits the draft before it's saved"), for a repo added **after** the environment was saved: Q345, option (b), which the maintainer chose on 2026-11-22. The drafting is built (`packages/domain/src/environment/repo-drafts.ts`, `detect.ts`); holding a draft beside a saved environment isn't (see "Data").
- **Builds on:** `../m1/environment.md` (the Setup tab and a draft's `Found in` groups), `../m8/environment-app-processes.md` (the band for something found but not added), `../m6/environment-proposal.md` (diff rows), as the live page draws them, in milestone 8's shell.
- **Status: approved 2026-11-22** (the maintainer: "yes to all"), with Q345 settled as (b). Its choices are settled as `README.md` recommends.

## Purpose

Today, a repo added to a project whose environment is saved runs the saved script as it stands: a plain script runs in the new repo too (pnpm lines in a Python repo), and a `case` on `OSTRA_REPO` without the new repo's name runs nothing. Under option (b) the saved environment keeps running unchanged, and ostra holds the new repo's draft for a project admin: what detection found, the lines it would add, and three choices, **Apply**, **Edit first** and **Dismiss**. A setup an admin reviewed never changes without review.

## Layout (CSS px at 1440×956)

The live Setup tab, unchanged but for the band and the draft between the tabs and **Setup script**, and the panel's new rows. `PageFrame` with `wideProperties` (380px); the main column 684px at 1440.

### The band and the draft

| Part | Size and style |
|---|---|
| Band | as the App tab's `Found in the repo, not added` (milestone 8): 34px, `--surface`, radius 6px, 18px under the tabs; Lucide `git-branch-plus` 15px `--muted`, `New repo, not in the setup yet` (14.5px 600), the count in mono 13px `--faint`. Two or more: `New repos, …` |
| A draft | under the band, padding `12px 12px 14px`, a hairline under it. No box |
| Its head | 30px: the repo's full name in mono 14.5px 600; `added by Alex Kim · 20 min ago` 13px `--faint`; right-aligned, ghost `Dismiss`, outline `Edit first`, outline `Apply` (28px, `sm`). The page's one primary stays `Save environment` in the top bar |
| Why | 13.5px / 1.5 `--muted`, `max-width: 640px`, what tasks in that repo get **today**, by the saved script's shape (copy below) |
| Setup script | a label row (`Setup script` 13px 500 `--muted`, `what Apply adds` 12.5px `--faint`), then a diff block: `--surface`, 1px `--line-2`, radius 8px, mono 13px / 22px. A 26px gutter (`+` in `--green` on `--diff-add` rows). Unchanged runs fold into one row: Lucide `chevrons-up-down` 12px + `10 lines unchanged` (Plex Sans 12.5px `--faint`), which opens them; one line of context each side |
| Variables and secrets | label `Variables and secrets` + `written to .env` (the repo's env file, from its `.env.example`); rows 34px with a hairline: `+` in `--green`, the kind's icon (`variable` / `key-round`, 14px `--faint`), the name in mono 13.5px (210px), the value in mono `--text-2` (a secret: `no value yet` 13px `--faint` and the outline chip `secret` with `lock`) |
| Foot | 13px `--faint`: `Applying saves the environment: new boxes get it, running tasks keep theirs, and the snapshot rebuilds.` |

### The properties panel (Setup tab)

As today (`Snapshot`, then `Environment`), plus:
- `Environment` › `Repos`: one mono row per repo; the new one followed by an outline chip `new` (11.5px).
- **`Found in acme/calculator-engine`**: the m1 draft's group, for the new repo only: each file in mono 13.5px `--text`, its finding under it in 13px `--muted` (`uv.lock` / `uv, install with --frozen`; `.python-version` / `Python 3.12`; `.env.example` / `2 variables, 1 looks like a secret`).
- **`Tools`**: outline chips in mono 12.5px (`python 3.12`, `uv 0.5`), then 13px `--faint` `Detected in the new repo. Nothing here changes until you apply it.`
- **`Services`** only when detection found any (m1's rows, `not on host`), with `Add it on Services and checks.` (teal): Apply doesn't add services, which are the environment's, not a repo's.

Several new repos: one `Found in` group each, in the band's order.

## The three choices

- **Apply:** saves the environment at once with the new repo's lines merged into the setup script and its variables and secrets (names only; secrets without a value) added to its section. The saved script is the one the diff shows: with a `case`, a new branch before `esac`; a plain script becomes a `case`, the old script under each repo that had it and the new lines under the new repo (`states`, first piece). A save, so it's scanned, audited (`environment.saved`, with `repoDraft: <repo>`) and versioned like any other; the snapshot rebuilds (`Environment changed`). The band leaves; the save's status line reads `Saved. acme/calculator-engine has its own lines now.`
- **Edit first** (`environment-repo-draft-edit`): puts the same lines into the editors without saving. The eyebrow reads `Editing · not saved yet`; the band becomes one line with a 2px `--teal` left rule, Lucide `pencil` 15px `--muted`: `Editing acme/calculator-engine's lines, marked below.` + `--muted` `Save to keep them.` and a ghost `Cancel` (drops the edits, the draft stays). The added lines carry a 2px `--teal` rule in the gutter and a 7% `--teal` wash; the new repo's rows in its section carry the same rule. `Save environment` saves them like any save, and the draft is done.
- **Dismiss:** drops the draft, no change to the environment. A status line, 14px `--muted`, `check`: `Dismissed. acme/calculator-engine runs the saved setup as it is.` + teal `Undo` until the page is left. Audited (`environment.repo-draft-dismissed`). A dismissed draft doesn't come back for that repo unless the repo is removed and added again.

## States and copy

| State | What shows |
|---|---|
| **A `case` without the repo** (the picture) | Why: `Its tasks run the saved setup as it is, and its case has no branch for this repo, so they set up nothing. Detection drafted the lines below.` |
| **A plain saved script** | Why: `Its tasks run the saved setup as it is: the pnpm lines, in a Python repo. Applying gives each repo its own branch of a case on OSTRA_REPO.` (the detected language and the saved script's tool named from detection's findings; with nothing to name, `…as it is, in every repo.`). The diff shows the wrap |
| **The same lines** | detection found exactly the saved plain script's lines: no draft and no band (nothing to review) |
| **Nothing found** | Why: `Detection found nothing to set up in it: no lockfile or setup file ostra knows. Its tasks run the saved setup as it is.` No diff, no foot; `Dismiss` only |
| **Two or more new repos** | one row each in the band; the first open, the others folded to their head with a `chevron-right` and detection's one-line summary (`Python · uv`); each its own buttons. Apply applies that repo's lines only |
| **Two new repos, a plain saved script** (added 2026-11-23, after review) | the wrap keeps the saved lines under every repo that ran them, a new one where detection found nothing among them, but gives no branch to another new repo whose own draft waits (its draft adds one). The draft says so under its diff, 13px `--muted`: `Applying this gives acme/calculator-mobile no branch: its own draft adds one, and until that's applied its tasks set up nothing.` Once applied, the other draft is a `case` draft |
| **A member** | the same band and draft, no buttons; the foot reads `A project admin applies it, edits it first or dismisses it.` |
| **Saving** (Apply) | the three buttons disable; `Apply` reads `Applying…` |
| **Apply failed** | under the draft's head, `role="alert"`, 13.5px `--red`: the save's error (`errorText`), as the page's save errors; a secret-scan refusal is milestone 4's refusal line |
| **The draft is older than the script** | someone saved the environment since the draft was made: the diff is recomputed against the saved script when the page loads; nothing to show |
| **Another tab** | `Services and checks` and `App` show the band as one 36px line with the teal `Review it on Setup` (as the proposal's banner) |
| **Loading** | the band waits for `environments.get`; skeleton lines as the tab has today |
| **Phone** (`environment-repo-draft-phone`) | the head stacks (name, then `added by…`), the diff scrolls sideways inside its box, variable rows drop the value, and the buttons go full width under the foot: `Apply` and `Edit first` side by side (44px), `Dismiss` (ghost, 44px) under them |

**No amber, no needs-you item:** the saved environment keeps working, the admin who added the repo is told on the spot (below), and members see the band. (The onboarding proposal is amber for project admins because an agent made it and waits on them; this is ostra's own detection, run once.)

**Settings › Repos** (not drawn): after adding a repo to a saved environment, the add's status line gains `ostra drafted its setup: review it on Environment →`.

## Data (new; Q345 option (b))

- **When:** `projects.addRepo` (Settings › Repos) on a project whose environment is saved runs detection for the new repo (`detectEnvironment`, no agent, no model) and stores a draft instead of changing the environment. While the environment is still a draft, today's behaviour stays: the whole draft is made again.
- **A draft holds** (a new `EnvironmentRepoDraft` row, one per project and repo): `repoId`, `createdAt`, `createdBy`, and the repo's `DetectedEnvironment` (`setupLines`, `variables`, `tools`, `services`, `appProcesses`, `reasons`, `baseImage`). `appProcesses` stay for the App tab's `Found in the repo, not added`; `baseImage` is ignored while the environment has one.
- **The diff** is computed on read from the saved script and the draft: a `case` gains `draftFromRepos`' branch for the repo; a plain script is wrapped as `setupScriptFromRepos` wraps scripts (the saved lines as written, the new branch as detection drafts it).
- **API:** `environments.get` gains `repoDrafts: { repoId, fullName, createdAt, createdBy, kind: "case" | "plain" | "nothing", diff, variables, reasons, tools, services }[]`; `environments.applyRepoDraft({ projectId, repoId })` (project admins; a save); `environments.dismissRepoDraft({ projectId, repoId })` and its undo. `Edit first` needs no call: the page merges the draft into its editors and saves through `environments.save`, which then drops the draft.
- Removing the repo drops its draft.

## Keyboard

- The draft's buttons are in the order read: `Dismiss`, `Edit first`, `Apply`. `Edit first` moves focus to the first marked line in the script editor. `Cancel` (while editing) returns focus to the band.
- `10 lines unchanged` is a button (`aria-expanded`).
- A folded repo's head is a disclosure button (`aria-expanded`); `Enter` opens it.
- Status lines (dismissed, applied) are `role="status"`; errors `role="alert"`.

## Components

The page's `EnvSection`, `ScriptEditor` (`ui/code-editor.tsx`), `Table`, `PropRow`, `Chip`, `Button` (ghost, outline), `Skeleton`; milestone 8's band; milestone 6's diff rows. Icons, Lucide 0.460: `git-branch-plus`, `chevrons-up-down`, `chevron-right`, `variable`, `key-round`, `lock`, `pencil`, `check`.

## Tokens

`--surface` (the band, the diff), `--diff-add` / `--green` (added lines and their `+`), `--teal` (the edit rule and wash, `Undo`, links), `--muted` / `--faint` (copy), `--text-2` (values), `--red` (errors). No amber.

## Copy (new keys under `environment.repoDraft.*`)

`band` `New repo, not in the setup yet` · `bandMany` `New repos, not in the setup yet` · `addedBy` `added by {name} · {age} ago` · `whyCase` `Its tasks run the saved setup as it is, and its case has no branch for this repo, so they set up nothing. Detection drafted the lines below.` · `whyPlain` `Its tasks run the saved setup as it is: {saved}, in a {language} repo. Applying gives each repo its own branch of a case on OSTRA_REPO.` · `whyPlainBare` `Its tasks run the saved setup as it is, in every repo. Applying gives each repo its own branch of a case on OSTRA_REPO.` · `whyNothing` `Detection found nothing to set up in it: no lockfile or setup file ostra knows. Its tasks run the saved setup as it is.` · `script` `Setup script` · `scriptNote` `what Apply adds` · `unchanged` `{n} lines unchanged` · `variables` `Variables and secrets` · `writtenTo` `written to {file}` · `noValue` `no value yet` · `foot` `Applying saves the environment: new boxes get it, running tasks keep theirs, and the snapshot rebuilds.` · `footMember` `A project admin applies it, edits it first or dismisses it.` · `apply` `Apply` · `applying` `Applying…` · `editFirst` `Edit first` · `dismiss` `Dismiss` · `editing` `Editing {repo}'s lines, marked below.` · `editingSave` `Save to keep them.` · `editingEyebrow` `Editing · not saved yet` · `dismissed` `Dismissed. {repo} runs the saved setup as it is.` · `undo` `Undo` · `applied` `Saved. {repo} has its own lines now.` · `appliedSecretsOne` / `appliedSecretsMany` `Give the secret {names} a value in the repo's section, then save: a secret is kept only with one.` / `Give the secrets {names} a value each in the repo's section, …` · `leftOutOne` / `leftOutMany` `Applying this gives {repos} no branch: its own draft adds one, and until that's applied its tasks set up nothing.` / `…: their own drafts add them, and until those are applied their tasks set up nothing.` · `elsewhere` `Review it on Setup` · `new` `new` · `toolsHelp` `Detected in the new repo. Nothing here changes until you apply it.` · `servicesHelp` `Add it on Services and checks.` · Repos: `projectSettings.repos.drafted` `ostra drafted its setup: review it on Environment`.

## Demo data

`calculator`, saved 2h ago, two repos (`acme/calculator-web`, `acme/calculator-api`) each with its own branch of the `case`; Alex Kim added `acme/calculator-engine` (Python, `uv.lock`, `.python-version` 3.12, `.env.example` with `ENGINE_LOG_LEVEL` and `ENGINE_API_KEY`) 20 minutes ago. The states use `acme/calculator-docs` for the repo with nothing found.

## Not in the pictures

- The band's one-line form on the other tabs, Settings › Repos' line, `Applying…` and an apply error.
