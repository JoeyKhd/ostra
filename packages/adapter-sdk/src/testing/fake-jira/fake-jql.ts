// The fake Jira's JQL: the subset ostra's adapter and an intake rule use (research/trackers.md
// §2.4), parsed and run over the fake's issues. `AND`, `OR`, `NOT` and parentheses; `=`, `!=`,
// `>`, `>=`, `<`, `<=`, `IN`, `NOT IN`, `IS [NOT] EMPTY`; `ORDER BY` with `ASC`/`DESC`. A query with
// no clause is refused as Jira refuses it ("Unbounded JQL queries are not allowed here"), and so is
// a field or an operator the fake doesn't know: a test never passes on JQL the fake ignored.

/** A query the fake refuses, as Jira answers 400. */
const jqlError = (message: string): Error => new Error(`JQL: ${message}`);

type Token =
  | { readonly kind: "word"; readonly value: string }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "op"; readonly value: string }
  | { readonly kind: "punct"; readonly value: "(" | ")" | "," };

const tokenize = (jql: string): Token[] => {
  const tokens: Token[] = [];
  let index = 0;
  while (index < jql.length) {
    const char = jql.charAt(index);
    if (/\s/.test(char)) {
      index += 1;
    } else if (char === "(" || char === ")" || char === ",") {
      tokens.push({ kind: "punct", value: char });
      index += 1;
    } else if (char === '"' || char === "'") {
      let value = "";
      index += 1;
      while (index < jql.length && jql.charAt(index) !== char) {
        if (jql.charAt(index) === "\\") index += 1;
        value += jql.charAt(index);
        index += 1;
      }
      if (index >= jql.length) throw jqlError("an unterminated string");
      index += 1;
      tokens.push({ kind: "string", value });
    } else if (/[!<>=~]/.test(char)) {
      const op = /^(!=|>=|<=|=|>|<|!~|~)/.exec(jql.slice(index))?.[0];
      if (op === undefined) throw jqlError("a bad operator");
      tokens.push({ kind: "op", value: op });
      index += op.length;
    } else {
      const word = /^[A-Za-z0-9_.\-/:@+]+(?:\(\))?/.exec(jql.slice(index))?.[0];
      if (word === undefined) throw jqlError(`an unexpected character at ${String(index)}`);
      tokens.push({ kind: "word", value: word });
      index += word.length;
    }
  }
  return tokens;
};

export type JqlClause =
  | { readonly kind: "compare"; readonly field: string; readonly op: string; readonly value: string }
  | { readonly kind: "in"; readonly field: string; readonly negated: boolean; readonly values: readonly string[] }
  | { readonly kind: "empty"; readonly field: string; readonly negated: boolean };

export type JqlExpression =
  | { readonly kind: "clause"; readonly clause: JqlClause }
  | { readonly kind: "and" | "or"; readonly left: JqlExpression; readonly right: JqlExpression }
  | { readonly kind: "not"; readonly inner: JqlExpression };

export type JqlQuery = {
  readonly where: JqlExpression | null;
  readonly orderBy: readonly { readonly field: string; readonly direction: "asc" | "desc" }[];
};

const isWord = (token: Token | undefined, word: string): boolean => token?.kind === "word" && token.value.toLowerCase() === word;

export const parseJql = (jql: string): JqlQuery => {
  const tokens = tokenize(jql);
  let at = 0;
  const peek = (): Token | undefined => tokens[at];
  const next = (): Token => {
    const token = tokens[at];
    if (token === undefined) throw jqlError("the query ends too early");
    at += 1;
    return token;
  };
  const value = (): string => {
    const token = next();
    if (token.kind === "word" || token.kind === "string") return token.value;
    throw jqlError("a value is missing");
  };
  const clause = (): JqlExpression => {
    const field = next();
    if (field.kind !== "word") throw jqlError("a field is missing");
    const name = field.value.toLowerCase();
    if (isWord(peek(), "is")) {
      next();
      const negated = isWord(peek(), "not");
      if (negated) next();
      const empty = next();
      if (!isWord(empty, "empty") && !isWord(empty, "null")) throw jqlError("IS takes EMPTY");
      return { kind: "clause", clause: { kind: "empty", field: name, negated } };
    }
    const negated = isWord(peek(), "not");
    if (negated) next();
    if (isWord(peek(), "in")) {
      next();
      if (next().value !== "(") throw jqlError("IN takes a list");
      const values = [value()];
      while (peek()?.value === ",") {
        next();
        values.push(value());
      }
      if (next().value !== ")") throw jqlError("a list isn't closed");
      return { kind: "clause", clause: { kind: "in", field: name, negated, values } };
    }
    if (negated) throw jqlError("NOT here takes IN");
    const op = next();
    if (op.kind !== "op") throw jqlError("an operator is missing");
    if (op.value === "~" || op.value === "!~") throw jqlError("the fake has no text search");
    return { kind: "clause", clause: { kind: "compare", field: name, op: op.value, value: value() } };
  };
  const primary = (): JqlExpression => {
    if (peek()?.value === "(") {
      next();
      const inner = orExpression();
      if (next().value !== ")") throw jqlError("a group isn't closed");
      return inner;
    }
    if (isWord(peek(), "not")) {
      next();
      return { kind: "not", inner: primary() };
    }
    return clause();
  };
  const andExpression = (): JqlExpression => {
    let left = primary();
    while (isWord(peek(), "and")) {
      next();
      left = { kind: "and", left, right: primary() };
    }
    return left;
  };
  const orExpression = (): JqlExpression => {
    let left = andExpression();
    while (isWord(peek(), "or")) {
      next();
      left = { kind: "or", left, right: andExpression() };
    }
    return left;
  };
  const where = peek() === undefined || isWord(peek(), "order") ? null : orExpression();
  const orderBy: { field: string; direction: "asc" | "desc" }[] = [];
  if (isWord(peek(), "order")) {
    next();
    if (!isWord(next(), "by")) throw jqlError("ORDER takes BY");
    for (;;) {
      const field = next();
      if (field.kind !== "word") throw jqlError("ORDER BY takes a field");
      let direction: "asc" | "desc" = "asc";
      if (isWord(peek(), "asc") || isWord(peek(), "desc")) direction = next().value.toLowerCase() === "desc" ? "desc" : "asc";
      orderBy.push({ field: field.value.toLowerCase(), direction });
      if (peek()?.value !== ",") break;
      next();
    }
  }
  if (peek() !== undefined) throw jqlError("the query goes on past its end");
  return { where, orderBy };
};

/** How a clause reads an issue: the fake answers each field it knows. */
export type JqlSubject = {
  /** Whether the issue matches `field op value`; throws for a field it doesn't know. */
  readonly compare: (field: string, op: string, value: string) => boolean;
  readonly isEmpty: (field: string) => boolean;
};

export const matchesJql = (expression: JqlExpression | null, subject: JqlSubject): boolean => {
  if (expression === null) return true;
  switch (expression.kind) {
    case "and":
      return matchesJql(expression.left, subject) && matchesJql(expression.right, subject);
    case "or":
      return matchesJql(expression.left, subject) || matchesJql(expression.right, subject);
    case "not":
      return !matchesJql(expression.inner, subject);
    case "clause": {
      const { clause } = expression;
      switch (clause.kind) {
        case "compare":
          return subject.compare(clause.field, clause.op, clause.value);
        case "in": {
          const any = clause.values.some((value) => subject.compare(clause.field, "=", value));
          return clause.negated ? !any : any;
        }
        case "empty":
          return clause.negated ? !subject.isEmpty(clause.field) : subject.isEmpty(clause.field);
        default:
          return clause satisfies never;
      }
    }
    default:
      return expression satisfies never;
  }
};
