import { describe, expect, it } from "vitest";

import { shortAge, titleParts } from "./highlight";
import { updatedText } from "./search-view";

// F-080 (search.md): a result block's whole title with its matched words, its short age, and the
// panel's `Updated`.

const now = Date.UTC(2026, 10, 21, 12);
const minute = 60_000;

describe("a search result's words (F-080)", () => {
  it("shows the whole title, with the words its snippet matched", () => {
    expect(titleParts("Pin the Stripe apiVersion in the webhook client", [{ text: "…Stripe ", match: false }, { text: "apiVersion", match: true }, { text: " in the", match: false }])).toEqual([
      { text: "Pin the Stripe ", match: false },
      { text: "apiVersion", match: true },
      { text: " in the webhook client", match: false },
    ]);
    expect(titleParts("Fix the history view", [])).toEqual([{ text: "Fix the history view", match: false }]);
    expect(titleParts("Read (a+b) config", [{ text: "(a+b)", match: true }])).toEqual([
      { text: "Read ", match: false },
      { text: "(a+b)", match: true },
      { text: " config", match: false },
    ]);
  });

  it("writes a block's age short, and the panel's update in words", () => {
    expect(shortAge(now - 5 * minute, now)).toBe("5m");
    expect(shortAge(now - 2 * 60 * minute, now)).toBe("2h");
    expect(shortAge(now - 3 * 24 * 60 * minute, now)).toBe("3d");
    expect(shortAge(now - 15 * 24 * 60 * minute, now)).toBe("2w");
    expect(updatedText(now - 3 * 24 * 60 * minute, now)).toBe("3 days ago");
    expect(updatedText(now - 60 * minute, now)).toBe("1 hour ago");
  });
});
