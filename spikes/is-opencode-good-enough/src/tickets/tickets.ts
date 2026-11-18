// The ten tickets filed against the sample repo (sample-repo/): 3 bug fixes,
// 3 small features, 2 refactors and 2 that add tests. Each is written as a
// teammate would write it in the tracker: what is wrong or wanted, how to see
// it, and the edges that matter. None names the fix.
//
// The sample ships with the three bugs in place (CALC-1, CALC-2, CALC-3).
// Each ticket is worked from a fresh checkout of the sample, on its own.

import { HISTORY_MUTANTS, TOKENIZER_MUTANTS } from "./mutants.ts";
import { ticketId, type Ticket, type TicketId } from "./schema.ts";

export const TICKETS: readonly Ticket[] = [
  {
    id: ticketId("calc-1"),
    kind: "bug",
    title: "Exponent chains evaluate left to right",
    body: `\`2^3^2\` gives 64. Exponentiation should group from the right, as it does in maths and in most languages' \`**\`: \`2^3^2\` is \`2^(3^2)\`, which is 512.

**Steps**
1. \`npm run calc -- "2^3^2"\`

**Expected:** \`512\`
**Actual:** \`64\`

The other operators keep grouping from the left: \`10 - 4 - 3\` is 3 and \`100 / 10 / 5\` is 2. \`-2^2\` must stay \`-4\`, and \`2^-1\` must stay \`0.5\`.`,
    acceptance: { kind: "behavior", file: "calc-1.accept.ts" },
  },
  {
    id: ticketId("calc-2"),
    kind: "bug",
    title: "Division by zero prints Infinity and exits 0",
    body: `\`1 / 0\` prints \`Infinity\` and exits 0. A script that checks the exit code of \`calc\` can't tell that anything went wrong.

**Steps**
1. \`npm run calc -- "1 / 0"\`

**Expected:** nothing on stdout, \`error: Division by zero\` on stderr, exit code 1, like any other bad expression.
**Actual:** \`Infinity\` on stdout, exit code 0.

This should hold wherever the calculator divides, not only on the command line: \`calculate("1 / 0")\` should throw a \`CalcError\` with the \`domain\` code. \`0 / 0\` the same. Ordinary division is unaffected: \`10 / 4\` is still 2.5.`,
    acceptance: { kind: "behavior", file: "calc-2.accept.ts" },
  },
  {
    id: ticketId("calc-3"),
    kind: "bug",
    title: "Results show floating-point noise",
    body: `\`0.1 + 0.2\` prints \`0.30000000000000004\`, and \`1 / 3\` prints \`0.3333333333333333\`. Nobody wants those on a calculator.

**Expected:** round the printed result to 12 significant digits and drop trailing zeros. \`0.1 + 0.2\` prints \`0.3\`, \`1 / 3\` prints \`0.333333333333\`, and \`100\` still prints \`100\`.

This is about what we print. The numbers the calculator computes don't change. \`--thousands\` keeps working: \`1234567.891\` prints as \`1,234,567.891\`.`,
    acceptance: { kind: "behavior", file: "calc-3.accept.ts" },
  },
  {
    id: ticketId("calc-4"),
    kind: "feature",
    title: "Support the % (remainder) operator",
    body: `We have \`+ - * / ^\` but no way to get a remainder. Add the \`%\` operator.

- It binds like \`*\` and \`/\` and groups from the left: \`10 % 4 * 2\` is 4, and \`2 * 10 % 4\` is 0.
- Its signs follow JavaScript's \`%\`: \`7 % 3\` is 1, \`-7 % 3\` is -1, \`7 % -3\` is 1, \`5.5 % 2\` is 1.5.
- \`x % 0\` is an error: a \`CalcError\` with the \`domain\` code and the message "Division by zero".
- It works on the command line: \`npm run calc -- "7 % 3"\` prints \`1\`.`,
    acceptance: { kind: "behavior", file: "calc-4.accept.ts" },
  },
  {
    id: ticketId("calc-5"),
    kind: "feature",
    title: "Add min and max functions",
    body: `Add \`min\` and \`max\`.

- Both take one or more arguments: \`max(1, 5, 3)\` is 5, \`min(4, 2, 8)\` is 2, \`min(7)\` is 7.
- The arguments are full expressions, and the functions nest: \`max(1 + 1, 3 * 2)\` is 6 and \`max(1, min(4, 2))\` is 2.
- With no arguments they throw a \`CalcError\` with the \`arity\` code, as the other functions do for a wrong number of arguments.
- \`sqrt\`, \`abs\`, \`floor\` and \`ceil\` keep taking exactly one.`,
    acceptance: { kind: "behavior", file: "calc-5.accept.ts" },
  },
  {
    id: ticketId("calc-6"),
    kind: "feature",
    title: "ans: reuse the previous result",
    body: `When I work through a chain of sums I keep retyping the last result. Add \`ans\`, a name that stands for the result of the previous successful calculation.

- In a calculator session, \`run("2 * 3")\` and then \`run("ans + 1")\` gives 7, and \`run("ans * 2")\` after that gives 14.
- Before any calculation has succeeded, using \`ans\` is an error: a \`CalcError\` whose message mentions \`ans\`.
- An expression that fails doesn't change \`ans\`.
- On the command line the expressions run in order in one session: \`npm run calc -- "2 * 3" "ans + 1"\` prints \`6\` and then \`7\`.
- \`calculate()\` on its own keeps no state, so it doesn't know \`ans\` unless the caller passes it as a variable.`,
    acceptance: { kind: "behavior", file: "calc-6.accept.ts" },
  },
  {
    id: ticketId("calc-7"),
    kind: "refactor",
    title: "Define the operators in one place",
    body: `Each operator is defined in three places: \`tokenizer.ts\` knows its character, \`parser.ts\` its precedence and \`evaluator.ts\` what it does. Adding one (we want \`%\` soon) means touching all three and hoping they agree.

Define the operators once, in a new \`src/operators.ts\`: for each one, its symbol, its precedence and how to apply it. Make the tokenizer, the parser and the evaluator read from it.

This is a refactor, so behaviour must not change. The existing tests pass untouched, and \`parse\` returns the same tree for any expression.`,
    acceptance: { kind: "behavior", file: "calc-7.accept.ts" },
  },
  {
    id: ticketId("calc-8"),
    kind: "refactor",
    title: "Make the command line testable",
    body: `\`src/cli.ts\` runs as soon as it is imported, and it writes to \`process\` and \`console\` directly, so the only way to test it is to start a process.

Export \`runCli(args: readonly string[], io: CliIo): number\` from \`src/cli.ts\`, where \`CliIo\` is \`{ out: (line: string) => void; err: (line: string) => void }\`. It does what the script does today, but writes through \`io\` and returns the exit code instead of setting \`process.exitCode\`.

The file touches \`process\` and \`console\` only when it is run directly: \`node src/cli.ts ...\` behaves exactly as it does now, and importing the file has no effect.

Behaviour stays the same, the exit codes (0, 1 and 2) and the messages included. Add tests for the command line in \`test/cli.test.ts\`.`,
    acceptance: { kind: "behavior", file: "calc-8.accept.ts" },
  },
  {
    id: ticketId("calc-9"),
    kind: "tests",
    title: "Add tests for the tokenizer",
    body: `\`src/tokenizer.ts\` has no tests of its own. It is only exercised through the parser tests. Add \`test/tokenizer.test.ts\`.

Cover what the tokenizer promises: numbers (integers, decimals, a leading dot), names (digits and underscores included), each operator, parentheses and commas, whitespace, the \`pos\` of every token, the final \`end\` token, and the error for a character it does not know. Don't change the tokenizer.`,
    acceptance: { kind: "mutation", target: "src/tokenizer.ts", mutants: TOKENIZER_MUTANTS },
  },
  {
    id: ticketId("calc-10"),
    kind: "tests",
    title: "Add tests for the history",
    body: `\`src/history.ts\` has no tests of its own. Add \`test/history.test.ts\`.

Cover \`createHistory\`: adding and listing entries (oldest first), \`last()\`, \`size()\`, \`clear()\`, dropping the oldest entry when the limit is passed, the default limit, and the error for a limit that is not a positive integer. The list it returns is a copy: a later \`add\` must not change a list you already hold. Don't change the module.`,
    acceptance: { kind: "mutation", target: "src/history.ts", mutants: HISTORY_MUTANTS },
  },
];

export const ticketById = (id: TicketId): Ticket | undefined => TICKETS.find((ticket) => ticket.id === id);

/** The runs the pass bar asks for on each ticket. */
export const REQUIRED_RUNS_PER_TICKET = 3;

/** The mix the pass bar asks for. */
export const REQUIRED_MIX = { bug: 3, feature: 3, refactor: 2, tests: 2 } as const;
