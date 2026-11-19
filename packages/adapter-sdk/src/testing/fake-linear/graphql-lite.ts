// A small reader for the GraphQL documents an adapter sends to the fake Linear: the operation's
// type, and its top-level fields with their arguments resolved against the variables. Selection
// sets are skipped: the fake answers every field it knows, whatever was asked, and the adapter
// reads the answer loosely. Fragments and directives aren't supported; a document that uses them
// is refused, so a test fails loudly rather than passing on a misread.

export type GraphqlValue =
  | string
  | number
  | boolean
  | null
  | readonly GraphqlValue[]
  | { readonly [key: string]: GraphqlValue };

export type TopLevelField = {
  /** The name the answer goes under: the alias, or the field's name. */
  readonly responseKey: string;
  readonly name: string;
  readonly args: Readonly<Record<string, GraphqlValue>>;
};

export type GraphqlOperation = {
  readonly type: "query" | "mutation";
  readonly fields: readonly TopLevelField[];
};

type Token =
  | { readonly kind: "punct"; readonly value: string }
  | { readonly kind: "name"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "string"; readonly value: string };

const isNameStart = (char: string): boolean => /[A-Za-z_]/.test(char);
const isNameChar = (char: string): boolean => /[A-Za-z0-9_]/.test(char);

const tokenize = (source: string): Token[] => {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source.charAt(index);
    if (/[\s,]/.test(char) || char === "﻿") {
      index += 1;
    } else if (char === "#") {
      while (index < source.length && source.charAt(index) !== "\n") index += 1;
    } else if (source.startsWith("...", index)) {
      throw new Error("the fake's GraphQL reader doesn't support fragments");
    } else if ("{}()[]:$!=@".includes(char)) {
      tokens.push({ kind: "punct", value: char });
      index += 1;
    } else if (source.startsWith('"""', index)) {
      const end = source.indexOf('"""', index + 3);
      if (end < 0) throw new Error("an unterminated block string");
      tokens.push({ kind: "string", value: source.slice(index + 3, end) });
      index = end + 3;
    } else if (char === '"') {
      let value = "";
      index += 1;
      while (index < source.length && source.charAt(index) !== '"') {
        if (source.charAt(index) === "\\") {
          const escaped = source.charAt(index + 1);
          if (escaped === "u") {
            value += String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 6), 16));
            index += 6;
            continue;
          }
          value += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped === "r" ? "\r" : escaped;
          index += 2;
          continue;
        }
        value += source.charAt(index);
        index += 1;
      }
      index += 1;
      tokens.push({ kind: "string", value });
    } else if (/[-0-9]/.test(char)) {
      const match = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(index));
      if (match === null) throw new Error("a bad number");
      tokens.push({ kind: "number", value: Number(match[0]) });
      index += match[0].length;
    } else if (isNameStart(char)) {
      let end = index + 1;
      while (end < source.length && isNameChar(source.charAt(end))) end += 1;
      tokens.push({ kind: "name", value: source.slice(index, end) });
      index = end;
    } else {
      throw new Error(`an unexpected character in the document`);
    }
  }
  return tokens;
};

/** Reads an operation, resolving `$variables` in the top-level fields' arguments. Throws on a document it can't read. */
export const readOperation = (document: string, variables: Readonly<Record<string, unknown>>): GraphqlOperation => {
  const tokens = tokenize(document);
  let position = 0;
  const peek = (): Token | undefined => tokens[position];
  const next = (): Token => {
    const token = tokens[position];
    if (token === undefined) throw new Error("the document ended early");
    position += 1;
    return token;
  };
  const expectPunct = (value: string): void => {
    const token = next();
    if (token.kind !== "punct" || token.value !== value) throw new Error(`expected "${value}"`);
  };
  const isPunct = (value: string): boolean => {
    const token = peek();
    return token?.kind === "punct" && token.value === value;
  };
  const skipBlock = (open: string, close: string): void => {
    expectPunct(open);
    let depth = 1;
    while (depth > 0) {
      const token = next();
      if (token.kind === "punct" && token.value === open) depth += 1;
      if (token.kind === "punct" && token.value === close) depth -= 1;
    }
  };
  const toValue = (raw: unknown): GraphqlValue => {
    if (raw === undefined || raw === null) return null;
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") return raw;
    if (Array.isArray(raw)) return raw.map((item: unknown) => toValue(item));
    if (typeof raw === "object") {
      const object: Record<string, GraphqlValue> = {};
      for (const [key, value] of Object.entries(raw)) object[key] = toValue(value);
      return object;
    }
    throw new Error("a variable that isn't JSON");
  };
  const readValue = (): GraphqlValue => {
    const token = next();
    if (token.kind === "punct" && token.value === "$") {
      const name = next();
      if (name.kind !== "name") throw new Error("a variable needs a name");
      return toValue(variables[name.value]);
    }
    if (token.kind === "punct" && token.value === "[") {
      const list: GraphqlValue[] = [];
      while (!isPunct("]")) list.push(readValue());
      expectPunct("]");
      return list;
    }
    if (token.kind === "punct" && token.value === "{") {
      const object: Record<string, GraphqlValue> = {};
      while (!isPunct("}")) {
        const key = next();
        if (key.kind !== "name") throw new Error("an object field needs a name");
        expectPunct(":");
        object[key.value] = readValue();
      }
      expectPunct("}");
      return object;
    }
    if (token.kind === "string" || token.kind === "number") return token.value;
    if (token.kind === "name") {
      if (token.value === "true") return true;
      if (token.value === "false") return false;
      if (token.value === "null") return null;
      // An enum value, such as `updatedAt` or `Ascending`.
      return token.value;
    }
    throw new Error("a value was expected");
  };

  let type: "query" | "mutation" = "query";
  const first = peek();
  if (first?.kind === "name") {
    if (first.value === "query" || first.value === "mutation") {
      type = first.value;
    } else {
      throw new Error(`the fake supports query and mutation, not ${first.value}`);
    }
    next();
    if (peek()?.kind === "name") next();
    if (isPunct("(")) skipBlock("(", ")");
  }
  if (isPunct("@")) throw new Error("the fake's GraphQL reader doesn't support directives");
  expectPunct("{");
  const fields: TopLevelField[] = [];
  while (!isPunct("}")) {
    const nameToken = next();
    if (nameToken.kind !== "name") throw new Error("a field name was expected");
    const responseKey = nameToken.value;
    let name = nameToken.value;
    if (isPunct(":")) {
      next();
      const real = next();
      if (real.kind !== "name") throw new Error("an alias needs a field");
      name = real.value;
    }
    const args: Record<string, GraphqlValue> = {};
    if (isPunct("(")) {
      next();
      while (!isPunct(")")) {
        const argName = next();
        if (argName.kind !== "name") throw new Error("an argument needs a name");
        expectPunct(":");
        args[argName.value] = readValue();
      }
      expectPunct(")");
    }
    if (isPunct("@")) throw new Error("the fake's GraphQL reader doesn't support directives");
    if (isPunct("{")) skipBlock("{", "}");
    fields.push({ responseKey, name, args });
  }
  expectPunct("}");
  if (position !== tokens.length) throw new Error("one operation per document");
  return { type, fields };
};
