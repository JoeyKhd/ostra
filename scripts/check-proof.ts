// The proof ledger, checked by a machine (`context/proof/README.md`).
//
// Every feature row of `context/features.md` whose status is `done` has a proof file,
// `context/proof/F-nnn.md`, with one table row per condition of its "done when". A condition is
// one sentence of that text, quoted verbatim; the dated notes in italics are not conditions.
// For a `done` row:
//
// - its proof file exists, and it has a row for every condition, matched verbatim;
// - every row is `proved`;
// - every cited test file exists, and holds a test with exactly the cited name, which runs (not
//   skipped, not behind a condition) and names the feature's ID;
// - every cited piece of live evidence exists.
//
// A `building` or `planned` row with a proof file gets the same checks as warnings. A `done` row
// in `context/proof/baseline.json` does too: rows marked done before the ledger existed, waiting
// for their proofs. The baseline only shrinks: the check fails once a baselined row is fully
// proved, or when it names a row that isn't `done`.
//
// Run with `pnpm check:proof`.

import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";
import { z } from "zod";

// ---------------------------------------------------------------------------------------------
// The feature ledger
// ---------------------------------------------------------------------------------------------

export const featureStatuses = ["planned", "building", "done", "dropped"] as const;
export type FeatureStatus = (typeof featureStatuses)[number];

export type Feature = {
  /** `F-024`. */
  id: string;
  title: string;
  /** The "done when" cell as written, dated notes included. */
  doneWhen: string;
  status: FeatureStatus;
  /** The sentences of the "done when", without its dated notes: what a proof file must cover. */
  conditions: readonly string[];
};

const featureIdPattern = /^F-\d{3,}$/;

const isFeatureStatus = (value: string): value is FeatureStatus =>
  featureStatuses.some((status) => status === value);

/** Splits a markdown table row into its cells, unescaping `\|`. */
const tableCells = (line: string): string[] | undefined => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return undefined;
  const cells: string[] = [];
  let current = "";
  for (let index = 1; index < trimmed.length - 1; index += 1) {
    const char = trimmed.charAt(index);
    if (char === "\\" && trimmed.charAt(index + 1) === "|") {
      current += "|";
      index += 1;
    } else if (char === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
};

const datePattern = /\d{4}-\d{2}-\d{2}/;

/**
 * Removes the dated notes, the italic spans such as `*Changed 2026-11-18: ...*`, and keeps the
 * italics that are part of a sentence, such as `*(working value)*`. Bold (`**`) is left alone.
 */
export const stripNotes = (doneWhen: string): string =>
  doneWhen.replaceAll(/(?<!\*)\*(?!\*)([^*]|\*\*)+?(?<!\*)\*(?!\*)/g, (span) =>
    datePattern.test(span) ? "" : span,
  );

/**
 * Splits a "done when" into its sentences. A sentence ends at `.`, `?` or `!`, and any closing
 * quote, bracket or `*` right after it, that is followed by a space or the end of the text,
 * outside code spans and parentheses, and not after an abbreviation such as "e.g.".
 */
const abbreviation = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|cf)\.$/;

export const splitSentences = (text: string): string[] => {
  const sentences: string[] = [];
  let start = 0;
  let inCode = false;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char === "`") {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    if (depth > 0 || !".?!".includes(char)) continue;
    let end = index + 1;
    while (end < text.length && "\"')*”’".includes(text.charAt(end))) end += 1;
    const rest = text.slice(end);
    // No space after it ("1.0", "demo.md"), or an abbreviation ("e.g. this"): not an end.
    if (rest.trim() !== "" && !/^\s/.test(rest)) continue;
    if (abbreviation.test(text.slice(start, index + 1))) continue;
    const sentence = text.slice(start, end).trim();
    if (sentence !== "") sentences.push(sentence);
    start = end;
    index = end - 1;
  }
  const last = text.slice(start).trim();
  if (last !== "") sentences.push(last);
  return sentences;
};

export const conditionsOf = (doneWhen: string): string[] => splitSentences(stripNotes(doneWhen));

/** Reads every feature row of `features.md`: the table rows whose first cell is an F-ID. */
export const parseFeatures = (markdown: string): Feature[] => {
  const features: Feature[] = [];
  for (const [index, line] of markdown.split(/\r?\n/).entries()) {
    const cells = tableCells(line);
    if (cells === undefined || !featureIdPattern.test(cells[0] ?? "")) continue;
    const [id = "", title = "", doneWhen = "", , status = ""] = cells;
    if (cells.length !== 5) {
      throw new Error(
        `features.md line ${String(index + 1)}: ${id} has ${String(cells.length)} cells, not 5`,
      );
    }
    if (!isFeatureStatus(status)) {
      throw new Error(
        `features.md line ${String(index + 1)}: ${id} has the status "${status}", not one of ${featureStatuses.join(", ")}`,
      );
    }
    features.push({ id, title, doneWhen, status, conditions: conditionsOf(doneWhen) });
  }
  return features;
};

// ---------------------------------------------------------------------------------------------
// Proof files
// ---------------------------------------------------------------------------------------------

export const proofKinds = ["unit", "integration", "e2e", "live"] as const;
export type ProofKind = (typeof proofKinds)[number];
export const proofStatuses = ["proved", "partial", "missing"] as const;
export type ProofStatus = (typeof proofStatuses)[number];

export type Citation =
  { kind: "test"; file: string; name: string } | { kind: "live"; evidence: string };

export type ProofRow = {
  /** 1-based line in the proof file. */
  line: number;
  condition: string;
  citations: readonly Citation[];
  /** Citations the parser couldn't read, as written. */
  badCitations: readonly string[];
  kinds: readonly string[];
  breakIt: string;
  status: string;
};

export const proofHeader = ["Condition", "Proved by", "Kind", "Break-it", "Status"] as const;

/** What a cell holds when it has nothing yet. */
const isEmptyCell = (cell: string): boolean => /^(|—|-|–)$/.test(cell.trim());

const testCitationPattern = /^`([^`]+)`\s*>\s*"(.+)"$/;
const liveCitationPattern = /^live:\s*(.+)$/;

const parseCitations = (cell: string): { citations: Citation[]; bad: string[] } => {
  const citations: Citation[] = [];
  const bad: string[] = [];
  if (isEmptyCell(cell)) return { citations, bad };
  for (const part of cell.split(/<br\s*\/?>/i).map((piece) => piece.trim())) {
    const test = testCitationPattern.exec(part);
    const live = liveCitationPattern.exec(part);
    if (test?.[1] !== undefined && test[2] !== undefined) {
      citations.push({ kind: "test", file: test[1], name: test[2] });
    } else if (live?.[1] !== undefined) {
      citations.push({ kind: "live", evidence: live[1].trim() });
    } else {
      bad.push(part);
    }
  }
  return { citations, bad };
};

export type ParsedProofFile =
  | {
      ok: true;
      rows: ProofRow[];
      /** The table's lines, 0-based: from its header to the line after its last row. */
      table: { start: number; end: number };
    }
  | { ok: false; reason: string };

/** Reads the proof table: the first table whose header is {@link proofHeader}. */
export const parseProofFile = (markdown: string): ParsedProofFile => {
  const lines = markdown.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => {
    const cells = tableCells(line);
    return (
      cells?.length === proofHeader.length &&
      cells.every((cell, index) => cell.toLowerCase() === proofHeader[index]?.toLowerCase())
    );
  });
  if (headerIndex === -1) {
    return { ok: false, reason: `it has no table with the header | ${proofHeader.join(" | ")} |` };
  }
  const rows: ProofRow[] = [];
  let index = headerIndex + 2;
  for (; index < lines.length; index += 1) {
    const cells = tableCells(lines[index] ?? "");
    if (cells === undefined) break;
    if (cells.length !== proofHeader.length) {
      return {
        ok: false,
        reason: `line ${String(index + 1)} has ${String(cells.length)} cells, not ${String(proofHeader.length)}`,
      };
    }
    const [condition = "", provedBy = "", kind = "", breakIt = "", status = ""] = cells;
    const { citations, bad } = parseCitations(provedBy);
    rows.push({
      line: index + 1,
      condition,
      citations,
      badCitations: bad,
      kinds: isEmptyCell(kind) ? [] : kind.split(",").map((piece) => piece.trim()),
      breakIt: isEmptyCell(breakIt) ? "" : breakIt,
      status,
    });
  }
  return { ok: true, rows, table: { start: headerIndex, end: index } };
};

const escapeCell = (text: string): string => text.replaceAll("|", "\\|");

/**
 * The proof table of a feature: one row per condition, in the order of the "done when", kept from
 * `existing` where it has one and `missing` where not, then any `existing` row whose condition is
 * no longer a sentence of the "done when".
 */
export const renderProofTable = (
  feature: Feature,
  existing: readonly ProofRow[] = [],
): string[] => {
  const byCondition = new Map(existing.map((row) => [row.condition, row]));
  const renderRow = (row: ProofRow | undefined, condition: string): string => {
    if (row === undefined) return `| ${escapeCell(condition)} | — | — | — | missing |`;
    const provedBy =
      row.citations.length === 0 && row.badCitations.length === 0
        ? "—"
        : [
            ...row.citations.map((citation) =>
              citation.kind === "test"
                ? `\`${citation.file}\` > "${citation.name}"`
                : `live: ${citation.evidence}`,
            ),
            ...row.badCitations,
          ].join("<br>");
    const kind = row.kinds.length === 0 ? "—" : row.kinds.join(", ");
    const breakIt = row.breakIt === "" ? "—" : row.breakIt;
    return `| ${escapeCell(condition)} | ${escapeCell(provedBy)} | ${escapeCell(kind)} | ${escapeCell(breakIt)} | ${escapeCell(row.status)} |`;
  };
  const stale = existing.filter((row) => !feature.conditions.includes(row.condition));
  return [
    `| ${proofHeader.join(" | ")} |`,
    `|${proofHeader.map(() => "---").join("|")}|`,
    ...feature.conditions.map((condition) => renderRow(byCondition.get(condition), condition)),
    ...stale.map((row) => renderRow(row, row.condition)),
  ];
};

/** A new proof file for a feature, with every condition `missing`. */
export const renderProofFile = (feature: Feature): string =>
  [
    `# ${feature.id}: ${feature.title}`,
    "",
    `The proof of ${feature.id}'s "done when" in \`context/features.md\`: one row per condition, quoted verbatim. The rules are in \`context/proof/README.md\`, and \`pnpm check:proof\` checks this file.`,
    "",
    ...renderProofTable(feature),
    "",
  ].join("\n");

/** The proof file with its table brought up to the "done when", and everything around it kept. */
export const updateProofFile = (markdown: string, feature: Feature): string => {
  const parsed = parseProofFile(markdown);
  if (!parsed.ok) throw new Error(parsed.reason);
  const lines = markdown.split(/\r?\n/);
  lines.splice(
    parsed.table.start,
    parsed.table.end - parsed.table.start,
    ...renderProofTable(feature, parsed.rows),
  );
  return lines.join("\n");
};

// ---------------------------------------------------------------------------------------------
// Tests in a test file
// ---------------------------------------------------------------------------------------------

export type TestRun = "runs" | "skipped" | "conditional" | "expected-to-fail";

export type TestCase = {
  /** The test's own title, as the string literal holds it (its describe blocks not included). */
  name: string;
  /** 1-based. */
  line: number;
  run: TestRun;
};

type Scope = { parent: Scope | undefined; run: TestRun };

const testBases = new Set(["it", "test"]);
const hookOrHelper = new Set([
  "beforeEach",
  "afterEach",
  "beforeAll",
  "afterAll",
  "step",
  "extend",
  "use",
  "info",
  "expect",
  "setTimeout",
  "slow",
  "configure",
  "dispose",
  "mutate",
]);

/** `it.skipIf(x)` → { base: "it", members: ["skipIf"] }. */
const calleeChain = (
  expression: ts.Expression,
): { base: string; members: string[] } | undefined => {
  if (ts.isIdentifier(expression)) return { base: expression.text, members: [] };
  if (ts.isPropertyAccessExpression(expression)) {
    const inner = calleeChain(expression.expression);
    return inner === undefined
      ? undefined
      : { base: inner.base, members: [...inner.members, expression.name.text] };
  }
  if (ts.isCallExpression(expression)) return calleeChain(expression.expression);
  return undefined;
};

const runOf = (members: readonly string[]): TestRun => {
  if (members.some((member) => member === "skip" || member === "todo" || member === "fixme"))
    return "skipped";
  if (members.some((member) => member === "skipIf" || member === "runIf")) return "conditional";
  if (members.some((member) => member === "fails" || member === "fail")) return "expected-to-fail";
  return "runs";
};

const worse = (a: TestRun, b: TestRun): TestRun => {
  const order: readonly TestRun[] = ["runs", "conditional", "expected-to-fail", "skipped"];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
};

const effectiveRun = (scope: Scope | undefined): TestRun =>
  scope === undefined ? "runs" : worse(scope.run, effectiveRun(scope.parent));

/**
 * Finds the tests of a Vitest or Playwright file: `it(...)` and `test(...)` calls whose first
 * argument is a string literal, with the modifiers on them and on their describe blocks, and the
 * run-time skips (`test.skip()`, `test.skip(condition)`) inside their bodies.
 */
export const findTests = (source: string, fileName: string): TestCase[] => {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: { name: string; line: number; scope: Scope }[] = [];
  const visit = (node: ts.Node, scope: Scope): void => {
    if (ts.isCallExpression(node)) {
      const chain = calleeChain(node.expression);
      const [first] = node.arguments;
      const title =
        first !== undefined &&
        (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
          ? first.text
          : undefined;
      if (
        chain !== undefined &&
        (chain.base === "describe" ||
          (testBases.has(chain.base) && chain.members[0] === "describe"))
      ) {
        const members = chain.base === "describe" ? chain.members : chain.members.slice(1);
        if (title !== undefined || members.length === 0 || runOf(members) !== "runs") {
          const inner: Scope = { parent: scope, run: runOf(members) };
          for (const argument of node.arguments) visit(argument, inner);
          return;
        }
      } else if (
        chain !== undefined &&
        testBases.has(chain.base) &&
        !chain.members.some((member) => hookOrHelper.has(member))
      ) {
        const run = runOf(chain.members);
        if (title === undefined && run !== "runs") {
          // A run-time skip, `test.skip()` or `test.skip(condition, reason)`: it holds for the
          // test or describe block around it.
          scope.run = worse(
            scope.run,
            run === "skipped" && first !== undefined ? "conditional" : run,
          );
          return;
        }
        if (title !== undefined) {
          const inner: Scope = { parent: scope, run };
          found.push({
            name: title,
            line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
            scope: inner,
          });
          for (const argument of node.arguments.slice(1)) visit(argument, inner);
          return;
        }
      }
    }
    ts.forEachChild(node, (child) => {
      visit(child, scope);
    });
  };
  visit(file, { parent: undefined, run: "runs" });
  return found.map(({ name, line, scope }) => ({ name, line, run: effectiveRun(scope) }));
};

// ---------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------

export type Problem =
  | { kind: "no-proof-file"; file: string }
  | { kind: "unreadable-proof-file"; file: string; reason: string }
  | { kind: "condition-without-row"; condition: string }
  | { kind: "row-not-a-condition"; line: number; condition: string }
  | { kind: "duplicate-row"; line: number; condition: string }
  | { kind: "bad-status"; line: number; status: string }
  | { kind: "not-proved"; line: number; condition: string; status: ProofStatus }
  | { kind: "bad-kind"; line: number; value: string }
  | { kind: "no-kind"; line: number }
  | { kind: "no-citation"; line: number }
  | { kind: "bad-citation"; line: number; text: string }
  | { kind: "kind-mismatch"; line: number; reason: string }
  | { kind: "no-break-it"; line: number }
  | { kind: "not-a-test-file"; line: number; file: string }
  | { kind: "test-file-missing"; line: number; file: string }
  | { kind: "test-not-found"; line: number; file: string; name: string }
  | {
      kind: "test-does-not-run";
      line: number;
      file: string;
      name: string;
      run: Exclude<TestRun, "runs">;
    }
  | { kind: "test-name-lacks-id"; line: number; name: string }
  | { kind: "evidence-missing"; line: number; evidence: string };

export type FeatureReport = {
  feature: Feature;
  /** Whether a failing check fails the run: a `done` row that isn't in the baseline. */
  enforced: boolean;
  baselined: boolean;
  problems: Problem[];
  /** How many of its conditions have a row that is `proved` with no problem on it. */
  proved: number;
};

export type LedgerProblem =
  | { kind: "unknown-proof-file"; file: string }
  | { kind: "baseline-unknown"; id: string }
  | { kind: "baseline-not-done"; id: string; status: FeatureStatus }
  | { kind: "baseline-proved"; id: string }
  | { kind: "bad-baseline"; reason: string };

export type ProofReport = {
  features: FeatureReport[];
  ledgerProblems: LedgerProblem[];
};

const baselineSchema = z
  .object({
    $comment: z.string().optional(),
    rows: z.array(z.string().regex(featureIdPattern)),
  })
  .strict();

const exists = async (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

const testFilePattern = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Whether `relative` stays inside the repo once resolved. */
const insideRoot = (root: string, relative: string): boolean => {
  const resolved = path.resolve(root, relative);
  const fromRoot = path.relative(root, resolved);
  return fromRoot !== "" && !fromRoot.startsWith("..") && !path.isAbsolute(fromRoot);
};

const checkRow = async (
  root: string,
  feature: Feature,
  row: ProofRow,
  testsByFile: Map<string, Promise<TestCase[] | undefined>>,
): Promise<Problem[]> => {
  const problems: Problem[] = [];
  const { line } = row;
  const status = proofStatuses.find((candidate) => candidate === row.status);
  if (status === undefined) {
    problems.push({ kind: "bad-status", line, status: row.status });
    return problems;
  }
  if (status !== "proved") {
    problems.push({ kind: "not-proved", line, condition: row.condition, status });
  }
  if (status === "missing") return problems;

  for (const text of row.badCitations) problems.push({ kind: "bad-citation", line, text });
  if (row.citations.length === 0 && row.badCitations.length === 0)
    problems.push({ kind: "no-citation", line });
  const kinds: ProofKind[] = [];
  for (const kind of row.kinds) {
    const known = proofKinds.find((candidate) => candidate === kind);
    if (known === undefined) problems.push({ kind: "bad-kind", line, value: kind });
    else kinds.push(known);
  }
  if (row.kinds.length === 0) problems.push({ kind: "no-kind", line });

  const testCitations = row.citations.filter((citation) => citation.kind === "test");
  const liveCitations = row.citations.filter((citation) => citation.kind === "live");
  const testKinds = kinds.filter((kind) => kind !== "live");
  if (testCitations.length > 0 && testKinds.length === 0 && kinds.length > 0) {
    problems.push({
      kind: "kind-mismatch",
      line,
      reason: "it cites a test, so its kind names unit, integration or e2e",
    });
  }
  if (testCitations.length === 0 && testKinds.length > 0) {
    problems.push({
      kind: "kind-mismatch",
      line,
      reason: `its kind says ${testKinds.join(", ")}, but it cites no test`,
    });
  }
  if (liveCitations.length > 0 && !kinds.includes("live")) {
    problems.push({
      kind: "kind-mismatch",
      line,
      reason: "it cites live evidence, so its kind includes live",
    });
  }
  if (liveCitations.length === 0 && kinds.includes("live")) {
    problems.push({
      kind: "kind-mismatch",
      line,
      reason: "its kind says live, but it cites no live evidence",
    });
  }
  if (testCitations.length > 0 && row.breakIt === "") problems.push({ kind: "no-break-it", line });

  const idPattern = new RegExp(`(^|[^\\w-])${feature.id}(?!\\d)`);
  for (const citation of row.citations) {
    if (citation.kind === "live") {
      const evidence = citation.evidence.replaceAll(/^`|`$/g, "");
      if (/^https:\/\/\S+$/.test(evidence)) continue;
      if (!insideRoot(root, evidence) || !(await exists(path.resolve(root, evidence)))) {
        problems.push({ kind: "evidence-missing", line, evidence });
      }
      continue;
    }
    const { file, name } = citation;
    if (!idPattern.test(name)) problems.push({ kind: "test-name-lacks-id", line, name });
    if (!testFilePattern.test(file)) {
      problems.push({ kind: "not-a-test-file", line, file });
      continue;
    }
    if (!insideRoot(root, file)) {
      problems.push({ kind: "test-file-missing", line, file });
      continue;
    }
    let tests = testsByFile.get(file);
    if (tests === undefined) {
      tests = readFile(path.resolve(root, file), "utf8").then(
        (source) => findTests(source, file),
        () => undefined,
      );
      testsByFile.set(file, tests);
    }
    const found = await tests;
    if (found === undefined) {
      problems.push({ kind: "test-file-missing", line, file });
      continue;
    }
    const matches = found.filter((test) => test.name === name);
    if (matches.length === 0) {
      problems.push({ kind: "test-not-found", line, file, name });
    } else if (!matches.some((test) => test.run === "runs")) {
      const run = matches[0]?.run ?? "skipped";
      if (run !== "runs") problems.push({ kind: "test-does-not-run", line, file, name, run });
    }
  }
  return problems;
};

const checkFeature = async (
  root: string,
  proofDir: string,
  feature: Feature,
  testsByFile: Map<string, Promise<TestCase[] | undefined>>,
): Promise<{ problems: Problem[]; proved: number } | undefined> => {
  const file = path.posix.join(proofDir, `${feature.id}.md`);
  const markdown = await readFile(path.resolve(root, file), "utf8").catch(() => undefined);
  if (markdown === undefined) {
    return feature.status === "done"
      ? { problems: [{ kind: "no-proof-file", file }], proved: 0 }
      : undefined;
  }
  const parsed = parseProofFile(markdown);
  if (!parsed.ok)
    return {
      problems: [{ kind: "unreadable-proof-file", file, reason: parsed.reason }],
      proved: 0,
    };

  const problems: Problem[] = [];
  const seen = new Set<string>();
  let proved = 0;
  for (const row of parsed.rows) {
    if (seen.has(row.condition)) {
      problems.push({ kind: "duplicate-row", line: row.line, condition: row.condition });
      continue;
    }
    seen.add(row.condition);
    if (!feature.conditions.includes(row.condition)) {
      problems.push({ kind: "row-not-a-condition", line: row.line, condition: row.condition });
      continue;
    }
    const rowProblems = await checkRow(root, feature, row, testsByFile);
    if (rowProblems.length === 0) proved += 1;
    problems.push(...rowProblems);
  }
  for (const condition of feature.conditions) {
    if (!seen.has(condition)) problems.push({ kind: "condition-without-row", condition });
  }
  return { problems, proved };
};

export type CheckOptions = {
  /** The repo root. */
  root: string;
  /** Relative to the root. Defaults to `context/features.md`. */
  featuresFile?: string;
  /** Relative to the root, with forward slashes. Defaults to `context/proof`. */
  proofDir?: string;
};

export const checkProofs = async (options: CheckOptions): Promise<ProofReport> => {
  const { root } = options;
  const proofDir = options.proofDir ?? "context/proof";
  const features = parseFeatures(
    await readFile(path.resolve(root, options.featuresFile ?? "context/features.md"), "utf8"),
  );
  const byId = new Map(features.map((feature) => [feature.id, feature]));
  const ledgerProblems: LedgerProblem[] = [];

  const baselineText = await readFile(path.resolve(root, proofDir, "baseline.json"), "utf8").catch(
    () => undefined,
  );
  const baseline = new Set<string>();
  if (baselineText !== undefined) {
    let json: unknown;
    try {
      json = JSON.parse(baselineText);
    } catch (error) {
      json = undefined;
      ledgerProblems.push({
        kind: "bad-baseline",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    if (json !== undefined) {
      const parsed = baselineSchema.safeParse(json);
      if (parsed.success) {
        for (const id of parsed.data.rows) baseline.add(id);
      } else {
        ledgerProblems.push({ kind: "bad-baseline", reason: z.prettifyError(parsed.error) });
      }
    }
  }
  for (const id of baseline) {
    const feature = byId.get(id);
    if (feature === undefined) ledgerProblems.push({ kind: "baseline-unknown", id });
    else if (feature.status !== "done")
      ledgerProblems.push({ kind: "baseline-not-done", id, status: feature.status });
  }

  const entries = await readdir(path.resolve(root, proofDir)).catch(() => []);
  for (const entry of entries.toSorted()) {
    if (entry === "README.md" || entry === "baseline.json") continue;
    const id = /^(F-\d{3,})\.md$/.exec(entry)?.[1];
    if (id === undefined || !byId.has(id)) {
      ledgerProblems.push({ kind: "unknown-proof-file", file: path.posix.join(proofDir, entry) });
    }
  }

  const testsByFile = new Map<string, Promise<TestCase[] | undefined>>();
  const reports: FeatureReport[] = [];
  for (const feature of features) {
    if (feature.status === "dropped") continue;
    const result = await checkFeature(root, proofDir, feature, testsByFile);
    if (result === undefined) continue;
    const baselined = baseline.has(feature.id);
    reports.push({
      feature,
      enforced: feature.status === "done" && !baselined,
      baselined,
      problems: result.problems,
      proved: result.proved,
    });
    if (baselined && feature.status === "done" && result.problems.length === 0) {
      ledgerProblems.push({ kind: "baseline-proved", id: feature.id });
    }
  }
  return { features: reports, ledgerProblems };
};

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

const quote = (text: string): string =>
  text.length > 110 ? `"${text.slice(0, 107)}..."` : `"${text}"`;

export const describeProblem = (problem: Problem): string => {
  switch (problem.kind) {
    case "no-proof-file":
      return `no proof file: create it with \`pnpm proof:new ${path.posix.basename(problem.file, ".md")}\` (${problem.file})`;
    case "unreadable-proof-file":
      return `${problem.file} can't be read: ${problem.reason}`;
    case "condition-without-row":
      return `no row for the condition ${quote(problem.condition)}`;
    case "row-not-a-condition":
      return `line ${String(problem.line)}: ${quote(problem.condition)} is not a sentence of the "done when": it was misquoted, or the "done when" changed (\`pnpm proof:new\` adds the new sentences)`;
    case "duplicate-row":
      return `line ${String(problem.line)}: a second row for ${quote(problem.condition)}`;
    case "bad-status":
      return `line ${String(problem.line)}: the status "${problem.status}" is not one of ${proofStatuses.join(", ")}`;
    case "not-proved":
      return `line ${String(problem.line)}: ${problem.status}: ${quote(problem.condition)}`;
    case "bad-kind":
      return `line ${String(problem.line)}: the kind "${problem.value}" is not one of ${proofKinds.join(", ")}`;
    case "no-kind":
      return `line ${String(problem.line)}: no kind (${proofKinds.join(", ")})`;
    case "no-citation":
      return `line ${String(problem.line)}: "proved by" cites nothing`;
    case "bad-citation":
      return `line ${String(problem.line)}: can't read the citation ${quote(problem.text)}: write \`path/to/file.test.ts\` > "exact test name", or live: <evidence>`;
    case "kind-mismatch":
      return `line ${String(problem.line)}: ${problem.reason}`;
    case "no-break-it":
      return `line ${String(problem.line)}: no break-it: say what you broke to see the test fail`;
    case "not-a-test-file":
      return `line ${String(problem.line)}: ${problem.file} is not a test file (*.test.ts or *.spec.ts)`;
    case "test-file-missing":
      return `line ${String(problem.line)}: ${problem.file} does not exist`;
    case "test-not-found":
      return `line ${String(problem.line)}: ${problem.file} has no test named ${quote(problem.name)}`;
    case "test-does-not-run":
      return `line ${String(problem.line)}: the test ${quote(problem.name)} in ${problem.file} is ${problem.run === "conditional" ? "behind a condition (skipIf, runIf or a run-time skip)" : problem.run}, so it proves nothing`;
    case "test-name-lacks-id":
      return `line ${String(problem.line)}: the test name ${quote(problem.name)} doesn't name the feature's ID`;
    case "evidence-missing":
      return `line ${String(problem.line)}: the live evidence ${problem.evidence} is neither a file in the repo nor an https link`;
    default:
      return problem satisfies never;
  }
};

export const describeLedgerProblem = (problem: LedgerProblem): string => {
  switch (problem.kind) {
    case "unknown-proof-file":
      return `${problem.file} is not named after a feature row of context/features.md (F-nnn.md)`;
    case "baseline-unknown":
      return `baseline.json names ${problem.id}, which is not a feature row`;
    case "baseline-not-done":
      return `baseline.json names ${problem.id}, which is ${problem.status}: the baseline holds only done rows, so remove it`;
    case "baseline-proved":
      return `${problem.id} is fully proved: remove it from context/proof/baseline.json, so it stays proved`;
    case "bad-baseline":
      return `context/proof/baseline.json can't be read: ${problem.reason}`;
    default:
      return problem satisfies never;
  }
};

export type RenderedReport = { lines: string[]; errors: number; warnings: number };

/**
 * The report, row by row. A row that is enforced lists every problem. A row that only warns lists
 * its rows that aren't proved as one count, unless `verbose`, and every other problem in full.
 */
export const renderReport = (
  report: ProofReport,
  options: { verbose?: boolean } = {},
): RenderedReport => {
  const lines: string[] = [];
  let errors = 0;
  let warnings = 0;
  for (const problem of report.ledgerProblems) {
    errors += 1;
    lines.push(`error  ${describeLedgerProblem(problem)}`);
  }
  for (const { feature, enforced, baselined, problems, proved } of report.features) {
    if (problems.length === 0) continue;
    const level = enforced ? "error" : "warn ";
    if (enforced) errors += problems.length;
    else warnings += problems.length;
    const why = baselined ? "done, in the baseline" : feature.status;
    const notProved = problems.filter((problem) => problem.kind === "not-proved");
    const summarise = !enforced && options.verbose !== true && notProved.length > 0;
    const counts = summarise
      ? proofStatuses
          .filter((status) => status !== "proved")
          .map(
            (status) =>
              [status, notProved.filter((problem) => problem.status === status).length] as const,
          )
          .filter(([, count]) => count > 0)
          .map(([status, count]) => `, ${String(count)} ${status}`)
          .join("")
      : "";
    lines.push(
      `${level}  ${feature.id} ${feature.title} (${why}), context/proof/${feature.id}.md: ${String(proved)} of ${String(feature.conditions.length)} conditions proved${counts}`,
    );
    for (const problem of problems) {
      if (summarise && problem.kind === "not-proved") continue;
      lines.push(`         ${describeProblem(problem)}`);
    }
  }
  const done = report.features.filter((entry) => entry.feature.status === "done");
  const fullyProved = done.filter((entry) => entry.problems.length === 0).length;
  const baselined = done.filter((entry) => entry.baselined).length;
  lines.push(
    `check:proof: ${String(done.length)} done rows, ${String(fullyProved)} fully proved, ${String(baselined)} in the baseline; ${String(errors)} error(s), ${String(warnings)} warning(s)`,
  );
  return { lines, errors, warnings };
};

const main = async (): Promise<void> => {
  const root = path.resolve(import.meta.dirname, "..");
  const verbose = process.argv.includes("--verbose");
  const { lines, errors } = renderReport(await checkProofs({ root }), { verbose });
  for (const line of lines) console.log(line);
  if (errors > 0) {
    console.error("check:proof: see context/proof/README.md for the rules");
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  await main();
}
