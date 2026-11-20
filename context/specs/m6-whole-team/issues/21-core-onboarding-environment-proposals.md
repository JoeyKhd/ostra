# 21: Core: the onboarding task and environment proposals

Status: done
Builder: core
Blocked by: 06
Features: F-113
Packages: `apps/core` (`src/onboarding/`, `src/runner-http/environment-proposal.ts`), `packages/domain`
Spec: `../spec.md`, section 4 ("The onboarding task"); ADR 0038 (amended)

## What to build

- **`startOnboarding`,** for a project admin: a code task with `onboarding: true` and the origin `onboarding`, from the built-in template (ticket 06's prompt) on the project's current environment, or the detected draft (F-112) when none is saved; the snapshot left out so the box starts from the base image; `tools: ["environment", "pr-text"]`; `commitPaths: ["AGENTS.md"]`, and the prompt names the repos that lack one. One open onboarding task per project.
- **`POST /runner/v1/tasks/:taskId/environment-proposal`:** an onboarding task only (else `wrong-kind`); the body checked by the protocol's schema; milestone 4's secret scan over the scripts and notes, and the environment's own secret values (a hit refuses with `secret-found`, naming the kind); an `EnvironmentProposal` (an earlier open one becomes `superseded`); `environment.proposed` in the thread; a needs-you item (`environment_proposal`) for the project's admins.
- **`decideEnvironmentProposal`:** "Accept" and "Edit and accept" save the environment's next version through milestone 1's `saveEnvironment` in one transaction with the audit entry; "Reject" with a reason. Only a project admin; the proposal never holds a secret's value, and accepting keeps the environment's existing secrets.
- **On `host`,** the template says services aren't available, and the task page says so; the proposal may still name services, which the admin sees as "not tested here".

## Done when

- [x] Tests named `it("F-113: ...")`: a project admin starts it and a member can't; the spec has no snapshot and the onboarding tools; a proposal with a secret's value is refused; accept saves a new version, keeping secrets; reject; only `AGENTS.md` reaches a PR (with ticket 23), and only for repos without one.
- [x] Break-it: the secret scan skipped fails its test; recorded in `context/proof/F-113.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add the onboarding task`.

## Comments

- 2026-11-20, committed as `✨ add the onboarding task`. Ticket 20 landed as 6c045c04 (with cccf9359, the review's body and page). Choices made here:
  - `startOnboarding` takes the project only: its environment is the project's one, so the signature's `environmentId` isn't needed. It goes through milestone 1's `createPromptTask` (the profile, the provider, the repos, the dispatch), then marks the task `onboarding` with the origin `onboarding`. Its refusals pass through.
  - The saved environment has one setup script for the workspace, not one per repo, so the prompt shows it with the first repo. Accepting a proposal turns its per-repo scripts into that one script, each repo's run in its own folder; a one-repo project's script is kept as it is.
  - Accepting keeps the environment's entries as they are (variables, files, and secrets by reference, so their values). The proposal's `variableNames` add no entries: they name values only an admin can give, and the panel (tickets 29, 36) shows them. Checks and services are upserted by name, and the others are kept. A new service has no variables, and an existing one keeps its own.
  - "The environment's next version": `Environment` has no version column, so `resultVersion` counts the environment's `environment.saved` audit entries after the save.
  - The item is for the project's admins. Needs-you audiences have no "project admins", so it's `project_members` (as domain-model.md's audience table says for environment proposals), and only an admin can decide it.
  - "Reject with a reason": the decision takes an optional reason. With no column for it, and audit data holding no content, the audit entry records only that one was given. Showing it is the panel's (ticket 36).
  - On `host`, the line is added to the prompt in the spec, where the box's executor is known. "Not tested here" for services is the panel's (tickets 29, 36), from the task's box.
  - The `environment.propose` job isn't used: the item is written in the endpoint's transaction.
  - The `AGENTS.md` PR itself needs ticket 23's runner commit. The test shows core's half (the spec's `commitPaths` through ticket 04's `splitByCommitPaths`, and the prompt naming only the repos without one).
- 2026-11-20: landed on main as 3f850ee9.
