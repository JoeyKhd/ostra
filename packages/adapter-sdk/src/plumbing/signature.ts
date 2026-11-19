import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Webhook signatures, written once for every adapter and fake (spike 5 read Linear's SDK: a
// constant-time HMAC-SHA256 over the raw body). Values never reach a log line.

/** HMAC-SHA256 of `bytes` with `secret`, in lower-case hex. */
export const hmacSha256Hex = (secret: string, bytes: Uint8Array): string =>
  createHmac("sha256", secret).update(bytes).digest("hex");

/** SHA-256 of a string or bytes, in lower-case hex. */
export const sha256Hex = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

/** Compares two hex digests in constant time. A different length, or a non-hex string, is unequal. */
export const hexDigestsEqual = (expected: string, actual: string): boolean => {
  if (!/^[0-9a-f]+$/i.test(actual) || expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected.toLowerCase(), "hex"), Buffer.from(actual.toLowerCase(), "hex"));
};

/** Whether `signature` is the hex HMAC-SHA256 of `bytes` with `secret`, compared in constant time. */
export const verifyHmacSha256Hex = (secret: string, bytes: Uint8Array, signature: string): boolean =>
  hexDigestsEqual(hmacSha256Hex(secret, bytes), signature.trim());
