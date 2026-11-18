# Who authors a PR

**Status:** superseded by ADR 0040 (2026-11-18). ADR 0040 replaces it: the organization's GitHub App opens every PR and authors every commit, each member whose prompt led to a commit is credited with a `Co-authored-by` trailer, and an `ostra/independent-review` check covers the gap that a requester can approve the bot's PR (Q55, F-104). It was accepted with the plan on 2026-11-17, chosen in grilling round 3 following `research/platform-auth-github.md`, and the text below is kept as the historical record.

- **When a member drives the task:**
  - The PR is opened with that member's own GitHub login, which the server holds and uses only there.
  - The team's GitHub App pushes the commits, with the member in a `Co-authored-by` trailer.
  - GitHub then stops the member from approving their own PR, as it would for any author.
- **When nobody drives it:** the team's GitHub App opens the PR. That covers a task started by an intake rule, or an approved task from someone outside ostra (F-040).

## Consequences

- Linking a member's GitHub login is part of setting up their account (F-002).
- A bot-opened PR can be approved by any member, including whoever approved the task. Teams that need more add their own required check.
