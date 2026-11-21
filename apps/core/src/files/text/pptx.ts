import type { Element } from "@xmldom/xmldom";

import type { MarkdownWriter } from "./markdown.ts";
import { writeTable } from "./markdown.ts";
import type { TextFailureReason } from "./result.ts";
import { attrOf, childNamed, childrenNamed, elementsOf, elementsUnder, findElement, ownText, parseXmlPart, relationIdOf } from "./xml.ts";
import { partOfTarget, relationsOf } from "./xlsx.ts";

// A PowerPoint deck's text (F-150, spec section 5.5): each slide in the order `ppt/presentation.xml`
// lists them, under `## Slide <n>`, its title as `### `, then each shape's paragraphs (`a:t` runs
// and line breaks) and its tables, in the slide's order. No media, no macro, no linked file.

const PRESENTATION = "ppt/presentation.xml";
const PRESENTATION_RELATIONS = "ppt/_rels/presentation.xml.rels";
const SLIDE = /^ppt\/slides\/slide(\d+)\.xml$/;

/** The parts the PowerPoint reader takes from the zip. */
export const isPptxPart = (name: string): boolean => name === PRESENTATION || name === PRESENTATION_RELATIONS || SLIDE.test(name);

/** A DrawingML paragraph's text: its runs and fields, and its line breaks. */
const drawingParagraphText = (paragraph: Element): string =>
  elementsOf(paragraph)
    .map((part) => {
      switch (part.localName ?? "") {
        case "r":
        case "fld": {
          const text = childNamed(part, "t");
          return text === undefined ? "" : ownText(text);
        }
        case "br":
          return "\n";
        default:
          return "";
      }
    })
    .join("");

/** A text body's paragraphs, without the empty ones. */
const paragraphsOf = (body: Element | undefined): readonly string[] =>
  (body === undefined ? [] : childrenNamed(body, "p")).map(drawingParagraphText).filter((text) => text.trim() !== "");

const TITLE_PLACEHOLDERS = new Set(["title", "ctrTitle"]);

/** Whether a shape is the slide's title placeholder. */
const isTitle = (shape: Element): boolean => {
  const properties = childNamed(shape, "nvSpPr");
  const appProperties = properties === undefined ? undefined : childNamed(properties, "nvPr");
  const placeholder = appProperties === undefined ? undefined : childNamed(appProperties, "ph");
  return placeholder !== undefined && TITLE_PLACEHOLDERS.has(attrOf(placeholder, "type") ?? "");
};

/** Writes a shape tree's shapes, in order: groups opened, pictures and media left out. */
const writeShapes = (tree: Element, writer: MarkdownWriter): void => {
  for (const shape of elementsOf(tree)) {
    if (writer.full()) {
      return;
    }
    switch (shape.localName ?? "") {
      case "sp": {
        const paragraphs = paragraphsOf(childNamed(shape, "txBody"));
        if (paragraphs.length === 0) {
          break;
        }
        if (isTitle(shape)) {
          writer.block(`### ${paragraphs.join(" ").replace(/\s+/g, " ").trim()}`);
        } else {
          const [first, ...rest] = paragraphs;
          writer.block(first ?? "");
          for (const paragraph of rest) {
            writer.line(paragraph);
          }
        }
        break;
      }
      case "grpSp":
        writeShapes(shape, writer);
        break;
      case "graphicFrame": {
        const table = findElement(shape, "tbl");
        if (table !== undefined) {
          writeTable(
            writer,
            childrenNamed(table, "tr").map((row) => childrenNamed(row, "tc").map((cell) => paragraphsOf(childNamed(cell, "txBody")).join(" "))),
          );
        }
        break;
      }
      default:
        break;
    }
  }
};

/** The slides' parts in the deck's order: `presentation.xml`'s list, or by their numbers when it has none. */
const slideOrder = (parts: ReadonlyMap<string, Uint8Array>, presentation: Element | null, relations: ReadonlyMap<string, string>): readonly string[] => {
  const listed = presentation === null ? [] : elementsUnder(presentation, "sldId");
  const ordered = listed.flatMap((slide) => {
    const target = relations.get(relationIdOf(slide) ?? "");
    return target === undefined ? [] : [partOfTarget("ppt/", target)];
  });
  if (ordered.length > 0) {
    return ordered;
  }
  return [...parts.keys()].filter((name) => SLIDE.test(name)).sort((a, b) => Number(SLIDE.exec(a)?.[1]) - Number(SLIDE.exec(b)?.[1]));
};

/** Writes a deck's text, or answers why it can't. */
export const readPptx = (parts: ReadonlyMap<string, Uint8Array>, writer: MarkdownWriter): TextFailureReason | null => {
  const presentationPart = parts.get(PRESENTATION);
  const relationsPart = parts.get(PRESENTATION_RELATIONS);
  const presentation = presentationPart === undefined ? null : parseXmlPart(presentationPart);
  const relations = relationsPart === undefined ? null : parseXmlPart(relationsPart);
  for (const part of [presentation, relations]) {
    if (part !== null && !part.ok) {
      return part.reason;
    }
  }
  if (presentation === null) {
    return "damaged";
  }
  const slides = slideOrder(parts, presentation.ok ? presentation.root : null, relationsOf(relations));
  for (const [index, name] of slides.entries()) {
    if (writer.full()) {
      break;
    }
    const slidePart = parts.get(name);
    if (slidePart === undefined) {
      continue;
    }
    const slide = parseXmlPart(slidePart);
    if (!slide.ok) {
      return slide.reason;
    }
    writer.heading(`## Slide ${String(index + 1)}`);
    const tree = findElement(slide.root, "spTree");
    if (tree !== undefined) {
      writeShapes(tree, writer);
    }
  }
  return null;
};
