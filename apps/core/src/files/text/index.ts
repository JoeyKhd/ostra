// The text out of documents (F-150, ADR 0070, spec section 5.5): core's reader of `.docx`, `.xlsx`,
// `.pptx` and `.pdf`, in a pool of worker threads. Tickets 10 (uploads) and 12 (a ticket's files)
// call `createDocumentTextReader` once per core process and `read` for each file as it comes in.

export { createDocumentTextReader } from "./reader.ts";
export type { DocumentText, DocumentTextInput, DocumentTextReader, DocumentTextReaderOptions } from "./reader.ts";
export { createTextPool } from "./pool.ts";
export type { TextPool, TextPoolInput, TextPoolOptions, TextPoolStats } from "./pool.ts";
export { extractText } from "./extract.ts";
export type { DocumentInput } from "./extract.ts";
export { documentContentTypes, documentKindOf, documentKinds } from "./kinds.ts";
export type { DocumentKind } from "./kinds.ts";
export { textPoolLimits, textReadLimits } from "./limits.ts";
export type { TextPoolLimits, TextReadLimits } from "./limits.ts";
export { textFailureReasons } from "./result.ts";
export type { ExtractedText, TextFailureReason } from "./result.ts";
export { textCutLine, textHeaderLine } from "./markdown.ts";
