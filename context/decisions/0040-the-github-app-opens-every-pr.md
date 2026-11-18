# The GitHub App opens every PR

**Status:** accepted (2026-11-18, from the delegated answers in `context/history/answers-2026-11-18.md`). Supersedes ADR 0019. Settles Q55, and the authorship part of Q41.

The organization's GitHub App opens every PR and authors every commit.

- **Credit.** Each member whose prompt led to a commit gets a `Co-authored-by` trailer (Q41). The agent may commit, and after every turn the box commits what's left and pushes the task's branches through the git proxy (ADR 0030).
- **One PR per changed repo** (ADR 0027).
- **A verified GitHub link.** Each member links their GitHub account once, through the App's own OAuth (F-119). It proves the identity and keeps no token. It serves three things: co-author credit, `@ostra` comments (F-053) and reviewers (ADR 0028).
- **The `ostra/independent-review` check.** ostra publishes it on each PR. It passes when someone who didn't drive the task approves. An organization can make it required in branch protection (F-104).
- **The App's permissions** include `checks: write` and `actions: read` from the first day (F-006).

## Considered options

- **The driving member's own GitHub login opens the PR, and the App pushes (ADR 0019).** Rejected for v1. v1 has no GitHub sign-in (Q35), so the server holds no member token to open the PR with. `research/platform-auth-github.md` §2.5 recommended this hybrid because GitHub then stops the author from approving their own PR.
- **Every PR and commit authored by the member.** Rejected. It needs a user token per member, which lasts 8 hours and is kept alive by single-use refresh tokens that last six months, and PR updates fail when the member leaves (`research/platform-auth-github.md` §2.5).
- **Bot-opened PRs with no check.** Rejected. A third-party bot's PR can be approved by the person who asked for it. GitHub closes that gap only for its own agent (`research/platform-auth-github.md` §2.5). The check closes it for organizations that need it.
- **Asking for `checks: write` later, when the check ships.** Rejected. A permission added later has to be approved again by every install.

## Consequences

- Linking GitHub is part of a member's setup, not a way to sign in. It ships in milestone 3, with `@ostra`.
- Spike 4 proves the flow: the manifest flow creates the App with `checks: write`, a PR the App opened shows the member as co-author, and the check run flips when someone approves.
- Bots aren't code owners, so a repo with CODEOWNERS still needs a human code owner to approve ostra's PRs (`research/platform-auth-github.md` §2.5).
- Commits pushed with `git push` aren't signed by GitHub. A repo that requires signed commits can't take ostra's pushes until signed commits (F-056) ship after v1.
- Ledger: F-030 and F-078 open one PR per changed repo with co-author trailers. F-104 and F-119 are new v1 rows.
- Revisit if an organization's rules require human-authored commits. Then member-opened PRs return together with GitHub sign-in (F-004).
