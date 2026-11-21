import { unzipSync } from "fflate";

import type { TextReadLimits } from "./limits.ts";
import type { TextFailureReason } from "./result.ts";

// An Office file's zip, read part by part (F-150/c2, spec section 5.5): only the parts a reader
// names, each one's declared size checked before anything is inflated, at most `zipEntriesMax`
// entries counted from the zip's own directory first. fflate inflates a part into a buffer of its
// declared size and no larger, so a part that lies about its size can't grow past it; the time
// limit stops one that inflates on and on. Runs in the worker only.

export type ZipRefusal = Extract<TextFailureReason, "too-big" | "too-many-parts" | "damaged" | "encrypted">;

export type ZipParts = { readonly ok: true; readonly parts: ReadonlyMap<string, Uint8Array> } | { readonly ok: false; readonly reason: ZipRefusal };

const u16 = (bytes: Uint8Array, at: number): number => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
const u32 = (bytes: Uint8Array, at: number): number => (u16(bytes, at) | (u16(bytes, at + 2) << 16)) >>> 0;
const u64 = (bytes: Uint8Array, at: number): number => u32(bytes, at) + u32(bytes, at + 4) * 2 ** 32;

const END_OF_DIRECTORY = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_END = 0x06064b50;

/**
 * How many entries the zip's directory says it holds, read from its end record (and its zip64
 * record when there is one), or `null` when it has no end record: not a zip.
 */
export const zipEntryCount = (bytes: Uint8Array): number | null => {
  // The end record is the last 22 bytes, before a comment of at most 65,535.
  const lowest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let at = bytes.length - 22; at >= lowest; at -= 1) {
    if (u32(bytes, at) !== END_OF_DIRECTORY) {
      continue;
    }
    const count = u16(bytes, at + 10);
    if (at >= 20 && u32(bytes, at - 20) === ZIP64_LOCATOR) {
      const record = u64(bytes, at - 20 + 8);
      if (record + 40 <= bytes.length && u32(bytes, record) === ZIP64_END) {
        return Math.max(count, u64(bytes, record + 32));
      }
    }
    return count;
  }
  return null;
};

/** An OLE compound file: what Office writes for a password-protected document, and for the old `.doc`. */
const COMPOUND_FILE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;

const isCompoundFile = (bytes: Uint8Array): boolean => COMPOUND_FILE.every((byte, index) => bytes[index] === byte);

/** A password-protected Office file keeps the real one in a stream named `EncryptedPackage`. */
const ENCRYPTED_PACKAGE = Buffer.from("EncryptedPackage", "utf16le");

const isEncryptedPackage = (bytes: Uint8Array): boolean => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(ENCRYPTED_PACKAGE);

/** The parts `wanted` names, inflated, or why the zip is refused. Nothing else in it is inflated. */
export const readZipParts = (bytes: Uint8Array, wanted: (name: string) => boolean, limits: TextReadLimits): ZipParts => {
  if (isCompoundFile(bytes)) {
    return { ok: false, reason: isEncryptedPackage(bytes) ? "encrypted" : "damaged" };
  }
  const count = zipEntryCount(bytes);
  if (count === null) {
    return { ok: false, reason: "damaged" };
  }
  if (count > limits.zipEntriesMax) {
    return { ok: false, reason: "too-many-parts" };
  }
  const seen: { entries: number; declared: number; refusal: ZipRefusal | null } = { entries: 0, declared: 0, refusal: null };
  const refuse = (reason: ZipRefusal): never => {
    seen.refusal = reason;
    throw new Error(reason);
  };
  try {
    // The worker is the place for synchronous work: nothing else runs on its thread.
    // eslint-disable-next-line no-restricted-syntax -- runs in the text worker, off core's event loop
    const files = unzipSync(bytes, {
      filter: (file) => {
        seen.entries += 1;
        if (seen.entries > limits.zipEntriesMax) {
          refuse("too-many-parts");
        }
        if (!wanted(file.name)) {
          return false;
        }
        seen.declared += file.originalSize;
        if (file.originalSize > limits.zipInflatedBytesMax || seen.declared > limits.zipInflatedBytesMax) {
          refuse("too-big");
        }
        return true;
      },
    });
    return { ok: true, parts: new Map(Object.entries(files)) };
  } catch {
    return { ok: false, reason: seen.refusal ?? "damaged" };
  }
};
