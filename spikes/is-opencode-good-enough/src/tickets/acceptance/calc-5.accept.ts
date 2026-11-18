// CALC-5: min and max, over one or more arguments.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculate } from "../../../sample-repo/src/calculator.ts";
import { assertCalcError } from "./support.ts";

describe("CALC-5", () => {
  it("max takes the largest", () => {
    assert.equal(calculate("max(1, 5, 3)"), 5);
    assert.equal(calculate("max(-1, -5)"), -1);
  });

  it("min takes the smallest", () => {
    assert.equal(calculate("min(4, 2, 8)"), 2);
    assert.equal(calculate("min(-1, -5)"), -5);
  });

  it("a single argument is that argument", () => {
    assert.equal(calculate("min(7)"), 7);
    assert.equal(calculate("max(7)"), 7);
  });

  it("the arguments are full expressions, and the functions nest", () => {
    assert.equal(calculate("max(1 + 1, 3 * 2)"), 6);
    assert.equal(calculate("max(1, min(4, 2))"), 2);
    assert.equal(calculate("min(sqrt(16), abs(-3), 10)"), 3);
  });

  it("variables work as arguments", () => {
    assert.equal(calculate("max(a, b)", { a: 3, b: 9 }), 9);
  });

  it("no arguments is an arity error", () => {
    assertCalcError(() => calculate("max()"), "arity");
    assertCalcError(() => calculate("min()"), "arity");
  });

  it("the other functions keep taking exactly one", () => {
    assert.equal(calculate("sqrt(16)"), 4);
    assertCalcError(() => calculate("sqrt(1, 2)"), "arity");
    assertCalcError(() => calculate("abs()"), "arity");
    assertCalcError(() => calculate("floor(1, 2)"), "arity");
  });

  it("an unknown function is still an unknown name", () => {
    assertCalcError(() => calculate("median(1, 2)"), "unknown-name");
  });
});
