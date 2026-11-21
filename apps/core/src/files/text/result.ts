// What reading a document's text gives (F-150, spec section 5.5). The worker imports this module, so
// it holds no schema and imports nothing: the pool checks the worker's answer with `messages.ts`.

/**
 * Why a document has no text (F-150/c3). The file is still attached, marked "no text" with this:
 * - `encrypted`: it needs a password;
 * - `damaged`: it can't be read as its kind (a broken zip, broken XML, a PDF pdf.js refuses);
 * - `too-big`: a part's declared size, or all of them, past the cap, or past the worker's heap;
 * - `too-many-parts`: a zip of more entries than the cap;
 * - `doctype`: a part holding a `<!DOCTYPE` (and so maybe an entity), never parsed;
 * - `timeout`: past the time a file may take;
 * - `no-text`: read, and nothing in it (a scan, an empty document);
 * - `busy`: no worker was free in time.
 */
export const textFailureReasons = ["encrypted", "damaged", "too-big", "too-many-parts", "doctype", "timeout", "no-text", "busy"] as const;
export type TextFailureReason = (typeof textFailureReasons)[number];

/**
 * A document's text: `ready` with its Markdown (ostra's first line, the text, and when cut, the
 * cut's last line), its words and whether it was cut; or `failed` with the reason. The Markdown is
 * the member's or the ticket's data: never logged.
 */
export type ExtractedText =
  | { readonly state: "ready"; readonly markdown: string; readonly words: number; readonly truncated: boolean }
  | { readonly state: "failed"; readonly reason: TextFailureReason };

export const textFailed = (reason: TextFailureReason): ExtractedText => ({ state: "failed", reason });
