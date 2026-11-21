import { describe, expect, it } from "vitest";

import { cronDescribed, cronSentence, cronZone } from "./cron-sentence.ts";
import type { CronWhen } from "./cron-sentence.ts";

// The schedule's sentence (F-106): the grammar of milestone 6's screen target `automation-edit.md`,
// each row of its table as a sentence's shape, the zone, and the fallback for an expression it has
// no shape for. The panel words them (`apps/web`'s `cron-words.test.ts` has the table's words).

describe("the cron sentence", () => {
  it("F-106/c1: gives each of the editor's examples its sentence's shape, in its zone", () => {
    const table: readonly (readonly [string, CronWhen])[] = [
      ["0 * * * *", { kind: "hourly", minute: 0 }],
      ["30 */2 * * *", { kind: "every-hours", step: 2, minute: 30 }],
      ["0 9 * * *", { kind: "daily", times: ["09:00"], months: null }],
      ["0 9 * * 1-5", { kind: "weekly", days: "weekdays", times: ["09:00"], months: null }],
      ["0 9 * * 1", { kind: "weekly", days: [1], times: ["09:00"], months: null }],
      ["0 9 * * 1,3", { kind: "weekly", days: [1, 3], times: ["09:00"], months: null }],
      ["0 9,17 * * *", { kind: "daily", times: ["09:00", "17:00"], months: null }],
      ["0 9 1 * *", { kind: "monthly", daysOfMonth: [1], times: ["09:00"], months: null }],
      ["0 9 1 1,7 *", { kind: "monthly", daysOfMonth: [1], times: ["09:00"], months: [1, 7] }],
      ["0 9 1 * 1", { kind: "monthly-or-weekly", daysOfMonth: [1], days: [1], times: ["09:00"] }],
    ];
    for (const [cron, when] of table) {
      expect(cronSentence(cron, "UTC"), cron).toEqual({ when, zone: { kind: "utc" } });
    }
    expect(cronSentence("0 9 * * 1", "Europe/Amsterdam")).toEqual({ when: { kind: "weekly", days: [1], times: ["09:00"], months: null }, zone: { kind: "city", city: "Amsterdam" } });
    expect(cronSentence("15 7 * * 1,3,5", "America/New_York")).toEqual({ when: { kind: "weekly", days: [1, 3, 5], times: ["07:15"], months: null }, zone: { kind: "city", city: "New York" } });
    // Sunday ends the week, as 0 or 7.
    expect(cronSentence("0 9 * * 0,1", "UTC")?.when).toEqual({ kind: "weekly", days: [1, 0], times: ["09:00"], months: null });
    expect(cronSentence("0 9 * * 7", "UTC")?.when).toEqual({ kind: "weekly", days: [0], times: ["09:00"], months: null });
  });

  it("F-106: falls back to the cron itself for what it has no shape for, and says nothing for an invalid one", () => {
    const fallback = cronSentence("0,30 9 * * *", "Europe/Amsterdam");
    expect(fallback).toEqual({ when: { kind: "cron", source: "0,30 9 * * *" }, zone: { kind: "city", city: "Amsterdam" } });
    expect(fallback === null ? null : cronDescribed(fallback)).toBe(false);
    expect(cronSentence("0 */2 * * 1", "UTC")?.when).toEqual({ kind: "cron", source: "0 */2 * * 1" });
    expect(cronSentence("0 9 1 1 1", "UTC")?.when).toEqual({ kind: "cron", source: "0 9 1 1 1" });
    expect(cronSentence("0 25 * * *", "UTC")).toBeNull();
    expect(cronSentence("* * * *", "UTC")).toBeNull();
  });

  it("F-106: names a zone by UTC or by its city", () => {
    expect(cronZone("Etc/UTC")).toEqual({ kind: "utc" });
    expect(cronZone("America/Argentina/Buenos_Aires")).toEqual({ kind: "city", city: "Buenos Aires" });
  });
});
