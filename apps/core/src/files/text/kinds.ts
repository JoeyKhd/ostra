// The documents ostra reads the text of (F-150, ADR 0070): Word, Excel and PowerPoint's Office Open
// XML files, and PDFs. Nothing else: no `.doc`, `.xls`, `.ppt`, OpenDocument or OCR (Q334).

export const documentKinds = ["docx", "xlsx", "pptx", "pdf"] as const;
export type DocumentKind = (typeof documentKinds)[number];

/** Each kind's type, as core tells it from the file's bytes (the domain's `fileKindOf`). */
export const documentContentTypes = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
} as const satisfies Record<DocumentKind, string>;

/** The kind of a detected type, or `null` for a type ostra reads no text from. */
export const documentKindOf = (contentType: string): DocumentKind | null =>
  documentKinds.find((kind) => documentContentTypes[kind] === contentType) ?? null;

export const isDocumentKind = (value: unknown): value is DocumentKind => documentKinds.some((kind) => kind === value);
