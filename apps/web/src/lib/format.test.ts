import { describe, expect, it } from "vitest";

import { formatAge, formatDuration, formatPrice, formatTokens } from "./format";

describe("format", () => {
  it("shortens token counts", () => {
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_050_000)).toBe("1.05M");
    expect(formatTokens(256_000)).toBe("256k");
    expect(formatTokens(512)).toBe("512");
    expect(formatTokens(null)).toBe("–");
  });

  it("writes prices, ages and durations", () => {
    expect(formatPrice(2)).toBe("$2.00");
    expect(formatAge(0, 30_000)).toBe("now");
    expect(formatAge(0, 4 * 60_000)).toBe("4m");
    expect(formatAge(0, 3 * 3_600_000)).toBe("3h");
    expect(formatDuration(2_140)).toBe("2.1s");
    expect(formatDuration(184_000)).toBe("3m 04s");
  });
});
