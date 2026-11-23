# 09: The end-to-end demo and the ledger

Status: ready-for-agent
Builder: core (lead)
Blocked by: 01 to 08; 10's test account
Features: F-153, F-152, F-007, F-097, F-149
Packages: `e2e/post-v1-trello` (new), `context/features.md` (the F-153 row's status), `context/build-order.md` (when the feature is scheduled), `context/specs/post-v1-trello/demo.md` (new)
Spec: `../spec.md`, sections 3 and 9.1

## What to build

- **The scripted run** at `e2e/post-v1-trello/` (`pnpm e2e:trello`): spec section 3's fourteen steps that need no person, on the `host` executor, against the HTTP fake Trello at `OSTRA_TRELLO_API_URL`, the fake Linear at `OSTRA_LINEAR_API_URL`, and two fake bot members. It starts from a database at milestone 11 with a Linear and a Jira connection and a Trello-shaped pending row, and it records nothing secret.
- **The manual run,** once, in a real browser: the maintainer's real Trello account, its app key and secret, its bot member's Allow through the tunnel, a real board and card to a merged PR, and the checks of spec section 3.
- **The demo write-up** in `demo.md` next to the spec: both runs' screenshots-free record, each step's result, and every section 11 detail the real account settled (the download's redirect, the board-cards paging, the payload's field names, the two size limits, the seat, the terms).
- **The ledger:** set F-153's status `done` in `context/features.md` only when every condition c1 to c11 has a passing test named with its key, with c11's live run recorded in `demo.md`; otherwise leave it `building` with the note of what waits. A condition only the live run shows waits for this ticket; no proof file.
- **The build order:** the feature's line (the orchestrator's, applied with the spec) and, when the feature ships, the note that Trello left "right after" and its picker tile is enabled.

## Done when

- [ ] Every F-153 condition's test exists, is named with its key, and passes in CI; the live-only conditions are recorded in `demo.md` from the manual run.
- [ ] The scripted run's own checks pass: nothing leaked (searched by value), the connections kept apart, the contract suite green for every subject, and `test1` cleaned up.
- [ ] `context/features.md`'s F-153 row and `context/build-order.md` are updated in the same commit as the run's result; no other shared row changes.
- [ ] Committed as `✅ prove Trello end to end`.
