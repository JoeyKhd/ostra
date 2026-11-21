import { createHmac, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { lenientTwins, tamperToken } from "../testing/tamper-token.ts";
import { base64urlMacEqual } from "./signature.ts";

const newMac = (): Buffer => createHmac("sha256", randomBytes(32)).update(randomBytes(16)).digest();

describe("a token's MAC, checked by its text", () => {
  it("takes the one canonical base64url text of the MAC", () => {
    const mac = newMac();
    const text = mac.toString("base64url");
    expect(base64urlMacEqual(mac, text)).toBe(true);
    expect(base64urlMacEqual(mac, tamperToken(text))).toBe(false);
    expect(base64urlMacEqual(mac, "")).toBe(false);
    expect(base64urlMacEqual(mac, mac.toString("base64"))).toBe(false);
  });

  it("refuses every other text that decodes to the same MAC: unused bits, padding, +/, whitespace and stray characters", () => {
    for (let round = 0; round < 200; round += 1) {
      const mac = newMac();
      const text = mac.toString("base64url");
      for (const other of [...lenientTwins(text), `${text.slice(0, 10)} ${text.slice(10)}`, `${text}!`]) {
        expect(Buffer.from(other, "base64url").equals(mac), other).toBe(true);
        expect(base64urlMacEqual(mac, other), other).toBe(false);
      }
    }
  });
});
