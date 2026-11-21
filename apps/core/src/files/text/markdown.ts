import type { DocumentKind } from "./kinds.ts";

// The text's Markdown (F-150, spec section 5.5): ostra's first line, then the document's text, cut
// at the cap with a last line that says so. The worker builds it; the readers write into a
// `MarkdownWriter`, which stops taking text past the cap, so a huge document never grows a huge
// string. Every string here is the document's: never logged.

const MiB = 1024 * 1024;

/** ostra's first line: whose text this is, from which file, and what it may miss. */
export const textHeaderLine = (name: string, kind: DocumentKind): string =>
  `Text extracted by ostra from ${name} (${kind}). Layout, images and anything scanned may be missing.`;

const sizeWords = (bytes: number): string => (bytes % MiB === 0 ? `${String(bytes / MiB)} MiB` : `${String(bytes)} bytes`);

/** The last line of a cut text. */
export const textCutLine = (maxBytes: number): string => `[ostra cut the text here: the document's text goes on past ${sizeWords(maxBytes)}.]`;

const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/** Where a reader writes a document's text: blocks (a paragraph, a heading, a table) and lines within one. */
export type MarkdownWriter = {
  /** Starts a block of the document's text, after a blank line. */
  readonly block: (text: string) => void;
  /** Starts a block of ostra's own (`## Slide 2`, a sheet's name), which isn't the document's text. */
  readonly heading: (text: string) => void;
  /** Adds a line to the current block. */
  readonly line: (text: string) => void;
  /** Whether the text is past the cap: a reader stops reading then. */
  readonly full: () => boolean;
  /** Whether any of the document's text was written, past ostra's headings. */
  readonly hasContent: () => boolean;
  /** The text so far. */
  readonly text: () => string;
};

/** A writer that keeps at most a little past `capBytes`, enough to know the text was longer. */
export const createMarkdownWriter = (capBytes: number): MarkdownWriter => {
  const parts: string[] = [];
  let bytes = 0;
  let blocks = 0;
  let content = false;
  const add = (text: string): void => {
    if (bytes > capBytes || text === "") {
      return;
    }
    // A character is at least a byte, so this many characters always reach past the cap.
    const room = capBytes - bytes + 1;
    const piece = text.length > room ? text.slice(0, room) : text;
    parts.push(piece);
    bytes += utf8Bytes(piece);
  };
  const startBlock = (text: string): void => {
    if (blocks > 0) {
      add("\n\n");
    }
    blocks += 1;
    add(text);
  };
  return {
    block: (text) => {
      content ||= hasText(text);
      startBlock(text);
    },
    heading: startBlock,
    line: (text) => {
      content ||= hasText(text);
      add("\n");
      add(text);
    },
    full: () => bytes > capBytes,
    hasContent: () => content,
    text: () => parts.join(""),
  };
};

/** At most `maxBytes` of `text` in UTF-8, never splitting a character, and at its last line break when one is near. */
const cutToBytes = (text: string, maxBytes: number): string => {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) {
    return text;
  }
  let end = Math.max(0, maxBytes);
  // A continuation byte (10xxxxxx) at the cut means the cut would split a character.
  while (end > 0 && ((encoded[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  const head = new TextDecoder().decode(encoded.subarray(0, end));
  const lastBreak = head.lastIndexOf("\n");
  return lastBreak >= head.length / 2 ? head.slice(0, lastBreak) : head;
};

/** The words of a text: runs of letters and digits, so table rules and bullets don't count. */
export const wordsOf = (text: string): number => text.match(/[\p{L}\p{N}][\p{L}\p{N}'’._-]*/gu)?.length ?? 0;

/** Whether a text holds anything to read. */
export const hasText = (text: string): boolean => /[\p{L}\p{N}\p{P}\p{S}]/u.test(text);

/**
 * The text beside the file: ostra's first line, a blank line, the document's text, and, when the
 * whole would pass `maxBytes`, the text cut to fit with `textCutLine` as its last line. Never more
 * than `maxBytes` in UTF-8.
 */
export const documentMarkdown = (
  name: string,
  kind: DocumentKind,
  body: string,
  maxBytes: number,
): { readonly markdown: string; readonly words: number; readonly truncated: boolean } => {
  const head = `${textHeaderLine(name, kind)}\n\n`;
  const whole = `${head}${body.trim()}\n`;
  if (utf8Bytes(whole) <= maxBytes) {
    return { markdown: whole, words: wordsOf(body), truncated: false };
  }
  const tail = `\n\n${textCutLine(maxBytes)}\n`;
  const kept = cutToBytes(body.trim(), maxBytes - utf8Bytes(head) - utf8Bytes(tail)).trimEnd();
  return { markdown: `${head}${kept}${tail}`, words: wordsOf(kept), truncated: true };
};

/** A table cell: one line, with `|` escaped so it can't end the cell. */
const cell = (text: string): string => text.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replace(/\s*\n\s*/g, " ").trim();

/** One Markdown table row of `columns` cells. */
export const tableRow = (cells: readonly string[], columns: number): string =>
  `| ${Array.from({ length: columns }, (_, index) => cell(cells[index] ?? "")).join(" | ")} |`;

/** The rule under a Markdown table's first row. */
export const tableRule = (columns: number): string => `|${" --- |".repeat(columns)}`;

/** Writes rows as a Markdown table, its first row the header, row by row so the cap can stop it. */
export const writeTable = (writer: MarkdownWriter, rows: readonly (readonly string[])[]): void => {
  const columns = Math.max(0, ...rows.map((row) => row.length));
  const [first, ...rest] = rows;
  if (first === undefined || columns === 0) {
    return;
  }
  writer.block(tableRow(first, columns));
  writer.line(tableRule(columns));
  for (const row of rest) {
    if (writer.full()) {
      return;
    }
    writer.line(tableRow(row, columns));
  }
};
