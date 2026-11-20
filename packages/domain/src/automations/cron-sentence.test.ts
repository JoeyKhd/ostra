import { describe, expect, it } from "vitest";

import { cronSentence, ordinal, zoneWords } from "./cron-sentence.ts";

// The schedule's sentence (F-106): the grammar of milestone 6's screen target `automation-edit.md`,
// each row of its table, the zone's words, and the fallback for an expression it has no words for.

describe("the cron sentence", () => {
  it("F-106: says each of the editor's examples in its zone's words", () => {
    const table: readonly (readonly [string, string])[] = [
      ["0 * * * *", "Every hour, on the hour"],
      ["30 */2 * * *", "Every 2 hours at :30"],
      ["0 9 * * *", "Every day at 09:00"],
      ["0 9 * * 1-5", "Every weekday at 09:00"],
      ["0 9 * * 1", "Every Monday at 09:00"],
      ["0 9 * * 1,3", "Every Monday and Wednesday at 09:00"],
      ["0 9,17 * * *", "Every day at 09:00 and 17:00"],
      ["0 9 1 * *", "On the 1st of every month at 09:00"],
      ["0 9 1 1,7 *", "On the 1st of January and July at 09:00"],
      ["0 9 1 * 1", "On the 1st of every month and every Monday at 09:00"],
    ];
    for (const [cron, words] of table) {
      expect(cronSentence(cron, "UTC"), cron).toEqual({ text: `${words}, UTC`, described: true });
    }
    expect(cronSentence("0 9 * * 1", "Europe/Amsterdam")?.text).toBe("Every Monday at 09:00, Amsterdam time");
    expect(cronSentence("15 7 * * 1,3,5", "America/New_York")?.text).toBe("Every Monday, Wednesday and Friday at 07:15, New York time");
    expect(cronSentence("0 9 * * 0", "UTC")?.text).toBe("Every Sunday at 09:00, UTC");
    expect(cronSentence("0 9 * * 7", "UTC")?.text).toBe("Every Sunday at 09:00, UTC");
  });

  it("F-106: falls back to the cron itself for what it has no words for, and says nothing for an invalid one", () => {
    expect(cronSentence("0,30 9 * * *", "Europe/Amsterdam")).toEqual({ text: "At 0,30 9 * * *, Amsterdam time", described: false });
    expect(cronSentence("0 */2 * * 1", "UTC")).toEqual({ text: "At 0 */2 * * 1, UTC", described: false });
    expect(cronSentence("0 9 1 1 1", "UTC")).toEqual({ text: "At 0 9 1 1 1, UTC", described: false });
    expect(cronSentence("0 25 * * *", "UTC")).toBeNull();
    expect(cronSentence("* * * *", "UTC")).toBeNull();
  });

  it("F-106: writes ordinals and zones as people read them", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "31st"]);
    expect(zoneWords("Etc/UTC")).toBe(", UTC");
    expect(zoneWords("America/Argentina/Buenos_Aires")).toBe(", Buenos Aires time");
  });
});
