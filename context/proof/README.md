# The proof ledger

The maintainer, 2026-11-19: "testing is extremely important, you need to be able to prove that everything you build/built works as intended."

A feature in `context/features.md` is `done` only when every condition of its "done when" holds. This folder holds the proof that each one does: one file per feature row, `F-nnn.md`, with one table row per condition. `pnpm check:proof` checks it, in CI and before every commit that touches a feature.

## A proof file

A proof file looks like this (the tests and paths here are made up):

```markdown
# F-025: Stop

| Condition | Proved by | Kind | Break-it | Status |
|---|---|---|---|---|
| A member stops a task's agent. | `apps/web/e2e/04-task.spec.ts` > "F-025: Stop stops the task" | e2e | returned early from `stopTask` in `packages/api/src/tasks.ts` | proved |
| The task's branches and its hidden ref, which holds any unfinished work, stay, ready to reopen (F-033, F-096). | `packages/domain/src/stop.test.ts` > "F-025: stopping keeps the branches and the hidden ref"<br>live: `context/specs/m1-first-pr/demo/run-3.log` | integration, live | deleted the branch in `releaseBox` | proved |
```

- **Condition:** one sentence of the "done when", **quoted verbatim**. A sentence ends at `.`, `?` or `!` followed by a space, outside code spans and parentheses. The dated notes in italics (`*Changed 2026-11-18: ...*`, `*Building ...*`, `*Done ...*`, `*Note ...*`) are not conditions; `*(working value)*` is part of its sentence. `pnpm proof:new` does the splitting for you, so copy nothing by hand.
- **Proved by:** what proves it, several separated by `<br>`:
  - a test: `` `path/to/file.test.ts` > "exact test name" ``, the path from the repo root and the test's own title (not its describe blocks), character for character. The title names the feature's ID: `it("F-025: ...")`.
  - live evidence: `live: <path>` to a file kept in the repo (a log, a screenshot), or `live: https://...` (a real PR).
- **Kind:** `unit`, `integration`, `e2e` or `live`, several separated by commas when the row cites several kinds. A test citation needs a test kind, and live evidence needs `live`.
- **Break-it:** what you broke in the code to watch the test fail (an inverted condition, a dropped call, an early return), then restored. A row that cites a test needs one. Live evidence can leave it `—`.
- **Status:** `proved`, `partial` (some proof, not enough for the whole sentence) or `missing`. Write `—` in the other cells while a row is missing.

Write notes below the table if you need them; the check reads only the table.

## What counts as proof

- A test that **exercises the behaviour for real**, through the real code path, and asserts the outcome. Fakes are only for external services (GitHub, Linear, a model endpoint).
- A test that **would fail if the behaviour broke**. Prove that with a break-it check: break the code it covers, run the test, see it fail, restore the code, and write down the break in the Break-it column.
- A test that can't fail, only re-asserts its own mock, or checks something weaker than the sentence is not proof. Mark the row `partial`.
- **Live evidence** (a real PR link, screenshots, logs from a real run) proves the conditions only a live run can show. Keep the evidence in the repo, or link a public page that stays.
- The cited test must run in CI. `check:proof` refuses a test that is skipped (`it.skip`, `test.fixme`, `describe.skip`), behind a condition (`it.skipIf`, `it.runIf`, `test.skip(condition)`) or expected to fail (`it.fails`). A test that only runs with live credentials is live evidence: cite its run's log instead.

## Adding a proof

1. `pnpm proof:new F-025` writes `context/proof/F-025.md` with every condition `missing`. Run it again after the "done when" changes: it keeps your rows, adds the new sentences as `missing`, and leaves rows whose sentence is gone at the end for you to move and delete.
2. Write or find the test for each condition. Put the ID in its title: `it("F-025: stopping keeps the branches", ...)`.
3. Break the code, watch the test fail, restore it. Fill in the row and set it `proved`.
4. Run `pnpm check:proof`. Set the feature `done` in `features.md` in the same commit as its last proof.

## What `pnpm check:proof` enforces

For every row of `features.md` whose status is `done`, it fails unless:

- `context/proof/F-nnn.md` exists;
- it has a row for every sentence of the "done when", matched verbatim, and no row for a sentence the "done when" doesn't have, and no sentence twice;
- every row is `proved`, with a kind, and a break-it for each test it cites;
- every cited test file exists, is a `*.test.*` or `*.spec.*` file, and holds a test with exactly that title, which runs and names the feature's ID;
- every piece of live evidence is a file in the repo or an `https` link.

For a `building` or `planned` row with a proof file, the same checks only warn. `pnpm check:proof --verbose` lists every condition that isn't proved yet, instead of a count. It also fails on a file here that isn't named after a feature row.

## The baseline

`baseline.json` lists the rows that were `done` before this ledger existed (2026-11-19) and wait for their proofs. `check:proof` only warns about them. The baseline only shrinks:

- the check fails once a baselined row is fully proved, until you remove it from the list;
- it fails when the list names a row that isn't `done`;
- never add a row to it. A row that becomes `done` from now on comes with its proofs.
