import ts from "typescript";

// F-083 (ticket 20): the message-file check. Every word the panel shows lives in `messages/en.json`
// and reaches the page through `t`. This reads the panel's sources with the TypeScript compiler and
// finds what would bypass it: JSX text with a letter in it, and a string literal shown as an
// `aria-label`, `title`, `placeholder`, `alt` or a toast's message. It also finds the keys of
// `en.json` no source names. `messages.check.test.ts` runs it over `apps/web/src` and
// `packages/task-view/src`, so `pnpm test` fails on a word written straight into a screen.

/** One word that bypasses `t`: where it is, and the text. */
export type MessageFinding = {
  readonly file: string;
  readonly line: number;
  readonly kind: "jsx-text" | "jsx-literal" | "attribute" | "toast";
  /** The attribute's name, for an `attribute` finding. */
  readonly attribute?: string;
  readonly text: string;
};

/** A literal that is a name, not a word: the product's name, a keyboard key. Each has its reason. */
export type AllowedLiteral = { readonly text: string; readonly reason: string };

/** The attributes whose value a person reads or hears. */
export const CHECKED_ATTRIBUTES: ReadonlySet<string> = new Set(["aria-label", "title", "placeholder", "alt"]);

const LETTER = /\p{L}/u;

const hasLetter = (text: string): boolean => LETTER.test(text);

/** The literal parts of an expression that end up shown: a branch, a fallback, a template's text. */
const shownLiterals = (node: ts.Expression): readonly { readonly node: ts.Node; readonly text: string }[] => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [{ node, text: node.text }];
  if (ts.isTemplateExpression(node)) {
    const parts = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ");
    return [{ node, text: parts }, ...node.templateSpans.flatMap((span) => shownLiterals(span.expression))];
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return shownLiterals(node.expression);
  if (ts.isConditionalExpression(node)) return [...shownLiterals(node.whenTrue), ...shownLiterals(node.whenFalse)];
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.BarBarToken) return [...shownLiterals(node.left), ...shownLiterals(node.right)];
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return shownLiterals(node.right);
    if (operator === ts.SyntaxKind.PlusToken) return [...shownLiterals(node.left), ...shownLiterals(node.right)];
  }
  return [];
};

const attributeName = (name: ts.JsxAttributeName): string => (ts.isIdentifier(name) ? name.text : `${name.namespace.text}:${name.name.text}`);

const isToastCall = (node: ts.CallExpression): boolean => {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === "toast";
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "toast";
};

/** Every word in one source file that bypasses `t`, less the allowed names. */
export const checkSource = (file: string, source: string, allowed: readonly AllowedLiteral[] = []): readonly MessageFinding[] => {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const allowedTexts = new Set(allowed.map((entry) => entry.text));
  const findings: MessageFinding[] = [];
  const add = (node: ts.Node, kind: MessageFinding["kind"], text: string, attribute?: string) => {
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (!hasLetter(trimmed) || allowedTexts.has(trimmed)) return;
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    findings.push({ file, line, kind, text: trimmed, ...(attribute === undefined ? {} : { attribute }) });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      // An entity (`&nbsp;`) is punctuation, not a word.
      add(node, "jsx-text", node.text.replace(/&(?:[a-z]+|#\d+|#x[\da-f]+);/gi, " "));
    } else if (ts.isJsxExpression(node) && node.expression !== undefined && !ts.isJsxAttribute(node.parent)) {
      for (const literal of shownLiterals(node.expression)) add(literal.node, "jsx-literal", literal.text);
    } else if (ts.isJsxAttribute(node)) {
      const name = attributeName(node.name);
      const value = node.initializer;
      if (CHECKED_ATTRIBUTES.has(name) && value !== undefined) {
        if (ts.isStringLiteral(value)) add(value, "attribute", value.text, name);
        else if (ts.isJsxExpression(value) && value.expression !== undefined) {
          for (const literal of shownLiterals(value.expression)) add(literal.node, "attribute", literal.text, name);
        }
      }
    } else if (ts.isCallExpression(node) && isToastCall(node)) {
      const [message] = node.arguments;
      if (message !== undefined) for (const literal of shownLiterals(message)) add(literal.node, "toast", literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
};

/** The dotted key of every string in a message file: `{ "a": { "b": "…" } }` → `a.b`. */
export const messageKeys = (messages: unknown, prefix = ""): readonly string[] => {
  if (typeof messages !== "object" || messages === null) return [];
  return Object.entries(messages).flatMap(([key, value]) => (typeof value === "string" ? [`${prefix}${key}`] : messageKeys(value, `${prefix}${key}.`)));
};

/** The start of a dotted key: `taskPage.` or `taskPage.limit.`. */
const KEY_HEAD = /^[a-z][\w]*\.(?:[\w]+\.)*[\w]*$/i;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What a source names as a key: every string literal, and every template whose fixed parts could
 * spell one (`` `budgetWait.${scope}` `` names every `budgetWait.*` key), as patterns.
 */
export const namedKeys = (file: string, source: string): { readonly exact: ReadonlySet<string>; readonly patterns: readonly RegExp[] } => {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const exact = new Set<string>();
  const patterns: RegExp[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) exact.add(node.text);
    else if (ts.isTemplateExpression(node)) {
      const fixed = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
      // Only a template that starts with a key's first part names keys (`${prefix}.${key}` names none).
      if (KEY_HEAD.test(node.head.text)) patterns.push(new RegExp(`^${fixed.map(escapeRegExp).join("[\\w.-]+")}$`));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { exact, patterns };
};

/** The keys of `messages` that no source names. */
export const unusedKeys = (messages: unknown, sources: readonly { readonly file: string; readonly source: string }[]): readonly string[] => {
  const named = sources.map(({ file, source }) => namedKeys(file, source));
  return messageKeys(messages).filter((key) => !named.some(({ exact, patterns }) => exact.has(key) || patterns.some((pattern) => pattern.test(key))));
};
