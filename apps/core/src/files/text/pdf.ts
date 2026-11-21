import type { MarkdownWriter } from "./markdown.ts";
import type { TextFailureReason } from "./result.ts";

// A PDF's text layer, page by page (F-150, spec section 5.5), with unpdf's build of pdf.js 6.5.438.
// pdf.js runs here, in the text worker, as its own "fake worker" on this thread: no worker of its
// own. Nothing in the document runs or is fetched:
// - pdf.js 6 has no `eval` path left (its `isEvalSupported` option is gone with it), and
//   `useWasm: false` keeps it from compiling a document's PostScript functions to WebAssembly;
// - no font is loaded (`disableFontFace`, `useSystemFonts: false`) and no URL is given for the
//   standard fonts, CMaps, colour profiles or decoders, so there is nothing to fetch;
// - no range, stream or auto fetch, no XFA, no image decoder, no canvas;
// - a document's JavaScript, links and attachments are never read: only `getTextContent`.
// pdf.js says nothing to the console below its errors (`verbosity: 0`), and the worker drops the
// console anyway. A PDF that needs a password is `encrypted`; one pdf.js can't open is `damaged`.

/** pdf.js's own name for "this document needs a password". */
const PASSWORD_EXCEPTION = "PasswordException";

/** pdf.js's verbosity for errors only. */
const ERRORS_ONLY = 0;

const isPasswordError = (error: unknown): boolean => error instanceof Error && error.name === PASSWORD_EXCEPTION;

/** Writes each page's text under `## Page <n>`, the pages without text left out, or answers why it can't. */
export const readPdf = async (bytes: Uint8Array, writer: MarkdownWriter): Promise<TextFailureReason | null> => {
  const { getDocumentProxy } = await import("unpdf");
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await getDocumentProxy(bytes, {
      useWasm: false,
      useSystemFonts: false,
      disableFontFace: true,
      useWorkerFetch: false,
      disableRange: true,
      disableStream: true,
      disableAutoFetch: true,
      enableXfa: false,
      isImageDecoderSupported: false,
      isOffscreenCanvasSupported: false,
      stopAtErrors: false,
      verbosity: ERRORS_ONLY,
    });
  } catch (error) {
    return isPasswordError(error) ? "encrypted" : "damaged";
  }
  try {
    for (let number = 1; number <= pdf.numPages && !writer.full(); number += 1) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? `${item.str}${item.hasEOL ? "\n" : ""}` : ""))
        .join("")
        .replace(/[^\S\n]+/g, " ")
        .replace(/ ?\n ?/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      page.cleanup();
      if (text !== "") {
        writer.heading(`## Page ${String(number)}`);
        writer.block(text);
      }
    }
    return null;
  } catch (error) {
    return isPasswordError(error) ? "encrypted" : "damaged";
  } finally {
    await pdf.loadingTask.destroy();
  }
};
