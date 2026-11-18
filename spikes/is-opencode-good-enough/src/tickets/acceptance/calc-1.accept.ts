// CALC-1: exponent chains group from the right; the other operators don't change.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculate } from "../../../sample-repo/src/calculator.ts";
import { runCliProcess } from "./support.ts";

describe("CALC-1", () => {
  it("2^3^2 is 2^(3^2)", () => {
    assert.equal(calculate("2^3^2"), 512);
  });

  it("2^2^3 is 2^(2^3)", () => {
    assert.equal(calculate("2 ^ 2 ^ 3"), 256);
  });

  it("an explicit grouping to the left still works", () => {
    assert.equal(calculate("(2^3)^2"), 64);
  });

  it("subtraction and division still group from the left", () => {
    assert.equal(calculate("10 - 4 - 3"), 3);
    assert.equal(calculate("100 / 10 / 5"), 2);
  });

  it("unary minus and negative exponents are unchanged", () => {
    assert.equal(calculate("-2^2"), -4);
    assert.equal(calculate("2^-1"), 0.5);
  });

  it("mixes with other operators by precedence", () => {
    assert.equal(calculate("2 * 3 ^ 2"), 18);
    assert.equal(calculate("1 + 2 ^ 3 ^ 2"), 513);
  });

  it("the command line prints 512", async () => {
    const run = await runCliProcess(["2^3^2"]);
    assert.equal(run.code, 0);
    assert.equal(run.stdout.trim(), "512");
  });
});
