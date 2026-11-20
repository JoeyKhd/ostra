# The proof ledger

The maintainer, 2026-11-19: "testing is extremely important, you need to be able to prove that everything you build/built works as intended." And 2026-11-20, on keeping it: "automate the paperwork".

A feature in `context/features.md` is `done` only when every condition of its "done when" holds. This folder holds the proof that each one does: one file per feature row, `F-nnn.md`, with one table row per condition. A test says which condition it proves in its name, and the tooling writes each row's list of tests and its status from the code. People write only what the code can't say: the break-it, live evidence, and why a row is held back.

## Proving a condition

1. `pnpm proof:new F-025` writes `context/proof/F-025.md`: one row per condition, each with its key (`c1`, `c2` ...) and `missing`. Run it again after the "done when" changes: it keeps your rows and their keys, adds the new sentences under new keys, and leaves rows whose sentence is gone at the end, for you to move and delete (a sentence only reworded may take its old row's key).
2. Write the test, and start its name with the feature's ID and the condition's key: `it("F-025/c1: stops the agent", ...)`. A test that proves several conditions, or several features, gives them all: `F-025/c1,c2, F-033/c4: ...`.
3. Break the code it covers, watch the test fail, restore the code, and write what you broke in the row's Break-it cell.
4. `pnpm proof:sync` writes the Tests and Status cells, then runs `pnpm check:proof`. Set the feature `done` in `features.md` in the same commit as its last proof; the check warns about a row whose every condition is proved and that isn't `done` yet.

## A proof file

The tests and paths here are made up:

```markdown
# F-025: Stop

| Key | Condition | Tests | Live | Break-it | Status |
|---|---|---|---|---|---|
| c1 | A member stops a task's agent. | `apps/web/e2e/04-task.spec.ts` > "F-025/c1: Stop stops the task" | — | returned early from `stopTask` in `packages/api/src/tasks.ts` | proved |
| c2 | The task's branches and its hidden ref, which holds any unfinished work, stay, ready to reopen (F-033, F-096). | `packages/domain/src/stop.test.ts` > "F-025/c2: stopping keeps the branches and the hidden ref" | `context/specs/m1-first-pr/demo/run-3.log` | deleted the branch in `releaseBox` | proved |
```

| Cell | Who writes it | What it holds |
|---|---|---|
| **Key** | `proof:new` | `c1`, `c2` and so on. A key belongs to its condition for good: never change one, and never give one to another sentence. |
| **Condition** | `proof:new` | One sentence of the "done when", **quoted verbatim**. A sentence ends at `.`, `?` or `!` followed by a space, outside code spans and parentheses. The dated notes in italics (`*Changed 2026-11-18: ...*`, `*Building ...*`, `*Done ...*`, `*Note ...*`) are not conditions; `*(working value)*` is part of its sentence. |
| **Tests** | `proof:sync` | Every test of the repo whose name gives the row's key and which runs, as `` `path/from/the/root.test.ts` > "its name" ``. Never edit it. |
| **Live** | you | Live evidence a test can't give: a file kept in the repo (a log, a screenshot), or an `https://` link that stays (a real PR). Several are separated by `<br>`. |
| **Break-it** | you | What you broke in the code to watch the row's tests fail (an inverted condition, a dropped call, an early return), then restored. Short. A row with tests needs one; a row with only live evidence can leave it `—`. |
| **Status** | `proof:sync`, and you | `proved` when the row has a test that runs and a break-it, or live evidence that exists, and `missing` otherwise. Write `partial: <why>` to hold back a row whose evidence doesn't cover the whole sentence, or `missing: <why>` to say what its proof waits for: `proof:sync` keeps both (a `missing` row that gains evidence becomes `proved`). |

Notes below the table are optional, and the check doesn't read them: keep them short, since the commits and the specs hold the history.

## Test names

- A test's keys are read from the **head** of its own name (not its describe blocks): the text before its first `: `, when it starts with an F-ID. `F-099/c1,c3, F-100/c2: ...` proves c1 and c3 of F-099 and c2 of F-100.
- A bare `F-099: ...` names the feature without proving a condition.
- `check:proof` fails a name whose key it can't read, such as `F-099/2: ...` or a key after the head.
- Tests are read from every `*.test.*` and `*.spec.*` file of the repo, outside `node_modules`, built folders and `spikes/`.

## What counts as proof

- A test that **exercises the behaviour for real**, through the real code path, and asserts the outcome. Fakes are only for external services (GitHub, Linear, a model endpoint).
- A test that **would fail if the behaviour broke**. The break-it check shows it: break the code it covers, run the test, see it fail, restore the code.
- A test that can't fail, only re-asserts its own mock, or checks something weaker than the sentence is not proof. Mark the row `partial: <why>`, or leave the key off the test.
- **Live evidence** (a real PR link, screenshots, logs from a real run) proves the conditions only a live run can show. Keep the evidence in the repo, or link a public page that stays.
- The test must run in CI. A test that is skipped (`it.skip`, `test.fixme`, `describe.skip`), behind a condition (`it.skipIf`, `it.runIf`, `test.skip(condition)`) or expected to fail (`it.fails`) is left out of the Tests cell, and `check:proof` names it. A test that only runs with live credentials is live evidence: put its run's log in the Live cell, and leave the key off its name.

## What `pnpm check:proof` enforces

It always fails when:

- a proof file's Tests or Status cells don't match the code, so a test renamed, deleted or newly keyed fails the check until `pnpm proof:sync` writes them again;
- a test's name holds a key it can't read, or a key of a feature that isn't a row (or is `dropped`);
- a file here isn't named after a feature row.

For every row of `features.md` whose status is `done`, it fails unless:

- `context/proof/F-nnn.md` exists;
- it has a row for every sentence of the "done when", matched verbatim, and no row for a sentence the "done when" doesn't have, and no sentence twice;
- every key is `c<n>` and used once, and every key its tests give has a row;
- every row is `proved`: a running test and a break-it, or live evidence in the repo or at an `https` link;
- no test that gives one of its keys is skipped, behind a condition or expected to fail.

For a `building` or `planned` row with a proof file, or with keyed tests, the same checks only warn, and a warning names a row whose every condition is proved. `pnpm check:proof --verbose` lists every condition that isn't proved yet, instead of a count.

## The baseline

`baseline.json` lists the rows that were `done` before this ledger existed (2026-11-19) and wait for their proofs. `check:proof` only warns about them. The baseline only shrinks:

- the check fails once a baselined row is fully proved, until you remove it from the list;
- it fails when the list names a row that isn't `done`;
- never add a row to it. A row that becomes `done` from now on comes with its proofs.

## Proof files in the former form

Until 2026-11-20, a proof file cited each test by hand, under `| Condition | Proved by | Kind | Break-it | Status |`. `node scripts/proof-migrate.ts` converts such a file: it keys the rows by their place in the "done when", renames each cited test to give its keys (and its Vitest snapshots with it), moves the live evidence to the Live cell, keeps the break-its and the `partial` rows, makes a `missing` row that cited something `partial`, and writes the Tests and Status cells. It touches only files in the former form, so after a rebase onto the keyed form, run it on the rows your branch added. The Kind column is gone: the path says whether a test is a Playwright `*.spec.ts`, and the Live cell holds the live evidence.
