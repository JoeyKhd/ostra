// CALC-7: the operators are defined once, in src/operators.ts, and everything
// still behaves as before. The structural part is deliberately thin: the file
// exists and the three modules read from it. Whether the result is tidy is for
// the reviewer. The behaviour cases are ones the sample already gets right, so
// they hold before and after the refactor.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { calculate } from "../../../sample-repo/src/calculator.ts";
import { parse } from "../../../sample-repo/src/parser.ts";
import { tokenize } from "../../../sample-repo/src/tokenizer.ts";
import { assertCalcError, SAMPLE_ROOT } from "./support.ts";

const source = async (name: string): Promise<string> => readFile(`${SAMPLE_ROOT}src/${name}`, "utf8");

describe("CALC-7: structure", () => {
  it("src/operators.ts exists", async () => {
    const text = await source("operators.ts");
    assert.ok(text.length > 0);
  });

  it("the tokenizer, the parser and the evaluator import it", async () => {
    for (const name of ["tokenizer.ts", "parser.ts", "evaluator.ts"]) {
      assert.match(await source(name), /from\s+["']\.\/operators\.ts["']/, `${name} does not import ./operators.ts`);
    }
  });
});

describe("CALC-7: behaviour is unchanged", () => {
  const cases: readonly (readonly [string, number])[] = [
    ["1 + 2 * 3", 7],
    ["(1 + 2) * 3", 9],
    ["10 - 4 - 3", 3],
    ["100 / 10 / 5", 2],
    ["8 / 2 * 4", 16],
    ["2 ^ 10", 1024],
    ["2 * 3 ^ 2", 18],
    ["-2 ^ 2", -4],
    ["2 ^ -1", 0.5],
    ["-3 + 5", 2],
    ["+4 - 1", 3],
    ["2 - -2", 4],
    ["sqrt(16) + abs(-2)", 6],
    ["1 / 4", 0.25],
  ];
  for (const [text, expected] of cases) {
    it(`${text} is ${String(expected)}`, () => {
      assert.equal(calculate(text), expected);
    });
  }

  it("parse returns the same tree", () => {
    assert.deepEqual(parse("1 + 2 * 3 - 4 / 2"), {
      kind: "binary",
      op: "-",
      left: {
        kind: "binary",
        op: "+",
        left: { kind: "number", value: 1 },
        right: { kind: "binary", op: "*", left: { kind: "number", value: 2 }, right: { kind: "number", value: 3 } },
      },
      right: { kind: "binary", op: "/", left: { kind: "number", value: 4 }, right: { kind: "number", value: 2 } },
    });
  });

  it("the tokenizer still produces an op token for each operator", () => {
    const ops = tokenize("1+2-3*4/5^6")
      .filter((token) => token.kind === "op")
      .map((token) => token.op);
    assert.deepEqual(ops, ["+", "-", "*", "/", "^"]);
  });

  it("the tokenizer still rejects a character that is not an operator", () => {
    assertCalcError(() => tokenize("1 $ 2"), "syntax", /unexpected character/i);
    assertCalcError(() => tokenize("1 & 2"), "syntax", /unexpected character/i);
  });

  it("a name is not an operator", () => {
    assertCalcError(() => calculate("1 plus 2"), "syntax");
  });
});
