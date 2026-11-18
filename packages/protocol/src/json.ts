import type { z } from "zod";

// Helpers for reading text that came over a wire. They never throw on bad input, and the details
// they return name paths and rules, never the values, so they are safe to log.

export type JsonParse = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

/** Parse JSON text without throwing. */
export const parseJson = (text: string): JsonParse => {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
};

/** The length of a string in UTF-8 bytes, without Node's `Buffer` or the DOM's `TextEncoder`. */
export const utf8ByteLength = (text: string): number => {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
};

/** A Zod error as a short line of paths and messages. Values are never included. */
export const describeIssues = (error: z.ZodError, max = 5): string => {
  const lines = error.issues.slice(0, max).map((issue) => {
    const where = issue.path.length === 0 ? "(root)" : issue.path.map(String).join(".");
    return `${where}: ${issue.message}`;
  });
  const more = error.issues.length > max ? ` (+${String(error.issues.length - max)} more)` : "";
  return `${lines.join("; ")}${more}`;
};
