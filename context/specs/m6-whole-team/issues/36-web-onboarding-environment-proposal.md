# 36: Web: the onboarding task and the environment proposal

Status: done
Builder: web
Blocked by: 29, 30
Features: F-113
Packages: `apps/web` (the project's environment page)
Spec: `../spec.md`, section 12 (`environment-proposal`, and the environment page growing)

## What to build

- "Test this environment", the running task's line, the proposal's diff per repo with its notes, "Accept", "Edit and accept", "Reject", and the `AGENTS.md` PR's link; the proposal's needs-you row for project admins.

## Done when

- [x] Playwright, with the proposing fake: start the task, see the proposal, edit and accept it.
- [x] Checked against its target at 1440 px and at phone width, in dark and light.
- [x] The touched packages' checks pass (spec section 9).
- [x] Committed as `✨ add the environment proposal screen`.

## Comments

- 2026-11-20: built in `✨ add the environment proposal screen`. The environment page gains the Proposal tab (`apps/web/src/components/projects/environment-proposal.tsx`, `?tab=proposal`, shown once the project has an onboarding task, with a dot while a proposal waits: amber for its admins), the banner on the other tabs, and "Test this environment" in the top bar for project admins (disabled with its reason while a task or a proposal is open; a refusal shows in the page). The tab holds the task line (key, title, state, the `AGENTS.md` PR), the proposal as a diff per repo against the saved environment (the setup script's lines, checks, variable names by name only) and the services, the notes, and Accept, Edit and accept, Reject (with an optional reason); its panel shows the secret scan, the `AGENTS.md` PRs and the paths the commits left out.
- Additive server change, tested: `environments.onboarding` (the newest onboarding task with its PRs, the `commit.filtered` paths, and `canStart`).
- Choices: the script's line diff is computed in the panel (`proposal-words.ts`), from ticket 29's current and proposed scripts; "Edit and accept" edits the proposal in place (each repo's setup script and its checks' commands), not in the Setup and Services editors, and Cancel keeps nothing (open point 2); every member who can open the environment sees the tab, read-only for non-admins (open point 3). Not built: "Close" for a proposal with nothing to change (open point 1: it needs a decision kind the API doesn't have), the Superseded and lost-the-race lines, and the "against an old version" warning.
- Proof: `apps/web/e2e/20-environment-proposal.spec.ts` on the desktop and phone projects: the project made through New project on the fake GitHub's `test1`, its code profile given a model its list serves (`seed-onboarding-world.ts`, `model`: the stack has no model provider), "Test this environment" pressed, the proposing fake's `sampleProposal` stored as core's endpoint stores it (`propose`, with the `AGENTS.md` PR and a filtered commit), the diff read, the setup script edited and accepted, and the Setup tab read back. Break-it: "Edit and accept" sent without the edits failed the case. API and unit break-its, each failing its case: a waiting proposal not holding the start, no filtered paths, the edited commands dropped, no unchanged run folded. Rows in `context/proof/F-113.md`.
- Checked against `environment-proposal.webp` at 1440 px and at phone width, in dark and light; the finals are `C:/Users/santi/ow/_lead/ui-check/m6-environment-proposal*-final.png`.
