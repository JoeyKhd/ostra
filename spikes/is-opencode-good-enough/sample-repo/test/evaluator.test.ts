import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluate } from "../src/evaluator.ts";
import { CalcError, type CalcErrorCode } from "../src/errors.ts";
import { parse } from "../src/parser.ts";

const run = (text: string, variables: Record<string, number> = {}): number => evaluate(parse(text), variables);

const failsWith = (code: CalcErrorCode): ((error: unknown) => boolean) => {
  return (error) => error instanceof CalcError && error.code === code;
};

describe("evaluate", () => {
  it("does arithmetic with the usual precedence", () => {
    assert.equal(run("1 + 2 * 3"), 7);
    assert.equal(run("(1 + 2) * 3"), 9);
    assert.equal(run("10 - 4 - 3"), 3);
  });

  it("raises to a power", () => {
    assert.equal(run("2 ^ 10"), 1024);
    assert.equal(run("2 ^ -1"), 0.5);
  });

  it("negates", () => {
    assert.equal(run("-3 + 5"), 2);
    assert.equal(run("-2 ^ 2"), -4);
  });

  it("knows pi and e", () => {
    assert.equal(run("pi"), Math.PI);
    assert.equal(run("e"), Math.E);
  });

  it("reads variables, which win over the constants", () => {
    assert.equal(run("x * 2", { x: 21 }), 42);
    assert.equal(run("pi", { pi: 3 }), 3);
  });

  it("throws unknown-name for a name that is not defined", () => {
    assert.throws(() => run("nope + 1"), failsWith("unknown-name"));
  });

  it("does not find names on the object prototype", () => {
    assert.throws(() => run("constructor"), failsWith("unknown-name"));
    assert.throws(() => run("toString(1)"), failsWith("unknown-name"));
  });

  it("calls functions", () => {
    assert.equal(run("sqrt(16)"), 4);
    assert.equal(run("abs(-7)"), 7);
    assert.equal(run("floor(2.7)"), 2);
    assert.equal(run("ceil(2.1)"), 3);
  });

  it("throws a domain error for the square root of a negative number", () => {
    assert.throws(() => run("sqrt(-1)"), failsWith("domain"));
  });

  it("throws an arity error for the wrong number of arguments", () => {
    assert.throws(() => run("sqrt(1, 2)"), failsWith("arity"));
    assert.throws(() => run("abs()"), failsWith("arity"));
  });
});
