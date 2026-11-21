import { describe, expect, it } from "vitest";

import { cronSentence } from "@ostra/domain";

import { cronSentenceText, ordinalText } from "./cron-words";

// The schedule's sentence in words (F-106, F-083): the domain's shape for each of the editor's
// examples (`automation-edit.md`), worded from the message file, with its zone.

const words = (cron: string, timeZone: string): string | null => {
  const sentence = cronSentence(cron, timeZone);
  return sentence === null ? null : cronSentenceText(sentence);
};

describe("the cron sentence in words", () => {
  it("F-106/c1: says each of the editor's examples in its zone's words", () => {
    const table: readonly (readonly [string, string])[] = [
      ["0 * * * *", "Every hour, on the hour"],
      ["15 * * * *", "Every hour at :15"],
      ["30 */2 * * *", "Every 2 hours at :30"],
      ["0 9 * * *", "Every day at 09:00"],
      ["0 9 * 1 *", "Every day in January at 09:00"],
      ["0 9 * * 1-5", "Every weekday at 09:00"],
      ["0 9 * * 1", "Every Monday at 09:00"],
      ["0 9 * * 1,3", "Every Monday and Wednesday at 09:00"],
      ["0 9 * 6 1", "Every Monday in June at 09:00"],
      ["0 9,17 * * *", "Every day at 09:00 and 17:00"],
      ["0 9 1 * *", "On the 1st of every month at 09:00"],
      ["0 9 1 1,7 *", "On the 1st of January and July at 09:00"],
      ["0 9 1 * 1", "On the 1st of every month and every Monday at 09:00"],
    ];
    for (const [cron, sentence] of table) {
      expect(words(cron, "UTC"), cron).toBe(`${sentence}, UTC`);
    }
    expect(words("0 9 * * 1", "Europe/Amsterdam")).toBe("Every Monday at 09:00, Amsterdam time");
    expect(words("15 7 * * 1,3,5", "America/New_York")).toBe("Every Monday, Wednesday and Friday at 07:15, New York time");
    expect(words("0 9 * * 0", "UTC")).toBe("Every Sunday at 09:00, UTC");
    expect(words("0 9 * * 7", "UTC")).toBe("Every Sunday at 09:00, UTC");
    expect(words("0,30 9 * * *", "Europe/Amsterdam")).toBe("At 0,30 9 * * *, Amsterdam time");
    expect(words("0 9 * * 1", "America/Argentina/Buenos_Aires")).toBe("Every Monday at 09:00, Buenos Aires time");
  });

  it("F-106: writes ordinals as people read them", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinalText)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "31st"]);
  });
});
