import { createHmac, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { lenientTwins, tamperToken } from "./tamper-token.ts";

const macOf = (token: string): Buffer => Buffer.from(token.slice(token.lastIndexOf(".") + 1), "base64url");

// A token shaped like ostra's own: a prefix, a base64url body, and its HMAC-SHA256 in base64url.
const tokenWith = (mac: Buffer): string => `ostra-test-${Buffer.from('{"v":1}').toString("base64url")}.${mac.toString("base64url")}`;
const newToken = (): { readonly token: string; readonly mac: Buffer } => {
  const mac = createHmac("sha256", randomBytes(32)).update(randomBytes(16)).digest();
  return { token: tokenWith(mac), mac };
};

describe("changing a signed token in a test", () => {
  it("tamperToken changes the MAC a token decodes to, every time, and only one character of it", () => {
    for (let round = 0; round < 2000; round += 1) {
      const { token, mac } = newToken();
      const tampered = tamperToken(token);
      expect(tampered).toHaveLength(token.length);
      expect(Array.from({ length: token.length }, (_, index) => index).filter((index) => tampered.charAt(index) !== token.charAt(index))).toHaveLength(1);
      expect(macOf(tampered).equals(mac)).toBe(false);
    }
    // The case the old `…xx` missed: a MAC that already ends in what the tamper writes.
    const endsInXx = tokenWith(Buffer.from(`${"A".repeat(41)}xx`, "base64url"));
    expect(macOf(`${endsInXx.slice(0, -2)}xx`).equals(macOf(endsInXx))).toBe(true);
    expect(macOf(tamperToken(endsInXx)).equals(macOf(endsInXx))).toBe(false);
  });

  it("tamperToken refuses a token whose last segment isn't base64url", () => {
    for (const junk of ["", "ostra-x.", "ostra-x.a", "ostra-x.ab=c", "ostra-x.ab+c"]) {
      expect(() => tamperToken(junk), junk).toThrow("base64url");
    }
  });

  it("lenientTwins are other texts that decode to the same MAC", () => {
    const { token, mac } = newToken();
    const twins = lenientTwins(token);
    expect(twins.length).toBeGreaterThanOrEqual(2);
    for (const twin of twins) {
      expect(twin).not.toBe(token);
      expect(macOf(twin).equals(mac), twin).toBe(true);
    }
    expect(lenientTwins("ostra-x.ab-c_d")).toEqual(["ostra-x.ab-c_d=", "ostra-x.ab-c_c", "ostra-x.ab+c/d"]);
  });
});
