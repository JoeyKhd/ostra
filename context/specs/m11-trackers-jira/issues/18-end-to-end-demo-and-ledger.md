# 18: The end-to-end demo and the ledger (at the launch gate)

Status: ready-for-agent (held for the launch gate)
Builder: core (lead)
Blocked by: 01 to 17; ticket 19's test site; the maintainer's word for the launch gate (milestone 7's held tickets, with the demos of milestones 8, 9 and 10)
Features: F-152, F-008
Packages: `e2e/m11-trackers-jira/` (new: the scripted run, `pnpm e2e:m11`), `apps/web/e2e/28-*.spec.ts` to `32-*.spec.ts` (run, not written), `packages/adapters/adapter-jira/src/jira-adapter.live.test.ts` (run), `context/specs/m11-trackers-jira/demo.md` (new), `context/features.md`, `README.md`, `context/build-order.md`
Spec: `../spec.md`, sections 3 and 10.1

## What to build

- **Before the gate:** the milestone's browser specs run once (tickets 12 to 16's), and each condition of F-152 and F-008 is checked against section 10.1's keys; a missing test goes back to its ticket. The scripted run of section 3 is written and passes on the fakes.
- **At the gate,** with milestone 7's ticket 32 and the demos of milestones 8, 9 and 10: the manual run of section 3's fifteen steps and its checks on `host`, with the maintainer's Jira Cloud test site (ticket 19), its service account and admin webhook through the tunnel, and `adapter-jira`'s live test. The answers to S-10 and S-12 go into `research/trackers.md` §5 and ADR 0047's consequences. Results in `demo.md`, step by step, with screenshots of the new screens at 1440 and 390 px in both themes beside the targets.
- **The ledger:** F-152 and F-008 set by section 2's "At M11's end", with dated notes for anything the run still owes; the touched rows' notes checked. `README.md`'s milestone row and `build-order.md` say where milestone 11 stands.

## Done when

- [ ] The browser specs passed once, and every condition key of section 10.1 has its test.
- [ ] The scripted run passes on the fakes.
- [ ] The live run passed every step and check (at the gate), or its misses are tickets; S-10 and S-12 recorded.
- [ ] The ledger, the README and the build order say where it stands.
- [ ] Committed as `✅ run milestone 11's demo and set its rows`.

## Comments
