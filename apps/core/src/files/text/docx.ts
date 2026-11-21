import type { Element } from "@xmldom/xmldom";

import type { MarkdownWriter } from "./markdown.ts";
import { writeTable } from "./markdown.ts";
import type { TextFailureReason } from "./result.ts";
import { attrOf, childNamed, childrenNamed, elementsOf, ownText, parseInBatches, parseXmlPart, pushChildren, XML_BATCH_CHARS } from "./xml.ts";

// A Word document's text (F-150, spec section 5.5): `word/document.xml`'s body in order, its
// paragraphs with their runs, tabs and breaks; headings (the `Heading1` to `Heading6` styles, by
// their id or their name in `word/styles.xml`, or a paragraph's outline level) as `#`; list
// paragraphs as `- `; tables as Markdown tables. Deleted text, field codes, drawings and their
// fallbacks are left out. Nothing is followed: no link, no external part, no embedded object.

export const DOCX_DOCUMENT = "word/document.xml";
export const DOCX_STYLES = "word/styles.xml";

/** The parts the Word reader takes from the zip. */
export const isDocxPart = (name: string): boolean => name === DOCX_DOCUMENT || name === DOCX_STYLES;

/** Inside a paragraph, what holds no text of the document's: deleted text, field codes, properties, drawings. */
const SKIPPED_IN_PARAGRAPH = new Set(["del", "moveFrom", "delText", "instrText", "pPr", "rPr", "drawing", "pict", "object", "AlternateContent"]);

/** A paragraph's text: its runs' text, tabs and breaks, in order. */
const paragraphText = (paragraph: Element): string => {
  let text = "";
  const stack: Element[] = [];
  pushChildren(stack, paragraph);
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const name = next.localName ?? "";
    if (SKIPPED_IN_PARAGRAPH.has(name)) {
      continue;
    }
    switch (name) {
      case "t":
        text += ownText(next);
        continue;
      case "tab":
      case "ptab":
        text += "\t";
        continue;
      case "br":
      case "cr":
        text += "\n";
        continue;
      case "noBreakHyphen":
        text += "-";
        continue;
      default:
        pushChildren(stack, next);
    }
  }
  return text;
};

/** A style's heading level, 1 to 6, from its id or its name (`Heading1`, `heading 1`, `Title`), or `null`. */
const levelOfStyle = (id: string, name: string | null): number | null => {
  const match = /^heading\s*([1-6])$/i.exec(id) ?? (name === null ? null : /^heading\s*([1-6])$/i.exec(name));
  if (match?.[1] !== undefined) {
    return Number(match[1]);
  }
  return /^title$/i.test(id) || (name !== null && /^title$/i.test(name)) ? 1 : null;
};

/** Each paragraph style's heading level, from `word/styles.xml` when the document has one. */
const headingStyles = (styles: Element | null): ReadonlyMap<string, number> => {
  const levels = new Map<string, number>();
  for (const style of styles === null ? [] : childrenNamed(styles, "style")) {
    const id = attrOf(style, "styleId");
    const nameElement = childNamed(style, "name");
    const outline = childNamed(childNamed(style, "pPr") ?? style, "outlineLvl");
    const outlineLevel = outline === undefined ? null : Number(attrOf(outline, "val")) + 1;
    const level = id === null ? null : (levelOfStyle(id, nameElement === undefined ? null : attrOf(nameElement, "val")) ?? (outlineLevel !== null && outlineLevel >= 1 && outlineLevel <= 6 ? outlineLevel : null));
    if (id !== null && level !== null) {
      levels.set(id, level);
    }
  }
  return levels;
};

type Paragraph = { readonly kind: "heading"; readonly level: number; readonly text: string } | { readonly kind: "list"; readonly depth: number; readonly text: string } | { readonly kind: "text"; readonly text: string };

const paragraphOf = (paragraph: Element, headings: ReadonlyMap<string, number>): Paragraph => {
  const text = paragraphText(paragraph);
  const properties = childNamed(paragraph, "pPr");
  const styleElement = properties === undefined ? undefined : childNamed(properties, "pStyle");
  const style = styleElement === undefined ? null : attrOf(styleElement, "val");
  const outline = properties === undefined ? undefined : childNamed(properties, "outlineLvl");
  const outlineLevel = outline === undefined ? null : Number(attrOf(outline, "val")) + 1;
  const level = (style === null ? null : (headings.get(style) ?? levelOfStyle(style, null))) ?? (outlineLevel !== null && outlineLevel >= 1 && outlineLevel <= 6 ? outlineLevel : null);
  if (level !== null) {
    return { kind: "heading", level, text };
  }
  const numbering = properties === undefined ? undefined : childNamed(properties, "numPr");
  const numberingId = numbering === undefined ? undefined : childNamed(numbering, "numId");
  const listStyle = style !== null && /^list/i.test(style);
  if ((numberingId !== undefined && attrOf(numberingId, "val") !== "0") || (numbering !== undefined && numberingId === undefined) || listStyle) {
    const depthElement = numbering === undefined ? undefined : childNamed(numbering, "ilvl");
    const depth = Number(depthElement === undefined ? 0 : attrOf(depthElement, "val"));
    return { kind: "list", depth: Number.isInteger(depth) && depth > 0 ? Math.min(depth, 8) : 0, text };
  }
  return { kind: "text", text };
};

/** A table cell's text: its paragraphs, and any table inside it, on one line. */
const cellText = (cell: Element): string => {
  const parts: string[] = [];
  for (const child of elementsOf(cell)) {
    if (child.localName === "p") {
      parts.push(paragraphText(child));
    } else if (child.localName === "tbl") {
      for (const row of childrenNamed(child, "tr")) {
        parts.push(childrenNamed(row, "tc").map(cellText).join(" "));
      }
    } else if (child.localName === "sdt") {
      const content = childNamed(child, "sdtContent");
      if (content !== undefined) {
        parts.push(cellText(content));
      }
    }
  }
  return parts.map((part) => part.trim()).filter((part) => part !== "").join(" ");
};

/** The elements that hold a body's blocks without being one: content controls, custom XML, tracked insertions. */
const BLOCK_CONTAINERS = new Set(["sdt", "sdtContent", "customXml", "ins", "moveTo", "smartTag"]);

const writeBlocks = (container: Element, headings: ReadonlyMap<string, number>, writer: MarkdownWriter, state: { inList: boolean }): void => {
  for (const block of elementsOf(container)) {
    if (writer.full()) {
      return;
    }
    const name = block.localName ?? "";
    if (name === "p") {
      const paragraph = paragraphOf(block, headings);
      const text = paragraph.kind === "heading" ? paragraph.text.replace(/\s+/g, " ").trim() : paragraph.text.trim();
      if (text === "") {
        continue;
      }
      switch (paragraph.kind) {
        case "heading":
          writer.block(`${"#".repeat(paragraph.level)} ${text}`);
          state.inList = false;
          break;
        case "list": {
          const item = `${"  ".repeat(paragraph.depth)}- ${text.replace(/\n/g, " ")}`;
          if (state.inList) {
            writer.line(item);
          } else {
            writer.block(item);
          }
          state.inList = true;
          break;
        }
        case "text":
          writer.block(text);
          state.inList = false;
          break;
        default:
          paragraph satisfies never;
      }
    } else if (name === "tbl") {
      writeTable(
        writer,
        childrenNamed(block, "tr").map((row) => childrenNamed(row, "tc").map(cellText)),
      );
      state.inList = false;
    } else if (BLOCK_CONTAINERS.has(name)) {
      writeBlocks(block, headings, writer, state);
    }
  }
};

/** Writes a Word document's text, or answers why it can't. */
export const readDocx = (parts: ReadonlyMap<string, Uint8Array>, writer: MarkdownWriter): TextFailureReason | null => {
  const documentPart = parts.get(DOCX_DOCUMENT);
  if (documentPart === undefined) {
    return "damaged";
  }
  const stylesPart = parts.get(DOCX_STYLES);
  const styles = stylesPart === undefined ? null : parseXmlPart(stylesPart);
  if (styles !== null && !styles.ok && styles.reason === "doctype") {
    return "doctype";
  }
  const headings = headingStyles(styles?.ok === true ? styles.root : null);
  const state = { inList: false };
  // The body's blocks a batch at a time: a long document never makes one big DOM.
  const refusal = parseInBatches(documentPart, "body", XML_BATCH_CHARS, (body) => {
    writeBlocks(body, headings, writer, state);
    return !writer.full();
  });
  return refusal === "missing" ? "damaged" : refusal;
};
