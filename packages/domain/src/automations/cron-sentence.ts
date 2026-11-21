import { z } from "zod";

import { parseCron } from "./cron.ts";
import type { Cron } from "./cron.ts";

// A schedule's cron as a sentence (F-106; milestone 6's screen target `automation-edit.md`), so the
// editor, the list and the history say it the same way: "Every Monday at 09:00, Amsterdam time".
// The grammar is here, as a sentence's shape and its values; the panel words it through its message
// file (F-083). Times are 24-hour `HH:mm` in the schedule's own zone. An expression the grammar has
// no shape for is `cron` ("At {cron}, {city} time"), and its next occurrences carry the meaning.

/** The most times of day a sentence lists before it gives up. */
const TIMES_MAX = 4;
/** Monday first, as a week reads. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** Days of the week, 0 Sunday to 6 Saturday, Monday first; or `weekdays` for Monday to Friday. */
const cronWeekDaysSchema = z.union([z.literal("weekdays"), z.array(z.number().int().min(0).max(6))]);

/** Months, 1 to 12, or `null` for every month. */
const cronMonthsSchema = z.array(z.number().int().min(1).max(12)).nullable();

/** Times of day as `HH:mm`. */
const cronTimesSchema = z.array(z.string().regex(/^\d\d:\d\d$/));

/** When a schedule runs, as a sentence's shape and its values. */
export const cronWhenSchema = z.discriminatedUnion("kind", [
  /** "Every hour, on the hour" (minute 0), or "Every hour at :15". */
  z.strictObject({ kind: z.literal("hourly"), minute: z.number().int().min(0).max(59) }),
  /** "Every 2 hours at :30". */
  z.strictObject({ kind: z.literal("every-hours"), step: z.number().int().min(2), minute: z.number().int().min(0).max(59) }),
  /** "Every day at 09:00", or "Every day in January at 09:00". */
  z.strictObject({ kind: z.literal("daily"), times: cronTimesSchema, months: cronMonthsSchema }),
  /** "Every Monday and Wednesday at 09:00", "Every weekday at 09:00", or with its months. */
  z.strictObject({ kind: z.literal("weekly"), days: cronWeekDaysSchema, times: cronTimesSchema, months: cronMonthsSchema }),
  /** "On the 1st of every month at 09:00", or "On the 1st of January and July at 09:00". */
  z.strictObject({ kind: z.literal("monthly"), daysOfMonth: z.array(z.number().int().min(1).max(31)), times: cronTimesSchema, months: cronMonthsSchema }),
  /** "On the 1st of every month and every Monday at 09:00": either day field matching is enough. */
  z.strictObject({ kind: z.literal("monthly-or-weekly"), daysOfMonth: z.array(z.number().int().min(1).max(31)), days: cronWeekDaysSchema, times: cronTimesSchema }),
  /** No shape for it: "At {cron}". */
  z.strictObject({ kind: z.literal("cron"), source: z.string() }),
]);
export type CronWhen = z.infer<typeof cronWhenSchema>;

/** The zone a sentence ends with: ", UTC", or ", Amsterdam time" (the zone's last segment, `_` as spaces). */
export const cronZoneSchema = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("utc") }), z.strictObject({ kind: z.literal("city"), city: z.string() })]);
export type CronZone = z.infer<typeof cronZoneSchema>;

/** A schedule as a sentence: when, and in which zone. */
export const cronSentenceSchema = z.strictObject({ when: cronWhenSchema, zone: cronZoneSchema });
export type CronSentence = z.infer<typeof cronSentenceSchema>;

/** A zone as a sentence ends with it: UTC, or its city. */
export const cronZone = (timeZone: string): CronZone => {
  if (timeZone === "UTC" || timeZone === "Etc/UTC" || timeZone === "Etc/GMT") {
    return { kind: "utc" };
  }
  return { kind: "city", city: (timeZone.split("/").at(-1) ?? timeZone).replaceAll("_", " ") };
};

const two = (value: number): string => String(value).padStart(2, "0");

const sortedSet = (values: ReadonlySet<number>): number[] => [...values].sort((a, b) => a - b);

/** A step from the first value to the field's end (`*\/2`, `3-23/4`): its step, or `null`. */
const stepOf = (values: readonly number[], max: number): number | null => {
  const [first, second] = values;
  if (first === undefined || second === undefined) {
    return null;
  }
  const step = second - first;
  if (step < 2 || first >= step) {
    return null;
  }
  const expected: number[] = [];
  for (let value = first; value <= max; value += step) {
    expected.push(value);
  }
  return expected.length === values.length && expected.every((value, index) => values[index] === value) ? step : null;
};

const weekDaysOf = (days: ReadonlySet<number>): "weekdays" | number[] => {
  const ordered = WEEK_ORDER.filter((day) => days.has(day));
  return ordered.length === 5 && [1, 2, 3, 4, 5].every((day) => days.has(day)) ? "weekdays" : ordered;
};

/** The sentence's shape before its zone, or `null` when the grammar has none. */
const whenOf = (cron: Cron): Exclude<CronWhen, { readonly kind: "cron" }> | null => {
  const months = cron.months.size === 12 ? null : sortedSet(cron.months);
  const anyDay = cron.anyDayOfMonth && cron.anyDayOfWeek && months === null;
  const [minute] = cron.minutes;
  if (minute === undefined || cron.minutes.length !== 1) {
    return null;
  }
  // Within the day: every hour, or every few hours.
  if (cron.hours.length === 24) {
    return anyDay ? { kind: "hourly", minute } : null;
  }
  const step = stepOf(cron.hours, 23);
  if (step !== null) {
    return anyDay ? { kind: "every-hours", step, minute } : null;
  }
  if (cron.hours.length > TIMES_MAX) {
    return null;
  }
  const times = cron.hours.map((hour) => `${two(hour)}:${two(minute)}`);
  const daysOfMonth = sortedSet(cron.daysOfMonth);
  if (cron.anyDayOfMonth && cron.anyDayOfWeek) {
    return { kind: "daily", times, months };
  }
  if (cron.anyDayOfMonth) {
    return { kind: "weekly", days: weekDaysOf(cron.daysOfWeek), times, months };
  }
  if (cron.anyDayOfWeek) {
    return { kind: "monthly", daysOfMonth, times, months };
  }
  // Both day fields restricted: either one matching is enough (cron's rule, said out loud).
  return months === null ? { kind: "monthly-or-weekly", daysOfMonth, days: weekDaysOf(cron.daysOfWeek), times } : null;
};

/** A valid cron as a sentence in its zone, or `null` for one that doesn't parse. */
export const cronSentence = (source: string, timeZone: string): CronSentence | null => {
  const parsed = parseCron(source);
  if (!parsed.ok) {
    return null;
  }
  return { when: whenOf(parsed.cron) ?? { kind: "cron", source: parsed.cron.source }, zone: cronZone(timeZone) };
};

/** Whether the grammar had a shape for it, rather than the cron itself. */
export const cronDescribed = (sentence: CronSentence): boolean => sentence.when.kind !== "cron";
