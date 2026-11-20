// Converts proof files written before 2026-11-20 to the keyed form (`context/proof/README.md`).
//
// A former proof file cited each test by its file and exact name, beside a hand-written kind and
// status. For each such file this:
//
// - gives each row the key of its condition's place in the "done when" (`c1`, `c2` ...);
// - renames every cited test so its name gives those keys, `F-025: x` becoming `F-025/c1: x` (a
//   test cited for several conditions or features gives them all, `F-025/c1,c2, F-033/c4: x`),
//   and renames its Vitest snapshots with it;
// - moves the live evidence to the Live cell, and keeps the break-it;
// - keeps `partial`, and makes a `missing` row that cited something `partial`, so no row is proved
//   that wasn't;
// - then writes the Tests and Status cells from the renamed tests, as `pnpm proof:sync` does.
//
// A cited name that is already keyed in the code (after a rebase onto the keyed form) is matched
// with its keys left out. Run with `node scripts/proof-migrate.ts`; it changes only former files.

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  findTests,
  formerProofHeader,
  parseFeatures,
  proofFileIntro,
  renderProofTable,
  syncProofs,
  tableCells,
} from "./check-proof.ts";
import type { Feature, ProofRow } from "./check-proof.ts";

type FormerRow = {
  condition: string;
  tests: { file: string; name: string }[];
  live: string[];
  breakIt: string;
  status: string;
};

const isEmptyCell = (cell: string): boolean => /^(|—|-|–)$/.test(cell.trim());
const testCitation = /^`([^`]+)`\s*>\s*"(.+)"$/;
const liveCitation = /^live:\s*(.+)$/;

/** Reads a former proof table, or nothing when the file has none. */
export const parseFormerProofFile = (
  markdown: string,
): { rows: FormerRow[]; start: number; end: number } | undefined => {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const cells = tableCells(line);
    return (
      cells?.length === formerProofHeader.length &&
      cells.every((cell, index) => cell.toLowerCase() === formerProofHeader[index]?.toLowerCase())
    );
  });
  if (start === -1) return undefined;
  const rows: FormerRow[] = [];
  let index = start + 2;
  for (; index < lines.length; index += 1) {
    const cells = tableCells(lines[index] ?? "");
    if (cells === undefined) break;
    const [condition = "", provedBy = "", , breakIt = "", status = ""] = cells;
    const row: FormerRow = {
      condition,
      tests: [],
      live: [],
      breakIt: isEmptyCell(breakIt) ? "" : breakIt,
      status,
    };
    if (!isEmptyCell(provedBy)) {
      for (const part of provedBy.split(/<br\s*\/?>/i).map((piece) => piece.trim())) {
        const test = testCitation.exec(part);
        const live = liveCitation.exec(part);
        if (test?.[1] !== undefined && test[2] !== undefined) {
          row.tests.push({ file: test[1], name: test[2] });
        } else if (live?.[1] !== undefined) {
          row.live.push(live[1].trim());
        } else {
          throw new Error(`can't read the citation "${part}" of "${condition}"`);
        }
      }
    }
    rows.push(row);
  }
  return { rows, start, end: index };
};

const keyToken = /F-\d{3,}(?:\/c\d+(?:,c\d+)*)?(?![\w/-])/g;
const headEnd = (title: string): number => title.search(/:(?:\s|$)/);

/** The title with the keys of its head taken off: `F-025/c1, F-033: x` → `F-025, F-033: x`. */
export const withoutKeys = (title: string): string => {
  const end = headEnd(title);
  if (end === -1 || !title.startsWith("F-")) return title;
  return title.slice(0, end).replaceAll(/(F-\d{3,})\/c\d+(?:,c\d+)*/g, "$1") + title.slice(end);
};

const sortKeys = (keys: Iterable<string>): string[] =>
  [...new Set(keys)].toSorted((a, b) => Number(a.slice(1)) - Number(b.slice(1)));

/**
 * The title with `wanted` keys in its head, as a change of its first `length` characters: the
 * head's F-IDs gain their keys, a feature the head lacks is added at its end, and a title with no
 * head of F-IDs gets one.
 */
export const addKeys = (
  title: string,
  wanted: ReadonlyMap<string, ReadonlySet<string>>,
): { length: number; head: string } => {
  const group = (id: string, keys: Iterable<string>): string => {
    const sorted = sortKeys(keys);
    return sorted.length === 0 ? id : `${id}/${sorted.join(",")}`;
  };
  const end = headEnd(title);
  if (end === -1 || !title.startsWith("F-")) {
    return {
      length: 0,
      head: `${[...wanted].map(([id, keys]) => group(id, keys)).join(", ")}: `,
    };
  }
  const head = title.slice(0, end);
  const present = new Set<string>();
  const keyed = head.replaceAll(keyToken, (token) => {
    const [id = "", keys = ""] = token.split("/");
    present.add(id);
    return group(id, [...(keys === "" ? [] : keys.split(",")), ...(wanted.get(id) ?? [])]);
  });
  const extra = [...wanted].filter(([id]) => !present.has(id)).map(([id, keys]) => group(id, keys));
  return { length: end, head: extra.length === 0 ? keyed : `${keyed}, ${extra.join(", ")}` };
};

type Rename = { from: string; length: number; head: string };

/**
 * A Vitest snapshot line with the renamed test's key, or nothing when the line holds another
 * test's. A key is the test's describe blocks and name, joined by " > ", then its count; the name
 * of an `it.each` test has its `%s` and `$name` placeholders filled in.
 */
export const renameSnapshotKey = (line: string, rename: Rename): string | undefined => {
  const key = /^exports\[`(.*) (\d+)`\]/.exec(line)?.[1];
  if (key === undefined) return undefined;
  const pattern = rename.from
    .replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
    .replaceAll(/%[sdifjoc#]|\\\$\w+/g, ".*");
  const match = new RegExp(`^(?:(.*) > )?${pattern}$`, "s").exec(key);
  if (match === null) return undefined;
  const start = match[1] === undefined ? 0 : match[1].length + 3;
  const offset = "exports[`".length + start;
  if (line.slice(offset, offset + rename.length) !== rename.from.slice(0, rename.length)) {
    return undefined;
  }
  return line.slice(0, offset) + rename.head + line.slice(offset + rename.length);
};

/** Renames the tests of one file, and its Vitest snapshots; says how many it renamed. */
const retitleFile = async (
  root: string,
  file: string,
  wanted: ReadonlyMap<string, Map<string, Set<string>>>,
): Promise<{ renamed: number; unmatched: string[] }> => {
  const absolute = path.resolve(root, file);
  let source = await readFile(absolute, "utf8");
  const tests = findTests(source, file);
  const byBareName = new Map([...wanted].map(([name, keys]) => [withoutKeys(name), keys]));
  const matched = new Set<string>();
  const renames: Rename[] = [];
  // From the end of the file, so the earlier positions hold.
  for (const test of tests.toSorted((a, b) => b.literal.start - a.literal.start)) {
    const keys = wanted.get(test.name) ?? byBareName.get(withoutKeys(test.name));
    if (keys === undefined) continue;
    matched.add(withoutKeys(test.name));
    const { length, head } = addKeys(test.name, keys);
    const raw = source.slice(test.literal.start + 1, test.literal.end - 1);
    if (!raw.startsWith(test.name.slice(0, length))) {
      throw new Error(`${file}:${String(test.line)}: can't rename "${test.name}" in place`);
    }
    if (head + test.name.slice(length) === test.name) continue;
    source =
      source.slice(0, test.literal.start + 1) +
      head +
      raw.slice(length) +
      source.slice(test.literal.end - 1);
    renames.push({ from: test.name, length, head });
  }
  if (renames.length > 0) await writeFile(absolute, source);

  const snapshots = path.join(
    path.dirname(absolute),
    "__snapshots__",
    `${path.basename(file)}.snap`,
  );
  const snapshotText = await readFile(snapshots, "utf8").catch(() => undefined);
  if (snapshotText !== undefined && renames.length > 0) {
    const next = snapshotText
      .split("\n")
      .map((line) => {
        for (const rename of renames) {
          const renamed = renameSnapshotKey(line, rename);
          if (renamed !== undefined) return renamed;
        }
        return line;
      })
      .join("\n");
    if (next !== snapshotText) await writeFile(snapshots, next);
  }
  const unmatched = [...wanted.keys()].filter((name) => !matched.has(withoutKeys(name)));
  return { renamed: renames.length, unmatched };
};

const formerIntro = (id: string): string =>
  `The proof of ${id}'s "done when" in \`context/features.md\`: one row per condition, quoted verbatim. The rules are in \`context/proof/README.md\`, and \`pnpm check:proof\` checks this file.`;

export type MigrationResult = {
  files: string[];
  renamedTests: number;
  /** Cited tests the code doesn't hold, as `file > name`: their rows lose them. */
  unmatched: string[];
};

/** Converts every former proof file under the repo. */
export const migrateProofs = async (
  root: string,
  proofDir = "context/proof",
): Promise<MigrationResult> => {
  const features = new Map(
    parseFeatures(await readFile(path.join(root, "context", "features.md"), "utf8")).map(
      (feature): [string, Feature] => [feature.id, feature],
    ),
  );
  // file → cited name → feature → keys
  const wanted = new Map<string, Map<string, Map<string, Set<string>>>>();
  const cite = (file: string, name: string, id: string, key: string): void => {
    const names = wanted.get(file) ?? new Map<string, Map<string, Set<string>>>();
    wanted.set(file, names);
    const ids = names.get(name) ?? new Map<string, Set<string>>();
    names.set(name, ids);
    const keys = ids.get(id) ?? new Set<string>();
    ids.set(id, keys);
    keys.add(key);
  };

  const converted: { file: string; markdown: string }[] = [];
  const entries = (await readdir(path.join(root, proofDir))).toSorted();
  for (const entry of entries) {
    const id = /^(F-\d{3,})\.md$/.exec(entry)?.[1];
    const feature = id === undefined ? undefined : features.get(id);
    if (id === undefined || feature === undefined) continue;
    const file = path.posix.join(proofDir, entry);
    const markdown = await readFile(path.join(root, file), "utf8");
    const former = parseFormerProofFile(markdown);
    if (former === undefined) continue;

    let next = feature.conditions.length + 1;
    const rows: ProofRow[] = former.rows.map((row) => {
      const position = feature.conditions.indexOf(row.condition);
      const key = `c${String(position === -1 ? next++ : position + 1)}`;
      for (const test of row.tests) cite(test.file, test.name, id, key);
      const cited = row.tests.length + row.live.length > 0;
      return {
        line: 0,
        key,
        condition: row.condition,
        tests: "",
        live: row.live.join("<br>"),
        breakIt: row.breakIt,
        status:
          row.status === "partial" || (row.status === "missing" && cited) ? "partial" : row.status,
      };
    });
    const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
    const lines = markdown.split(/\r?\n/);
    lines.splice(former.start, former.end - former.start, ...renderProofTable(feature, rows));
    converted.push({
      file,
      markdown: lines.join(eol).replace(formerIntro(id), proofFileIntro(id)),
    });
  }

  let renamedTests = 0;
  const unmatched: string[] = [];
  for (const [file, names] of [...wanted].toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    const result = await retitleFile(root, file, names).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { renamed: 0, unmatched: [...names.keys()] };
      }
      throw error;
    });
    renamedTests += result.renamed;
    unmatched.push(...result.unmatched.map((name) => `${file} > ${name}`));
  }
  for (const { file, markdown } of converted) await writeFile(path.join(root, file), markdown);
  await syncProofs({
    root,
    proofDir,
    ids: converted.map(({ file }) => path.posix.basename(file, ".md")),
  });
  return { files: converted.map(({ file }) => file), renamedTests, unmatched };
};

const main = async (): Promise<void> => {
  const root = path.resolve(import.meta.dirname, "..");
  const result = await migrateProofs(root);
  console.log(
    `proof-migrate: converted ${String(result.files.length)} proof file(s), renamed ${String(result.renamedTests)} test(s)`,
  );
  for (const citation of result.unmatched) {
    console.log(`proof-migrate: no test matches the citation ${citation}: its row loses it`);
  }
};

if (import.meta.main) {
  await main();
}
