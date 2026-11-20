import { X509Certificate } from "node:crypto";
import { createSecureContext } from "node:tls";
import { describe, expect, it } from "vitest";
import { derInteger, makeSelfSignedCert } from "./self-signed-cert.ts";

describe("the fake mail server's self-signed certificate", () => {
  it("F-115: a DER integer is positive and in its shortest form", () => {
    expect(derInteger(Buffer.from([0x00, 0x01, 0x02]))).toEqual(Buffer.from([0x02, 0x02, 0x01, 0x02]));
    expect(derInteger(Buffer.from([0x00, 0x00, 0x80]))).toEqual(Buffer.from([0x02, 0x02, 0x00, 0x80]));
    expect(derInteger(Buffer.from([0x80, 0x01]))).toEqual(Buffer.from([0x02, 0x03, 0x00, 0x80, 0x01]));
    expect(derInteger(Buffer.from([0x00]))).toEqual(Buffer.from([0x02, 0x01, 0x00]));
    expect(derInteger(Buffer.from([0x02]))).toEqual(Buffer.from([0x02, 0x01, 0x02]));
  });

  it("F-115: a serial that starts with a zero byte still makes a certificate TLS takes (CI run 44654626587)", async () => {
    // About one random serial in 512 starts 0x00 then a byte under 0x80; written as is, OpenSSL
    // refuses the certificate ("illegal padding") and the STARTTLS tests hang until they time out.
    for (const serial of [
      Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]),
      Buffer.from([0x00, 0x00, 0x7f, 0x03, 0x04, 0x05, 0x06, 0x07]),
      Buffer.from([0xff, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]),
    ]) {
      const { cert, key } = await makeSelfSignedCert(new Date(), serial);
      expect(new X509Certificate(cert).subjectAltName).toContain("localhost");
      expect(() => createSecureContext({ key, cert })).not.toThrow();
    }
  });
});
