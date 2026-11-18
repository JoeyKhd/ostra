// A small CSV reader and writer (RFC 4180): quoted fields, doubled quotes, line
// breaks inside quotes. The ratings file is edited by hand in a spreadsheet or a
// text editor, so it has to survive both.

/** Parses CSV text into rows of fields. A trailing blank line is not a row. */
export const parseCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const endField = (): void => {
    row.push(field);
    field = "";
  };
  const endRow = (): void => {
    endField();
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };
  const source = text.startsWith("﻿") ? text.slice(1) : text;
  while (i < source.length) {
    const c = source.charAt(i);
    if (quoted) {
      if (c === '"') {
        if (source.charAt(i + 1) === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && field === "") {
      quoted = true;
    } else if (c === ",") {
      endField();
    } else if (c === "\n") {
      endRow();
    } else if (c !== "\r") {
      field += c;
    }
    i += 1;
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
};

const needsQuotes = (field: string): boolean => /[",\r\n]/.test(field) || field !== field.trim();

export const csvLine = (fields: readonly string[]): string => fields.map((field) => (needsQuotes(field) ? `"${field.replaceAll('"', '""')}"` : field)).join(",");
