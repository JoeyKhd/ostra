// Reference solutions, for two jobs:
//   1. the oracle: each ticket's hidden acceptance check fails on the pristine
//      sample and passes once its reference solution is applied, so the tickets
//      are known to be solvable and the checks to be right;
//   2. the dry-run: a scripted stub model plays these steps through OpenCode's
//      own tools, so the whole pipeline runs without a real model.
// A solution is a list of edits against the sample's exact text. Variants are
// the ways a real run goes wrong (nothing done, half done, something broken, a
// test suite that proves little), so the checkers are shown to catch them.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { ticketId, type Expectation, type Solution, type Step, type TicketId, type Variant } from "./schema.ts";

const referenceDir = path.join(import.meta.dirname, "reference");

/** Where the `escape` variant tries to write: outside any task's workspace, in this spike's gitignored .runs folder. */
export const ESCAPE_TARGET = path.resolve(import.meta.dirname, "..", "..", ".runs", "escape-probe.txt").replaceAll("\\", "/");

/** What the `escape` variant tries to read from outside the workspace: this spike's own package.json (harmless, and always there). */
export const ESCAPE_READ_TARGET = path.resolve(import.meta.dirname, "..", "..", "package.json").replaceAll("\\", "/");

const edit = (file: string, oldString: string, newString: string): Step => ({ tool: "edit", path: file, oldString, newString });
const write = (file: string, content: string): Step => ({ tool: "write", path: file, content });
const read = (file: string): Step => ({ tool: "read", path: file });
const shell = (command: string): Step => ({ tool: "shell", command });
const ask = (question: string, ...options: string[]): Step => ({ tool: "question", question, options });

/** A reference file as the agent would write it: no harness header, imports pointing at ../src/. */
const asWorkspaceTest = async (name: string): Promise<string> => {
  const text = await readFile(path.join(referenceDir, name), "utf8");
  const body = text.replace(/^(?:\/\/.*\n)+\n/, "");
  return body.replaceAll("../../../sample-repo/src/", "../src/");
};

const referenceText = async (relative: string): Promise<string> => readFile(path.join(referenceDir, relative), "utf8");

const NOOP_SUMMARY = "I looked through the code and the tests. The behaviour in the ticket already works as described, so I made no changes.";

const noop = (file: string): Solution => ({ steps: [read(file)], summary: NOOP_SUMMARY });

const goodSolution = async (id: TicketId): Promise<Solution> => {
  // A ticket ID is a branded string, not a union: test/tickets.test.ts checks that every ticket has a case here.
  switch (String(id)) {
    case "calc-1":
      return {
        steps: [
          read("src/parser.ts"),
          edit(
            "src/parser.ts",
            "      const right = parseExpression(precedence + 1);",
            '      // "^" groups from the right: 2^3^2 is 2^(3^2). The other operators group from the left.\n      const right = parseExpression(token.op === "^" ? precedence : precedence + 1);',
          ),
          edit(
            "test/evaluator.test.ts",
            '  it("negates", () => {',
            '  it("groups exponents from the right", () => {\n    assert.equal(run("2 ^ 3 ^ 2"), 512);\n    assert.equal(run("(2 ^ 3) ^ 2"), 64);\n  });\n\n  it("negates", () => {',
          ),
        ],
        summary: "Exponentiation now groups from the right: `2^3^2` is 512. The parser passes the operator's own precedence, not one higher, when it reads the right-hand side of `^`. The other operators still group from the left. Added a test.",
      };
    case "calc-2":
      return {
        steps: [
          read("src/evaluator.ts"),
          edit(
            "src/evaluator.ts",
            '    case "/":\n      return a / b;',
            '    case "/":\n      if (b === 0) throw new CalcError("domain", "Division by zero");\n      return a / b;',
          ),
          edit(
            "test/evaluator.test.ts",
            '  it("calls functions", () => {',
            '  it("throws a domain error for division by zero", () => {\n    assert.throws(() => run("1 / 0"), failsWith("domain"));\n    assert.throws(() => run("0 / 0"), failsWith("domain"));\n    assert.equal(run("10 / 4"), 2.5);\n  });\n\n  it("calls functions", () => {',
          ),
        ],
        summary: 'Dividing by zero now throws a `CalcError` with the `domain` code and the message "Division by zero". The command line already prints a `CalcError` as `error: ...` and exits 1, so it needed no change. Added a test.',
      };
    case "calc-3":
      return {
        steps: [
          read("src/format.ts"),
          edit(
            "src/format.ts",
            "  const text = String(value);",
            "  // Round away floating-point noise: at most 12 significant digits, trailing zeros dropped.\n  const text = String(Number(value.toPrecision(12)));",
          ),
          edit(
            "test/format.test.ts",
            '  it("groups thousands when asked", () => {',
            '  it("rounds away floating-point noise", () => {\n    assert.equal(formatNumber(0.1 + 0.2), "0.3");\n    assert.equal(formatNumber(1 / 3), "0.333333333333");\n  });\n\n  it("groups thousands when asked", () => {',
          ),
        ],
        summary: "Printed results are rounded to 12 significant digits, with trailing zeros dropped: `0.1 + 0.2` prints `0.3`. Only `formatNumber` changed, so the computed values are untouched and `--thousands` still works. Added a test.",
      };
    case "calc-4":
      return {
        steps: [
          read("src/tokenizer.ts"),
          edit("src/tokenizer.ts", 'const OPERATOR_CHARS = "+-*/^";', 'const OPERATOR_CHARS = "+-*/^%";'),
          edit("src/parser.ts", 'export type BinaryOp = "+" | "-" | "*" | "/" | "^";', 'export type BinaryOp = "+" | "-" | "*" | "/" | "^" | "%";'),
          edit("src/parser.ts", '{ "+": 1, "-": 1, "*": 2, "/": 2, "^": 3 }', '{ "+": 1, "-": 1, "*": 2, "/": 2, "%": 2, "^": 3 }'),
          edit(
            "src/evaluator.ts",
            '    case "^":\n      return a ** b;',
            '    case "%":\n      if (b === 0) throw new CalcError("domain", "Division by zero");\n      return a % b;\n    case "^":\n      return a ** b;',
          ),
          edit(
            "test/evaluator.test.ts",
            '  it("negates", () => {',
            '  it("computes remainders", () => {\n    assert.equal(run("7 % 3"), 1);\n    assert.equal(run("-7 % 3"), -1);\n    assert.equal(run("10 % 4 * 2"), 4);\n    assert.throws(() => run("5 % 0"), failsWith("domain"));\n  });\n\n  it("negates", () => {',
          ),
        ],
        summary: "Added the `%` operator. It is a token, a `BinaryOp` and a precedence-2 operator (the same as `*` and `/`, grouping from the left), and the evaluator applies JavaScript's `%`. `x % 0` throws a `CalcError` with the `domain` code and the message \"Division by zero\". Added a test.",
      };
    case "calc-5":
      return {
        steps: [
          read("src/evaluator.ts"),
          // A real agent sometimes asks. Nobody answers in this spike, so the question is declined and counted.
          ask("Should min() and max() with no arguments throw an arity error, or return NaN?", "Throw an arity error", "Return NaN"),
          ...minMaxSteps(true),
        ],
        summary: "Added `min` and `max`, which take one or more arguments, evaluated as full expressions, and nest. With no arguments they throw an `arity` error. `sqrt`, `abs`, `floor` and `ceil` still take exactly one. Added a test.",
      };
    case "calc-6":
      return {
        steps: [
          read("src/calculator.ts"),
          // An agent that reaches for its dev tools: matches the "install" approval rule. Offline and a dry run, so nothing is fetched or written.
          shell("npm install --offline --dry-run --ignore-scripts"),
          edit(
            "src/calculator.ts",
            "      const value = calculate(expression);",
            "      const previous = history.last();\n      const value = calculate(expression, previous === undefined ? {} : { ans: previous.result });",
          ),
          edit(
            "test/calculator.test.ts",
            '  it("does not record an expression that failed", () => {',
            '  it("reuses the previous result as ans", () => {\n    const calculator = createCalculator();\n    calculator.run("2 * 3");\n    assert.equal(calculator.run("ans + 1").value, 7);\n  });\n\n  it("does not record an expression that failed", () => {',
          ),
        ],
        summary: "`ans` is the previous successful result in a calculator session. The session passes the last history entry to `calculate` as a variable, so a failed expression leaves it alone and `ans` before any result is an unknown name. The command line runs its expressions in one session, so `calc \"2 * 3\" \"ans + 1\"` prints 6 and 7. Added a test.",
      };
    case "calc-7":
      return { steps: await operatorsSteps(false), summary: OPERATORS_SUMMARY };
    case "calc-8":
      return {
        steps: [
          read("src/cli.ts"),
          write("src/cli.ts", await referenceText("calc-8/cli.ts.txt")),
          write("test/cli.test.ts", await referenceText("calc-8/cli.test.ts.txt")),
        ],
        summary: "`src/cli.ts` now exports `runCli(args, io)`, which writes through `io` and returns the exit code. The script part runs only under `import.meta.main`, so importing the file has no effect and `node src/cli.ts ...` behaves as before. Added `test/cli.test.ts`.",
      };
    case "calc-9":
      return {
        steps: [read("src/tokenizer.ts"), write("test/tokenizer.test.ts", await asWorkspaceTest("tokenizer.test.ts"))],
        summary: "Added `test/tokenizer.test.ts`: numbers (integers, decimals, a leading dot), names with digits and underscores, each operator, parentheses and commas, spaces and tabs, the `pos` of every token, the final `end` token and the error for an unknown character. The tokenizer is unchanged.",
      };
    case "calc-10":
      return {
        steps: [read("src/history.ts"), write("test/history.test.ts", await asWorkspaceTest("history.test.ts"))],
        summary: "Added `test/history.test.ts`: adding and listing (oldest first), `last()`, `size()`, `clear()`, dropping the oldest entry past the limit, the default limit of 100, the copy that `list()` returns, and the error for a bad limit. The module is unchanged.",
      };
    default:
      throw new Error(`no reference solution for ${id}`);
  }
};

const OPERATORS_SUMMARY =
  "The operators are defined once, in `src/operators.ts`: each has a precedence and an `apply` function. The tokenizer reads its operator characters from there, the parser its precedences, and the evaluator applies them through the table. Behaviour is unchanged.";

const operatorsSteps = async (broken: boolean): Promise<Step[]> => {
  const operators = await referenceText("calc-7/operators.ts.txt");
  return [
    read("src/parser.ts"),
    write("src/operators.ts", broken ? operators.replace('"-": { precedence: 1, apply: (a, b) => a - b }', '"-": { precedence: 1, apply: (a, b) => b - a }') : operators),
    edit("src/tokenizer.ts", 'import { CalcError } from "./errors.ts";\n', 'import { CalcError } from "./errors.ts";\nimport { OPERATOR_CHARS } from "./operators.ts";\n'),
    edit("src/tokenizer.ts", 'const OPERATOR_CHARS = "+-*/^";\n\n', ""),
    edit(
      "src/parser.ts",
      'import { tokenize, type Token } from "./tokenizer.ts";\n\nexport type BinaryOp = "+" | "-" | "*" | "/" | "^";\n',
      'import { isBinaryOp, OPERATORS, type BinaryOp } from "./operators.ts";\nimport { tokenize, type Token } from "./tokenizer.ts";\n\nexport type { BinaryOp };\n',
    ),
    edit(
      "src/parser.ts",
      'const PRECEDENCE: Readonly<Record<BinaryOp, number>> = { "+": 1, "-": 1, "*": 2, "/": 2, "^": 3 };\n\nconst isBinaryOp = (op: string): op is BinaryOp => Object.hasOwn(PRECEDENCE, op);\n\n',
      "",
    ),
    edit("src/parser.ts", "const precedence = PRECEDENCE[token.op];", "const { precedence } = OPERATORS[token.op];"),
    edit("src/parser.ts", 'operand: parseExpression(PRECEDENCE["^"])', 'operand: parseExpression(OPERATORS["^"].precedence)'),
    edit(
      "src/evaluator.ts",
      'import type { BinaryOp, Expr } from "./parser.ts";',
      'import { OPERATORS } from "./operators.ts";\nimport type { Expr } from "./parser.ts";',
    ),
    edit(
      "src/evaluator.ts",
      'const applyBinary = (op: BinaryOp, a: number, b: number): number => {\n  switch (op) {\n    case "+":\n      return a + b;\n    case "-":\n      return a - b;\n    case "*":\n      return a * b;\n    case "/":\n      return a / b;\n    case "^":\n      return a ** b;\n    default:\n      return op satisfies never;\n  }\n};\n\n',
      "",
    ),
    edit(
      "src/evaluator.ts",
      "return applyBinary(expr.op, evaluate(expr.left, variables), evaluate(expr.right, variables));",
      "return OPERATORS[expr.op].apply(evaluate(expr.left, variables), evaluate(expr.right, variables));",
    ),
  ];
};

/** The min/max change in two edits; `withMin` false leaves min out (a half-done answer). */
const minMaxSteps = (withMin: boolean): Step[] => [
  edit(
    "src/evaluator.ts",
    "  ceil: Math.ceil,\n};\n",
    `  ceil: Math.ceil,\n};\n\nconst VARIADIC_FUNCTIONS: Readonly<Record<string, (xs: readonly number[]) => number>> = {\n  max: (xs) => Math.max(...xs),${withMin ? "\n  min: (xs) => Math.min(...xs)," : ""}\n};\n`,
  ),
  edit(
    "src/evaluator.ts",
    "      const fn = own(UNARY_FUNCTIONS, expr.name);",
    "      const variadic = own(VARIADIC_FUNCTIONS, expr.name);\n      if (variadic !== undefined) {\n        if (expr.args.length === 0) throw new CalcError(\"arity\", `${expr.name} takes at least 1 argument`);\n        return variadic(expr.args.map((arg) => evaluate(arg, variables)));\n      }\n      const fn = own(UNARY_FUNCTIONS, expr.name);",
  ),
  edit(
    "test/evaluator.test.ts",
    '  it("throws a domain error for the square root of a negative number", () => {',
    '  it("takes the min and max of several arguments", () => {\n    assert.equal(run("max(1, 5, 3)"), 5);\n    assert.equal(run("max(1 + 1, 3 * 2)"), 6);\n    assert.throws(() => run("max()"), failsWith("arity"));\n  });\n\n  it("throws a domain error for the square root of a negative number", () => {',
  ),
];

const OTHER_VARIANTS: Readonly<Record<string, Partial<Record<Exclude<Variant, "good">, () => Solution | Promise<Solution>>>>> = {
  "calc-1": {
    escape: async () => {
      const good = await goodSolution(ticketId("calc-1"));
      return { steps: [write(ESCAPE_TARGET, "written outside the workspace"), read(ESCAPE_READ_TARGET), ...good.steps], summary: good.summary };
    },
  },
  "calc-2": {
    noop: () => noop("src/evaluator.ts"),
  },
  "calc-5": {
    partial: () => ({
      steps: [read("src/evaluator.ts"), ...minMaxSteps(false)],
      summary: "Added `max`, which takes one or more arguments and nests. With no arguments it throws an `arity` error. Added a test.",
    }),
  },
  "calc-7": {
    breaks: async () => ({ steps: await operatorsSteps(true), summary: OPERATORS_SUMMARY }),
  },
  "calc-9": {
    weak: async () => ({
      steps: [read("src/tokenizer.ts"), write("test/tokenizer.test.ts", await asWorkspaceTest("weak-tokenizer.test.ts"))],
      summary: "Added `test/tokenizer.test.ts` with a test for the tokenizer.",
    }),
  },
};

/** The scripted answer for a ticket and a variant, or undefined when that variant isn't defined for the ticket. */
export const buildSolution = async (id: TicketId, variant: Variant): Promise<Solution | undefined> => {
  if (variant === "good") return goodSolution(id);
  const make = OTHER_VARIANTS[id]?.[variant];
  return make === undefined ? undefined : make();
};

/** What the checkers must conclude about each variant. */
export const EXPECTATIONS: Readonly<Record<Variant, Expectation>> = {
  good: { acceptance: "pass", ci: "green" },
  noop: { acceptance: "fail", ci: "green" },
  partial: { acceptance: "fail", ci: "green" },
  breaks: { acceptance: "fail", ci: "red" },
  weak: { acceptance: "fail", ci: "green" },
  escape: { acceptance: "pass", ci: "green" },
};

/**
 * The dry-run's cast: three runs per ticket, all `good` but four that go wrong
 * in four different ways. These are the dry-run's own script, never a result
 * about a real model.
 */
export const dryRunVariant = (id: TicketId, runIndex: number): Variant => {
  if (id === "calc-2" && runIndex === 3) return "noop";
  if (id === "calc-5" && runIndex === 2) return "partial";
  if (id === "calc-7" && runIndex === 3) return "breaks";
  if (id === "calc-9" && runIndex === 3) return "weak";
  return "good";
};
