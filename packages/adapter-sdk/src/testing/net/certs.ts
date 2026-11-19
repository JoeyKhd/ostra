import { generateKeyPair, randomBytes, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { isIP } from "node:net";

import { boolean, integer, oid, OIDS, octetString, pem, sequence, set, tlv, utcTime, utf8 } from "./der.ts";

// Per-run certificates, made in memory (ticket 06, ported from spike 6's `certs.ts`, which ran the
// openssl CLI): a CA, and leaves it signs for the names and addresses a test server answers on. A
// self-hosted install's own CA, or a corporate TLS-inspecting proxy's, is one of these. P-256 keys,
// valid from an hour ago for two days. Test and dev only: no key is kept in the repo.

export type TestCa = {
  readonly name: string;
  /** The CA's certificate, PEM, for `ca:` or `NODE_EXTRA_CA_CERTS`. */
  readonly cert: string;
  readonly key: KeyObject;
  readonly subject: Buffer;
};

export type TestCert = { readonly cert: string; readonly key: string };

const keyPair = (): Promise<{ readonly publicKey: KeyObject; readonly privateKey: KeyObject }> =>
  new Promise((resolve, reject) => {
    generateKeyPair("ec", { namedCurve: "prime256v1" }, (error, publicKey, privateKey) => {
      if (error === null) resolve({ publicKey, privateKey });
      else reject(error);
    });
  });

const signed = (data: Buffer, key: KeyObject): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    sign("sha256", data, key, (error, signature) => {
      if (error === null) resolve(signature);
      else reject(error);
    });
  });

const nameOf = (commonName: string): Buffer => sequence(set(sequence(oid(OIDS.commonName), utf8(commonName))));

const extension = (id: string, critical: boolean, value: Buffer): Buffer => sequence(oid(id), ...(critical ? [boolean(true)] : []), octetString(value));

/** A BIT STRING of one byte, with its unused low bits counted, as DER wants it. */
const flags = (byte: number): Buffer => {
  let unused = 0;
  while (unused < 8 && (byte & (1 << unused)) === 0) unused += 1;
  return tlv(0x03, Buffer.from([unused, byte]));
};

const certificate = async (input: {
  readonly subject: Buffer;
  readonly issuer: Buffer;
  readonly publicKey: KeyObject;
  readonly signer: KeyObject;
  readonly extensions: readonly Buffer[];
  readonly now: Date;
}): Promise<string> => {
  const algorithm = sequence(oid(OIDS.ecdsaWithSha256));
  const tbs = sequence(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(randomBytes(12)),
    algorithm,
    input.issuer,
    sequence(utcTime(new Date(input.now.getTime() - 3_600_000)), utcTime(new Date(input.now.getTime() + 2 * 86_400_000))),
    input.subject,
    input.publicKey.export({ type: "spki", format: "der" }),
    tlv(0xa3, sequence(...input.extensions)),
  );
  const signature = await signed(tbs, input.signer);
  return pem("CERTIFICATE", sequence(tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), signature]))));
};

/** A new CA, `CA:TRUE`, allowed to sign certificates. */
export const makeTestCa = async (name: string, now: Date = new Date()): Promise<TestCa> => {
  const { publicKey, privateKey } = await keyPair();
  const subject = nameOf(name);
  const cert = await certificate({
    subject,
    issuer: subject,
    publicKey,
    signer: privateKey,
    now,
    extensions: [extension(OIDS.basicConstraints, true, sequence(boolean(true))), extension(OIDS.keyUsage, true, flags(0x06))],
  });
  return { name, cert, key: privateKey, subject };
};

/** A server certificate the CA signs, for each name and address in `hosts` (`localhost`, `127.0.0.1`, `ostra-core.test`). */
export const issueTestCert = async (ca: TestCa, hosts: readonly string[], now: Date = new Date()): Promise<TestCert> => {
  const { publicKey, privateKey } = await keyPair();
  const altNames = sequence(
    ...hosts.map((host) => {
      const version = isIP(host);
      if (version === 4) return tlv(0x87, Buffer.from(host.split(".").map(Number)));
      return tlv(0x82, Buffer.from(host, "ascii"));
    }),
  );
  const cert = await certificate({
    subject: nameOf(hosts[0] ?? "localhost"),
    issuer: ca.subject,
    publicKey,
    signer: ca.key,
    now,
    extensions: [
      extension(OIDS.basicConstraints, false, sequence()),
      extension(OIDS.keyUsage, true, flags(0x80)),
      extension(OIDS.extendedKeyUsage, false, sequence(oid(OIDS.serverAuth))),
      extension(OIDS.subjectAltName, false, altNames),
    ],
  });
  return { cert, key: privateKey.export({ type: "pkcs8", format: "pem" }) };
};
