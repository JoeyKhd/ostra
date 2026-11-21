import { promisify } from "node:util";
import { inflateRaw } from "node:zlib";

import { safeFileName } from "@ostra/protocol";
import type { MessageFileKind, SafeFileName } from "@ostra/protocol";

// What a file is, told by core from its bytes alone (ADR 0070, Q339, spec section 5.4): the
// browser's type is never read, and a file's name never decides its kind. A PNG, JPEG, GIF or WebP
// by its magic bytes is an `image`; a PDF by `%PDF-`, and a `.docx`, `.xlsx` or `.pptx` by a zip
// whose `[Content_Types].xml` names its main part, is a `document`; valid UTF-8 with no NUL in its
// first 8 KiB is `text`; anything else is a `file`. An SVG, a HEIC, an AVIF and a BMP are files,
// and an SVG is never drawn as an image. Nothing here runs, fetches or follows anything a file
// holds, and a file's bytes and name are never logged.

/** What detection makes of a file: its kind, the type it's served and named as, and its safe name. */
export type DetectedFile = {
  readonly kind: MessageFileKind;
  readonly contentType: string;
  /** The name made safe, with the detected type's extension added when the name has none of its own. */
  readonly name: SafeFileName;
};

/** The Office documents' types, by their main part's content type in `[Content_Types].xml`. */
const OFFICE_MAIN_PARTS = [
  {
    main: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extension: "docx",
  },
  {
    main: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: "xlsx",
  },
  {
    main: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
    contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    extension: "pptx",
  },
] as const;

/** A type that isn't an image, a document or text: never sniffed by a browser, never run. */
export const OCTET_STREAM = "application/octet-stream";

/** The extension each detected type adds to a name that has none. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  ...Object.fromEntries(OFFICE_MAIN_PARTS.map((part) => [part.contentType, part.extension])),
};

/** How much of a file's start the text check reads for a NUL. */
export const TEXT_PROBE_BYTES = 8 * 1024;

/** The largest `[Content_Types].xml` detection inflates: an Office file's is a few KiB. */
const CONTENT_TYPES_MAX_BYTES = 256 * 1024;

/** The most central directory entries detection walks before it gives up: a zip with more isn't an Office file it reads. */
const ZIP_ENTRIES_MAX = 5000;

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0): boolean =>
  bytes.length >= at + prefix.length && prefix.every((byte, index) => bytes[at + index] === byte);

const ascii = (text: string): readonly number[] => Array.from({ length: text.length }, (_, index) => text.charCodeAt(index));

const inflate = promisify(inflateRaw);

/** The image types by their magic bytes. */
const imageTypeOf = (bytes: Uint8Array): string | null => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) {
    return "image/gif";
  }
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) {
    return "image/webp";
  }
  return null;
};

const view = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/**
 * The bytes of one entry of a zip, found by its name in the central directory, or `null` when the
 * zip doesn't hold it, isn't one ostra reads (zip64, encrypted, an unknown method), or would
 * inflate past `maxBytes`. Bounds are checked at every step: a damaged zip is `null`, never a throw.
 */
const zipEntry = async (bytes: Uint8Array, wanted: string, maxBytes: number): Promise<Uint8Array | null> => {
  const data = view(bytes);
  // The end of the central directory: its signature, searched back over the comment's 64 KiB.
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1) {
    if (data.getUint32(at, true) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) {
    return null;
  }
  const entries = data.getUint16(end + 10, true);
  const directorySize = data.getUint32(end + 12, true);
  const directoryStart = data.getUint32(end + 16, true);
  if (entries === 0xffff || directoryStart === 0xffffffff || entries > ZIP_ENTRIES_MAX || directoryStart + directorySize > end) {
    return null;
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let at = directoryStart;
  for (let index = 0; index < entries; index += 1) {
    if (at + 46 > end || data.getUint32(at, true) !== 0x02014b50) {
      return null;
    }
    const flags = data.getUint16(at + 8, true);
    const method = data.getUint16(at + 10, true);
    const compressedSize = data.getUint32(at + 20, true);
    const size = data.getUint32(at + 24, true);
    const nameLength = data.getUint16(at + 28, true);
    const extraLength = data.getUint16(at + 30, true);
    const commentLength = data.getUint16(at + 32, true);
    const localHeader = data.getUint32(at + 42, true);
    if (at + 46 + nameLength > end) {
      return null;
    }
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (name === wanted) {
      // Encrypted (bit 0), or over the cap by its own word: not read.
      if ((flags & 1) !== 0 || size > maxBytes || compressedSize > bytes.length || localHeader + 30 > bytes.length) {
        return null;
      }
      if (data.getUint32(localHeader, true) !== 0x04034b50) {
        return null;
      }
      const start = localHeader + 30 + data.getUint16(localHeader + 26, true) + data.getUint16(localHeader + 28, true);
      if (start + compressedSize > bytes.length) {
        return null;
      }
      const stored = bytes.subarray(start, start + compressedSize);
      if (method === 0) {
        return stored.length === size ? stored : null;
      }
      if (method !== 8) {
        return null;
      }
      try {
        const inflated = await inflate(stored, { maxOutputLength: maxBytes });
        return inflated.length === size ? new Uint8Array(inflated) : null;
      } catch {
        return null;
      }
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return null;
};

/** An Office document's type, by the main part its zip's `[Content_Types].xml` names, or `null`. */
const officeTypeOf = async (bytes: Uint8Array): Promise<(typeof OFFICE_MAIN_PARTS)[number] | null> => {
  if (!startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    return null;
  }
  const types = await zipEntry(bytes, "[Content_Types].xml", CONTENT_TYPES_MAX_BYTES);
  if (types === null) {
    return null;
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(types);
  return OFFICE_MAIN_PARTS.find((part) => text.includes(`"${part.main}"`)) ?? null;
};

/** An SVG's start: an optional BOM, XML declaration, comments and DOCTYPE, then `<svg`. */
const SVG_START = /^﻿?\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>/]/i;

/** Whether the bytes are text: valid UTF-8 all through, and no NUL in the first 8 KiB. An SVG isn't. */
const isText = (bytes: Uint8Array): boolean => {
  if (bytes.subarray(0, TEXT_PROBE_BYTES).includes(0)) {
    return false;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  return !SVG_START.test(text.slice(0, TEXT_PROBE_BYTES));
};

/** The kind and type of a file's bytes (Q339). */
export const fileTypeOf = async (bytes: Uint8Array): Promise<{ readonly kind: MessageFileKind; readonly contentType: string }> => {
  const image = imageTypeOf(bytes);
  if (image !== null) {
    return { kind: "image", contentType: image };
  }
  if (startsWith(bytes, ascii("%PDF-"))) {
    return { kind: "document", contentType: "application/pdf" };
  }
  const office = await officeTypeOf(bytes);
  if (office !== null) {
    return { kind: "document", contentType: office.contentType };
  }
  return isText(bytes) ? { kind: "text", contentType: "text/plain" } : { kind: "file", contentType: OCTET_STREAM };
};

/**
 * A file's kind and type from its bytes alone, and its name made safe (`safeFileName`), with the
 * detected type's extension added when the name has none of its own. The name never decides the
 * kind: a PNG named `.exe` is an image, a script named `.png` is text or a file.
 */
export const fileKindOf = async (bytes: Uint8Array, name: string): Promise<DetectedFile> => {
  const type = await fileTypeOf(bytes);
  return { ...type, name: safeFileName(name, EXTENSIONS[type.contentType] ?? null) };
};
