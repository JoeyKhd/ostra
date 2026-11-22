# 19: The end-to-end demo and the ledger (at the launch gate)

Status: ready-for-agent
Builder: core (lead)
Blocked by: 01 to 18; the maintainer's word for the launch gate (milestone 7's held tickets, with milestone 8's ticket 33 and milestone 9's ticket 18)
Features: F-151
Packages: `apps/web/e2e/27-thread-*.spec.ts` (run, not written), `context/specs/m10-compact-thread/demo.md` (new), `context/features.md`, `README.md`, `context/build-order.md`
Spec: `../spec.md`, sections 3 and 10.1

## What to build

- **Before the gate:** the milestone's browser specs run once (tickets 09 to 17's `27-thread-*.spec.ts`), and each condition of F-151 is checked against section 10.1's keys; a missing test goes back to its ticket.
- **At the gate,** with milestone 7's ticket 32 and milestones 8's and 9's demos: the live run of section 3's eleven steps and its checks, on `host` with the pinned OpenCode and a real model on `test1`. Results in `demo.md`, step by step, with the thread's screenshots at 1440 and 390 px in both themes kept beside the targets.
- **The ledger:** F-151 set by section 2's "At M10's end", with dated notes for anything the run still owes; the touched rows' notes checked. `README.md`'s milestone row and `build-order.md` say where milestone 10 stands.

## Done when

- [ ] The browser specs passed once, and every condition key of section 10.1 has its test.
- [ ] The live run passed every step and check (at the gate), or its misses are tickets.
- [ ] The ledger, the README and the build order say where it stands.
- [ ] Committed as `✅ run milestone 10's demo and set its row`.

## Comments
