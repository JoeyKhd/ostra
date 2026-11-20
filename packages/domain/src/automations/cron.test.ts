import { describe, expect, it } from "vitest";

import { instantOfWallClock, isTimeZone, minimumIntervalOk, nextOccurrence, occurrencesBetween, parseCron, planOccurrences, wallClockOf } from "./cron.ts";
import type { Cron } from "./cron.ts";

// The schedule's evaluator (F-106, ADR 0056, spec section 8): parsed and run over a year of minutes
// in three zones, against a reference the test computes another way, minute by minute; and the
// daylight-saving days against a list written out by hand.

const MINUTE = 60_000;
const HOUR = 3_600_000;
const zones = ["UTC", "Europe/Amsterdam", "America/New_York"] as const;

const cron = (source: string): Cron => {
  const parsed = parseCron(source);
  if (!parsed.ok) {
    throw new Error(parsed.reason);
  }
  return parsed.cron;
};

/** The reference: the local fields of a wall-clock reading, and the cron's match on them, written plainly. */
const fieldsOf = (wall: number) => {
  const date = new Date(wall);
  return { minute: date.getUTCMinutes(), hour: date.getUTCHours(), day: date.getUTCDate(), month: date.getUTCMonth() + 1, weekday: date.getUTCDay() };
};

const referenceMatches = (c: Cron, wall: number): boolean => {
  const f = fieldsOf(wall);
  if (!c.minutes.includes(f.minute) || !c.hours.includes(f.hour) || !c.months.has(f.month)) {
    return false;
  }
  const dom = c.daysOfMonth.has(f.day);
  const dow = c.daysOfWeek.has(f.weekday);
  return c.anyDayOfMonth || c.anyDayOfWeek ? dom && dow : dom || dow;
};

/**
 * Every occurrence in `(from, to]`, found minute by minute: a UTC minute fires when its wall clock
 * matches and no earlier minute showed the same wall clock (a repeated hour fires once); and the
 * first minute after a jump forward fires when any wall-clock minute the jump skipped matches.
 */
const reference = (c: Cron, zone: string, from: number, to: number): readonly number[] => {
  const found: number[] = [];
  // The offset changes on the hour in these three zones: read it once an hour.
  let hourStart = Number.NaN;
  let offset = 0;
  const wallAt = (instant: number): number => {
    const hour = Math.floor(instant / HOUR) * HOUR;
    if (hour !== hourStart) {
      hourStart = hour;
      offset = wallClockOf(hour, zone) - hour;
    }
    return instant + offset;
  };
  let previousWall = wallAt(from);
  let highestWall = previousWall;
  for (let instant = from + MINUTE; instant <= to; instant += MINUTE) {
    const wall = wallAt(instant);
    let fires = wall > highestWall && referenceMatches(c, wall);
    if (!fires && wall - previousWall > MINUTE) {
      for (let skipped = previousWall + MINUTE; skipped < wall; skipped += MINUTE) {
        if (referenceMatches(c, skipped)) {
          fires = true;
          break;
        }
      }
    }
    if (fires) {
      found.push(instant);
    }
    previousWall = wall;
    highestWall = Math.max(highestWall, wall);
  }
  return found;
};

const iso = (instant: number): string => new Date(instant).toISOString().replace(":00.000Z", "Z");

describe("the cron evaluator", () => {
  it("F-106/c1: parses five fields with ranges, steps, lists and names, and refuses seconds, L, W and #", () => {
    const c = cron("0,30 9-17/2 1,15 jan-mar,DEC mon-fri");
    expect(c.minutes).toEqual([0, 30]);
    expect(c.hours).toEqual([9, 11, 13, 15, 17]);
    expect([...c.daysOfMonth].sort((a, b) => a - b)).toEqual([1, 15]);
    expect([...c.months].sort((a, b) => a - b)).toEqual([1, 2, 3, 12]);
    expect([...c.daysOfWeek].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect([...cron("0 0 * * 7").daysOfWeek]).toEqual([0]);
    expect(cron("5/20 * * * *").minutes).toEqual([5, 25, 45]);
    for (const bad of ["", "* * * *", "0 0 * * * *", "0 0 L * *", "0 0 * * 1#2", "0 0 15W * *", "60 * * * *", "0 24 * * *", "0 0 0 * *", "0 0 * 13 *", "*/0 * * * *", "5-1 * * * *", "0 0 * * funday"]) {
      expect(parseCron(bad).ok, bad).toBe(false);
    }
  });

  it("knows a zone, and refuses one Intl doesn't", () => {
    for (const zone of zones) {
      expect(isTimeZone(zone)).toBe(true);
    }
    expect(isTimeZone("Mars/Olympus_Mons")).toBe(false);
  });

  const yearFrom = Date.UTC(2026, 0, 1);
  const yearTo = Date.UTC(2027, 0, 1);
  const expressions = ["30 2 * * *", "0 * * * *", "30 1 * * *", "0 */6 * * 1-5", "15 9 1,15 * *", "0 0 * * sun", "0 3 * * *", "45 2 * mar,nov 0"];

  // A year minute by minute, eight expressions: a few seconds alone, more on a busy CI machine (run 44743811978).
  const YEAR_TIMEOUT_MS = 60_000;

  const matchesReference = (zone: (typeof zones)[number]): void => {
    for (const source of expressions) {
      const c = cron(source);
      expect(occurrencesBetween(c, zone, yearFrom, yearTo, 20_000), `${source} in ${zone}`).toEqual(reference(c, zone, yearFrom, yearTo));
    }
  };

  it("F-106/c1: matches the minute-by-minute reference over a year in UTC, across both daylight-saving changes", () => {
    matchesReference("UTC");
  }, YEAR_TIMEOUT_MS);

  it("F-106/c1: matches the minute-by-minute reference over a year in Europe/Amsterdam, across both daylight-saving changes", () => {
    matchesReference("Europe/Amsterdam");
  }, YEAR_TIMEOUT_MS);

  it("F-106/c1: matches the minute-by-minute reference over a year in America/New_York, across both daylight-saving changes", () => {
    matchesReference("America/New_York");
  }, YEAR_TIMEOUT_MS);

  it("F-106/c1: a skipped local time fires at the next valid minute, and a repeated hour fires once", () => {
    const daily = cron("30 2 * * *");
    const hourly = cron("0 * * * *");
    // Amsterdam, 29 March 2026: 02:00 local jumps to 03:00. 02:30 doesn't exist; it fires at 03:00 local (01:00Z).
    expect(occurrencesBetween(daily, "Europe/Amsterdam", Date.UTC(2026, 2, 28, 12), Date.UTC(2026, 2, 30, 12)).map(iso)).toEqual([
      "2026-03-29T01:00Z",
      "2026-03-30T00:30Z",
    ]);
    // Amsterdam, 25 October 2026: 03:00 local falls back to 02:00, so 02:30 happens twice. It fires once, at the first.
    expect(occurrencesBetween(daily, "Europe/Amsterdam", Date.UTC(2026, 9, 24, 12), Date.UTC(2026, 9, 26, 12)).map(iso)).toEqual([
      "2026-10-25T00:30Z",
      "2026-10-26T01:30Z",
    ]);
    // New York, 8 March 2026: 02:00 jumps to 03:00. 02:30 fires at 03:00 EDT (07:00Z).
    expect(occurrencesBetween(daily, "America/New_York", Date.UTC(2026, 2, 7, 12), Date.UTC(2026, 2, 9, 12)).map(iso)).toEqual([
      "2026-03-08T07:00Z",
      "2026-03-09T06:30Z",
    ]);
    // New York, 1 November 2026: 02:00 falls back to 01:00. Every hour fires once: 24 local hours in 25 real ones.
    const fallDay = occurrencesBetween(hourly, "America/New_York", Date.UTC(2026, 10, 1, 4) - 1, Date.UTC(2026, 10, 2, 5) - 1);
    expect(fallDay).toHaveLength(24);
    expect(fallDay.map(iso).slice(0, 4)).toEqual(["2026-11-01T04:00Z", "2026-11-01T05:00Z", "2026-11-01T07:00Z", "2026-11-01T08:00Z"]);
    // The spring day has 23 local hours: the skipped 02:00 and 03:00 are one occurrence.
    expect(occurrencesBetween(hourly, "America/New_York", Date.UTC(2026, 2, 8, 5) - 1, Date.UTC(2026, 2, 9, 4) - 1)).toHaveLength(23);
  });

  it("maps a wall-clock minute to its instant: the first of a repeated one, the gap's end for a skipped one", () => {
    expect(iso(instantOfWallClock(Date.UTC(2026, 9, 25, 2, 30), "Europe/Amsterdam"))).toBe("2026-10-25T00:30Z");
    expect(iso(instantOfWallClock(Date.UTC(2026, 2, 29, 2, 30), "Europe/Amsterdam"))).toBe("2026-03-29T01:00Z");
    expect(iso(instantOfWallClock(Date.UTC(2026, 5, 1, 12, 0), "America/New_York"))).toBe("2026-06-01T16:00Z");
  });

  it("answers null for an expression that never fires", () => {
    expect(nextOccurrence(cron("0 0 30 2 *"), "UTC", Date.UTC(2026, 0, 1))).toBeNull();
    expect(iso(nextOccurrence(cron("0 0 29 2 *"), "UTC", Date.UTC(2026, 0, 1)) ?? 0)).toBe("2028-02-29T00:00Z");
  });

  it("F-106/c7: holds a schedule to the minimum interval", () => {
    expect(minimumIntervalOk(cron("0 * * * *"), 60, "UTC")).toBe(true);
    expect(minimumIntervalOk(cron("30 * * * *"), 60, "UTC")).toBe(true);
    expect(minimumIntervalOk(cron("*/30 * * * *"), 60, "UTC")).toBe(false);
    expect(minimumIntervalOk(cron("0,59 * * * *"), 60, "UTC")).toBe(false);
    expect(minimumIntervalOk(cron("0 9 * * 1"), 60, "UTC")).toBe(true);
    // The 31st and the 1st at midnight are a day apart; 23:30 and 00:15 are 45 minutes apart.
    expect(minimumIntervalOk(cron("0 0 31,1 * *"), 24 * 60, "UTC")).toBe(true);
    expect(minimumIntervalOk(cron("15,30 0,23 * * *"), 60, "UTC")).toBe(false);
    // At one minute (the hunt's every-minute schedules, ticket 37) every schedule passes at once.
    expect(minimumIntervalOk(cron("* * * * *"), 1, "UTC")).toBe(true);
    expect(minimumIntervalOk(cron("* * * * *"), 2, "UTC")).toBe(false);
  });

  it("F-106/c1: holds a schedule to the minimum interval as it fires in its zone, across a daylight-saving change", () => {
    // 01:30 and 02:30 are an hour apart on the wall clock, but on the spring-forward day 02:30
    // doesn't exist and fires at 03:00, half an hour after 01:30.
    expect(minimumIntervalOk(cron("30 1,2 * * *"), 60, "UTC")).toBe(true);
    expect(minimumIntervalOk(cron("30 1,2 * * *"), 60, "America/New_York")).toBe(false);
    expect(minimumIntervalOk(cron("30 1,2 * * *"), 60, "Europe/Amsterdam")).toBe(false);
    // Tokyo keeps no daylight saving: the same pattern stays an hour apart there.
    expect(minimumIntervalOk(cron("30 1,2 * * *"), 60, "Asia/Tokyo")).toBe(true);
    // Hourly and daily schedules stay an hour apart in every zone.
    for (const zone of ["UTC", "Europe/Amsterdam", "America/New_York"]) {
      expect(minimumIntervalOk(cron("0 * * * *"), 60, zone)).toBe(true);
      expect(minimumIntervalOk(cron("0 9 * * *"), 60, zone)).toBe(true);
    }
  });

  it("F-106/c5: fires the latest missed occurrence under 6 hours late, and skips the older ones", () => {
    const hourly = cron("0 * * * *");
    const since = Date.UTC(2026, 4, 1, 0);
    // A normal tick: one occurrence, seconds late.
    expect(planOccurrences({ cron: hourly, timeZone: "UTC", since, now: since + HOUR + 5_000, missedHours: 6 })).toEqual({
      fire: since + HOUR,
      missed: [],
      missedCount: 0,
      next: since + 2 * HOUR,
    });
    // Down for 10 hours: the latest fires, the 9 before it are missed.
    const back = planOccurrences({ cron: hourly, timeZone: "UTC", since, now: since + 10 * HOUR + 30 * MINUTE, missedHours: 6 });
    expect(back.fire).toBe(since + 10 * HOUR);
    expect(back.missed).toHaveLength(9);
    expect(back.missedCount).toBe(9);
    // A daily one 7 hours late is missed too, and nothing fires.
    const daily = planOccurrences({ cron: cron("0 2 * * *"), timeZone: "UTC", since, now: since + 9 * HOUR, missedHours: 6 });
    expect(daily.fire).toBeNull();
    expect(daily.missed).toEqual([since + 2 * HOUR]);
    // Down for months: the missed are counted, at most 50 named.
    const months = planOccurrences({ cron: hourly, timeZone: "UTC", since, now: since + 90 * 24 * HOUR + MINUTE, missedHours: 6 });
    expect(months.missed).toHaveLength(50);
    expect(months.missedCount).toBe(90 * 24 - 1);
  });
});
