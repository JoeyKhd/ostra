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
