# 25: The 30-minute measure

Status: ready-for-human
Builder: core (lead), with two people new to ostra whom the maintainer picks
Blocked by: 22, 24, 29, 31
Features: F-076, F-001 (its first sentence's live evidence)
Packages: `context/specs/m7-launch/measure/` (new), `context/proof/F-076.md`
Spec: `../spec.md`, sections 2 and 10.1; ADR 0064 ("The 30-minute measure")

## Why a person

F-076 says "an organization new to ostra". Nobody who built it, and no agent, is new to it.

## What to do

1. **The rehearsal** (core, an agent session with a browser, on the maintainer's Linux machine with Docker; not this Windows machine, which can't run `docker compose up`, and not the proof job, which runs the guide's commands mechanically (ticket 22) but can't follow prose): the install guide followed with no knowledge but the docs site. Every gap it hits is a docs bug, fixed in ticket 22 or 23 before step 2. Recorded as a rehearsal; it never counts.
2. **Two measured runs,** one per newcomer, on a Linux machine with Docker that has never run ostra, with the release candidate's images, `ostra-test` as their GitHub organization and the model provider of `model.env` (given to them by the maintainer, never written in the record). Each writes down the time of the guide's first command, then follows the docs site only; nobody answers their questions. The clock stops when their first agent-made PR is open on GitHub.
3. **The record,** per run, in `context/specs/m7-launch/measure/run-<n>/`: `timeline.json` from `pnpm measure:setup`, the person's notes on where they slowed down (no name unless they agree), the PR's link, screenshots with addresses masked, and the docs commit they followed. A run over 30 minutes is kept with what changed in the docs before the next.
4. **The proof:** F-076's second condition cites both runs as `live:`; its first condition's "after `docker compose up`" cites them too.

## Done when

- [ ] The rehearsal is recorded, with what it changed in the docs.
- [ ] Two measured runs by two different newcomers are recorded, each under 30 minutes.
- [ ] `context/proof/F-076.md` cites them, and `pnpm check:proof` passes.
- [ ] Committed as `📝 record the 30-minute measure`.

## Comments
