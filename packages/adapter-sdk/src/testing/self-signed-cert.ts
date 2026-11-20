import { generateKeyPair, randomBytes, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";

// A throwaway self-signed certificate for `localhost` and `127.0.0.1`, made at run time, for the
// fake SMTP server's STARTTLS (milestone 3, ticket 04). It's built here from `node:crypto` and a
// few lines of DER, so no private key is ever kept in the repo and no new dependency is needed.
// Test-only: every call makes a new key, valid for a day.

const length = (size: number): Buffer => {
  if (size < 0x80) {
    return Buffer.from([size]);
  }
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) {
    bytes.unshift(rest % 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};

const tlv = (tag: number, content: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), length(content.length), content]);
const sequence = (...items: readonly Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
const set = (...items: readonly Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));
/**
 * A DER INTEGER, positive and in its shortest form: redundant leading zero bytes go (OpenSSL refuses
 * them as "illegal padding"), and a 0 byte goes in front when the top bit would read as negative.
 */
export const derInteger = (value: Buffer): Buffer => {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0 && (value[start + 1] ?? 0) < 0x80) {
    start += 1;
  }
  const trimmed = value.subarray(start);
  return tlv(0x02, (trimmed[0] ?? 0) >= 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
};
const utf8 = (text: string): Buffer => tlv(0x0c, Buffer.from(text, "utf8"));
const bitString = (content: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), content]));
const octetString = (content: Buffer): Buffer => tlv(0x04, content);

const oid = (dotted: string): Buffer => {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [40 * first + second];
  for (const part of rest) {
    const chunk: number[] = [part & 0x7f];
    for (let value = part >> 7; value > 0; value >>= 7) {
      chunk.unshift((value & 0x7f) | 0x80);
    }
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
};

const utcTime = (date: Date): Buffer => {
  const two = (value: number): string => String(value).padStart(2, "0");
  const text = `${two(date.getUTCFullYear() % 100)}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(text, "ascii"));
};

const ECDSA_WITH_SHA256 = "1.2.840.10045.4.3.2";
const COMMON_NAME = "2.5.4.3";
const SUBJECT_ALT_NAME = "2.5.29.17";

const pem = (label: string, der: Buffer): string => {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
};

export type SelfSignedCert = { readonly cert: string; readonly key: string };

/** A new P-256 key and a certificate for `localhost` and `127.0.0.1`, signed by itself, valid from an hour ago for a day. */
const ecKeyPair = (): Promise<{ readonly publicKey: KeyObject; readonly privateKey: KeyObject }> =>
  new Promise((resolve, reject) => {
    generateKeyPair("ec", { namedCurve: "prime256v1" }, (error, publicKey, privateKey) => {
      if (error === null) {
        resolve({ publicKey, privateKey });
      } else {
        reject(error);
      }
    });
  });

const signed = (data: Buffer, key: KeyObject): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    sign("sha256", data, key, (error, signature) => {
      if (error === null) {
        resolve(signature);
      } else {
        reject(error);
      }
    });
  });

export const makeSelfSignedCert = async (now: Date = new Date(), serial: Buffer = randomBytes(8)): Promise<SelfSignedCert> => {
  const { publicKey, privateKey } = await ecKeyPair();
  const name = sequence(set(sequence(oid(COMMON_NAME), utf8("localhost"))));
  const algorithm = sequence(oid(ECDSA_WITH_SHA256));
  const altNames = sequence(tlv(0x82, Buffer.from("localhost", "ascii")), tlv(0x87, Buffer.from([127, 0, 0, 1])));
  const extensions = tlv(0xa3, sequence(sequence(oid(SUBJECT_ALT_NAME), octetString(altNames))));
  const tbs = sequence(
    tlv(0xa0, derInteger(Buffer.from([2]))),
    derInteger(serial),
    algorithm,
    name,
    sequence(utcTime(new Date(now.getTime() - 3_600_000)), utcTime(new Date(now.getTime() + 86_400_000))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    extensions,
  );
  const signature = await signed(tbs, privateKey);
  const certificate = sequence(tbs, algorithm, bitString(signature));
  return { cert: pem("CERTIFICATE", certificate), key: privateKey.export({ type: "pkcs8", format: "pem" }) };
};
