# 44: Files left outside every repo raise a needs-you item

Status: ready-for-agent
Builder: runner, core; api and web for the item's words
Blocked by: 02 (the protocol's minor 1), 05 (the migration), 22 (the work after every turn)
Features: F-016, F-065
Packages: `packages/protocol` (one event kind, additive), `packages/adapter-sdk` (`ExecutorAdapter`: listing the workspace root, and the executor suite), the two executors, `apps/runner` (`src/task-host/`), `packages/db` (one `NeedsYouReason` value), `packages/domain`, `apps/core`, `packages/task-view`, `apps/web`, `apps/web/messages/en.json`
Spec: `../spec.md`, section 7 (follow-ups); `context/domain-model.md`, "When a task needs you"

## Why

Settled as Q133 on 2026-11-19 (`context/open-questions.md`, Settled). The workspace holds the repos side by side. A file the agent writes beside them belongs to no repo, so no branch, hidden ref or PR carries it, and it goes when the box does. In milestone 1's demo a task lost a file that way without a word. With one repo the agent now starts inside it, which makes this rare. With several repos it starts at the workspace root, which makes it likely.

## What to build

- **The scan,** in the task host, after every turn and at a stop: through the executor, the names in the workspace root that aren't a repo's checkout folder and aren't ostra's own. ostra's own folders are one constant. Top level only: a folder left there is one entry.
- **The event** `workspace.files_outside_repos { paths, more }`: at most 50 paths *(working value)*, relative to the workspace root, and how many more there were. It is sent when the set changes, not after every turn.
- **Core's reaction:**
  - a needs-you item for the driver, or for the project's members when the task has none, with the reason `files_outside_repos`
  - an open item is updated, never doubled, and it closes when a later scan finds nothing or a member dismisses it
  - PRs open and update as usual: a task with an open PR is in review, with this item beside it
  - when the turn changed no repo and no PR is open, the task needs you for this reason, not for `no_changes`
- **The panel:** the thread shows the event with its paths, and the item says what to do: "The agent left 2 files outside the repositories: notes.md, plan.txt. Reply to have them moved into a repository, or dismiss." From `apps/web/messages/en.json`. If the task page's targets have no place for the item, the target is amended and approved first.
- **ostra never moves, commits, uploads or deletes them.** It can't know which repo they belong to. They stay in the box, and a reply while the box is kept lets the agent move them.
- **Not here:** telling the driver by mail or on the ticket. Milestone 3's notifications choose their moments (`../../m3-step-in/spec.md`, section 5.2), and this reason joins them there or stays a panel item.
- **The same on every executor:** on `host` the task host lists the worktree's root, and on `docker` the sidecar lists the task volume.

## Done when

- [ ] With the scripted fake agent, in both executors' suites: a file written at the root is reported once, with its path. A turn that also changed a repo still opens its PR, with the item beside it. A turn that changed nothing needs you for this reason. A later turn that moved the file closes the item. The repos' folders and ostra's own are never reported.
- [ ] The paths reach the event log and the panel, and no log line.
- [ ] Proof (`AGENTS.md`, `context/proof/README.md`): each test that proves a condition of a row's "done when" names the row's ID in its title and has a break-it check, its rows are in `context/proof/`, and `pnpm check:proof` passes.
- [ ] The whole-repo checks pass (spec section 9: the runner protocol, the schema).
- [ ] Committed as `✨ flag files left outside every repo`.

## Comments
