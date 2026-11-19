# 33: The launch: the release run, after the go

Status: ready-for-human
Builder: maintainer, with core
Blocked by: 25 to 32, 35 to 38; ticket 34's steps 4 and 9 (the names, the go)
Features: F-039, F-058 (published), every v1 row's final status
Packages: none but the record: this ticket's `## Comments`, `context/features.md`, `README.md`
Spec: `../spec.md`, sections 1 and 4; ADR 0064 ("The gates", "The release")

## Why a person

A release is the maintainer's act, and it waits for decisions only the maintainer can make (ADR 0048, ADR 0064).

## What to do

1. **The gates,** checked against ADR 0064's table, each with its evidence linked here: the ledger, two agents, the measure, the load test, the security review, the legal items, the names.
2. **The licensor line.** Q110's answer is the line as it is today, "JoeyKhd (https://github.com/JoeyKhd), the maintainer of ostra" (ADR 0048, settled 2026-11-19), so there is nothing to set: ticket 30's test shows that `LICENSE`, `NOTICE` and every published `package.json` match it. Only if a company has become the licensor by then does the line change, in the one place ticket 30 reads it from, in its own commit before the release.
3. **The maintainer's go,** written here with the date.
4. **`gh workflow run Release -f version=1.0.0 -f dry-run=false`,** by the maintainer. Its run is linked here, with each image's digest and each package's version.
5. **One `docker run`:** on the maintainer's Linux machine, the published runner image started with a pool's join token (F-039's "a new pool runner is one `docker run` with a join token"), joining the pool and taking a task; its log is kept as F-039's live evidence.
6. **Afterwards,** in one commit: F-039 and F-058 set `done` with their proofs (the release's run, the published runner's join, the site's address); the README's status says v1 is out, with the install guide's link; `context/README.md` and `build-order.md` say milestone 7 is done.

## Done when

- [ ] Every gate's evidence is linked here, and the go is written with its date.
- [ ] The licensor line matches Q110's answer everywhere.
- [ ] The release ran, and its run is linked; the published runner image joined a pool with one `docker run`.
- [ ] The ledger, the README and the build order say what's true after it.

## Comments
