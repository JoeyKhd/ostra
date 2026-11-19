# The GitHub App opens every PR

**Status:** accepted (2026-11-18, from the delegated answers in `context/history/answers-2026-11-18.md`). Supersedes ADR 0019. Settles Q55, and the authorship part of Q41. **Amended 2026-11-18 after spike 4** (`research/spike-github-app-and-git-proxy.md`): what GitHub accepted for the App, how the check behaves, and who counts as the driver (Q121, Q122). **Amended again 2026-11-19 for milestone 4's spec** (Q207): whose approval counts, and how the check is kept current ("Milestone 4: the check in practice" below). **Amended again 2026-11-19 for milestone 6's spec** (Q227): a "changes requested" reviewer gets no trailer for it ("Milestone 6: a "changes requested" reviewer stays independent" below). **Amended again 2026-11-19 by ADR 0065** (Q279 to Q283): an App other accounts may install, linked installations, a client's own App beside the organization's, and a bot per repo ("Repos from several GitHub organizations" below).

The organization's GitHub App opens every PR and authors every commit.

- **Credit.** Each member whose prompt led to a commit gets a `Co-authored-by` trailer (Q41). The agent may commit, and after every turn the box commits what's left and pushes the task's branches through the git proxy (ADR 0030).
- **One PR per changed repo** (ADR 0027).
- **A verified GitHub link.** Each member links their GitHub account once, through the App's own OAuth (F-119). It proves the identity and keeps no token. It serves three things: co-author credit, `@ostra` comments (F-053) and reviewers (ADR 0028).
- **The `ostra/independent-review` check.** ostra publishes it on each PR. It passes when someone who didn't drive the task approves. An organization can make it required in branch protection (F-104).
- **The App's permissions** include `checks: write` and `actions: read` from the first day (F-006). Spike 4 settled their spelling: GitHub accepts `contents`, `pull_requests`, `checks`, `actions`, `issues`, `statuses` and `metadata` as the manifest writes them and returns the same seven. `email_addresses` is refused, so the verified link takes only the member's login and ID from the App's OAuth (`GET /user`, which needs no permission, so the code's comment says; the spike got the ID another way, so the OAuth route itself is unverified and is F-119's own test). **`workflows: write` is not asked for in v1 (Q122):** it would let an agent change CI, and a permission added later has to be approved again by every install, so the choice is real. A push that touches `.github/workflows/` is therefore expected to fail on GitHub, and the task says why. The spike left it out and did not try such a push; F-006's test does. If a team needs it, a later release asks for it and every install approves once.
- **How the check behaves** (F-104). The approver rule is the evaluator's: for each reviewer, their latest approval, change request or dismissal counts and a comment doesn't, bots and drivers don't count, and the approval must be of the PR's current head. **The driver is every member credited with a trailer on the task (Q121),** because ADR 0040 credits everyone whose prompt led to a commit, so "someone who didn't drive the task" means none of them. The check moves both ways: a new push gives the PR a new head and the check is published for it as pending; a dismissal or a withdrawn approval sets a green check back to pending. An unapproved PR shows the check as `in_progress`, titled "Waiting for an independent reviewer". Whether a required check that is `in_progress` blocks a merge the way a failing one does is unverified, and F-104's test on a real repo with branch protection settles it. If it doesn't block, the check reports `action_required` instead. GitHub's rule that an author can't approve their own PR doesn't cover a human approving a bot's PR, which is why the check exists.
- **With no public URL there is no webhook.** GitHub refuses a webhook URL on a loopback host even when the hook is inactive, so the setup flow creates the App with no events, and adds the webhook and its events once a public address exists. F-006 says so, and the `setup_url` is left out until the panel has a post-install page.

## Considered options

- **The driving member's own GitHub login opens the PR, and the App pushes (ADR 0019).** Rejected for v1. v1 has no GitHub sign-in (Q35), so the server holds no member token to open the PR with. `research/platform-auth-github.md` §2.5 recommended this hybrid because GitHub then stops the author from approving their own PR.
- **Every PR and commit authored by the member.** Rejected. It needs a user token per member, which lasts 8 hours and is kept alive by single-use refresh tokens that last six months, and PR updates fail when the member leaves (`research/platform-auth-github.md` §2.5).
- **Bot-opened PRs with no check.** Rejected. A third-party bot's PR can be approved by the person who asked for it. GitHub closes that gap only for its own agent (`research/platform-auth-github.md` §2.5). The check closes it for organizations that need it.
- **Asking for `checks: write` later, when the check ships.** Rejected. A permission added later has to be approved again by every install.

## Consequences

- Linking GitHub is part of a member's setup, not a way to sign in. It ships in milestone 3, with `@ostra`.
- Spike 4 proves the flow: the manifest flow creates the App with `checks: write`, a PR the App opened shows the member as co-author, and the check run flips when someone approves. On GitHub, the manifest flow and the co-author trailer passed (GraphQL `Commit.authors` resolved the no-reply address to the member). The check's flip from a real `pull_request_review` webhook hasn't been seen: only polling and the local signature check ran, and it needs a token for a second sandbox user who can approve.
- Bots aren't code owners, so a repo with CODEOWNERS still needs a human code owner to approve ostra's PRs (`research/platform-auth-github.md` §2.5).
- Commits pushed with `git push` aren't signed by GitHub. A repo that requires signed commits can't take ostra's pushes until signed commits (F-056) ship after v1.
- Ledger: F-030 and F-078 open one PR per changed repo with co-author trailers. F-104 and F-119 are new v1 rows.
- Revisit if an organization's rules require human-authored commits. Then member-opened PRs return together with GitHub sign-in (F-004).

## Milestone 4: the check in practice

Added 2026-11-19 (Q207), for milestone 4's spec, which ships F-104.

- **Whose approval counts.** A review counts only when its GitHub user is linked (F-119) to an active member of the task's organization who isn't a driver. A driver is every member with a co-author trailer on the task (Q121). An unlinked approver doesn't count, because ostra can't tell whether they are a driver on another account; the check's text says "Approved by @login, who isn't linked to an ostra member" so the team knows why it waits.
- **When it's evaluated.** On every `pull_request_review` (submitted, edited, dismissed), on every `pull_request` `synchronize` (a new head: a new pending check for it), when a member links or unlinks GitHub, when a trailer is added, and in milestone 2's PR reconcile, every 5 minutes. Each evaluation lists the PR's reviews through the code host adapter and runs spike 4's evaluator (`spikes/github-app-and-git-proxy/src/github/independent-review.ts`), and writes the check only when its result changed, idempotent by PR and head.
- **On every PR of every task,** in every project. A repo's branch protection decides whether it blocks a merge; ostra never changes branch protection.
- **`in_progress` or `action_required`.** The check reports `in_progress` ("Waiting for an independent reviewer") until milestone 4's live test on `test1`, with branch protection requiring the check, shows whether that blocks a merge. If it doesn't, the adapter reports `action_required` instead, the test records which, and this ADR is amended with the answer.


## Milestone 6: a "changes requested" reviewer stays independent

Added 2026-11-19 (Q227), for milestone 6's spec, which ships F-105.

- **A review that requests changes reopens the task with its comments as one prompt (F-105), and gives its reviewer no co-author trailer.** The driver rule (Q121) makes everyone with a trailer a driver, and a driver's approval doesn't count for `ostra/independent-review`. A reviewer who asked for changes and then approves the fix is the independent reviewer the check is for. `@ostra` comments and the panel's messages still credit their member, as they always did.

## Repos from several GitHub organizations

Added 2026-11-19 by ADR 0065, for F-136.

- **"The organization's GitHub App" becomes "the repo's App".** An organization has its own App, and may connect an App a client's GitHub organization owns beside it. Each repo's PR is opened, and its commits authored, by its own App's bot. A task whose repos belong to two Apps carries a git identity per repo (protocol minor 3).
- **The App may be installable by other accounts.** The manifest form asks, and creates it private by default, since GitHub won't make a public App private again once another account installed it.
- **ostra works only through linked installations.** The App owner's own account is linked when seen; any other installation waits until an organization admin links it, and until then ostra mints no token, offers no repo and stores no webhook delivery for it.
