import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculate, createCalculator } from "../src/calculator.ts";
import { CalcError } from "../src/errors.ts";

describe("calculate", () => {
  it("evaluates the text of an expression", () => {
    assert.equal(calculate("2 * (3 + 4)"), 14);
  });

  it("passes variables through", () => {
    assert.equal(calculate("r ^ 2", { r: 3 }), 9);
  });

  it("throws a CalcError for a bad expression", () => {
    assert.throws(() => calculate("2 +"), CalcError);
  });
});

describe("createCalculator", () => {
  it("returns the value and its text", () => {
    const calculator = createCalculator();
    assert.deepEqual(calculator.run("1 + 2"), { value: 3, text: "3" });
  });

  it("formats with the options it was given", () => {
    const calculator = createCalculator({ format: { thousands: true } });
    assert.equal(calculator.run("1000 * 1000").text, "1,000,000");
  });

  it("records each expression in its history", () => {
    const calculator = createCalculator();
    calculator.run("1 + 1");
    calculator.run("2 * 3");
    assert.deepEqual(calculator.history.list(), [
      { expression: "1 + 1", result: 2 },
      { expression: "2 * 3", result: 6 },
    ]);
  });

  it("does not record an expression that failed", () => {
    const calculator = createCalculator();
    assert.throws(() => calculator.run("1 +"), CalcError);
    assert.equal(calculator.history.size(), 0);
  });
});
