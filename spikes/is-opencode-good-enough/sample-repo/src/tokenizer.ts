import { CalcError } from "./errors.ts";

export type Token =
  | { readonly kind: "number"; readonly value: number; readonly pos: number }
  | { readonly kind: "name"; readonly name: string; readonly pos: number }
  | { readonly kind: "op"; readonly op: string; readonly pos: number }
  | { readonly kind: "lparen"; readonly pos: number }
  | { readonly kind: "rparen"; readonly pos: number }
  | { readonly kind: "comma"; readonly pos: number }
  | { readonly kind: "end"; readonly pos: number };

const OPERATOR_CHARS = "+-*/^";

const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isNameStart = (c: string): boolean => /^[A-Za-z_]$/.test(c);
const isNameChar = (c: string): boolean => /^[A-Za-z0-9_]$/.test(c);

/** Splits an expression into tokens. `pos` is the zero-based index of a token's first character. */
export const tokenize = (input: string): Token[] => {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input.charAt(i);
    if (c === " " || c === "\t") {
      i += 1;
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(input.charAt(i + 1)))) {
      const start = i;
      while (isDigit(input.charAt(i))) i += 1;
      if (input.charAt(i) === ".") {
        i += 1;
        while (isDigit(input.charAt(i))) i += 1;
      }
      tokens.push({ kind: "number", value: Number(input.slice(start, i)), pos: start });
      continue;
    }
    if (isNameStart(c)) {
      const start = i;
      while (isNameChar(input.charAt(i))) i += 1;
      tokens.push({ kind: "name", name: input.slice(start, i), pos: start });
      continue;
    }
    if (OPERATOR_CHARS.includes(c)) {
      tokens.push({ kind: "op", op: c, pos: i });
      i += 1;
      continue;
    }
    if (c === "(") {
      tokens.push({ kind: "lparen", pos: i });
    } else if (c === ")") {
      tokens.push({ kind: "rparen", pos: i });
    } else if (c === ",") {
      tokens.push({ kind: "comma", pos: i });
    } else {
      throw new CalcError("syntax", `Unexpected character '${c}' at position ${String(i)}`);
    }
    i += 1;
  }
  tokens.push({ kind: "end", pos: input.length });
  return tokens;
};
