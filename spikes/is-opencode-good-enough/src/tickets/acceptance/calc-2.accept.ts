// CALC-2: division by zero is an error, on the command line and in the library.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculate } from "../../../sample-repo/src/calculator.ts";
import { assertCalcError, runCliProcess } from "./support.ts";

describe("CALC-2", () => {
  it("1 / 0 throws a domain error that says so", () => {
    assertCalcError(() => calculate("1 / 0"), "domain", /division by zero/i);
  });

  it("0 / 0 throws too", () => {
    assertCalcError(() => calculate("0 / 0"), "domain", /division by zero/i);
  });

  it("a divisor that works out to zero throws", () => {
    assertCalcError(() => calculate("1 / (2 - 2)"), "domain", /division by zero/i);
  });

  it("ordinary division is unaffected", () => {
    assert.equal(calculate("10 / 4"), 2.5);
    assert.equal(calculate("0 / 5"), 0);
    assert.equal(calculate("-9 / 3"), -3);
  });

  it("the command line prints the error and exits 1", async () => {
    const run = await runCliProcess(["1 / 0"]);
    assert.equal(run.code, 1);
    assert.equal(run.stdout.trim(), "");
    assert.match(run.stderr, /division by zero/i);
  });

  it("the command line still divides", async () => {
    const run = await runCliProcess(["10 / 4"]);
    assert.equal(run.code, 0);
    assert.equal(run.stdout.trim(), "2.5");
  });
});
