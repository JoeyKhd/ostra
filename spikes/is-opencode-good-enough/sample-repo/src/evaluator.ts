import { CalcError } from "./errors.ts";
import type { BinaryOp, Expr } from "./parser.ts";

export type Variables = Readonly<Record<string, number>>;

const CONSTANTS: Readonly<Record<string, number>> = { pi: Math.PI, e: Math.E };

const UNARY_FUNCTIONS: Readonly<Record<string, (x: number) => number>> = {
  sqrt: (x) => {
    if (x < 0) throw new CalcError("domain", "sqrt of a negative number");
    return Math.sqrt(x);
  },
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
};

/** Looks a name up in a table without reaching the table's prototype (`constructor`, `toString`). */
const own = <T>(table: Readonly<Record<string, T>>, name: string): T | undefined => (Object.hasOwn(table, name) ? table[name] : undefined);

const applyBinary = (op: BinaryOp, a: number, b: number): number => {
  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      return a / b;
    case "^":
      return a ** b;
    default:
      return op satisfies never;
  }
};

/** Evaluates a syntax tree. A name is looked up in `variables` first, then among the constants. */
export const evaluate = (expr: Expr, variables: Variables = {}): number => {
  switch (expr.kind) {
    case "number":
      return expr.value;
    case "name": {
      const value = own(variables, expr.name) ?? own(CONSTANTS, expr.name);
      if (value === undefined) throw new CalcError("unknown-name", `Unknown name '${expr.name}'`);
      return value;
    }
    case "unary": {
      const operand = evaluate(expr.operand, variables);
      return expr.op === "-" ? -operand : operand;
    }
    case "binary":
      return applyBinary(expr.op, evaluate(expr.left, variables), evaluate(expr.right, variables));
    case "call": {
      const fn = own(UNARY_FUNCTIONS, expr.name);
      if (fn === undefined) throw new CalcError("unknown-name", `Unknown function '${expr.name}'`);
      const arg = expr.args[0];
      if (arg === undefined || expr.args.length !== 1) {
        throw new CalcError("arity", `${expr.name} takes 1 argument, got ${String(expr.args.length)}`);
      }
      return fn(evaluate(arg, variables));
    }
    default:
      return expr satisfies never;
  }
};
