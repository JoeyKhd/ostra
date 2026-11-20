import { describe, expect, it } from "vitest";
import { integer } from "./der.ts";

describe("the per-run test certificates' DER", () => {
  it("F-093: an integer is positive and in its shortest form, so OpenSSL takes every random serial (CI run 44812324433)", () => {
    expect(integer(Buffer.from([0x00, 0x01, 0x02]))).toEqual(Buffer.from([0x02, 0x02, 0x01, 0x02]));
    expect(integer(Buffer.from([0x00, 0x00, 0x80]))).toEqual(Buffer.from([0x02, 0x02, 0x00, 0x80]));
    expect(integer(Buffer.from([0x80, 0x01]))).toEqual(Buffer.from([0x02, 0x03, 0x00, 0x80, 0x01]));
    expect(integer(Buffer.from([0x00]))).toEqual(Buffer.from([0x02, 0x01, 0x00]));
    expect(integer(Buffer.from([0x02]))).toEqual(Buffer.from([0x02, 0x01, 0x02]));
  });
});
