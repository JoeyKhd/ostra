# 33: The launch: the release run, after the go

Status: ready-for-human
Builder: maintainer, with core
Blocked by: 25 to 32; ticket 34's steps 3, 4 and 9 (the legal items, the names, the go)
Features: F-039, F-058 (published), every v1 row's final status
Packages: none but the record: this ticket's `## Comments`, `context/features.md`, `README.md`
Spec: `../spec.md`, sections 1 and 4; ADR 0064 ("The gates", "The release")

## Why a person

A release is the maintainer's act, and it waits for decisions only the maintainer can make (ADR 0048, ADR 0064).

## What to do

1. **The gates,** checked against ADR 0064's table, each with its evidence linked here: the ledger, two agents, the measure, the load test, the security review, the legal items, the names.
2. **The maintainer's go,** written here with the date.
3. **`gh workflow run Release -f version=1.0.0 -f dry-run=false`,** by the maintainer. Its run is linked here, with each image's digest and each package's version.
4. **Afterwards,** in one commit: F-039 and F-058 set `done` with their proofs (the release's run, the site's address); the README's status says v1 is out, with the install guide's link; `context/README.md` and `build-order.md` say milestone 7 is done.

## Done when

- [ ] Every gate's evidence is linked here, and the go is written with its date.
- [ ] The release ran, and its run is linked.
- [ ] The ledger, the README and the build order say what's true after it.

## Comments
