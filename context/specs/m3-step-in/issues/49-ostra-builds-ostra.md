# 49: ostra builds ostra

Status: ready-for-human
Builder: core (lead), with the maintainer
Blocked by: 50, 51 (steps 6 and 7)
Features: none new: the milestone's "ostra's own tickets run through ostra from here on" (`build-order.md`, Q101)
Packages: `docs/development.md`, `docs/agents/issue-tracker.md`, the moved tickets' `## Comments`
Spec: `../spec.md`, section 1

## What to build

From milestone 3, ostra's own development runs through ostra (`build-order.md`, "ostra builds ostra"). The repo is public and real, so nothing here starts until the maintainer names the workspace and the install (`AGENTS.md`: a real team's tracker or repos only when the maintainer names it).

- **The install:** an ostra install the maintainer runs, on the version tagged at milestone 3's demo, with a project `ostra` holding `JoeyKhd/ostra`, the GitHub App installed on that repo by the maintainer, an environment that runs `pnpm install` and the checks `pnpm typecheck`, `pnpm lint` and `pnpm test`, a profile `ostra-builder` with the repo's own `AGENTS.md` beside its instructions and the rules "Adding a dependency" and "Writing a migration", and plan first on.
- **The tracker:** the Linear workspace the maintainer names for ostra's own tickets, connected (milestone 2), with its team attached as the project's board.
- **The tickets move:** each open ticket under `context/specs/` that's `ready-for-agent` becomes a Linear ticket with a link back to its file; the file gets a line under `## Comments` with the Linear key. `docs/agents/issue-tracker.md` says where tickets live from then on, and that specs stay in `context/specs/`.
- **The first three:** three small open tickets run through ostra end to end, with their PRs reviewed and merged by the maintainer, recorded here with what went wrong.

## Done when

- [ ] The maintainer named the workspace and the install (ticket 51, steps 6 and 7).
- [ ] Three of ostra's own tickets became merged PRs through ostra, recorded here.
- [ ] `docs/agents/issue-tracker.md` and `docs/development.md` say how ostra's own work flows now.
- [ ] Committed as `📝 run ostra's own tickets through ostra`.

## Comments
