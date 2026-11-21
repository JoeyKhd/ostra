# 33: The end-to-end demo and the ledger (at the launch gate)

Status: ready-for-agent
Builder: core (lead)
Blocked by: 10 to 32; the maintainer's word for the launch gate
Features: F-121, F-140, F-141, F-142, F-143, F-144, F-145, F-146, F-147
Packages: `e2e/m8-previews-and-library/` (new), `context/specs/m8-previews-and-library/demo.md` (new), `context/features.md`, `README.md`, `context/build-order.md`
Spec: `../spec.md`, sections 3 and 10.1
Note: held for the launch gate (`build-order.md`, 2026-11-20: "Milestone demos move to the launch gate too"). It runs once, with milestone 7's ticket 32, when the maintainer says it's time. Until then, each building ticket's own tests and proofs stand.

## What to build

- **`pnpm e2e:m8`:** the scripted run of spec section 3, steps 1 to 14, with their checks after the run, in `e2e/m8-previews-and-library/`:
  - the `test-web` fixture (ticket 03's), pushed to `ostra-test/test-web` for the live run;
  - the fake MCP registry, the stub MCP server and the fake skills search;
  - a helper that pushes a commit to the fake skill repo for step 13;
  - two core processes for the replicas' check;
  - the leak search by value, never printed.
- **The manual run,** once: the same steps in real browsers, with real GitHub sources, GitHub's MCP registry and skills.sh's search, a signed-out second browser, and Safari on a Mac if ticket 34 has one.
- **The record:** `demo.md` next to the spec, with each step's result, the screenshots kept, the commits it ran on, and what waited (the Linux jobs, Safari).
- **The ledger:** each row of spec section 2 set to its status, if and only if every condition of its "done when" holds, each with a passing test named with its key (*changed 2026-11-21: it was "and its proof file proves it (`pnpm check:proof`)", the maintainer: "keep tests, drop extras"*). Each row's note says what waits.
- **`README.md`'s** milestone 8 row and **`build-order.md`'s** "Where it stands" updated in the same commit.
- **Clean-up** as section 3 lists it, in `test1`, `test2` and `test-web` only.

## Done when

- [ ] The scripted run passes from a fresh clone, and its log is in the repo.
- [ ] The manual run is recorded in `demo.md`.
- [ ] Every row of section 2 has its status, each `done` row with a passing test for each condition. *Changed 2026-11-21: it was "and `pnpm check:proof` passes", gone with the proof files.*
- [ ] The browser suite runs once, in full, here (the milestone's one full run, `AGENT-RULES.md`).
- [ ] Committed as `✅ add the milestone 8 end-to-end demo`, and the record and ledger as `📝 set milestone 8's ledger statuses`.

## Comments
