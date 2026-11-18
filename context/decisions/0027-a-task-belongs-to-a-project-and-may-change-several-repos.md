# A task belongs to a project and may change several repos

**Status:** accepted (2026-11-18, from the delegated answers in `context/history/answers-2026-11-18.md`). Settles Q29, and supersedes Q7. Replaces "one ticket, one repo" in F-007 and the domain model.

A task belongs to one project (ADR 0026). It starts from a ticket or from a prompt (F-097), and later from a PR. It may change any of the project's repos.

- **The box checks every repo of the project out side by side.** The workspace is those checkouts, on the task's branches (F-016).
- **One branch name across repos.** The git proxy accepts pushes only to the task's branches and its hidden ref (ADR 0030).
- **One PR per repo the task changed.** The PRs link to each other and to the ticket. Each is a **task repo** record: the repo, its branch and its PR. A repo the task didn't change gets no PR.
- **Lifecycle.** A code task is in review while any of its PRs is open, and merged when the last one merges. The ticket moves to "in review" when the first PR opens (F-031). Linear already moves a ticket only when its last linked PR merges.
- **After a merge, per repo.** Reopening a task gives a repo whose PR merged a fresh branch and a new PR (F-066).
- **A ticket gets at most one active code task per project.** A ticket with sub-issues still becomes one task per sub-issue (F-077).
- **Intake doesn't pick a repo.** An intake rule names a task kind, a profile and pool labels (F-011).

## Considered options

- **One task per repo, with a ticket that needs two repos split into linked tasks shown as a group (Q7, F-007).** Rejected.
  - Two sessions can't keep an API change and its caller in step. One session in one box can.
  - Intake has to guess a repo. `research/landscape.md` records that mistake in Cyrus: "silently falling back to the first repo".
  - The maintainer's picture is the project as one computer, and the environment concept shows two repos in it.
- **Several repos per project, but each task still limited to one.** Rejected for the same reasons. It keeps the guessing and splits work that belongs together.

## Consequences

- The schema has the task repo from milestone 1, before tasks across several repos ship. Milestone 1 runs one repo per project (F-086). PRs across several repos ship in milestone 4 (F-098).
- The project's snapshot holds every repo's checkout, so there is one snapshot per project, not per repo (ADR 0038).
- The GitHub App opens each PR (ADR 0040). A task with three changed repos opens three PRs, each with its own checks and reviews. The review loops (ADR 0041) act on all of them.
- A repo that sits in two projects has two sets of secrets, one in each project's environment.
- Domain rule: "one ticket, one active code task per project".
- Ledger: F-007 loses its sentences about picking a repo. F-098 (tasks across several repos) is a new v1 row. F-030 and F-078 open one PR per changed repo.
- **Fallback, confidence medium.** If several PRs per task cost more than a milestone, v1 runs one repo per task in behaviour and the schema stays as it is. It's fourth on the list of what slips first (section 5 of the answers).
