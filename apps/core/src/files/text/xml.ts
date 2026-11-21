import { DOMParser } from "@xmldom/xmldom";
import type { Document, Element, Node } from "@xmldom/xmldom";

import type { TextFailureReason } from "./result.ts";

// An Office part's XML (F-150/c2, spec section 5.5). A part holding `<!DOCTYPE` or `<!ENTITY` is
// refused before it's parsed, so no entity is ever declared, expanded or fetched (XXE); xmldom
// itself expands only XML's five predefined entities and character references, and fetches
// nothing. Its errors go to `onError`, never to the console, since they quote the document.
// Elements are matched by their local name, so a strict Office file's namespaces read the same.
// A big part (a long document's body, a sheet's rows, the shared strings) is parsed a batch of its
// elements at a time (`parseInBatches`), so the DOM held at once stays a few MiB inside the
// worker's heap whatever the part's size.

/** About how many characters of XML one batch holds. */
export const XML_BATCH_CHARS = 256 * 1024;

export type XmlPart = { readonly ok: true; readonly root: Element } | { readonly ok: false; readonly reason: Extract<TextFailureReason, "doctype" | "damaged"> };

const decodePart = (bytes: Uint8Array): string => {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes);
  }
  return new TextDecoder("utf-8").decode(bytes);
};

/** A declaration of a document type or an entity, in any letter case. */
const DECLARATION = /<!\s*(?:DOCTYPE|ENTITY)/i;

/** The root element of XML source already checked for declarations, or `null` when it isn't well-formed. */
const parseSource = (source: string): Element | null => {
  let document: Document;
  try {
    document = new DOMParser({
      onError: (level) => {
        if (level !== "warning") {
          throw new Error("the part isn't well-formed XML");
        }
      },
    }).parseFromString(source, "application/xml");
  } catch {
    return null;
  }
  return document.documentElement;
};

/** Parses one part, refusing a DOCTYPE; broken XML is `damaged`. For the small parts: a big one goes through `parseInBatches`. */
export const parseXmlPart = (bytes: Uint8Array): XmlPart => {
  const source = decodePart(bytes);
  if (DECLARATION.test(source)) {
    return { ok: false, reason: "doctype" };
  }
  const root = parseSource(source);
  return root === null ? { ok: false, reason: "damaged" } : { ok: true, root };
};

// ---------- a big part, in batches ----------

type Tag = { readonly kind: "start" | "end" | "empty"; readonly name: string; readonly start: number; readonly end: number };

const LESS_THAN = 60;
const GREATER_THAN = 62;
const SLASH = 47;
const DOUBLE_QUOTE = 34;
const SINGLE_QUOTE = 39;

/** Where a markup section that holds no tag ends: a comment, CDATA or a processing instruction. */
const SKIPPED_SECTIONS = [
  ["<!--", "-->"],
  ["<![CDATA[", "]]>"],
  ["<?", "?>"],
] as const;

/**
 * The next start, end or empty tag at or after `from`, its `>` found outside quoted attribute
 * values; comments, CDATA and processing instructions skipped. `null` at the end, or for markup
 * that never closes.
 */
const nextTag = (source: string, from: number): Tag | null => {
  let at = source.indexOf("<", from);
  scan: while (at !== -1) {
    for (const [open, close] of SKIPPED_SECTIONS) {
      if (source.startsWith(open, at)) {
        const end = source.indexOf(close, at + open.length);
        if (end === -1) {
          return null;
        }
        at = source.indexOf("<", end + close.length);
        continue scan;
      }
    }
    let quote = 0;
    let index = at + 1;
    for (; index < source.length; index += 1) {
      const code = source.charCodeAt(index);
      if (quote !== 0) {
        if (code === quote) {
          quote = 0;
        }
      } else if (code === DOUBLE_QUOTE || code === SINGLE_QUOTE) {
        quote = code;
      } else if (code === GREATER_THAN || code === LESS_THAN) {
        break;
      }
    }
    if (index >= source.length || source.charCodeAt(index) !== GREATER_THAN) {
      return null;
    }
    const isEnd = source.charCodeAt(at + 1) === SLASH;
    const nameStart = isEnd ? at + 2 : at + 1;
    let nameEnd = nameStart;
    while (nameEnd < index && !/[\s/>]/.test(source.charAt(nameEnd))) {
      nameEnd += 1;
    }
    const kind = isEnd ? "end" : source.charCodeAt(index - 1) === SLASH ? "empty" : "start";
    return { kind, name: source.slice(nameStart, nameEnd), start: at, end: index + 1 };
  }
  return null;
};

const localNameOf = (name: string): string => name.slice(name.indexOf(":") + 1);

const closingTagOf = (startTag: string): string => `</${/^<([^\s/>]+)/.exec(startTag)?.[1] ?? ""}>`;

/** Why a part read in batches gave nothing: a declaration, XML that isn't well-formed, or no such container. */
export type BatchRefusal = "doctype" | "damaged" | "missing";

/**
 * Reads the children of a part's first `container` element (a body's blocks, a sheet's rows, the
 * shared strings) in batches of about `batchChars` characters, each parsed by xmldom on its own
 * inside copies of the container's start tag and its ancestors' (so their namespaces hold), so a
 * big part never makes one big DOM. `visit` gets each batch's container element and answers
 * whether to go on. A DOCTYPE anywhere refuses the part before anything is parsed.
 */
export const parseInBatches = (bytes: Uint8Array, container: string, batchChars: number, visit: (container: Element) => boolean): BatchRefusal | null => {
  const source = decodePart(bytes);
  if (DECLARATION.test(source)) {
    return "doctype";
  }
  const open: string[] = [];
  let tag = nextTag(source, 0);
  // Find the container, keeping the start tags of the elements around it.
  for (; tag !== null; tag = nextTag(source, tag.end)) {
    if (tag.kind === "end") {
      open.pop();
      continue;
    }
    if (localNameOf(tag.name) === container) {
      break;
    }
    if (tag.kind === "start") {
      open.push(source.slice(tag.start, tag.end));
    }
  }
  if (tag === null) {
    return "missing";
  }
  if (tag.kind === "empty") {
    return null;
  }
  const head = [...open, source.slice(tag.start, tag.end)];
  const before = head.join("");
  const after = [...head].reverse().map(closingTagOf).join("");
  const flush = (from: number, to: number): boolean | null => {
    let element = parseSource(`${before}${source.slice(from, to)}${after}`);
    if (element === null) {
      return null;
    }
    for (let depth = 1; depth < head.length; depth += 1) {
      element = elementsOf(element)[0] ?? null;
      if (element === null) {
        return null;
      }
    }
    return visit(element);
  };
  let depth = 0;
  let batchStart = -1;
  for (tag = nextTag(source, tag.end); tag !== null; tag = nextTag(source, tag.end)) {
    if (tag.kind === "end" && depth === 0) {
      // The container's end: what's left is the last batch.
      if (batchStart === -1) {
        return null;
      }
      const goOn = flush(batchStart, tag.start);
      return goOn === null ? "damaged" : null;
    }
    if (depth === 0 && batchStart === -1) {
      batchStart = tag.start;
    }
    depth += tag.kind === "start" ? 1 : tag.kind === "end" ? -1 : 0;
    if (depth === 0 && tag.end - batchStart >= batchChars) {
      const goOn = flush(batchStart, tag.end);
      if (goOn === null) {
        return "damaged";
      }
      if (!goOn) {
        return null;
      }
      batchStart = -1;
    }
  }
  return "damaged";
};

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;

export const isElement = (node: Node): node is Element => node.nodeType === ELEMENT_NODE;

/** A node's child elements, in order. */
export const elementsOf = (node: Node): readonly Element[] => {
  const found: Element[] = [];
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    if (isElement(child)) {
      found.push(child);
    }
  }
  return found;
};

/** A node's child elements of one local name. */
export const childrenNamed = (node: Node, name: string): readonly Element[] => elementsOf(node).filter((child) => child.localName === name);

/** A node's first child element of one local name. */
export const childNamed = (node: Node, name: string): Element | undefined => elementsOf(node).find((child) => child.localName === name);

/** Pushes a node's child elements onto a stack, last first, so they pop in document order. */
export const pushChildren = (stack: Element[], node: Node): void => {
  for (let child = node.lastChild; child !== null; child = child.previousSibling) {
    if (isElement(child)) {
      stack.push(child);
    }
  }
};

/** The first element of a local name at or under `node`, depth first, or `undefined`. */
export const findElement = (node: Element, name: string): Element | undefined => {
  if (node.localName === name) {
    return node;
  }
  const stack: Element[] = [];
  pushChildren(stack, node);
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    if (next.localName === name) {
      return next;
    }
    pushChildren(stack, next);
  }
  return undefined;
};

/** Every element of a local name under `node`, in document order, without looking inside those in `skip`. */
export const elementsUnder = (node: Element, name: string, skip: ReadonlySet<string> = new Set()): readonly Element[] => {
  const found: Element[] = [];
  const stack: Element[] = [];
  pushChildren(stack, node);
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    if (next.localName !== null && skip.has(next.localName)) {
      continue;
    }
    if (next.localName === name) {
      found.push(next);
    }
    pushChildren(stack, next);
  }
  return found;
};

/** An attribute's value by its local name (`w:val` is `val`), whatever its prefix. */
export const attrOf = (element: Element, name: string): string | null => {
  for (const attribute of element.attributes) {
    if (attribute.localName === name || (attribute.localName === null && attribute.name === name)) {
      return attribute.value;
    }
  }
  return null;
};

/**
 * An element's relationship ID (`r:id`), told from a plain `id` (a slide's `id="256"`) by its
 * namespace: the officeDocument relationships', transitional or strict.
 */
export const relationIdOf = (element: Element): string | null => {
  for (const attribute of element.attributes) {
    if (attribute.localName === "id" && (attribute.namespaceURI ?? "").endsWith("/relationships")) {
      return attribute.value;
    }
  }
  return null;
};

/** The text directly in an element: its text and CDATA children. */
export const ownText = (element: Element): string => {
  let text = "";
  for (let child = element.firstChild; child !== null; child = child.nextSibling) {
    if (child.nodeType === TEXT_NODE || child.nodeType === CDATA_SECTION_NODE) {
      text += child.nodeValue ?? "";
    }
  }
  return text;
};
