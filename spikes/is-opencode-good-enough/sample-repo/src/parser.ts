import { CalcError } from "./errors.ts";
import { tokenize, type Token } from "./tokenizer.ts";

export type BinaryOp = "+" | "-" | "*" | "/" | "^";
export type UnaryOp = "+" | "-";

export type Expr =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "unary"; readonly op: UnaryOp; readonly operand: Expr }
  | { readonly kind: "binary"; readonly op: BinaryOp; readonly left: Expr; readonly right: Expr }
  | { readonly kind: "call"; readonly name: string; readonly args: readonly Expr[] };

const PRECEDENCE: Readonly<Record<BinaryOp, number>> = { "+": 1, "-": 1, "*": 2, "/": 2, "^": 3 };

const isBinaryOp = (op: string): op is BinaryOp => Object.hasOwn(PRECEDENCE, op);

const describe = (token: Token): string => {
  switch (token.kind) {
    case "number":
      return `number ${String(token.value)}`;
    case "name":
      return `name '${token.name}'`;
    case "op":
      return `operator '${token.op}'`;
    case "lparen":
      return "'('";
    case "rparen":
      return "')'";
    case "comma":
      return "','";
    case "end":
      return "end of input";
    default:
      return token satisfies never;
  }
};

/** Parses an expression by precedence climbing. Unary minus binds looser than `^`, so `-2^2` is `-(2^2)`. */
export const parse = (input: string): Expr => {
  const tokens = tokenize(input);
  let index = 0;

  const peek = (): Token => tokens[index] ?? { kind: "end", pos: input.length };
  const next = (): Token => {
    const token = peek();
    index += 1;
    return token;
  };

  const parseExpression = (minPrecedence: number): Expr => {
    let left = parseUnary();
    for (;;) {
      const token = peek();
      if (token.kind !== "op" || !isBinaryOp(token.op)) break;
      const precedence = PRECEDENCE[token.op];
      if (precedence < minPrecedence) break;
      next();
      const right = parseExpression(precedence + 1);
      left = { kind: "binary", op: token.op, left, right };
    }
    return left;
  };

  const parseUnary = (): Expr => {
    const token = peek();
    if (token.kind === "op" && (token.op === "-" || token.op === "+")) {
      next();
      return { kind: "unary", op: token.op, operand: parseExpression(PRECEDENCE["^"]) };
    }
    return parsePrimary();
  };

  const parseArguments = (): Expr[] => {
    const args: Expr[] = [];
    if (peek().kind === "rparen") {
      next();
      return args;
    }
    for (;;) {
      args.push(parseExpression(1));
      const token = next();
      if (token.kind === "rparen") return args;
      if (token.kind !== "comma") throw new CalcError("syntax", `Expected ',' or ')' at position ${String(token.pos)}`);
    }
  };

  const parsePrimary = (): Expr => {
    const token = next();
    switch (token.kind) {
      case "number":
        return { kind: "number", value: token.value };
      case "name": {
        if (peek().kind !== "lparen") return { kind: "name", name: token.name };
        next();
        return { kind: "call", name: token.name, args: parseArguments() };
      }
      case "lparen": {
        const inner = parseExpression(1);
        const close = next();
        if (close.kind !== "rparen") throw new CalcError("syntax", `Expected ')' at position ${String(close.pos)}`);
        return inner;
      }
      case "op":
      case "rparen":
      case "comma":
      case "end":
        throw new CalcError("syntax", `Unexpected ${describe(token)} at position ${String(token.pos)}`);
      default:
        return token satisfies never;
    }
  };

  const expr = parseExpression(1);
  const trailing = peek();
  if (trailing.kind !== "end") throw new CalcError("syntax", `Unexpected ${describe(trailing)} at position ${String(trailing.pos)}`);
  return expr;
};
