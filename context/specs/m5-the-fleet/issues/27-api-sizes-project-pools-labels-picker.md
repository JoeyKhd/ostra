# 27: API: box sizes, project pools, profile labels and the runner picker

Status: done
Builder: api
Blocked by: 13, 14
Features: F-095, F-069, F-086, F-014
Packages: `packages/api` (`src/routers/box-sizes.ts` (new), `src/routers/projects.ts`, `src/routers/agent-profiles.ts`, `src/routers/tasks.ts`)
Spec: `../spec.md`, sections 3 (steps 1, 5, 7 and 8) and 11, items 4 to 7

## What to build

- **`boxSizes.list`** and **`boxSizes.update { name, cpuMillis, memoryMiB }`** (admins; the three names only; at least 500 millicores and 1 GiB *(working values)*), each change an audit entry.
- **`projects.setPools { projectId, pools: [{ poolId, maxBoxes | null }] }`** (project admins and organization admins): the order is the list's; a pool of another organization is refused. **`projects.setDefaultBoxSize`**.
- **`agentProfiles` grows `runnerLabels`:** validated by the protocol's label schema, reserved prefixes refused.
- **`tasks.runnerChoices { projectId, profileId }`** for New task: "A pool" with the pools that could take it now, and the member's own personal runner when they have one, each with whether it can and why not (offline, busy, no services, the provider not allowed on personal runners).
- **`tasks.create`** takes an optional `runnerId` only for the caller's own personal runner.

## Done when

- [x] Tests named for their rows: sizes updated by an admin and refused for a member and below the minimum (`F-095`); the pool list's order and shares, refused across organizations (`F-086`); a profile's labels, reserved ones refused (`F-069`); the picker's reasons; another member's personal runner refused in `tasks.create` (`F-014`).
- [x] Break-it: accepting another member's personal runner in `tasks.create` fails its test; recorded in `context/proof/F-014.md`.
- [x] Committed as `✨ add sizes, project pools and labels to the API`.

## Comments

- 2026-11-20: built in `packages/domain/src/use-cases/fleet-settings.ts` (new: `setBoxSizes`, `setProjectPools`, `setProfileLabels`, `profileLabelsRefusal`), `packages/api/src/routers/box-sizes.ts` (new: `boxSizes.list`, `boxSizes.update`), `project-runners.ts` (new, spread into `projects`: `runners`, `setPools`, `setDefaultBoxSize`), `task-runner-choices.ts` (new: `tasks.runnerChoices`) and `agent-profiles.ts` (`runnerLabels` on every row, `setRunnerLabels`). Tests: `packages/api/src/routers/fleet-settings.test.ts`; proof rows in `context/proof/F-095.md`, `F-086.md`, `F-069.md` and `F-014.md`. Decisions:
  - The signatures grew additively: `setBoxSizes` takes some of the three sizes (`boxSizes.update` sets one, in one transaction), and `setProjectPools` takes `pools` and `defaultBoxSize` each optional, a field left out kept, so `projects.setDefaultBoxSize` is the same use case.
  - Sizes: at least 500 millicores and 1024 MiB, at most 256 vCPUs and 2 TiB. Every member reads them (`boxSizes.list`: a project's default names one); an organization admin changes them. Each changed size is a `box-size.updated` entry naming the organization, with the size's limits before and after, and every pool's admission looks again.
  - A project's pools: at least one, each once, each of the organization's (else `BAD_REQUEST`, and nothing changes). The project's admins and the organization's set them. `project.pools-set` and `project.default-box-size-set` are new audit actions, and the pools it had and has each get `queue.admit`. `projects.runners` reads the list (the default pool, `listed: false`, when the project lists none).
  - Profile labels are refused when they don't match `runnerLabelSchema` or use a reserved prefix, as this ticket says. **This differs from the protocol's comment on `reservedLabelPrefixes` ("a profile may ask for one")**: a profile can't ask for `executor:kubernetes` or `os:linux` today. Lifting the refusal is one line in `profileLabelsRefusal`, for the maintainer to decide. Labels are stored sorted and once each; a change is an `agent-profile.updated` entry; a queued task keeps the labels it was queued with.
  - The picker runs `chooseRunner` over the dispatch's rows without its locks: per pool in the project's order (`canRun` and the reason), and across them for the nearest miss. Personal runners are the caller's own only, each `offline`, `needs-services`, `provider-not-allowed` or `busy` (checked in that order), with its busy boxes against its slots. `tasks.create` already took `runnerId` for the caller's own personal runner only (milestone 1's `runner-not-yours`); the test now proves it, and that a pool runner is refused too.
