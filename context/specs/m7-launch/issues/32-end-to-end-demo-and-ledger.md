# 32: The end-to-end demo and the ledger

Status: needs-triage
Held: until the maintainer says it is time for the launch gate. The maintainer, 2026-11-20: "make sure you skip the things that you might need to redo later. for example i might add more features in between. so perhaps a security review should come at the absolute end when i tell you it's time to do it?"
Builder: core (lead), with each builder on call for their part
Blocked by: 03, 04, 11, 13, 16 to 24, 36 (it was also 06 to 10, 14, 15, 31, 35, 37 and 38, which are `wontfix` since 2026-11-19)
Features: every F-ID in the spec's section 2
Packages: `e2e/m7-launch/` (new), `package.json` (`pnpm e2e:m7`), `context/features.md`, `context/specs/m7-launch/demo.md` and `demo/` (new), this ticket's `## Comments`, `README.md`
Spec: `../spec.md`, section 3
Note: changed 2026-11-19. Claude Code (F-018) moved after v1, so the demo runs on OpenCode alone: section 3's steps 1, 2 and 10 are withdrawn, and F-018 and F-033 leave this ticket's ledger work.

## What to build

- **`e2e/m7-launch/`:** a script that runs part A of spec section 3 against a fresh dev stack and the test workspaces: OpenCode on real tickets, the check that no credential leaked, stepping in (with "allow for this task", the stop and both reopens), the review, refine and memory, and the keyboard, theme and phone steps in Playwright. Then the checks after the run.
- **The run, by hand, once,** in a real browser, following part A, and **part B** once on the maintainer's Linux machine (ticket 34, step 6). What was seen goes in `demo.md` (times, URLs, the PRs, screenshots with addresses masked, anything that surprised).
- **The ledger:** in the same commit as the record, set each row of section 2 to the status its "At M7's end" column says, if and only if every condition in its "done when" holds. F-058 is `done` only once published; F-076 only with ticket 25's two runs; F-117 only with the Linux run; F-039 only once the release ran (ticket 33 sets it then). Every row left `building` gets a dated note naming what's left.
- **The tests** (`AGENTS.md`, "Proof"; *changed 2026-11-21, the maintainer: "keep tests, drop extras"*): every row set to `done` has a passing test named with its key for each condition of its "done when". A condition only a live run shows is shown by this run, recorded in `demo.md`, or by the launch-gate Proof run below. No proof file, no break-it pass.
- **The one Proof run** (ADR 0064, "The Proof run"; *added 2026-11-21, the maintainer: "Launch gate only"*): `gh workflow run Proof -f jobs=all` on the release candidate, dispatched once by the lead on the maintainer's word, beside the load test (26) and the security review (27, 28). It runs the panel's e2e suite, the docs' commands, and the live jobs on Linux with Docker, on kind and on macOS, with ticket 28's adversarial job. A job that fails is fixed and the run repeated. Then every "done when" box, in every milestone's tickets, that waited for it ("waits for the launch-gate Proof run") is ticked or reopened with what the run showed, and the ledger rows that waited for it are set.
- **The README:** milestone 7's status line, as it is.

## Done when

- [ ] `pnpm e2e:m7` passes on this machine twice in a row from an empty data folder.
- [ ] Every step of section 3 happened, recorded in `demo.md`, or is recorded as not run with the reason (no Linux machine yet). Steps 1, 2 and 10 are withdrawn and not run.
- [ ] Every check after the run passes.
- [ ] Every `done` row of section 2 has a passing test for each condition. *Changed 2026-11-21: it was `pnpm check:proof`, gone with the proof files (the maintainer: "keep tests, drop extras").*
- [ ] All the checks for the whole repo pass.
- [ ] The launch-gate Proof run passed on the release candidate (`gh workflow run Proof -f jobs=all`), its run linked under `## Comments`, and every box and ledger row that waited for it settled. *Added 2026-11-21 (the maintainer: "Launch gate only").*
- [ ] Committed as `✅ add the milestone 7 end-to-end demo`, and the record and ledger as `📝 set milestone 7's ledger statuses`.

## Comments
- 2026-11-20: held for the launch gate, on the maintainer's word; set back to `ready-for-agent` when they call it.
