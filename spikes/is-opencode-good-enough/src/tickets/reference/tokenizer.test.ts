// The reference solution to CALC-9. It is written against the sample at
// ../../../sample-repo/src/, and the dry-run's scripted model writes it into
// the agent's workspace as test/tokenizer.test.ts with that path rewritten to
// ../src/.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CalcError } from "../../../sample-repo/src/errors.ts";
import { tokenize } from "../../../sample-repo/src/tokenizer.ts";

describe("tokenize", () => {
  it("ends every token list with an end token at the input length", () => {
    assert.deepEqual(tokenize(""), [{ kind: "end", pos: 0 }]);
    assert.deepEqual(tokenize("12 "), [
      { kind: "number", value: 12, pos: 0 },
      { kind: "end", pos: 3 },
    ]);
  });

  it("reads integers and decimals", () => {
    assert.deepEqual(tokenize("42"), [
      { kind: "number", value: 42, pos: 0 },
      { kind: "end", pos: 2 },
    ]);
    assert.deepEqual(tokenize("3.25"), [
      { kind: "number", value: 3.25, pos: 0 },
      { kind: "end", pos: 4 },
    ]);
  });

  it("reads a number that starts with a dot", () => {
    assert.deepEqual(tokenize(".5"), [
      { kind: "number", value: 0.5, pos: 0 },
      { kind: "end", pos: 2 },
    ]);
  });

  it("reads names, with digits and underscores after the first character", () => {
    assert.deepEqual(tokenize("x1 _y2"), [
      { kind: "name", name: "x1", pos: 0 },
      { kind: "name", name: "_y2", pos: 3 },
      { kind: "end", pos: 6 },
    ]);
  });

  it("reads each operator", () => {
    const tokens = tokenize("+-*/^");
    assert.deepEqual(
      tokens.map((token) => (token.kind === "op" ? token.op : token.kind)),
      ["+", "-", "*", "/", "^", "end"],
    );
    assert.deepEqual(
      tokens.map((token) => token.pos),
      [0, 1, 2, 3, 4, 5],
    );
  });

  it("reads parentheses and commas", () => {
    assert.deepEqual(tokenize("(1,2)"), [
      { kind: "lparen", pos: 0 },
      { kind: "number", value: 1, pos: 1 },
      { kind: "comma", pos: 2 },
      { kind: "number", value: 2, pos: 3 },
      { kind: "rparen", pos: 4 },
      { kind: "end", pos: 5 },
    ]);
  });

  it("skips spaces and tabs, and keeps positions in the original text", () => {
    assert.deepEqual(tokenize("1 \t+\t 22"), [
      { kind: "number", value: 1, pos: 0 },
      { kind: "op", op: "+", pos: 3 },
      { kind: "number", value: 22, pos: 6 },
      { kind: "end", pos: 8 },
    ]);
  });

  it("tokenizes a whole expression", () => {
    const kinds = tokenize("max(a1, 2.5) * 3").map((token) => token.kind);
    assert.deepEqual(kinds, ["name", "lparen", "name", "comma", "number", "rparen", "op", "number", "end"]);
  });

  it("throws a syntax error that names an unknown character and where it is", () => {
    assert.throws(
      () => tokenize("1 + $"),
      (error: unknown) => error instanceof CalcError && error.code === "syntax" && error.message === "Unexpected character '$' at position 4",
    );
  });
});
