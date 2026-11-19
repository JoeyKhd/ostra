# 54: Web: GitHub organizations and installations

Status: ready-for-agent
Builder: web
Blocked by: 39 (project repos), 51, 52
Features: F-136, F-006
Packages: `apps/web` (the organization's GitHub page, the GitHub setup form, a project's Repos, New project)
Spec: `../spec.md`, sections 3 (step 15) and 12; target `github-organizations`

## What to build

- **Organization, "GitHub"** to the `github-organizations` target: each App with its installations, linked, waiting (with "Link" and "Remove") or removed; "Add a GitHub organization", with the install link to send, why a private App can't be installed elsewhere, and the link to GitHub's setting; "Connect another App", showing the webhook address and the secret once.
- **The screens that only grow** (section 12): the setup form's question on whether repos outside the App owner's account will use the App; repos grouped by GitHub account in a project's Repos and at creation; a repo whose installation was unlinked, with its reason.

## Done when

- [ ] Playwright cases named `F-136: ...`:
  - a waiting installation is shown with "Link" and "Remove", and its repos aren't offered until it's linked
  - "Connect another App" shows the webhook address and the secret once
  - the setup form sends the answer it was given
- [ ] Every string is in the message files; dark and light; phone width.
- [ ] Committed as `✨ add GitHub organizations to the panel`.

## Comments

- 2026-11-19 (ticket 52): target approved (`app-targets/m4/github-organizations`), so the UI can start. Its open points are settled in the build spec; record them here as built. **The screens that only grow**, built against their existing targets with no new picture:
  - `app-targets/m1/github-not-connected`: on `Create a new App`, a `RadioGroup` under the organization field, label `Will repos outside this account use the App?`: `No, only this account's repos` (default) and `Yes, other GitHub organizations install it too`; help, 12px `--faint`: `Private is the default: a public App can't be made private again once another account installs it.` The answer goes to `github.createApp` as `public`.
  - `app-targets/m1/project-new` and `app-targets/m4/project-repos`' `Add a repo` sheet: repos from every linked installation, grouped by GitHub account (a 12px 500 `--faint` group label: the login in mono and `organization` / `user`), never from a waiting or removed one.
  - `app-targets/m4/project-repos`: the repo list grouped by GitHub account the same way when the project's repos span two; a repo whose installation was unlinked or removed shows the check line `ban` 15px `--red` + `Its installation on globex was unlinked` and, after a `·` in `--faint`, `New tasks here wait until an admin links it again.`; the verdict reads `Not usable` in `--red`.
