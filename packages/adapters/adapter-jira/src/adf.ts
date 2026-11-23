import { z } from "zod";

// Atlassian Document Format, Jira's rich text in REST v3 (research/trackers.md §2.4), both ways,
// written by hand: Atlassian ships no markdown converter, and ostra adds no library for it.
//
// - ADF to markdown reads what Jira holds (a description, a comment) for the ticket's context. Every
//   node it doesn't know keeps its text, so nothing a person wrote is lost to an unknown node.
// - Markdown to ADF writes ostra's own text (its comments, a draft's description) in the subset
//   Jira's editor shows: headings, paragraphs, lists, code, quotes, rules, tables, links, mentions
//   and images.
//
// The text is untrusted both ways: it's data, never run, never logged. The patterns are anchored
// and bounded, delimiter searches look a bounded way ahead, and nesting is capped, so a hostile
// description costs time linear in its length.

/** A node of ADF, read loosely: Jira owns the format, and adds nodes and attributes over time. */
export type AdfNode = {
  readonly type: string;
  readonly text?: string | undefined;
  readonly attrs?: Readonly<Record<string, unknown>> | undefined;
  readonly marks?: readonly AdfMark[] | undefined;
  readonly content?: readonly AdfNode[] | undefined;
};

export type AdfMark = { readonly type: string; readonly attrs?: Readonly<Record<string, unknown>> | undefined };

/** A whole document, as Jira takes it. */
export type AdfDoc = { readonly type: "doc"; readonly version: 1; readonly content: readonly AdfNode[] };

export const adfNodeSchema: z.ZodType<AdfNode> = z.lazy(() =>
  z.looseObject({
    type: z.string(),
    text: z.string().optional(),
    attrs: z.record(z.string(), z.unknown()).optional(),
    marks: z.array(z.looseObject({ type: z.string(), attrs: z.record(z.string(), z.unknown()).optional() })).optional(),
    content: z.array(adfNodeSchema).optional(),
  }),
);

const MAX_DEPTH = 48;

const attrString = (node: { readonly attrs?: Readonly<Record<string, unknown>> | undefined }, key: string): string | null => {
  const value = node.attrs?.[key];
  return typeof value === "string" && value !== "" ? value : null;
};

const attrNumber = (node: { readonly attrs?: Readonly<Record<string, unknown>> | undefined }, key: string): number | null => {
  const value = node.attrs?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d{1,15}$/.test(value)) return Number(value);
  return null;
};

// ---------- ADF to markdown ----------

/** A file a document shows, as the caller's resolver names it. */
export type ShownFile = { readonly url: string; readonly name: string; readonly image: boolean };

export type AdfReadOptions = {
  /**
   * The file a `media` node of type `file` shows, by its media ID and its alt text (Jira writes an
   * upload's file name there). `null`: unknown, and the node shows its name as text only.
   */
  readonly media?: (media: { readonly id: string | null; readonly alt: string | null }) => ShownFile | null;
  /** A link's target, when it's a file the tracker holds: its URL as `downloadFile` takes it, and a name. */
  readonly hostedFile?: (href: string, text: string) => ShownFile | null;
};

export type AdfRead = {
  readonly markdown: string;
  /** The files the document shows, in order, each URL once (a media node, or a link to the file host). */
  readonly files: readonly ShownFile[];
};

/** Moves an inline's edge whitespace outside its markers, which markdown needs to read them. */
const wrapCore = (text: string, open: string, close: string): string => {
  const lead = /^\s*/.exec(text)?.[0] ?? "";
  const trail = /\s*$/.exec(text.slice(lead.length))?.[0] ?? "";
  const core = text.slice(lead.length, text.length - trail.length);
  return core === "" ? text : `${lead}${open}${core}${close}${trail}`;
};

/** A code span around `text`, with a fence longer than any run of backticks inside it. */
const codeSpan = (text: string): string => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
};

const linkHref = (marks: readonly AdfMark[]): string | null => {
  const link = marks.find((mark) => mark.type === "link");
  const href = link?.attrs?.["href"];
  return typeof href === "string" && href !== "" ? href : null;
};

const isoDate = (timestamp: number): string => {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? String(timestamp) : date.toISOString().slice(0, 10);
};

const createReader = (options: AdfReadOptions) => {
  const files: ShownFile[] = [];
  const seen = new Set<string>();
  const addFile = (file: ShownFile): void => {
    if (!seen.has(file.url)) {
      seen.add(file.url);
      files.push(file);
    }
  };

  const fileMarkdown = (file: ShownFile): string => (file.image ? `![${file.name}](${file.url})` : `[${file.name}](${file.url})`);

  const media = (node: AdfNode): string => {
    const type = attrString(node, "type");
    const alt = attrString(node, "alt");
    if (type === "external") {
      const url = attrString(node, "url");
      if (url === null) return alt ?? "";
      const hosted = options.hostedFile?.(url, alt ?? "") ?? null;
      if (hosted !== null) {
        addFile({ ...hosted, image: true });
        return fileMarkdown({ ...hosted, image: true });
      }
      return `![${alt ?? "image"}](${url})`;
    }
    const file = options.media?.({ id: attrString(node, "id"), alt }) ?? null;
    if (file === null) {
      // An upload ostra can't place: its name stays, so the reader knows something was there.
      return alt === null ? "" : `[${alt}]`;
    }
    addFile(file);
    return fileMarkdown(file);
  };

  const text = (node: AdfNode): string => {
    const raw = node.text ?? "";
    if (raw === "") return "";
    const marks = node.marks ?? [];
    const href = linkHref(marks);
    let out: string;
    if (marks.some((mark) => mark.type === "code")) {
      out = codeSpan(raw);
    } else {
      out = raw;
      if (marks.some((mark) => mark.type === "strike")) out = wrapCore(out, "~~", "~~");
      if (marks.some((mark) => mark.type === "em")) out = wrapCore(out, "_", "_");
      if (marks.some((mark) => mark.type === "strong")) out = wrapCore(out, "**", "**");
    }
    if (href === null) return out;
    const hosted = options.hostedFile?.(href, raw) ?? null;
    if (hosted !== null) {
      addFile(hosted);
      return `[${out}](${hosted.url})`;
    }
    // A bare URL stays bare, as ostra wrote it.
    return raw === href && out === raw ? href : `[${out}](${href})`;
  };

  const inline = (nodes: readonly AdfNode[] | undefined, depth: number): string =>
    (nodes ?? []).map((node) => inlineNode(node, depth)).join("");

  const inlineNode = (node: AdfNode, depth: number): string => {
    if (depth > MAX_DEPTH) return plainText(node);
    switch (node.type) {
      case "text":
        return text(node);
      case "hardBreak":
        return "\n";
      case "mention": {
        const name = attrString(node, "text")?.replace(/^@/, "") ?? null;
        return `@${name ?? attrString(node, "id") ?? "someone"}`;
      }
      case "emoji":
        return attrString(node, "text") ?? attrString(node, "shortName") ?? "";
      case "inlineCard":
      case "blockCard":
      case "embedCard": {
        const url = attrString(node, "url");
        if (url === null) return "";
        const hosted = options.hostedFile?.(url, "") ?? null;
        if (hosted !== null) {
          addFile(hosted);
          return fileMarkdown(hosted);
        }
        return url;
      }
      case "date": {
        const timestamp = attrNumber(node, "timestamp");
        return timestamp === null ? "" : isoDate(timestamp);
      }
      case "status":
        return attrString(node, "text") ?? "";
      case "placeholder":
        return "";
      case "media":
      case "mediaInline":
        return media(node);
      default:
        return node.content === undefined ? (node.text ?? "") : inline(node.content, depth + 1);
    }
  };

  /** Indents every line after the first by `width` spaces: a list item's or a quote's continuation. */
  const indentRest = (body: string, width: number): string =>
    body
      .split("\n")
      .map((line, index) => (index === 0 || line === "" ? line : `${" ".repeat(width)}${line}`))
      .join("\n");

  /** A list item's blocks: a nested list right under its line, any other block after a blank line. */
  const listItem = (marker: string, item: AdfNode, depth: number): string => {
    let body = "";
    for (const child of item.content ?? []) {
      const part = block(child, depth + 1);
      if (part === "") continue;
      const nestedList = child.type === "bulletList" || child.type === "orderedList" || child.type === "taskList";
      body = body === "" ? part : `${body}${nestedList ? "\n" : "\n\n"}${part}`;
    }
    return `${marker} ${indentRest(body, marker.length + 1)}`;
  };

  const tableCell = (cell: AdfNode, depth: number): string =>
    blocks(cell.content, depth + 1, "\n")
      .replace(/\|/g, "\\|")
      .replace(/\n+/g, "<br>");

  const table = (node: AdfNode, depth: number): string => {
    const rows = (node.content ?? []).filter((row) => row.type === "tableRow").map((row) => (row.content ?? []).map((cell) => tableCell(cell, depth)));
    const width = Math.max(0, ...rows.map((row) => row.length));
    if (width === 0) return "";
    const line = (cells: readonly string[]): string =>
      `| ${Array.from({ length: width }, (_, index) => cells[index] ?? "").join(" | ")} |`;
    const [head = [], ...body] = rows;
    return [line(head), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...body.map(line)].join("\n");
  };

  const block = (node: AdfNode, depth: number): string => {
    if (depth > MAX_DEPTH) return plainText(node);
    switch (node.type) {
      case "paragraph":
        return inline(node.content, depth);
      case "heading": {
        const level = attrNumber(node, "level") ?? 1;
        return `${"#".repeat(Math.min(6, Math.max(1, level)))} ${inline(node.content, depth)}`;
      }
      case "bulletList":
        return (node.content ?? []).map((item) => listItem("-", item, depth)).join("\n");
      case "orderedList": {
        const start = attrNumber(node, "order") ?? 1;
        return (node.content ?? []).map((item, index) => listItem(`${String(start + index)}.`, item, depth)).join("\n");
      }
      case "taskList":
        return (node.content ?? [])
          .map((item) => (item.type === "taskItem" ? `- [${attrString(item, "state") === "DONE" ? "x" : " "}] ${indentRest(inline(item.content, depth + 1), 2)}` : block(item, depth + 1)))
          .join("\n");
      case "decisionList":
        return (node.content ?? []).map((item) => `- ${indentRest(inline(item.content, depth + 1), 2)}`).join("\n");
      case "codeBlock": {
        const code = (node.content ?? []).map((child) => child.text ?? "").join("");
        const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((run) => run[0].length));
        const fence = "`".repeat(longest + 1);
        return `${fence}${attrString(node, "language") ?? ""}\n${code}\n${fence}`;
      }
      case "blockquote":
      case "panel":
        return blocks(node.content, depth + 1, "\n\n")
          .split("\n")
          .map((line) => (line === "" ? ">" : `> ${line}`))
          .join("\n");
      case "rule":
        return "---";
      case "expand":
      case "nestedExpand": {
        const title = attrString(node, "title");
        const body = blocks(node.content, depth + 1, "\n\n");
        return title === null ? body : `**${title}**\n\n${body}`;
      }
      case "table":
        return table(node, depth);
      case "mediaSingle":
      case "mediaGroup":
        return (node.content ?? []).map((child) => inlineNode(child, depth + 1)).filter((part) => part !== "").join("\n");
      case "media":
        return media(node);
      default:
        return fallback(node, depth);
    }
  };

  /** An unknown node: its children as blocks or inline, whichever they are, else its own text. */
  const fallback = (node: AdfNode, depth: number): string => {
    const content = node.content;
    if (content === undefined) {
      return inlineNode(node, depth);
    }
    const inlineChildren = content.every((child) => INLINE_TYPES.has(child.type) || child.content === undefined);
    return inlineChildren ? inline(content, depth + 1) : blocks(content, depth + 1, "\n\n");
  };

  const blocks = (nodes: readonly AdfNode[] | undefined, depth: number, separator: string): string =>
    (nodes ?? [])
      .map((node) => block(node, depth))
      .filter((part) => part !== "")
      .join(separator);

  return { blocks, files: () => [...files] };
};

const INLINE_TYPES: ReadonlySet<string> = new Set(["text", "hardBreak", "mention", "emoji", "inlineCard", "date", "status", "placeholder", "mediaInline"]);

/** Every text in a node, joined: what an over-deep node keeps. */
const plainText = (node: AdfNode): string => {
  const parts: string[] = [];
  const stack: AdfNode[] = [node];
  while (parts.length < 100_000) {
    const next = stack.pop();
    if (next === undefined) break;
    if (next.text !== undefined) parts.push(next.text);
    for (const child of [...(next.content ?? [])].reverse()) stack.push(child);
  }
  return parts.join("");
};

/**
 * Reads an ADF document into markdown and the files it shows. Anything that isn't a document reads
 * as empty; a node this doesn't know keeps its text.
 */
export const readAdf = (doc: unknown, options: AdfReadOptions = {}): AdfRead => {
  const parsed = adfNodeSchema.safeParse(doc);
  if (!parsed.success) {
    // Jira's v2 bodies and some custom fields are plain strings.
    return { markdown: typeof doc === "string" ? doc : "", files: [] };
  }
  const reader = createReader(options);
  const markdown = parsed.data.type === "doc" ? reader.blocks(parsed.data.content, 0, "\n\n") : reader.blocks([parsed.data], 0, "\n\n");
  return { markdown, files: reader.files() };
};

/** ADF to markdown alone. */
export const adfToMarkdown = (doc: unknown, options: AdfReadOptions = {}): string => readAdf(doc, options).markdown;

// ---------- markdown to ADF ----------

export type AdfWriteOptions = {
  /**
   * Whether an image's URL is a file the tracker holds. Jira shows an external image by fetching it
   * without a credential, so such an image is written as a link to the file instead.
   */
  readonly isHostedFile?: (url: string) => boolean;
};

/** How far ahead a closing delimiter is looked for: past it, the opener is text. */
const LOOKAHEAD = 4000;
const MAX_INLINE_DEPTH = 8;

const IMAGE_AT = /^!\[([^\]\n]{0,500})\]\(\s{0,10}<?([^\s)<>]{1,2048})>?(?:\s{1,10}"[^"\n]{0,500}")?\s{0,10}\)/;
const LINK_AT = /^\[([^\]\n]{0,1000})\]\(\s{0,10}<?([^\s)<>]{1,2048})>?(?:\s{1,10}"[^"\n]{0,500}")?\s{0,10}\)/;
const MENTION_AT = /^\[~accountid:([A-Za-z0-9:_-]{1,128})\]/;
const AUTOLINK_AT = /^<((?:https?:\/\/|mailto:)[^\s<>]{1,2048})>/;
const BARE_URL_AT = /^https?:\/\/[^\s<>()[\]]{1,2048}/;
const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

/** A piece of a paragraph: a node, or an image to lift out into a block of its own. */
type Inline = { readonly kind: "node"; readonly node: AdfNode } | { readonly kind: "image"; readonly url: string; readonly alt: string };

const withMark = (marks: readonly AdfMark[], mark: AdfMark): readonly AdfMark[] => [...marks.filter((one) => one.type !== mark.type), mark];

const safeHref = (href: string): string | null => (/^(https?:|mailto:)/i.test(href) && URL.canParse(href) ? href : null);

const textNode = (text: string, marks: readonly AdfMark[]): Inline => {
  // ADF lets `code` share a text only with `link`.
  const allowed = marks.some((mark) => mark.type === "code") ? marks.filter((mark) => mark.type === "code" || mark.type === "link") : marks;
  return { kind: "node", node: allowed.length === 0 ? { type: "text", text } : { type: "text", text, marks: allowed } };
};

const nodePiece = (node: AdfNode): Inline => ({ kind: "node", node });

const sameMarks = (a: readonly AdfMark[] | undefined, b: readonly AdfMark[] | undefined): boolean =>
  JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/** Joins neighbouring texts with the same marks, and drops empty ones (ADF refuses them). */
const mergeTexts = (pieces: readonly Inline[]): Inline[] => {
  const out: Inline[] = [];
  for (const piece of pieces) {
    if (piece.kind === "node" && piece.node.type === "text" && (piece.node.text ?? "") === "") continue;
    const last = out.at(-1);
    if (last?.kind === "node" && piece.kind === "node" && last.node.type === "text" && piece.node.type === "text" && sameMarks(last.node.marks, piece.node.marks)) {
      out[out.length - 1] = nodePiece({ ...last.node, text: `${last.node.text ?? ""}${piece.node.text ?? ""}` });
      continue;
    }
    out.push(piece);
  }
  return out;
};

const isWordChar = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}]/u.test(char);

/** The index of `delimiter` closing a span opened just before `from`, or -1. */
const closingIndex = (text: string, delimiter: string, from: number, wordBound: boolean): number => {
  const limit = Math.min(text.length, from + LOOKAHEAD);
  let index = text.indexOf(delimiter, from);
  while (index !== -1 && index < limit) {
    const before = text[index - 1];
    const after = text[index + delimiter.length];
    const closes = index > from && before !== undefined && !/\s/.test(before) && (!wordBound || !isWordChar(after));
    if (closes) return index;
    index = text.indexOf(delimiter, index + 1);
  }
  return -1;
};

const parseInline = (text: string, marks: readonly AdfMark[], options: AdfWriteOptions, depth: number): Inline[] => {
  const out: Inline[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain !== "") {
      out.push(textNode(plain, marks));
      plain = "";
    }
  };
  const nested = (inner: string, mark: AdfMark): void => {
    flush();
    if (depth >= MAX_INLINE_DEPTH) {
      out.push(textNode(inner, withMark(marks, mark)));
      return;
    }
    out.push(...parseInline(inner, withMark(marks, mark), options, depth + 1));
  };
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    const rest = text.slice(index, index + 4200);
    if (char === "\\" && PUNCTUATION.test(text.charAt(index + 1))) {
      plain += text.charAt(index + 1);
      index += 2;
      continue;
    }
    if (char === "\n") {
      flush();
      out.push(nodePiece({ type: "hardBreak" }));
      index += 1;
      continue;
    }
    if (char === "`") {
      const run = /^`+/.exec(rest)?.[0] ?? "`";
      const close = text.indexOf(run, index + run.length);
      if (close !== -1 && close - index < LOOKAHEAD) {
        let code = text.slice(index + run.length, close);
        if (code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "") code = code.slice(1, -1);
        flush();
        out.push(textNode(code, withMark(marks, { type: "code" })));
        index = close + run.length;
        continue;
      }
      plain += run;
      index += run.length;
      continue;
    }
    if (char === "!" && text.charAt(index + 1) === "[") {
      const image = IMAGE_AT.exec(rest);
      const url = image?.[2];
      if (image !== null && url !== undefined && safeHref(url) !== null) {
        flush();
        const alt = image[1] ?? "";
        if (options.isHostedFile?.(url) === true) {
          out.push(textNode(alt === "" ? url : alt, withMark(marks, { type: "link", attrs: { href: url } })));
        } else {
          out.push({ kind: "image", url, alt });
        }
        index += image[0].length;
        continue;
      }
    }
    if (char === "[") {
      const mention = MENTION_AT.exec(rest);
      if (mention?.[1] !== undefined) {
        flush();
        out.push(nodePiece({ type: "mention", attrs: { id: mention[1] } }));
        index += mention[0].length;
        continue;
      }
      const link = LINK_AT.exec(rest);
      const href = link?.[2] === undefined ? null : safeHref(link[2]);
      if (link !== null && href !== null) {
        const label = link[1] ?? "";
        nested(label === "" ? href : label, { type: "link", attrs: { href } });
        index += link[0].length;
        continue;
      }
    }
    if (char === "<") {
      const autolink = AUTOLINK_AT.exec(rest);
      if (autolink?.[1] !== undefined) {
        flush();
        out.push(textNode(autolink[1], withMark(marks, { type: "link", attrs: { href: autolink[1] } })));
        index += autolink[0].length;
        continue;
      }
    }
    if (char === "h" && !isWordChar(text[index - 1]) && text[index - 1] !== "/" && !marks.some((mark) => mark.type === "link")) {
      const bare = BARE_URL_AT.exec(rest)?.[0];
      if (bare !== undefined) {
        // Trailing punctuation ends the sentence, not the URL.
        const url = bare.replace(/[.,;:!?'"]+$/, "");
        if (URL.canParse(url)) {
          flush();
          out.push(textNode(url, withMark(marks, { type: "link", attrs: { href: url } })));
          index += url.length;
          continue;
        }
      }
    }
    if (char === "*" || char === "_" || char === "~") {
      const double = text.charAt(index + 1) === char;
      const delimiter = double ? char + char : char;
      const wordBound = char === "_";
      const opensWord = !wordBound || !isWordChar(text[index - 1]);
      const next = text[index + delimiter.length];
      if (opensWord && next !== undefined && !/\s/.test(next) && !(char === "~" && !double)) {
        const close = closingIndex(text, delimiter, index + delimiter.length, wordBound);
        if (close !== -1) {
          const inner = text.slice(index + delimiter.length, close);
          const mark: AdfMark = char === "~" ? { type: "strike" } : double ? { type: "strong" } : { type: "em" };
          nested(inner, mark);
          index = close + delimiter.length;
          continue;
        }
      }
      plain += delimiter;
      index += delimiter.length;
      continue;
    }
    plain += char;
    index += 1;
  }
  flush();
  return mergeTexts(out);
};

/** A paragraph's inline content, with each image lifted out into a block of its own (ADF's `mediaSingle`). */
const paragraphs = (text: string, options: AdfWriteOptions): AdfNode[] => {
  const blocks: AdfNode[] = [];
  let run: AdfNode[] = [];
  const close = (): void => {
    // A break at a paragraph's edge, left by a lifted image, isn't text.
    while (run[0]?.type === "hardBreak") run = run.slice(1);
    while (run.at(-1)?.type === "hardBreak") run = run.slice(0, -1);
    if (run.length > 0) blocks.push({ type: "paragraph", content: run });
    run = [];
  };
  for (const piece of parseInline(text, [], options, 0)) {
    if (piece.kind === "image") {
      close();
      blocks.push({
        type: "mediaSingle",
        attrs: { layout: "center" },
        content: [{ type: "media", attrs: { type: "external", url: piece.url, ...(piece.alt === "" ? {} : { alt: piece.alt }) } }],
      });
    } else {
      run.push(piece.node);
    }
  }
  close();
  return blocks;
};

/** Inline content where no block can go (a heading, a table cell): an image there becomes a link. */
const inlineOnly = (text: string, options: AdfWriteOptions): AdfNode[] =>
  mergeTexts(
    parseInline(text, [], options, 0).map((piece) =>
      piece.kind === "image" ? textNode(piece.alt === "" ? piece.url : piece.alt, [{ type: "link", attrs: { href: piece.url } }]) : piece,
    ),
  ).flatMap((piece) => (piece.kind === "node" ? [piece.node] : []));

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([\w+#.-]{0,40})[ \t]*$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ ]?(.*)$/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const TABLE_SEPARATOR = /^ {0,3}\|?[ \t]*:?-{1,200}:?[ \t]*(?:\|[ \t]*:?-{1,200}:?[ \t]*){0,60}\|?[ \t]*$/;

const indentOf = (line: string): number => /^ */.exec(line)?.[0].length ?? 0;
const isBlank = (line: string | undefined): boolean => line === undefined || line.trim() === "";

const tableCells = (line: string): string[] => {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body.charAt(index);
    if (char === "\\" && body.charAt(index + 1) === "|") {
      cell += "|";
      index += 1;
    } else if (char === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
};

const startsBlock = (line: string, next: string | undefined): boolean =>
  FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line) || (line.includes("|") && next !== undefined && TABLE_SEPARATOR.test(next));

const parseBlocks = (lines: readonly string[], options: AdfWriteOptions, depth: number): AdfNode[] => {
  const out: AdfNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (isBlank(line)) {
      index += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence?.[1] !== undefined) {
      const marker = fence[1];
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^ {0,3}${marker.startsWith("`") ? "`" : "~"}{${String(marker.length)},}[ \\t]*$`).test(lines[index] ?? "")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      const code = body.join("\n");
      const language = fence[2] ?? "";
      out.push({ type: "codeBlock", ...(language === "" ? {} : { attrs: { language } }), ...(code === "" ? {} : { content: [{ type: "text", text: code }] }) });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading?.[1] !== undefined) {
      out.push({ type: "heading", attrs: { level: heading[1].length }, content: inlineOnly(heading[2] ?? "", options) });
      index += 1;
      continue;
    }
    if (RULE.test(line)) {
      out.push({ type: "rule" });
      index += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index] ?? "")) {
        quoted.push(QUOTE.exec(lines[index] ?? "")?.[1] ?? "");
        index += 1;
      }
      const inner = depth < MAX_INLINE_DEPTH ? parseBlocks(quoted, options, depth + 1) : paragraphs(quoted.join("\n"), options);
      // A quote in ADF holds paragraphs, lists, code and media, never a heading.
      const content = inner.map((node) => (node.type === "heading" ? { type: "paragraph", content: node.content ?? [] } : node));
      if (content.length > 0) out.push({ type: "blockquote", content });
      continue;
    }
    if (line.includes("|") && TABLE_SEPARATOR.test(lines[index + 1] ?? "")) {
      const rows: string[][] = [tableCells(line)];
      index += 2;
      while (index < lines.length && !isBlank(lines[index]) && (lines[index] ?? "").includes("|")) {
        rows.push(tableCells(lines[index] ?? ""));
        index += 1;
      }
      const width = Math.max(...rows.map((row) => row.length));
      out.push({
        type: "table",
        attrs: { isNumberColumnEnabled: false, layout: "default" },
        content: rows.map((row, rowIndex) => ({
          type: "tableRow",
          content: Array.from({ length: width }, (_, cellIndex) => ({
            type: rowIndex === 0 ? "tableHeader" : "tableCell",
            content: [{ type: "paragraph", content: inlineOnly(row[cellIndex] ?? "", options) }],
          })),
        })),
      });
      continue;
    }
    const item = ITEM.exec(line);
    if (item !== null) {
      const list = parseList(lines, index, options, depth);
      out.push(list.node);
      index = list.next;
      continue;
    }
    const text: string[] = [line.trim()];
    index += 1;
    while (index < lines.length && !isBlank(lines[index]) && !startsBlock(lines[index] ?? "", lines[index + 1])) {
      text.push((lines[index] ?? "").trim());
      index += 1;
    }
    out.push(...paragraphs(text.join("\n"), options));
  }
  return out;
};

const parseList = (lines: readonly string[], start: number, options: AdfWriteOptions, depth: number): { readonly node: AdfNode; readonly next: number } => {
  const first = ITEM.exec(lines[start] ?? "");
  const base = first?.[1]?.length ?? 0;
  const ordered = /^\d/.test(first?.[2] ?? "");
  const items: AdfNode[] = [];
  let index = start;
  while (index < lines.length) {
    const item = ITEM.exec(lines[index] ?? "");
    if (item === null || (item[1]?.length ?? 0) !== base || /^\d/.test(item[2] ?? "") !== ordered) break;
    const contentIndent = base + (item[2]?.length ?? 1) + 1;
    const body: string[] = [item[3] ?? ""];
    index += 1;
    while (index < lines.length) {
      const line = lines[index] ?? "";
      if (isBlank(line)) {
        const after = lines.slice(index + 1).find((candidate) => !isBlank(candidate));
        if (after !== undefined && indentOf(after) >= contentIndent) {
          body.push("");
          index += 1;
          continue;
        }
        break;
      }
      const indent = indentOf(line);
      if (indent > base && (indent >= contentIndent || ITEM.test(line))) {
        body.push(line.slice(Math.min(indent, contentIndent)));
        index += 1;
        continue;
      }
      if (indent <= base && ITEM.test(line)) break;
      if (startsBlock(line, lines[index + 1])) break;
      // A lazy continuation of the item's paragraph.
      body.push(line.trim());
      index += 1;
    }
    const content = depth < MAX_INLINE_DEPTH ? parseBlocks(body, options, depth + 1) : paragraphs(body.join("\n"), options);
    // A list item starts with a paragraph in ADF.
    const lead = content[0];
    items.push({
      type: "listItem",
      content: lead === undefined || (lead.type !== "paragraph" && lead.type !== "codeBlock" && lead.type !== "mediaSingle") ? [{ type: "paragraph", content: [] }, ...content] : content,
    });
  }
  const order = Number(first?.[2]?.replace(/[.)]$/, "") ?? "1");
  const node: AdfNode = ordered
    ? { type: "orderedList", ...(order === 1 || !Number.isSafeInteger(order) ? {} : { attrs: { order } }), content: items }
    : { type: "bulletList", content: items };
  return { node, next: index };
};

/** Markdown to an ADF document, as Jira takes a comment or a description. */
export const markdownToAdf = (markdown: string, options: AdfWriteOptions = {}): AdfDoc => ({
  type: "doc",
  version: 1,
  content: parseBlocks(markdown.replace(/\r\n?/g, "\n").split("\n"), options, 0),
});
