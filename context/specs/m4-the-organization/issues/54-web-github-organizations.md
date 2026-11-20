# 54: Web: GitHub organizations and installations

Status: resolved
Builder: web
Blocked by: 39 (project repos), 51, 52
Features: F-136, F-006
Packages: `apps/web` (the organization's GitHub page, the GitHub setup form, a project's Repos, New project)
Spec: `../spec.md`, sections 3 (step 15) and 12; target `github-organizations`

## What to build

- **Organization, "GitHub"** to the `github-organizations` target: each App with its installations, linked, waiting (with "Link" and "Remove") or removed; "Add a GitHub organization", with the install link to send, why a private App can't be installed elsewhere, and the link to GitHub's setting; "Connect another App", showing the webhook address and the secret once.
- **The screens that only grow** (section 12): the setup form's question on whether repos outside the App owner's account will use the App; repos grouped by GitHub account in a project's Repos and at creation; a repo whose installation was unlinked, with its reason.

## Done when

- [x] Playwright cases named `F-136: ...`:
  - a waiting installation is shown with "Link" and "Remove", and its repos aren't offered until it's linked
  - "Connect another App" shows the webhook address and the secret once
  - the setup form sends the answer it was given
- [x] Every string is in the message files; dark and light; phone width.
- [x] Committed as `✨ add GitHub organizations to the panel`.

## Comments

- 2026-11-19 (ticket 52): target approved (`app-targets/m4/github-organizations`), so the UI can start. Its open points are settled in the build spec; record them here as built. **The screens that only grow**, built against their existing targets with no new picture:
  - `app-targets/m1/github-not-connected`: on `Create a new App`, a `RadioGroup` under the organization field, label `Will repos outside this account use the App?`: `No, only this account's repos` (default) and `Yes, other GitHub organizations install it too`; help, 12px `--faint`: `Private is the default: a public App can't be made private again once another account installs it.` The answer goes to `github.createApp` as `public`.
  - `app-targets/m1/project-new` and `app-targets/m4/project-repos`' `Add a repo` sheet: repos from every linked installation, grouped by GitHub account (a 12px 500 `--faint` group label: the login in mono and `organization` / `user`), never from a waiting or removed one.
  - `app-targets/m4/project-repos`: the repo list grouped by GitHub account the same way when the project's repos span two; a repo whose installation was unlinked or removed shows the check line `ban` 15px `--red` + `Its installation on globex was unlinked` and, after a `·` in `--faint`, `New tasks here wait until an admin links it again.`; the verdict reads `Not usable` in `--red`.
- 2026-11-20 (web builder), `✨ add GitHub organizations to the panel` (8ec40dc), after `✨ name each repo's installation in projects.get` (b0428ee), built against ticket 51's API:
  - **Organization › GitHub:** one section per App (its own first), with its owner, visibility and webhook state; installations as rows (linked, waiting with `Link` and `Remove`, suspended, removed), each selecting the panel's `Installation` group. `Add a GitHub organization` puts the install link (a `Select` over several public Apps) and `Private Apps` (with the link to GitHub's own setting) in the panel. `Connect another App` takes the App ID and key, then shows the webhook address and the generated secret once, with `Done`. At phone width the two top-bar buttons read `Another App` and `+ Organization`, keeping their full names for screen readers.
  - **The setup form:** `Will repos outside this account use the App?`, private by default, sent to `github.startManifest` as `public`.
  - **New project:** repos of every linked installation, across the Apps, grouped by GitHub account (`github.reposByAccount`); none from a waiting or removed one.
  - **A project's Repos:** grouped by account when the repos span two; a repo whose installation was unlinked or removed reads `Not usable` in red, with `Its installation on {account} was unlinked` (or `removed`) `· New tasks here wait until an admin links it again.`, and the panel's `Why it's not usable` links to the GitHub page. `projects.get` (and `checkRepos`) gained each repo's `installation` (account, kind, `linked` / `unlinked` / `removed`), an additive change in its own commit.
  - **As built:** an unlinked installation that GitHub still lists says `Unlinked by … The App is still installed there` in the panel, not `no longer installed`. The project Repos page built here is milestone 2's `repo-checks` page; ticket 39's `settings/repos` page and its `Add a repo` sheet, not built yet, should reuse `reposByAccount` and the not-linked line from `repo-checks-words.ts`.
  - **Proof:** `apps/web/e2e/10-github-organizations.spec.ts`, five cases (the two `@desktop-only` at 1440 px; the fit and the setup form's two answers at both 1440 px and Pixel 7), all passing. Break-its, each failing its case: no `Link` button; no shown-once group; `public: false` whatever the answer; every private App linked to the user settings page; the phone labels at full length. Unit and API: `repo-checks.test.tsx` (three `F-136` cases) and `linked-installations.test.ts` (`projects.get`'s installation), each with its break-it. Rows in `context/proof/F-136.md`. Proved with the fake GitHub only; the live two-org run is ticket 55.
  - **Dark and light:** the panel ships one theme, dark. Checked at 1440 px and phone width against `app-targets/m4/github-organizations`; finals `m4-github-organizations`, `-waiting`, `-add`, `m4-project-new-groups` and `m4-repo-not-linked` (`-final.png`, the first two also `-phone-final.png`) in the run's ui-check folder. Left from the picture: the repos column truncates `Selected repositories` at 1440 px (the grid's widths are the target's).
  - **Not mine:** `01-shell` and `02-setup` fail on main as it stands (noted in ticket 53), so `03-first-run` stops before its checklist ticks; the GitHub steps it runs still pass.
