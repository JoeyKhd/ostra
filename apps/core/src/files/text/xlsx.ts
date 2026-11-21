import type { Element } from "@xmldom/xmldom";

import type { MarkdownWriter } from "./markdown.ts";
import { writeTable } from "./markdown.ts";
import type { TextFailureReason } from "./result.ts";
import { attrOf, childNamed, childrenNamed, elementsUnder, findElement, ownText, parseInBatches, parseXmlPart, relationIdOf, XML_BATCH_CHARS } from "./xml.ts";
import type { XmlPart } from "./xml.ts";

// An Excel workbook's text (F-150, spec section 5.5): each sheet, in the workbook's order, under
// `## <sheet>`, its rows as a Markdown table of the cells' stored values: shared strings, inline
// strings, numbers, booleans and errors as written, and a formula's last result as Excel stored
// it, never recomputed. Nothing is evaluated, and no external link or connection is followed.

const WORKBOOK = "xl/workbook.xml";
const WORKBOOK_RELATIONS = "xl/_rels/workbook.xml.rels";
const SHARED_STRINGS = "xl/sharedStrings.xml";
const SHEET = /^xl\/worksheets\/sheet(\d+)\.xml$/;

/** The parts the Excel reader takes from the zip. */
export const isXlsxPart = (name: string): boolean => name === WORKBOOK || name === WORKBOOK_RELATIONS || name === SHARED_STRINGS || SHEET.test(name);

/** Text under an element, its phonetic guides (`rPh`) left out. */
const stringItemText = (item: Element): string =>
  elementsUnder(item, "t", new Set(["rPh"]))
    .map(ownText)
    .join("");

/** A relationship's target as a part's name in the zip: `worksheets/sheet1.xml` under `xl/`, or an absolute `/xl/…`. */
export const partOfTarget = (base: string, target: string): string => (target.startsWith("/") ? target.slice(1) : `${base}${target.replace(/^\.\//, "")}`);

/** A relationships part's targets by their ID. */
export const relationsOf = (part: XmlPart | null): ReadonlyMap<string, string> => {
  const targets = new Map<string, string>();
  if (part?.ok === true) {
    for (const relation of childrenNamed(part.root, "Relationship")) {
      const id = attrOf(relation, "Id");
      const target = attrOf(relation, "Target");
      if (id !== null && target !== null && attrOf(relation, "TargetMode") !== "External") {
        targets.set(id, target);
      }
    }
  }
  return targets;
};

/** A cell reference's column, from 0: `A1` is 0, `AB12` is 27. */
const columnOf = (reference: string | null): number | null => {
  const letters = reference === null ? null : /^([A-Z]{1,3})\d*$/i.exec(reference)?.[1];
  if (letters === undefined || letters === null) {
    return null;
  }
  let column = 0;
  for (const letter of letters.toUpperCase()) {
    column = column * 26 + (letter.charCodeAt(0) - 64);
  }
  return column - 1;
};

/** The widest a row may be: Excel's last column, XFD. */
const COLUMNS_MAX = 16_384;

const cellValue = (cell: Element, shared: readonly string[]): string => {
  const valueElement = childNamed(cell, "v");
  const value = valueElement === undefined ? "" : ownText(valueElement);
  switch (attrOf(cell, "t") ?? "n") {
    case "s":
      return shared[Number(value)] ?? "";
    case "inlineStr": {
      const inline = childNamed(cell, "is");
      return inline === undefined ? "" : stringItemText(inline);
    }
    case "b":
      return value === "1" ? "TRUE" : value === "0" ? "FALSE" : value;
    default:
      return value;
  }
};

/** A row's cells' stored values, by their columns, trailing empty ones dropped. */
const rowValues = (row: Element, shared: readonly string[]): string[] => {
  const cells: string[] = [];
  let next = 0;
  for (const cell of childrenNamed(row, "c")) {
    const column = columnOf(attrOf(cell, "r")) ?? next;
    if (column >= COLUMNS_MAX) {
      break;
    }
    while (cells.length < column) {
      cells.push("");
    }
    cells[column] = cellValue(cell, shared);
    next = column + 1;
  }
  while (cells.length > 0 && (cells.at(-1) ?? "").trim() === "") {
    cells.pop();
  }
  return cells;
};

/** A sheet's rows of stored values, a batch of rows at a time, read until they'd pass `capChars`. */
const sheetRows = (sheetPart: Uint8Array, shared: readonly string[], capChars: number): { readonly rows: readonly (readonly string[])[] } | { readonly refusal: "doctype" | "damaged" } => {
  const rows: string[][] = [];
  let chars = 0;
  const refusal = parseInBatches(sheetPart, "sheetData", XML_BATCH_CHARS, (data) => {
    for (const row of childrenNamed(data, "row")) {
      const cells = rowValues(row, shared);
      if (cells.length > 0) {
        rows.push(cells);
        chars += cells.reduce((sum, cell) => sum + cell.length + 3, 2);
      }
      if (chars > capChars) {
        return false;
      }
    }
    return true;
  });
  // A sheet with no `sheetData` has no rows.
  return refusal === null || refusal === "missing" ? { rows } : { refusal };
};

/** Every shared string, a batch at a time. */
const sharedStrings = (part: Uint8Array | undefined): { readonly strings: readonly string[] } | { readonly refusal: "doctype" | "damaged" } => {
  const strings: string[] = [];
  if (part === undefined) {
    return { strings };
  }
  const refusal = parseInBatches(part, "sst", XML_BATCH_CHARS, (table) => {
    for (const item of childrenNamed(table, "si")) {
      strings.push(stringItemText(item));
    }
    return true;
  });
  return refusal === null || refusal === "missing" ? { strings } : { refusal };
};

/** Writes a workbook's text, or answers why it can't. */
export const readXlsx = (parts: ReadonlyMap<string, Uint8Array>, writer: MarkdownWriter, capChars: number): TextFailureReason | null => {
  const workbookPart = parts.get(WORKBOOK);
  if (workbookPart === undefined) {
    return "damaged";
  }
  const workbook = parseXmlPart(workbookPart);
  if (!workbook.ok) {
    return workbook.reason;
  }
  const relationsPart = parts.get(WORKBOOK_RELATIONS);
  const relations = relationsPart === undefined ? null : parseXmlPart(relationsPart);
  if (relations !== null && !relations.ok && relations.reason === "doctype") {
    return "doctype";
  }
  const shared = sharedStrings(parts.get(SHARED_STRINGS));
  if ("refusal" in shared) {
    return shared.refusal;
  }
  const targets = relationsOf(relations);
  const sheetsElement = findElement(workbook.root, "sheets");
  const sheets = sheetsElement === undefined ? [] : childrenNamed(sheetsElement, "sheet");
  for (const [index, sheet] of sheets.entries()) {
    if (writer.full()) {
      break;
    }
    const target = targets.get(relationIdOf(sheet) ?? "");
    const partName = target === undefined ? `xl/worksheets/sheet${String(index + 1)}.xml` : partOfTarget("xl/", target);
    const sheetPart = parts.get(partName);
    if (sheetPart === undefined) {
      continue;
    }
    const rows = sheetRows(sheetPart, shared.strings, capChars);
    if ("refusal" in rows) {
      return rows.refusal;
    }
    writer.heading(`## ${(attrOf(sheet, "name") ?? `Sheet ${String(index + 1)}`).replace(/\s+/g, " ").trim()}`);
    writeTable(writer, rows.rows);
  }
  return null;
};
