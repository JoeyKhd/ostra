# 27: API: box sizes, project pools, profile labels and the runner picker

Status: ready-for-agent
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

- [ ] Tests named for their rows: sizes updated by an admin and refused for a member and below the minimum (`F-095`); the pool list's order and shares, refused across organizations (`F-086`); a profile's labels, reserved ones refused (`F-069`); the picker's reasons; another member's personal runner refused in `tasks.create` (`F-014`).
- [ ] Break-it: accepting another member's personal runner in `tasks.create` fails its test; recorded in `context/proof/F-014.md`.
- [ ] Committed as `✨ add sizes, project pools and labels to the API`.

## Comments
