# calc

A small expression calculator, as a library and as a command line.

```sh
npm install                       # dev tools only (TypeScript); the code has no dependencies
npm test                          # node:test, on Node's built-in TypeScript support
npm run typecheck                 # tsc --noEmit, strict
npm run calc -- "1 + 2 * 3"       # prints 7
npm run calc -- --thousands "1000 * 1000"
```

## Layout

| File | What it does |
|---|---|
| `src/tokenizer.ts` | Turns the text of an expression into tokens |
| `src/parser.ts` | Turns tokens into a syntax tree (`parse`), by precedence climbing |
| `src/evaluator.ts` | Evaluates a syntax tree to a number (`evaluate`); knows `pi`, `e`, `sqrt`, `abs`, `floor` and `ceil` |
| `src/calculator.ts` | `calculate` (text to number), and `createCalculator`, a session that keeps a history |
| `src/history.ts` | A bounded list of past calculations |
| `src/format.ts` | Turns a number into the text the command line prints |
| `src/errors.ts` | `CalcError`, the only error the calculator throws on bad input |
| `src/cli.ts` | The command line |
| `test/` | Tests, one file per module under test |

## Conventions

- Strict TypeScript. No `any`, no non-null assertions, no enums.
- Imports carry the `.ts` extension, because Node runs the files as they are.
- Bad input throws a `CalcError` with a `code`; any other error is a bug.
- The command line exits 0 on success, 1 when an expression is wrong, and 2 when it is used wrongly.
- A change comes with a test.
