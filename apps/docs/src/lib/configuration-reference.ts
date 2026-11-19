// The configuration reference, read from `docs/configuration.md` (ADR 0063: the site renders the
// tested file and never keeps a copy). One parser, used by the page, the search index and the
// F-058 tests, so they can't disagree. It has no imports: `packages/domain`'s test runs it too.
//
// It relies on the file's table headers: `Setting | Default | What it does` under "The server" and
// "Development and tests only", and `Setting | Flag | Default | What it does` under "The runner".
// A change to a header changes this file in the same commit.

/** Which process reads a setting, from the group it's listed under. */
export type ReadBy = "server" | "runner" | "dev";

export type SettingRow = {
  /** The variable's name, such as `OSTRA_PUBLIC_URL`. */
  readonly name: string;
  /** The runner's flag for it, such as `--executor`; `null` for the other groups. */
  readonly flag: string | null;
  /** The default cell as written, inline Markdown: `(required)` and `(none)` included. */
  readonly defaultValue: string;
  /** The "What it does" cell, inline Markdown. */
  readonly description: string;
  readonly readBy: ReadBy;
};

/** What a group holds, in the file's order: prose (paragraphs, other tables) or a settings table. */
export type ReferenceBlock =
  | { readonly kind: "markdown"; readonly markdown: string }
  | { readonly kind: "settings"; readonly rows: readonly SettingRow[] };

export type ReferenceGroup = {
  /** The `##` heading as written. */
  readonly heading: string;
  /** The heading's anchor, as GitHub and the site make it. */
  readonly slug: string;
  /** The process that reads the group's settings; `null` for a prose group. */
  readonly readBy: ReadBy | null;
  readonly blocks: readonly ReferenceBlock[];
};

export type ConfigurationReference = {
  /** The file's first paragraph: what the page is. */
  readonly lede: string;
  readonly groups: readonly ReferenceGroup[];
};

const groupReadBy: Readonly<Record<string, ReadBy>> = {
  "The server": "server",
  "The runner": "runner",
  "Development and tests only": "dev",
};

const readByOf = (heading: string): ReadBy | null => groupReadBy[heading] ?? null;

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces to hyphens. */
export const slugOf = (heading: string): string =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");

/** Splits a table line into its cells, keeping `|` inside code spans and escaped `\|`. */
export const splitRow = (line: string): string[] => {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  let inCode = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body.charAt(index);
    if (char === "\\" && body.charAt(index + 1) === "|") {
      cell += "|";
      index += 1;
    } else if (char === "`") {
      inCode = !inCode;
      cell += char;
    } else if (char === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
};

const unquote = (cell: string): string => cell.replace(/^`(.*)`$/, "$1");

const isTableLine = (line: string): boolean => line.trimStart().startsWith("|");

const settingsColumns = {
  plain: ["Setting", "Default", "What it does"],
  runner: ["Setting", "Flag", "Default", "What it does"],
} as const;

const sameColumns = (cells: readonly string[], columns: readonly string[]): boolean =>
  cells.length === columns.length && cells.every((cell, index) => cell === columns[index]);

const settingsRows = (lines: readonly string[], readBy: ReadBy, heading: string): SettingRow[] | null => {
  const [head, , ...body] = lines;
  if (head === undefined) {
    return null;
  }
  const columns = splitRow(head);
  const withFlag = sameColumns(columns, settingsColumns.runner);
  if (!withFlag && !sameColumns(columns, settingsColumns.plain)) {
    if (columns[0] === "Setting") {
      throw new Error(`docs/configuration.md: the table under "${heading}" has columns this parser doesn't know: ${columns.join(" | ")}`);
    }
    return null;
  }
  return body.map((line) => {
    const cells = splitRow(line);
    const at = (index: number): string => cells[index] ?? "";
    return withFlag
      ? { name: unquote(at(0)), flag: unquote(at(1)), defaultValue: at(2), description: at(3), readBy }
      : { name: unquote(at(0)), flag: null, defaultValue: at(1), description: at(2), readBy };
  });
};

/** Splits a section's lines into paragraphs and tables, in order. */
const chunksOf = (lines: readonly string[]): { readonly table: boolean; readonly lines: string[] }[] => {
  const chunks: { table: boolean; lines: string[] }[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      chunks.push({ table: false, lines: [] });
      continue;
    }
    const table = isTableLine(line);
    const last = chunks.at(-1);
    if (last?.table === table && (table || last.lines.length > 0)) {
      last.lines.push(line);
    } else {
      chunks.push({ table, lines: [line] });
    }
  }
  return chunks.filter((chunk) => chunk.lines.length > 0);
};

export const parseConfigurationReference = (markdown: string): ConfigurationReference => {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const sections: { heading: string | null; lines: string[] }[] = [{ heading: null, lines: [] }];
  for (const line of lines) {
    const heading = /^## (.+)$/.exec(line);
    if (heading?.[1] !== undefined) {
      sections.push({ heading: heading[1].trim(), lines: [] });
    } else if (!line.startsWith("# ")) {
      sections.at(-1)?.lines.push(line);
    }
  }
  const [preamble, ...rest] = sections;
  const lede = chunksOf(preamble?.lines ?? []).find((chunk) => !chunk.table)?.lines.join(" ") ?? "";
  const groups = rest.flatMap((section): ReferenceGroup[] => {
    if (section.heading === null) {
      return [];
    }
    const heading = section.heading;
    const readBy = readByOf(heading);
    const blocks = chunksOf(section.lines).map((chunk): ReferenceBlock => {
      const rows = chunk.table && readBy !== null ? settingsRows(chunk.lines, readBy, heading) : null;
      return rows === null ? { kind: "markdown", markdown: chunk.lines.join("\n") } : { kind: "settings", rows };
    });
    return [{ heading, slug: slugOf(heading), readBy, blocks }];
  });
  return { lede, groups };
};

/** Every setting row of the reference, in the file's order. */
export const settingsOf = (reference: ConfigurationReference): SettingRow[] =>
  reference.groups.flatMap((group) => group.blocks.flatMap((block) => (block.kind === "settings" ? block.rows : [])));

/** How a default cell reads: a value, or the file's `(required)` and `(none)` markers. */
export type DefaultKind = "value" | "required" | "none";

export const defaultKindOf = (cell: string): DefaultKind => {
  const plain = cell.trim();
  if (plain === "(required)") {
    return "required";
  }
  if (plain === "(none)") {
    return "none";
  }
  return "value";
};
