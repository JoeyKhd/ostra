import { readDocx, isDocxPart } from "./docx.ts";
import type { DocumentKind } from "./kinds.ts";
import type { TextReadLimits } from "./limits.ts";
import { createMarkdownWriter, documentMarkdown } from "./markdown.ts";
import type { MarkdownWriter } from "./markdown.ts";
import { readPdf } from "./pdf.ts";
import { isPptxPart, readPptx } from "./pptx.ts";
import { textFailed } from "./result.ts";
import type { ExtractedText, TextFailureReason } from "./result.ts";
import { isXlsxPart, readXlsx } from "./xlsx.ts";
import { readZipParts } from "./zip.ts";

// Reading one document's text (F-150, spec section 5.5): the Office reader or the PDF reader, then
// ostra's Markdown. It runs in the text worker (`worker.ts`), never on core's event loop, and it
// never throws: whatever goes wrong is a reason. The bytes, the name and the text are the member's
// or the ticket's: nothing here logs.

/** One document to read: its bytes, its kind, and the safe name its text's first line gives. */
export type DocumentInput = {
  readonly bytes: Uint8Array;
  readonly kind: DocumentKind;
  /** The file's safe name, as the box holds it. Never logged. */
  readonly name: string;
};

const readOffice = (bytes: Uint8Array, kind: Exclude<DocumentKind, "pdf">, writer: MarkdownWriter, limits: TextReadLimits): TextFailureReason | null => {
  const wanted = kind === "docx" ? isDocxPart : kind === "xlsx" ? isXlsxPart : isPptxPart;
  const zip = readZipParts(bytes, wanted, limits);
  if (!zip.ok) {
    return zip.reason;
  }
  switch (kind) {
    case "docx":
      return readDocx(zip.parts, writer);
    case "xlsx":
      return readXlsx(zip.parts, writer, limits.textMaxBytes);
    case "pptx":
      return readPptx(zip.parts, writer);
    default:
      return kind satisfies never;
  }
};

/** The document's text before ostra's first line: what its reader wrote, or why it wrote nothing. */
export const readDocumentBody = async (
  bytes: Uint8Array,
  kind: DocumentKind,
  limits: TextReadLimits,
): Promise<{ readonly ok: true; readonly body: string } | { readonly ok: false; readonly reason: TextFailureReason }> => {
  const writer = createMarkdownWriter(limits.textMaxBytes);
  let refusal: TextFailureReason | null;
  try {
    refusal = kind === "pdf" ? await readPdf(bytes, writer) : readOffice(bytes, kind, writer, limits);
  } catch {
    // A reader's own failure on a hostile file (a stack overflow, a broken part): never a crash.
    refusal = "damaged";
  }
  if (refusal !== null) {
    return { ok: false, reason: refusal };
  }
  return writer.hasContent() ? { ok: true, body: writer.text() } : { ok: false, reason: "no-text" };
};

/**
 * A document's text as it goes beside the file: ostra's first line naming the file and its kind,
 * then the text, cut at `limits.textMaxBytes` with a last line saying so. `ready` with its words, or
 * `failed` with the reason (F-150/c3: never a throw).
 */
export const extractText = async (input: DocumentInput, limits: TextReadLimits): Promise<ExtractedText> => {
  const body = await readDocumentBody(input.bytes, input.kind, limits);
  if (!body.ok) {
    return textFailed(body.reason);
  }
  return { state: "ready", ...documentMarkdown(input.name, input.kind, body.body, limits.textMaxBytes) };
};
