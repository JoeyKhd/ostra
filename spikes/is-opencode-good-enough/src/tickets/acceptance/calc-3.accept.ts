// CALC-3: printed results are rounded to 12 significant digits, trailing zeros dropped.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCalculator } from "../../../sample-repo/src/calculator.ts";
import { formatNumber } from "../../../sample-repo/src/format.ts";
import { runCliProcess } from "./support.ts";

describe("CALC-3", () => {
  it("0.1 + 0.2 prints 0.3", () => {
    assert.equal(formatNumber(0.1 + 0.2), "0.3");
  });

  it("1 / 3 prints twelve digits", () => {
    assert.equal(formatNumber(1 / 3), "0.333333333333");
    assert.equal(formatNumber(2 / 3), "0.666666666667");
  });

  it("whole numbers and short decimals print as they are", () => {
    assert.equal(formatNumber(100), "100");
    assert.equal(formatNumber(42), "42");
    assert.equal(formatNumber(2.5), "2.5");
    assert.equal(formatNumber(-0.25), "-0.25");
    assert.equal(formatNumber(0), "0");
  });

  it("grouping thousands keeps working", () => {
    assert.equal(formatNumber(1234567.891, { thousands: true }), "1,234,567.891");
    assert.equal(formatNumber(1234567, { thousands: true }), "1,234,567");
    assert.equal(formatNumber(0.1 + 0.2, { thousands: true }), "0.3");
  });

  it("negative noise is rounded too", () => {
    assert.equal(formatNumber(-(0.1 + 0.2)), "-0.3");
  });

  it("the calculator keeps the computed value and rounds only the text", () => {
    const calculator = createCalculator();
    const result = calculator.run("0.1 + 0.2");
    assert.equal(result.text, "0.3");
    assert.equal(result.value, 0.1 + 0.2);
  });

  it("the command line prints the rounded result", async () => {
    const run = await runCliProcess(["0.1 + 0.2", "1 / 3"]);
    assert.equal(run.code, 0);
    assert.deepEqual(run.stdout.trim().split(/\r?\n/), ["0.3", "0.333333333333"]);
  });
});
