import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CalcError } from "../src/errors.ts";
import { parse, type Expr } from "../src/parser.ts";

const num = (value: number): Expr => ({ kind: "number", value });
const bin = (op: "+" | "-" | "*" | "/" | "^", left: Expr, right: Expr): Expr => ({ kind: "binary", op, left, right });

describe("parse", () => {
  it("parses a number", () => {
    assert.deepEqual(parse("42"), num(42));
  });

  it("parses a decimal that starts with a dot", () => {
    assert.deepEqual(parse(".5"), num(0.5));
  });

  it("gives multiplication a higher precedence than addition", () => {
    assert.deepEqual(parse("1 + 2 * 3"), bin("+", num(1), bin("*", num(2), num(3))));
  });

  it("is left associative for subtraction", () => {
    assert.deepEqual(parse("8 - 3 - 2"), bin("-", bin("-", num(8), num(3)), num(2)));
  });

  it("lets parentheses override precedence", () => {
    assert.deepEqual(parse("(1 + 2) * 3"), bin("*", bin("+", num(1), num(2)), num(3)));
  });

  it("parses unary minus", () => {
    assert.deepEqual(parse("-2"), { kind: "unary", op: "-", operand: num(2) });
  });

  it("binds unary minus looser than the power operator", () => {
    assert.deepEqual(parse("-2^2"), { kind: "unary", op: "-", operand: bin("^", num(2), num(2)) });
  });

  it("parses a call with arguments", () => {
    assert.deepEqual(parse("sqrt(16)"), { kind: "call", name: "sqrt", args: [num(16)] });
  });

  it("parses a name", () => {
    assert.deepEqual(parse("pi"), { kind: "name", name: "pi" });
  });

  it("throws a syntax error for an unclosed parenthesis", () => {
    assert.throws(
      () => parse("(1 + 2"),
      (error: unknown) => error instanceof CalcError && error.code === "syntax",
    );
  });

  it("throws a syntax error for empty input", () => {
    assert.throws(
      () => parse(""),
      (error: unknown) => error instanceof CalcError && error.code === "syntax",
    );
  });

  it("throws a syntax error for trailing tokens", () => {
    assert.throws(
      () => parse("1 2"),
      (error: unknown) => error instanceof CalcError && error.code === "syntax",
    );
  });
});
