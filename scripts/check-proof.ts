// The proof ledger, checked by a machine (`context/proof/README.md`).
//
// A feature row of `context/features.md` has a proof file, `context/proof/F-nnn.md`, with one table
// row per condition of its "done when". A condition is one sentence of that text, quoted verbatim
// (the dated notes in italics are not conditions), and its row gives it a key: `c1`, `c2` and so on.
// A test proves a condition when its name starts with the feature's ID and that key:
// `it("F-025/c1: stops the agent", ...)`.
//
// The tooling writes two cells of each row from the code, and checks them:
//
// - Tests: every test of the repo whose name gives the row's key and which runs (not skipped, not
//   behind a condition), by file and name;
// - Status: `proved` when the row has such a test and a break-it, or live evidence kept in the
//   repo; `missing` otherwise; `partial` when a person wrote it, to hold the row back.
//
// People write the rest: the live evidence, the break-it, and why a row is partial or missing.
//
// For a `done` row: its proof file exists, it has a row for every condition, matched verbatim, and
// every row is `proved`. A `building` or `planned` row with a proof file gets the same checks as
// warnings, and a warning names a row whose every condition is proved. The two written cells must
// match the code in every proof file, so a renamed or deleted test fails the check until
// `pnpm proof:sync` writes them again. A `done` row in `context/proof/baseline.json` only warns:
// rows marked done before the ledger existed. The baseline only shrinks.
//
// Run with `pnpm check:proof`; `pnpm proof:sync` (`--write`) writes the two cells first.

import { access, readdir, readFile, writeFile } from "node:fs/promises";
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
export const tableCells = (line: string): string[] | undefined => {
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
 * italics that are part of a sentence, such as `*(working value)*`. Bold (`**`) is left alone,
 * and so is a `*` inside a code span, such as `refs/ostra/wip/*`.
 */
export const stripNotes = (doneWhen: string): string => {
  /** The index of the `*` that closes an italic span opened just before `from`, or -1. */
  const closing = (from: number): number => {
    let inCode = false;
    for (let index = from; index < doneWhen.length; index += 1) {
      const char = doneWhen.charAt(index);
      if (char === "`") inCode = !inCode;
      else if (!inCode && char === "*") {
        if (doneWhen.charAt(index + 1) !== "*") return index;
        index += 1;
      }
    }
    return -1;
  };
  let result = "";
  let inCode = false;
  for (let index = 0; index < doneWhen.length; index += 1) {
    const char = doneWhen.charAt(index);
    if (char === "`") inCode = !inCode;
    if (inCode || char !== "*") {
      result += char;
      continue;
    }
    if (doneWhen.charAt(index + 1) === "*") {
      result += "**";
      index += 1;
      continue;
    }
    const end = closing(index + 1);
    if (end === -1) {
      result += char;
      continue;
    }
    const span = doneWhen.slice(index, end + 1);
    if (!datePattern.test(span)) result += span;
    index = end;
  }
  return result;
};

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
// Tests in a test file
// ---------------------------------------------------------------------------------------------

export type TestRun = "runs" | "skipped" | "conditional" | "expected-to-fail";

export type TestCase = {
  /** The test's own title, as the string literal holds it (its describe blocks not included). */
  name: string;
  /** 1-based. */
  line: number;
  run: TestRun;
  /** The title's string literal, for a tool that rewrites it. */
  literal: { start: number; end: number };
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
  const found: { name: string; line: number; scope: Scope; literal: ts.Node }[] = [];
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
        if (title !== undefined && first !== undefined) {
          const inner: Scope = { parent: scope, run };
          found.push({
            name: title,
            line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
            scope: inner,
            literal: first,
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
  return found.map(({ name, line, scope, literal }) => ({
    name,
    line,
    run: effectiveRun(scope),
    literal: { start: literal.getStart(file), end: literal.getEnd() },
  }));
};

// ---------------------------------------------------------------------------------------------
// Condition keys in test names
// ---------------------------------------------------------------------------------------------

export type TitleKeys = {
  /** Each feature the title's head names, with the condition keys it gives (none: a bare ID). */
  features: readonly { id: string; keys: readonly string[] }[];
  /** Whether the title holds a key the rules can't read, such as `F-025/2` or `x, F-025/c1:`. */
  malformed: boolean;
};

/** An F-ID with its keys, `F-025/c1,c3`, not followed by a letter, digit, `/` or `-`. */
const keyToken = /F-\d{3,}(?:\/c\d+(?:,c\d+)*)?(?![\w/-])/g;

/**
 * The condition keys a test's title gives. They're read from its head, the text before its first
 * `: `, when the head starts with an F-ID: `F-099/c1,c3, F-100/c2: ...` gives c1 and c3 of F-099
 * and c2 of F-100. A bare `F-099` names the feature without proving a condition.
 */
export const titleKeys = (title: string): TitleKeys => {
  const end = title.search(/:(?:\s|$)/);
  const head = end === -1 ? "" : title.slice(0, end);
  if (!head.startsWith("F-")) {
    return { features: [], malformed: /F-\d{3,}\/c\d/.test(title) };
  }
  const byId = new Map<string, string[]>();
  let tokens = 0;
  for (const [token] of head.matchAll(keyToken)) {
    tokens += 1;
    const [id = "", keys = ""] = token.split("/");
    const list = byId.get(id) ?? [];
    for (const key of keys === "" ? [] : keys.split(",")) if (!list.includes(key)) list.push(key);
    byId.set(id, list);
  }
  const ids = head.match(/F-\d{3,}/g)?.length ?? 0;
  return {
    features: [...byId].map(([id, keys]) => ({ id, keys })),
    malformed: ids !== tokens || /F-\d{3,}\/c\d/.test(title.slice(head.length)),
  };
};

export type KeyedTest = {
  id: string;
  key: string;
  /** From the repo root, with forward slashes. */
  file: string;
  name: string;
  line: number;
  run: TestRun;
};

export type TestIndex = {
  /** One entry per test and key it gives. */
  keyed: readonly KeyedTest[];
  /** Tests whose title holds a key the rules can't read. */
  malformed: readonly { file: string; name: string; line: number }[];
};

const testFilePattern = /\.(test|spec)\.[cm]?[jt]sx?$/;
/** Folders that hold no test of ostra's: installed, built or generated files, and the spikes. */
const skippedFolders = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "generated",
  "test-results",
  "playwright-report",
]);

/** Every test file under the repo, from its root with forward slashes, sorted. */
export const listTestFiles = async (root: string): Promise<string[]> => {
  const found: string[] = [];
  const walk = async (folder: string): Promise<void> => {
    const entries = await readdir(path.join(root, folder), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const relative = folder === "" ? entry.name : `${folder}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || skippedFolders.has(entry.name)) continue;
        if (folder === "" && entry.name === "spikes") continue;
        await walk(relative);
      } else if (entry.isFile() && testFilePattern.test(entry.name)) {
        found.push(relative);
      }
    }
  };
  await walk("");
  return found.toSorted();
};

/** Reads every test of the repo whose title gives a condition key. */
export const scanTests = async (root: string): Promise<TestIndex> => {
  const perFile = await Promise.all(
    (await listTestFiles(root)).map(async (file) => {
      const source = await readFile(path.join(root, file), "utf8");
      if (!/F-\d{3}/.test(source)) return { keyed: [], malformed: [] };
      const keyed: KeyedTest[] = [];
      const malformed: { file: string; name: string; line: number }[] = [];
      for (const test of findTests(source, file)) {
        const keys = titleKeys(test.name);
        if (keys.malformed) malformed.push({ file, name: test.name, line: test.line });
        for (const feature of keys.features) {
          for (const key of feature.keys) {
            keyed.push({
              id: feature.id,
              key,
              file,
              name: test.name,
              line: test.line,
              run: test.run,
            });
          }
        }
      }
      return { keyed, malformed };
    }),
  );
  return {
    keyed: perFile.flatMap((entry) => entry.keyed),
    malformed: perFile.flatMap((entry) => entry.malformed),
  };
};

// ---------------------------------------------------------------------------------------------
// Proof files
// ---------------------------------------------------------------------------------------------

export const proofStatuses = ["proved", "partial", "missing"] as const;
export type ProofStatus = (typeof proofStatuses)[number];

export const proofHeader = ["Key", "Condition", "Tests", "Live", "Break-it", "Status"] as const;
/** The header of a proof file written before 2026-11-20, which `proof-migrate.ts` converts. */
export const formerProofHeader = ["Condition", "Proved by", "Kind", "Break-it", "Status"] as const;

/** A row of a proof table, its cells as written (`\|` unescaped). */
export type ProofRow = {
  /** 1-based line in the proof file. */
  line: number;
  key: string;
  condition: string;
  /** Written by the tooling. */
  tests: string;
  live: string;
  breakIt: string;
  /** Written by the tooling, except `partial` and a reason after `missing:`. */
  status: string;
};

/** What a cell holds when it has nothing yet. */
const isEmptyCell = (cell: string): boolean => /^(|—|-|–)$/.test(cell.trim());

const keyPattern = /^c\d+$/;
const keyNumber = (key: string): number => (keyPattern.test(key) ? Number(key.slice(1)) : 0);

const isHeader = (line: string, header: readonly string[]): boolean => {
  const cells = tableCells(line);
  return (
    cells?.length === header.length &&
    cells.every((cell, index) => cell.toLowerCase() === header[index]?.toLowerCase())
  );
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
  const headerIndex = lines.findIndex((line) => isHeader(line, proofHeader));
  if (headerIndex === -1) {
    return lines.some((line) => isHeader(line, formerProofHeader))
      ? {
          ok: false,
          reason:
            "its table is in the form used before 2026-11-20: convert it with `node scripts/proof-migrate.ts`",
        }
      : { ok: false, reason: `it has no table with the header | ${proofHeader.join(" | ")} |` };
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
    const [key = "", condition = "", tests = "", live = "", breakIt = "", status = ""] = cells;
    rows.push({
      line: index + 1,
      key,
      condition,
      tests: isEmptyCell(tests) ? "" : tests,
      live: isEmptyCell(live) ? "" : live,
      breakIt: isEmptyCell(breakIt) ? "" : breakIt,
      status,
    });
  }
  return { ok: true, rows, table: { start: headerIndex, end: index } };
};

const escapeCell = (text: string): string => text.replaceAll("|", "\\|");
const cellOrDash = (text: string): string => (text === "" ? "—" : text);

export const renderRow = (row: Omit<ProofRow, "line">): string =>
  `| ${[row.key, row.condition, cellOrDash(row.tests), cellOrDash(row.live), cellOrDash(row.breakIt), row.status].map(escapeCell).join(" | ")} |`;

/** The Tests cell for a row's tests: each once, by file, then in the file's order. */
export const renderTestsCell = (tests: readonly KeyedTest[]): string => {
  const seen = new Set<string>();
  const citations: string[] = [];
  const sorted = tests.toSorted((a, b) =>
    a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1,
  );
  for (const test of sorted) {
    const citation = `\`${test.file}\` > "${test.name}"`;
    if (seen.has(citation)) continue;
    seen.add(citation);
    citations.push(citation);
  }
  return citations.join("<br>");
};

/** The items of a Live cell: repo paths (backticks taken off) or https links. */
export const liveItems = (cell: string): string[] =>
  cell
    .split(/<br\s*\/?>/i)
    .map((item) => item.trim().replaceAll(/^`|`$/g, ""))
    .filter((item) => item !== "");

type WrittenStatus = { status: ProofStatus; reason: string };

const parseStatus = (cell: string): WrittenStatus | undefined => {
  const match = /^(proved|partial|missing)(?::\s*(.*))?$/s.exec(cell.trim());
  const status = proofStatuses.find((candidate) => candidate === match?.[1]);
  if (status === undefined) return undefined;
  const reason = match?.[2]?.trim() ?? "";
  if (status === "proved" && reason !== "") return undefined;
  return { status, reason };
};

const renderStatus = ({ status, reason }: WrittenStatus): string =>
  reason === "" ? status : `${status}: ${reason}`;

const rowTemplate = (key: string, condition: string): Omit<ProofRow, "line"> => ({
  key,
  condition,
  tests: "",
  live: "",
  breakIt: "",
  status: "missing",
});

/**
 * The proof table of a feature: one row per condition, in the order of the "done when", kept from
 * `existing` where it has one and `missing` where not, then any `existing` row whose condition is
 * no longer a sentence of the "done when". A new row's key is one past the highest key so far, so
 * no key is ever given to two conditions.
 */
export const renderProofTable = (
  feature: Feature,
  existing: readonly ProofRow[] = [],
): string[] => {
  const byCondition = new Map(existing.map((row) => [row.condition, row]));
  let next = Math.max(0, ...existing.map((row) => keyNumber(row.key))) + 1;
  const stale = existing.filter((row) => !feature.conditions.includes(row.condition));
  return [
    `| ${proofHeader.join(" | ")} |`,
    `|${proofHeader.map(() => "---").join("|")}|`,
    ...feature.conditions.map((condition) => {
      const row = byCondition.get(condition);
      if (row !== undefined) return renderRow(row);
      const key = `c${String(next)}`;
      next += 1;
      return renderRow(rowTemplate(key, condition));
    }),
    ...stale.map((row) => renderRow(row)),
  ];
};

export const proofFileIntro = (id: string): string =>
  `The proof of ${id}'s "done when" in \`context/features.md\`: one row per condition, quoted verbatim. A test proves a condition when its name starts with the condition's key, \`${id}/c1: ...\`. \`pnpm proof:sync\` writes the Tests and Status cells; the rules are in \`context/proof/README.md\`.`;

/** A new proof file for a feature, with every condition `missing`. */
export const renderProofFile = (feature: Feature): string =>
  [
    `# ${feature.id}: ${feature.title}`,
    "",
    proofFileIntro(feature.id),
    "",
    ...renderProofTable(feature),
    "",
  ].join("\n");

const lineEnding = (markdown: string): string => (markdown.includes("\r\n") ? "\r\n" : "\n");

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
  return lines.join(lineEnding(markdown));
};

// ---------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------

export type Problem =
  | { kind: "no-proof-file"; file: string }
  | { kind: "keys-without-proof-file"; file: string; tests: number }
  | { kind: "unreadable-proof-file"; file: string; reason: string }
  | { kind: "condition-without-row"; condition: string }
  | { kind: "row-not-a-condition"; line: number; condition: string }
  | { kind: "duplicate-row"; line: number; condition: string }
  | { kind: "bad-key"; line: number; key: string }
  | { kind: "duplicate-key"; line: number; key: string }
  | { kind: "unknown-key"; key: string; file: string; name: string }
  | { kind: "bad-status"; line: number; status: string }
  | { kind: "not-proved"; line: number; condition: string; status: Exclude<ProofStatus, "proved"> }
  | { kind: "no-break-it"; line: number }
  | { kind: "evidence-missing"; line: number; evidence: string }
  | {
      kind: "test-does-not-run";
      line: number;
      file: string;
      name: string;
      run: Exclude<TestRun, "runs">;
    }
  | { kind: "stale-tests"; line: number; key: string; added: number; gone: number }
  | { kind: "stale-status"; line: number; key: string; written: string; status: string }
  | { kind: "could-be-done" };

/** Problems that fail the check for every row, whatever its status: the cells the tooling writes. */
const isStale = (problem: Problem): boolean =>
  problem.kind === "stale-tests" || problem.kind === "stale-status";

export type FeatureReport = {
  feature: Feature;
  /** Whether a failing check fails the run: a `done` row that isn't in the baseline. */
  enforced: boolean;
  baselined: boolean;
  problems: Problem[];
  /** How many of its conditions have a row that is `proved` with no problem on it. */
  proved: number;
  /** The proof file with the cells the tooling writes brought up to date, when they aren't. */
  synced?: { file: string; markdown: string };
};

export type LedgerProblem =
  | { kind: "unknown-proof-file"; file: string }
  | { kind: "baseline-unknown"; id: string }
  | { kind: "baseline-not-done"; id: string; status: FeatureStatus }
  | { kind: "baseline-proved"; id: string }
  | { kind: "bad-baseline"; reason: string }
  | { kind: "malformed-test-key"; file: string; line: number; name: string }
  | { kind: "test-key-unknown-feature"; file: string; line: number; name: string; id: string };

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

/** Whether `relative` stays inside the repo once resolved. */
const insideRoot = (root: string, relative: string): boolean => {
  const resolved = path.resolve(root, relative);
  const fromRoot = path.relative(root, resolved);
  return fromRoot !== "" && !fromRoot.startsWith("..") && !path.isAbsolute(fromRoot);
};

const testCitationPattern = /^`([^`]+)`\s*>\s*"(.+)"$/;

/** The citations of a Tests cell as `file > name`, to say how it differs from the code. */
const citationsOf = (cell: string): Set<string> =>
  new Set(
    cell === ""
      ? []
      : cell.split(/<br\s*\/?>/i).map((part) => {
          const match = testCitationPattern.exec(part.trim());
          return match === null ? part.trim() : `${match[1] ?? ""} > ${match[2] ?? ""}`;
        }),
  );

/** Checks one row against its tests, and works out the two cells the tooling writes. */
const checkRow = async (
  root: string,
  row: ProofRow,
  tests: readonly KeyedTest[],
): Promise<{ problems: Problem[]; status: ProofStatus | undefined; cells: ProofRow }> => {
  const { line } = row;
  const problems: Problem[] = [];
  const running = tests.filter((test) => test.run === "runs");
  const testsCell = renderTestsCell(running);

  const evidence: Problem[] = [];
  const live = liveItems(row.live);
  if (running.length > 0 && row.breakIt === "") evidence.push({ kind: "no-break-it", line });
  for (const item of live) {
    if (/^https:\/\/\S+$/.test(item)) continue;
    if (!insideRoot(root, item) || !(await exists(path.resolve(root, item)))) {
      evidence.push({ kind: "evidence-missing", line, evidence: item });
    }
  }

  const written = parseStatus(row.status);
  let status: ProofStatus | undefined;
  let statusCell = row.status;
  if (written === undefined) {
    problems.push({ kind: "bad-status", line, status: row.status });
  } else if (written.status === "partial") {
    status = "partial";
    statusCell = renderStatus(written);
  } else {
    const proved = running.length + live.length > 0 && evidence.length === 0;
    status = proved ? "proved" : "missing";
    statusCell = renderStatus(proved ? { status, reason: "" } : { status, reason: written.reason });
  }
  if (status !== undefined && status !== "proved") {
    problems.push({ kind: "not-proved", line, condition: row.condition, status });
  }
  problems.push(...evidence);
  for (const test of tests) {
    if (test.run !== "runs") {
      problems.push({
        kind: "test-does-not-run",
        line,
        file: test.file,
        name: test.name,
        run: test.run,
      });
    }
  }
  if (testsCell !== row.tests) {
    const before = citationsOf(row.tests);
    const after = citationsOf(testsCell);
    problems.push({
      kind: "stale-tests",
      line,
      key: row.key,
      added: [...after].filter((citation) => !before.has(citation)).length,
      gone: [...before].filter((citation) => !after.has(citation)).length,
    });
  }
  if (statusCell !== row.status) {
    problems.push({
      kind: "stale-status",
      line,
      key: row.key,
      written: row.status,
      status: statusCell,
    });
  }
  return { problems, status, cells: { ...row, tests: testsCell, status: statusCell } };
};

const checkFeature = async (
  root: string,
  proofDir: string,
  feature: Feature,
  tests: readonly KeyedTest[],
): Promise<
  { problems: Problem[]; proved: number; synced?: { file: string; markdown: string } } | undefined
> => {
  const file = path.posix.join(proofDir, `${feature.id}.md`);
  const markdown = await readFile(path.resolve(root, file), "utf8").catch(() => undefined);
  if (markdown === undefined) {
    if (feature.status === "done")
      return { problems: [{ kind: "no-proof-file", file }], proved: 0 };
    if (tests.length > 0) {
      return {
        problems: [{ kind: "keys-without-proof-file", file, tests: tests.length }],
        proved: 0,
      };
    }
    return undefined;
  }
  const parsed = parseProofFile(markdown);
  if (!parsed.ok) {
    return {
      problems: [{ kind: "unreadable-proof-file", file, reason: parsed.reason }],
      proved: 0,
    };
  }

  const problems: Problem[] = [];
  const lines = markdown.split(/\r?\n/);
  let changed = false;
  const keys = new Set<string>();
  const conditions = new Set<string>();
  let proved = 0;
  for (const row of parsed.rows) {
    if (!keyPattern.test(row.key)) {
      problems.push({ kind: "bad-key", line: row.line, key: row.key });
      continue;
    }
    if (keys.has(row.key)) {
      problems.push({ kind: "duplicate-key", line: row.line, key: row.key });
      continue;
    }
    keys.add(row.key);
    const result = await checkRow(
      root,
      row,
      tests.filter((test) => test.key === row.key),
    );
    const rendered = renderRow(result.cells);
    if (result.cells.tests !== row.tests || result.cells.status !== row.status) {
      lines[row.line - 1] = rendered;
      changed = true;
    }
    if (conditions.has(row.condition)) {
      problems.push({ kind: "duplicate-row", line: row.line, condition: row.condition });
      problems.push(...result.problems.filter(isStale));
      continue;
    }
    conditions.add(row.condition);
    if (!feature.conditions.includes(row.condition)) {
      problems.push({ kind: "row-not-a-condition", line: row.line, condition: row.condition });
      problems.push(...result.problems.filter(isStale));
      continue;
    }
    if (result.status === "proved" && result.problems.length === 0) proved += 1;
    problems.push(...result.problems);
  }
  for (const condition of feature.conditions) {
    if (!conditions.has(condition)) problems.push({ kind: "condition-without-row", condition });
  }
  const reported = new Set<string>();
  for (const test of tests) {
    if (keys.has(test.key) || reported.has(test.key)) continue;
    reported.add(test.key);
    problems.push({ kind: "unknown-key", key: test.key, file: test.file, name: test.name });
  }
  if (feature.status !== "done" && problems.length === 0 && proved === feature.conditions.length) {
    problems.push({ kind: "could-be-done" });
  }
  return {
    problems,
    proved,
    ...(changed ? { synced: { file, markdown: lines.join(lineEnding(markdown)) } } : {}),
  };
};

export type CheckOptions = {
  /** The repo root. */
  root: string;
  /** Relative to the root. Defaults to `context/features.md`. */
  featuresFile?: string;
  /** Relative to the root, with forward slashes. Defaults to `context/proof`. */
  proofDir?: string;
  /** The tests, when already scanned. */
  index?: TestIndex;
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

  const index = options.index ?? (await scanTests(root));
  for (const test of index.malformed) {
    ledgerProblems.push({ kind: "malformed-test-key", ...test });
  }
  const testsById = new Map<string, KeyedTest[]>();
  const unknown = new Set<string>();
  for (const test of index.keyed) {
    const feature = byId.get(test.id);
    if (feature === undefined || feature.status === "dropped") {
      const seen = `${test.file} > ${test.name}`;
      if (!unknown.has(seen)) {
        unknown.add(seen);
        ledgerProblems.push({
          kind: "test-key-unknown-feature",
          file: test.file,
          line: test.line,
          name: test.name,
          id: test.id,
        });
      }
      continue;
    }
    const list = testsById.get(test.id) ?? [];
    list.push(test);
    testsById.set(test.id, list);
  }

  const reports: FeatureReport[] = [];
  for (const feature of features) {
    if (feature.status === "dropped") continue;
    const result = await checkFeature(root, proofDir, feature, testsById.get(feature.id) ?? []);
    if (result === undefined) continue;
    const baselined = baseline.has(feature.id);
    reports.push({
      feature,
      enforced: feature.status === "done" && !baselined,
      baselined,
      problems: result.problems,
      proved: result.proved,
      ...(result.synced === undefined ? {} : { synced: result.synced }),
    });
    if (baselined && feature.status === "done" && result.problems.length === 0) {
      ledgerProblems.push({ kind: "baseline-proved", id: feature.id });
    }
  }
  return { features: reports, ledgerProblems };
};

/**
 * Writes the cells the tooling owns, Tests and Status, in every proof file whose cells don't
 * match the code (or only in the files of `ids`), and says which files it wrote.
 */
export const syncProofs = async (
  options: CheckOptions & { ids?: readonly string[] },
): Promise<string[]> => {
  const report = await checkProofs(options);
  const written: string[] = [];
  for (const { feature, synced } of report.features) {
    if (synced === undefined) continue;
    if (options.ids !== undefined && !options.ids.includes(feature.id)) continue;
    await writeFile(path.resolve(options.root, synced.file), synced.markdown);
    written.push(synced.file);
  }
  return written;
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
    case "keys-without-proof-file":
      return `${String(problem.tests)} test key(s) name its conditions, but it has no proof file: create it with \`pnpm proof:new ${path.posix.basename(problem.file, ".md")}\``;
    case "unreadable-proof-file":
      return `${problem.file} can't be read: ${problem.reason}`;
    case "condition-without-row":
      return `no row for the condition ${quote(problem.condition)}: \`pnpm proof:new\` adds it`;
    case "row-not-a-condition":
      return `line ${String(problem.line)}: ${quote(problem.condition)} is not a sentence of the "done when": it was misquoted, or the "done when" changed (\`pnpm proof:new\` adds the new sentences)`;
    case "duplicate-row":
      return `line ${String(problem.line)}: a second row for ${quote(problem.condition)}`;
    case "bad-key":
      return `line ${String(problem.line)}: the key "${problem.key}" is not c1, c2 and so on`;
    case "duplicate-key":
      return `line ${String(problem.line)}: a second row with the key ${problem.key}`;
    case "unknown-key":
      return `no row has the key ${problem.key}, which the test ${quote(problem.name)} in ${problem.file} gives`;
    case "bad-status":
      return `line ${String(problem.line)}: the status "${problem.status}" is not proved, missing or partial (a reason may follow "missing:" or "partial:")`;
    case "not-proved":
      return `line ${String(problem.line)}: ${problem.status}: ${quote(problem.condition)}`;
    case "no-break-it":
      return `line ${String(problem.line)}: no break-it: say what you broke to see its tests fail`;
    case "evidence-missing":
      return `line ${String(problem.line)}: the live evidence ${problem.evidence} is neither a file in the repo nor an https link`;
    case "test-does-not-run":
      return `line ${String(problem.line)}: the test ${quote(problem.name)} in ${problem.file} is ${problem.run === "conditional" ? "behind a condition (skipIf, runIf or a run-time skip)" : problem.run}, so it proves nothing: make it run, or take its key off`;
    case "stale-tests":
      return `line ${String(problem.line)}: ${problem.key}'s tests changed in the code (${String(problem.added)} new, ${String(problem.gone)} gone or renamed): run \`pnpm proof:sync\``;
    case "stale-status":
      return `line ${String(problem.line)}: ${problem.key}'s status is "${problem.written}", and its evidence says "${problem.status}": run \`pnpm proof:sync\``;
    case "could-be-done":
      return `every condition is proved: set its status to done in context/features.md`;
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
    case "malformed-test-key":
      return `${problem.file}:${String(problem.line)}: can't read the keys of the test ${quote(problem.name)}: start its name with \`F-nnn/c1: \`, or \`F-nnn/c1,c2, F-mmm/c1: \``;
    case "test-key-unknown-feature":
      return `${problem.file}:${String(problem.line)}: the test ${quote(problem.name)} gives a key of ${problem.id}, which is not a feature row (or is dropped)`;
    default:
      return problem satisfies never;
  }
};

export type RenderedReport = { lines: string[]; errors: number; warnings: number };

/**
 * The report, row by row. A row that is enforced lists every problem. A row that only warns lists
 * its rows that aren't proved as one count, unless `verbose`, and every other problem in full; its
 * out-of-date cells are errors all the same.
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
    const failing = problems.filter((problem) => enforced || isStale(problem)).length;
    errors += failing;
    warnings += problems.length - failing;
    const level = failing > 0 ? "error" : "warn ";
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
  const index = await scanTests(root);
  if (process.argv.includes("--write")) {
    const written = await syncProofs({ root, index });
    console.log(
      written.length === 0
        ? "proof:sync: every proof file matches the tests"
        : `proof:sync: wrote ${written.join(", ")}`,
    );
  }
  const { lines, errors } = renderReport(await checkProofs({ root, index }), { verbose });
  for (const line of lines) console.log(line);
  if (errors > 0) {
    console.error("check:proof: see context/proof/README.md for the rules");
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  await main();
}
