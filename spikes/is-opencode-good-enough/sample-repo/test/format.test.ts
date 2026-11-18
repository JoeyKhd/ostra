import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatNumber } from "../src/format.ts";

describe("formatNumber", () => {
  it("prints integers and decimals as they are", () => {
    assert.equal(formatNumber(42), "42");
    assert.equal(formatNumber(2.5), "2.5");
    assert.equal(formatNumber(-0.25), "-0.25");
  });

  it("groups thousands when asked", () => {
    assert.equal(formatNumber(1234567, { thousands: true }), "1,234,567");
    assert.equal(formatNumber(-1234567, { thousands: true }), "-1,234,567");
    assert.equal(formatNumber(999, { thousands: true }), "999");
  });

  it("keeps the fraction when grouping", () => {
    assert.equal(formatNumber(1234.5, { thousands: true }), "1,234.5");
  });

  it("does not group by default", () => {
    assert.equal(formatNumber(1234567), "1234567");
  });

  it("prints NaN and the infinities by name", () => {
    assert.equal(formatNumber(Number.NaN), "NaN");
    assert.equal(formatNumber(Number.POSITIVE_INFINITY), "Infinity");
    assert.equal(formatNumber(Number.NEGATIVE_INFINITY), "-Infinity");
  });
});
