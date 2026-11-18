// CALC-6: ans, the previous successful result, in a session and on the command line.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculate, createCalculator } from "../../../sample-repo/src/calculator.ts";
import { CalcError } from "../../../sample-repo/src/errors.ts";
import { lines, runCliProcess } from "./support.ts";

describe("CALC-6", () => {
  it("ans is the previous result", () => {
    const calculator = createCalculator();
    calculator.run("2 * 3");
    assert.equal(calculator.run("ans + 1").value, 7);
    assert.equal(calculator.run("ans * 2").value, 14);
  });

  it("ans can be used more than once in an expression", () => {
    const calculator = createCalculator();
    calculator.run("5");
    assert.equal(calculator.run("ans * ans").value, 25);
  });

  it("before any result, ans is an error that mentions ans", () => {
    const calculator = createCalculator();
    assert.throws(
      () => calculator.run("ans + 1"),
      (error: unknown) => error instanceof CalcError && error.message.includes("ans"),
    );
  });

  it("an expression that fails doesn't change ans", () => {
    const calculator = createCalculator();
    calculator.run("10");
    assert.throws(() => calculator.run("nope + 1"), CalcError);
    assert.throws(() => calculator.run("1 +"), CalcError);
    assert.equal(calculator.run("ans").value, 10);
  });

  it("each result replaces ans", () => {
    const calculator = createCalculator();
    calculator.run("1");
    calculator.run("2");
    assert.equal(calculator.run("ans").value, 2);
  });

  it("calculate() keeps no state: ans is unknown unless it is passed in", () => {
    assert.throws(() => calculate("ans"), CalcError);
    assert.equal(calculate("ans + 1", { ans: 41 }), 42);
  });

  it("the command line carries ans from one expression to the next", async () => {
    const run = await runCliProcess(["2 * 3", "ans + 1"]);
    assert.equal(run.code, 0);
    assert.deepEqual(lines(run.stdout), ["6", "7"]);
  });

  it("the command line reports ans before any result", async () => {
    const run = await runCliProcess(["ans + 1"]);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /ans/);
  });
});
