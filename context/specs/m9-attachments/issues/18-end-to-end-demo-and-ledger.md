# 18: The end-to-end demo and the ledger (at the launch gate)

Status: ready-for-agent
Builder: core (lead)
Blocked by: 02 to 17; the maintainer's word for the launch gate (milestone 7's held tickets, with milestone 8's ticket 33)
Features: F-148, F-149, F-150
Packages: `e2e/m9-attachments/` (the scripted demo, `pnpm e2e:m9`), `context/specs/m9-attachments/demo.md` (new), `context/features.md`, `README.md`, `context/build-order.md`
Spec: `../spec.md`, sections 3 and 10.1

## What to build

- **Before the gate:** the milestone's Playwright specs run once (tickets 15 and 16's), and each row's tests are checked against section 10.1's keys; a missing one goes back to its ticket.
- **At the gate,** with milestone 7's ticket 32 and milestone 8's ticket 33: the scripted run of section 3's thirteen steps and its checks, then the manual run with ticket 19's real Linear ticket and real models. Results in `demo.md`, step by step, with the thread's screenshots kept.
- **The ledger:** F-148, F-149 and F-150 set by section 2's "At M9's end", with dated notes for anything a live run still owes. `README.md`'s milestone row and `build-order.md` say where milestone 9 stands.

## Done when

- [ ] The browser specs passed once, and every condition key of section 10.1 has its test.
- [ ] The scripted run passed every step and check (at the gate).
- [ ] The manual run passed, or its misses are tickets (at the gate).
- [ ] The ledger, the README and the build order say where it stands.
- [ ] Committed as `✅ run milestone 9's demo and set its rows`.

## Comments
