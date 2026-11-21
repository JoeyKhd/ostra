// Changing a signed token in a test, for every package's tests (the runner's too: this package is
// Apache-2.0, so nothing here may come from the domain). A token's last segment is base64url: its
// MAC, for ostra's own tokens (`<prefix><body>.<mac>`).

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Where a token's last segment starts: after its last `.`, or the whole token when it has none. */
const lastSegment = (token: string): { readonly start: number; readonly text: string } => {
  const start = token.lastIndexOf(".") + 1;
  const text = token.slice(start);
  if (!/^[A-Za-z0-9_-]{2,}$/.test(text)) {
    throw new Error("a token's last segment must be base64url, two characters or more");
  }
  return { start, text };
};

/**
 * `token` with one character in the middle of its last segment swapped for another base64url
 * character, its 6-bit value's top bit flipped: a change to the bytes that segment decodes to, every
 * time. Changing a token's last characters isn't always one: base64url drops a last character's
 * unused low bits, so `…xx` in place of `…xy` can decode to the same MAC (about 1 time in 1,024).
 */
export const tamperToken = (token: string): string => {
  const { start, text } = lastSegment(token);
  const at = start + Math.floor((text.length - 1) / 2);
  const swapped = BASE64URL.charAt(BASE64URL.indexOf(token.charAt(at)) ^ 32);
  return `${token.slice(0, at)}${swapped}${token.slice(at + 1)}`;
};

/**
 * Other texts for `token` that a lenient base64url decoder reads as the same last segment: its last
 * character's unused bits set, `=` padding, and `+` or `/` for `-` or `_`. A verifier that compares
 * decoded bytes takes them all; one that compares the canonical text takes none.
 */
export const lenientTwins = (token: string): readonly string[] => {
  const { start, text } = lastSegment(token);
  const head = token.slice(0, start);
  const twins: string[] = [`${token}=`];
  // A length of 4n + 2 or 4n + 3 leaves 4 or 2 unused bits in the last character: flip the lowest.
  if (text.length % 4 !== 0) {
    twins.push(`${head}${text.slice(0, -1)}${BASE64URL.charAt(BASE64URL.indexOf(text.charAt(text.length - 1)) ^ 1)}`);
  }
  const standard = text.replace("-", "+").replace("_", "/");
  if (standard !== text) {
    twins.push(`${head}${standard}`);
  }
  return twins;
};
