// A worst-case score of a GraphQL document, by Linear's published rules
// (linear.app/developers/rate-limiting, read 2026-11-19): each property is 0.1 point, each object
// 1 point, and a connection multiplies its children's points by its `first` (or `last`), or 50
// when it has none; the total is rounded up. Linear refuses a query over 10,000 points.
//
// It's conservative: every field with a selection set counts as an object, and every field that
// takes `first`, or whose selection holds `nodes`, as a connection over all its children. Linear's
// own `X-Complexity` header scores the answer it sent, which is lower; the live suite reads it too.
// Fragments aren't used by the adapter, and are refused here so a score is never a guess.

export const LINEAR_MAX_COMPLEXITY = 10_000;
const DEFAULT_PAGE = 50;

type Token = { readonly kind: "punct" | "name" | "value"; readonly text: string };

const tokenize = (source: string): Token[] => {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source.charAt(index);
    if (/[\s,]/.test(char)) {
      index += 1;
    } else if (source.startsWith("...", index)) {
      throw new Error("the complexity score doesn't read fragments");
    } else if ("{}()[]:$!=@".includes(char)) {
      tokens.push({ kind: "punct", text: char });
      index += 1;
    } else if (char === '"') {
      let end = index + 1;
      while (end < source.length && source.charAt(end) !== '"') {
        end += source.charAt(end) === "\\" ? 2 : 1;
      }
      tokens.push({ kind: "value", text: source.slice(index + 1, end) });
      index = end + 1;
    } else {
      const match = /^[A-Za-z0-9_.-]+/.exec(source.slice(index));
      if (match === null) {
        throw new Error(`an unexpected character in a GraphQL document at ${String(index)}`);
      }
      tokens.push({ kind: /^[A-Za-z_]/.test(match[0]) ? "name" : "value", text: match[0] });
      index += match[0].length;
    }
  }
  return tokens;
};

type Field = {
  readonly name: string;
  /** The page size it asks for, when it names one: a number, or the variable's name. */
  readonly page: number | string | null;
  readonly children: readonly Field[] | null;
};

/** Reads a document's top-level selection set into fields. */
const parseDocument = (source: string): readonly Field[] => {
  const tokens = tokenize(source);
  let at = 0;
  const peek = (): Token | undefined => tokens[at];
  const next = (): Token => {
    const token = tokens[at];
    if (token === undefined) throw new Error("a GraphQL document ended early");
    at += 1;
    return token;
  };
  const skipBalanced = (open: string, close: string): void => {
    let depth = 0;
    do {
      const token = next();
      if (token.kind === "punct" && token.text === open) depth += 1;
      if (token.kind === "punct" && token.text === close) depth -= 1;
    } while (depth > 0);
  };
  const readArgs = (): number | string | null => {
    // At "(": reads `first`/`last` at the top level of the arguments, and skips the rest.
    let page: number | string | null = null;
    next();
    let depth = 1;
    while (depth > 0) {
      const token = next();
      if (token.kind === "punct" && (token.text === "(" || token.text === "{" || token.text === "[")) depth += 1;
      else if (token.kind === "punct" && (token.text === ")" || token.text === "}" || token.text === "]")) depth -= 1;
      else if (depth === 1 && token.kind === "name" && (token.text === "first" || token.text === "last") && peek()?.text === ":") {
        next();
        const value = next();
        if (value.kind === "punct" && value.text === "$") page = next().text;
        else page = Number(value.text);
      }
    }
    return page;
  };
  const readSelection = (): Field[] => {
    // At "{".
    next();
    const fields: Field[] = [];
    while (peek()?.text !== "}") {
      let name = next().text;
      if (peek()?.text === ":") {
        next();
        name = next().text;
      }
      if (peek()?.text === "@") throw new Error("the complexity score doesn't read directives");
      const page = peek()?.text === "(" ? readArgs() : null;
      const children = peek()?.text === "{" ? readSelection() : null;
      fields.push({ name, page, children });
    }
    next();
    return fields;
  };
  // Skips `query Name($a: T, ...)` up to the selection set.
  while (peek() !== undefined && peek()?.text !== "{") {
    if (peek()?.text === "(") skipBalanced("(", ")");
    else next();
  }
  return readSelection();
};

const scoreFields = (fields: readonly Field[], variables: Readonly<Record<string, unknown>>): number =>
  fields.reduce((total, field) => total + scoreField(field, variables), 0);

const scoreField = (field: Field, variables: Readonly<Record<string, unknown>>): number => {
  if (field.children === null) {
    return 0.1;
  }
  const isConnection = field.page !== null || field.children.some((child) => child.name === "nodes");
  if (!isConnection) {
    return 1 + scoreFields(field.children, variables);
  }
  let page = DEFAULT_PAGE;
  if (typeof field.page === "number" && Number.isFinite(field.page)) {
    page = field.page;
  } else if (typeof field.page === "string") {
    const value = variables[field.page];
    page = typeof value === "number" ? value : DEFAULT_PAGE;
  }
  return 1 + page * scoreFields(field.children, variables);
};

/** The document's worst-case score with these variables, rounded up as Linear rounds it. */
export const estimateComplexity = (document: string, variables: Readonly<Record<string, unknown>> = {}): number =>
  Math.ceil(scoreFields(parseDocument(document), variables) - 1e-9);
