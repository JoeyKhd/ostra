// The few DER encodings a test certificate needs (X.509, RFC 5280), so certificates are made in
// memory from `node:crypto` with no dependency and no key kept in the repo. Test and dev only.

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

export const tlv = (tag: number, content: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), length(content.length), content]);
export const sequence = (...items: readonly Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
export const set = (...items: readonly Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));
export const integer = (value: Buffer): Buffer => tlv(0x02, (value[0] ?? 0) >= 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value);
export const utf8 = (text: string): Buffer => tlv(0x0c, Buffer.from(text, "utf8"));
export const bitString = (content: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), content]));
export const octetString = (content: Buffer): Buffer => tlv(0x04, content);
export const boolean = (value: boolean): Buffer => tlv(0x01, Buffer.from([value ? 0xff : 0]));

export const oid = (dotted: string): Buffer => {
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

export const utcTime = (date: Date): Buffer => {
  const two = (value: number): string => String(value).padStart(2, "0");
  const text = `${two(date.getUTCFullYear() % 100)}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(text, "ascii"));
};

export const pem = (label: string, der: Buffer): string => {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
};

export const OIDS = {
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  commonName: "2.5.4.3",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extendedKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1",
} as const;
