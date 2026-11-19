# 51: The maintainer's steps outside the code

Status: ready-for-human
Builder: maintainer
Blocked by: none for the decisions; 39 and 47 for the GitHub link; 50 for steps 6 and 7
Features: F-115, F-119, F-053, and the screens of ticket 41
Packages: none (decisions and settings outside the repo, recorded here)
Spec: `../spec.md`, sections 3, 11 and 12

## Why a person

Each step needs an account, a click or a yes that an agent doesn't have.

1. **A Resend key for development** in `~/.config/ostra-dev/email.env` (`RESEND_API_KEY`, and `EMAIL_FROM`: an address on a domain verified in Resend, or Resend's onboarding sender, which only mails the account's own address), plus `EMAIL_TO`, the maintainer's own address for the manual run. `docs/development.md` gets the names, never the values.
2. **The link's callback on the test App:** add `<web>/api/github/link/callback` (the dev tunnel's address) to the test App's callback URLs in GitHub's App settings. New Apps get it from the manifest (ticket 09).
3. **Link the maintainer's GitHub account** to the demo admin once, through Account, "Link GitHub", once ticket 47 is in, so the demo's `@ostra` comment comes from a linked member.
4. **The second sandbox GitHub user** of `GITHUB_TEST_REVIEWER_TOKEN` (already asked for in `build-order.md`), as the unlinked commenter.
5. **Approve the milestone 3 screen targets** (ticket 41), recorded there with the date.
6. **Name the install and the Linear workspace for ostra's own tickets** (ticket 49), and install the GitHub App on `JoeyKhd/ostra`.
7. **Say yes to ostra's own tickets moving to Linear** (ticket 49), and which ones go first.
8. **Review spec section 11's twenty choices** (Q165 to Q185 in `context/open-questions.md`), all settled on the delegation of 2026-11-19, and move back to the open list any you disagree with.

## Done when

- [ ] Each step is done or answered, with the date, under `## Comments`.

## Comments
