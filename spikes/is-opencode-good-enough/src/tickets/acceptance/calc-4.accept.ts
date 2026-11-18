// CALC-4: the % operator.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculate } from "../../../sample-repo/src/calculator.ts";
import { assertCalcError, runCliProcess } from "./support.ts";

describe("CALC-4", () => {
  it("computes a remainder", () => {
    assert.equal(calculate("7 % 3"), 1);
    assert.equal(calculate("7%3"), 1);
    assert.equal(calculate("10 % 5"), 0);
  });

  it("follows the signs of JavaScript's %", () => {
    assert.equal(calculate("-7 % 3"), -1);
    assert.equal(calculate("7 % -3"), 1);
    assert.equal(calculate("5.5 % 2"), 1.5);
  });

  it("binds like * and /, grouping from the left", () => {
    assert.equal(calculate("10 % 4 * 2"), 4);
    assert.equal(calculate("2 * 10 % 4"), 0);
    assert.equal(calculate("2 + 7 % 4 * 2"), 8);
    assert.equal(calculate("20 / 3 % 2"), (20 / 3) % 2);
  });

  it("works with parentheses and the power operator", () => {
    assert.equal(calculate("(1 + 2) % 2"), 1);
    assert.equal(calculate("2 ^ 3 % 5"), 3);
  });

  it("x % 0 is a domain error, with the message Division by zero", () => {
    assertCalcError(() => calculate("5 % 0"), "domain", /division by zero/i);
    assertCalcError(() => calculate("5 % (3 - 3)"), "domain", /division by zero/i);
  });

  it("the command line prints the remainder", async () => {
    const run = await runCliProcess(["7 % 3"]);
    assert.equal(run.code, 0);
    assert.equal(run.stdout.trim(), "1");
  });
});
