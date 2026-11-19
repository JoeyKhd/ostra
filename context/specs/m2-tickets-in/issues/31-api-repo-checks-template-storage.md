# 31: API: repo checks, the ticket template, storage and retention

Status: done
Builder: api
Blocked by: 06, 09
Features: F-055, F-060, F-064, F-114, F-079
Packages: `packages/api` (`routers/projects.ts`, `routers/organization.ts`), `packages/domain`
Spec: `../spec.md`, sections 2 and 3 (the checks after the run)

## What to build

- **Repo checks:** when a repo is added to a project, at every project page load (cached for 10 min *(working value)*) and when a task starts, read `readBranchRules` for its default branch. `projects.get` returns, per repo, `defaultBranchProtected` and `signedCommitsRequired` (each `true`, `false` or `unknown` with its reason). A task whose project has a repo requiring signed commits is refused at creation, with the message that ostra doesn't support signed-commit repos yet (F-055). An unprotected default branch never refuses; its warning says why that's allowed: the agent holds no token and the git proxy accepts only the task's refs (F-060).
- **The ticket template:** `projects.getTicketTemplate`, `projects.saveTicketTemplate` (project admins; validated by ticket 06's validator) and `projects.previewTicketTemplate` (renders it on one of the Inbox's tickets, the render shown, never logged).
- **Storage and retention:** `organization.storage` for instance admins: the store in use, its blob count and total size, the cap, and whether the S3 store is configured. `instance.saveRetention` sets the retention period (or none), with an audit entry.

## Decided 2026-11-19 (ticket 40)

The lead, on the maintainer's delegation, settled the open points the milestone 2 targets (`context/brand/app-targets/m2/`) and ticket 40 left. They're part of what to build:

- **`projects.get`'s repos** gain `private`, `checkedAt`, `defaultBranchProtected` and `signedCommitsRequired`, each in `repoBranchRulesSchema`'s shape (ticket 06), read from `Repo.branchRules` within its 10 minutes.
- **`projects.checkRepos { projectId }`:** a project admin re-reads the rules now. It's the target's `Check again`.
- **`organization.storage`** also returns:
  - the store's `health()`
  - the retention in effect and its source: `saved`, `env` or `default`
  - the last `retention.swept` audit entry (ticket 20)
- **`instance.saveRetention`** writes `retentionSetAt` with the value, so a saved "keep" wins over the env too.

## Done when

- [x] Tests against the fake code host: each combination of the two checks shows as it should; a signed-commit repo refuses task creation and a prompt task alike; "unknown" never refuses; the template is validated, saved and previewed; the storage figures count only the organization's blobs; only instance admins change retention.
- [x] Committed as `✨ add repo checks, template and storage`.

## Comments
- 2026-11-19, api: done (`✨ add repo checks, template and storage`, `6733044`). For tickets 29, 30 and 37:
  - **Repo checks** are `checkProjectRepos` in `@ostra/domain` (`use-cases/repo-checks.ts`): it keeps `private`, `branchRules` and `branchRulesCheckedAt` on the `Repo` row, reuses them for 10 minutes unless `force`, and gives `unknown` with a reason for a host that can't say (cached) or doesn't answer (not cached). It runs as a repo is added (`projects.create`), at `projects.get`, on `projects.checkRepos` and, forced, before `tasks.create`. The use case itself only reads the stored rules (`unsupportedRepos`), so `createPromptTask` gained the error `repo-unsupported` (additive), and ticket 29's `startTicketTask` should call `checkProjectRepos` with `force: true` before its transaction and refuse the same way.
  - **`projects.get`'s repos** are `{ repoId, fullName, defaultBranch, private, checkedAt, defaultBranchProtected, signedCommitsRequired }`, each check `{ result: true | false | "unknown", reason? }`.
  - **Template:** `projects.getTicketTemplate` (saved text, `builtIn`, the built-in text, the vocabulary, the cap), `projects.saveTicketTemplate` (a template that fails the validator comes back as `{ saved: false, problems }`, not an error; `null` or blank resets), `projects.previewTicketTemplate` (a mutation, since the text can be long; renders on a cached ticket with comments, relations and images empty).
  - **Storage:** `organization.storage` and `instance.saveRetention` are for instance admins (`instanceAdminProcedure`, new in `trpc/init.ts`). `ApiDeps` gained `blobStore` (a name and a `health()`), and `ApiSettings` `retentionDays`, `blobStore`, `trackerPollSeconds` and `reconcileMinutes`; `createApiRuntime` takes `blobStore`, which the panel's composition root builds (a database ping for the built-in store, until an S3 adapter is wired in). The last sweep is read from the newest `retention.swept` audit entry, whose `data` ticket 20 decides.
  - Test helpers for the next tickets: `seedLinearConnection`, `seedBoard`, `seedTicket` in `@ostra/api/testing`, and `FakeCodeHost.branchRules`.
