# 21: Core: the onboarding task and environment proposals

Status: ready-for-agent
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

- [ ] Tests named `it("F-113: ...")`: a project admin starts it and a member can't; the spec has no snapshot and the onboarding tools; a proposal with a secret's value is refused; accept saves a new version, keeping secrets; reject; only `AGENTS.md` reaches a PR (with ticket 23), and only for repos without one.
- [ ] Break-it: the secret scan skipped fails its test; recorded in `context/proof/F-113.md`.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add the onboarding task`.

## Comments
