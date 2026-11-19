# 32: The end-to-end demo and the ledger

Status: ready-for-agent
Builder: core (lead), with each builder on call for their part
Blocked by: 03, 04, 11, 13, 16 to 24, 36 (it was also 06 to 10, 14, 15, 31, 35, 37 and 38, which are `wontfix` since 2026-11-19)
Features: every F-ID in the spec's section 2
Packages: `e2e/m7-launch/` (new), `package.json` (`pnpm e2e:m7`), `context/features.md`, `context/proof/`, `context/specs/m7-launch/demo.md` and `demo/` (new), this ticket's `## Comments`, `README.md`
Spec: `../spec.md`, section 3
Note: changed 2026-11-19. Claude Code (F-018) moved after v1, so the demo runs on OpenCode alone: section 3's steps 1, 2 and 10 are withdrawn, and F-018 and F-033 leave this ticket's ledger work.

## What to build

- **`e2e/m7-launch/`:** a script that runs part A of spec section 3 against a fresh dev stack and the test workspaces: OpenCode on real tickets, the check that no credential leaked, stepping in (with "allow for this task", the stop and both reopens), the review, refine and memory, and the keyboard, theme and phone steps in Playwright. Then the checks after the run.
- **The run, by hand, once,** in a real browser, following part A, and **part B** once on the maintainer's Linux machine (ticket 34, step 6). What was seen goes in `demo.md` (times, URLs, the PRs, screenshots with addresses masked, anything that surprised).
- **The ledger:** in the same commit as the record, set each row of section 2 to the status its "At M7's end" column says, if and only if every condition in its "done when" holds. F-058 is `done` only once published; F-076 only with ticket 25's two runs; F-117 only with the Linux run; F-039 only once the release ran (ticket 33 sets it then). Every row left `building` gets a dated note naming what's left.
- **The proofs** (`context/proof/README.md`, spec section 10.1): every row set to `done` has its proof file, every condition `proved` by a test that names the row's ID and has a break-it check, or by live evidence kept in `context/specs/m7-launch/demo/`. The `building` rows get their proof files too, with the plan for the rest in the notes.
- **The README:** milestone 7's status line, as it is.

## Done when

- [ ] `pnpm e2e:m7` passes on this machine twice in a row from an empty data folder.
- [ ] Every step of section 3 happened, recorded in `demo.md`, or is recorded as not run with the reason (no Linux machine yet). Steps 1, 2 and 10 are withdrawn and not run.
- [ ] Every check after the run passes.
- [ ] `pnpm check:proof` passes with every `done` row of section 2 proved.
- [ ] All the checks for the whole repo pass.
- [ ] Committed as `✅ add the milestone 7 end-to-end demo`, and the record and ledger as `📝 set milestone 7's ledger statuses`.

## Comments
