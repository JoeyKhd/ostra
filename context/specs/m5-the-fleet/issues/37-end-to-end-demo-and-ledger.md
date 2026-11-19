# 37: The end-to-end demo and the ledger

Status: ready-for-agent
Builder: core (lead), with each builder on call for their part
Blocked by: 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 24, 30, 31, 32, 33, 34, 35, 36
Features: every F-ID in the spec's section 2
Packages: `e2e/m5-the-fleet/` (the demo), `package.json` (`pnpm e2e:m5`), `context/features.md`, `context/proof/`, `context/specs/m5-the-fleet/demo.md` and `demo/` (new), this ticket's `## Comments`, `README.md`, `context/build-order.md` (where the spikes stand: spike 3's and 6's checks that ticket 35 ran)
Spec: `../spec.md`, section 3

## What to build

- **`e2e/m5-the-fleet/`:** a script that runs spec section 3 against a fresh dev stack with three core replicas and the test workspaces. It signs in as milestone 1's default first admin with `OSTRA_ALLOW_DEFAULT_PASSWORD=true`, starts ticket 36's dev tools, packs and installs the CLI from its tarball, starts every runner of the steps from it (the `host` pool's with `OSTRA_DEV_HOST_POOL_SAME_USER=true`), builds the minor-3 and minor-2 runners from their tags (ticket 16's script), drives two browsers (Demo, Sam) with Playwright, renders the runner chart and applies it to the fake API, and runs `pnpm load:run --ramp` last. Then the checks after the run.
- **The run, by hand, once,** following section 3 in real browsers, with Sam's personal runner signed in by device code for real. What was seen goes in `demo.md`: times, the fleet view's and the pool page's screenshots, the fake cluster's pod as JSON with the secrets' values masked, the load ramp's summary, links to ticket 35's job runs, and anything that surprised.
- **The ledger:** in the same commit as the record, set each row of section 2 to the status its "At M5's end" column says, if and only if every condition in its "done when" holds. The rows that stay `building` (F-093, F-039, F-117, and any whose ticket 35 job didn't pass) get dated notes saying what's proved and what waits, on which machine. F-086, F-017, F-001, F-051, F-094, F-096, F-036 and F-045 get dated notes for what milestone 5 added.
- **The proofs** (`context/proof/README.md`, spec section 9.1): every row set to `done` has its `context/proof/F-nnn.md`, every condition `proved` by a test that names the row's ID and has a break-it check, or by live evidence from this run or ticket 35's kept in `context/specs/m5-the-fleet/demo/`. The `building` rows get their proof files too, with what's proved so far, and `partial` where a machine this one isn't is still needed.
- **The README:** milestone 5's status line, as it is.

## Done when

- [ ] `pnpm e2e:m5` passes on this machine twice in a row from an empty data folder.
- [ ] Every step of section 3 happened in the manual run, recorded in `demo.md`.
- [ ] Every check after the run passes.
- [ ] `pnpm check:proof` passes with every `done` row of section 2 proved, and no row set `done` on a condition that only a machine this one isn't could show without that machine's log.
- [ ] All the checks for the whole repo pass.
- [ ] Committed as `✅ add the milestone 5 end-to-end demo`, and the record and ledger as `📝 set milestone 5's ledger statuses`.

## Comments
