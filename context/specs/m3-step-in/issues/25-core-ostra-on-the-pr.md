# 25: Core: `@ostra` on the PR

Status: ready-for-agent
Builder: core
Blocked by: 07, 09
Features: F-053
Packages: `apps/core` (milestone 2's webhook inbox, `src/reactions/`), `packages/domain` (`acceptPrComment`)
Spec: `../spec.md`, section 4 ("`@ostra`"); ADR 0052, ADR 0041

## What to build

- **`github.comment`** (from milestone 2's inbox, keyed by the comment's ID): for an `issue_comment` on a PR or a `pull_request_review_comment`, created or edited, whose body starts with `@ostra` (after whitespace, case-insensitive) or holds it on a line of its own.
- **Who:** find the task by the repo and PR number (`TaskPullRequest`); find the member by the commenter's GitHub user ID (`User.githubUserId`, F-119) within the task's organization; check the member can open the project. Anyone else, bots included, is recorded by IDs (the delivery, the task if found, `reason: "unlinked"` or `"no-access"`) and dropped, with no reply.
- **Then:** react 👀 on the comment (idempotent), write `pr.comment_received` and one member message (`intent: "pr-comment"`) with the text after `@ostra` inside a marked block, the comment's URL, and for a line comment its path and line, attributed to the member. With a session going it waits for the turn's end (a queued steer, whoever drives); with none it reopens the task. The member is credited as a co-author of what follows (ADR 0040).
- **An edit** of an accepted comment does nothing more; an edit that adds `@ostra` to a comment counts once.
- Comment text is untrusted: it never reaches a shell and is never logged.

## Done when

- [ ] Tests: a linked member's comment reopens the task once, with one reaction, and a replayed delivery does nothing; a line comment carries its path and line; an unlinked commenter, a linked one without access and a bot are dropped with no reply; a comment while a session runs waits for the turn's end; another organization's task is never matched.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ reopen tasks from @ostra on a PR`.

## Decided 2026-11-19

Decided on the maintainer's delegation while preparing the build, from the open points of the milestone 3 targets (`context/brand/app-targets/m3/`) and the spec's gaps. If the maintainer disagrees with one, it goes back to `context/open-questions.md` and this section changes.

- **`@ostra` needs the App's webhook** (Q187). Nothing polls PR comments in milestone 3. An App created without a public address has no webhook (`buildAppManifest` leaves `hook_attributes` out), and on such an install a comment never reaches ostra. `docs/configuration.md` says so where it describes the GitHub App. The test App has no webhook and no events today (ticket 51, step 9).
- **Reactions and the App's permissions.** The App has `pull_requests: write` and `issues: read`. Ticket 09's live case confirms that 👀 on a PR's issue comment and on a review comment works with these. If GitHub refuses it, the manifest asks for `issues: write`, the change goes in ticket 09's comments, and the maintainer accepts the new permission on the test App's installation.

## Comments
