import { parseCron } from "./cron.ts";
import type { Cron } from "./cron.ts";

// A schedule's cron as a sentence (F-106; milestone 6's screen target `automation-edit.md`), so the
// editor, the list and the history say it the same way: "Every Monday at 09:00, Amsterdam time".
// Times are 24-hour `HH:mm` in the schedule's own zone. An expression the grammar has no sentence for
// reads "At {cron}, {city} time", and its next occurrences carry the meaning.

const DAY_WORDS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTH_WORDS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
/** Monday first, as a week reads. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
/** The most times of day a sentence lists before it gives up. */
const TIMES_MAX = 4;

/** "A", "A and B", "A, B and C". */
const listWords = (words: readonly string[]): string => {
  if (words.length <= 1) {
    return words.join("");
  }
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1) ?? ""}`;
};

const two = (value: number): string => String(value).padStart(2, "0");

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st, 22nd, 23rd, 31st. */
export const ordinal = (day: number): string => {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) {
    return `${String(day)}th`;
  }
  switch (day % 10) {
    case 1:
      return `${String(day)}st`;
    case 2:
      return `${String(day)}nd`;
    case 3:
      return `${String(day)}rd`;
    default:
      return `${String(day)}th`;
  }
};

/** ", UTC" or ", Amsterdam time": the zone's last segment, `_` as spaces. */
export const zoneWords = (timeZone: string): string => {
  if (timeZone === "UTC" || timeZone === "Etc/UTC" || timeZone === "Etc/GMT") {
    return ", UTC";
  }
  const city = (timeZone.split("/").at(-1) ?? timeZone).replaceAll("_", " ");
  return `, ${city} time`;
};

const sortedSet = (values: ReadonlySet<number>): readonly number[] => [...values].sort((a, b) => a - b);

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

const daysOfWeekWords = (days: ReadonlySet<number>): string => {
  const ordered = WEEK_ORDER.filter((day) => days.has(day));
  if (ordered.length === 5 && [1, 2, 3, 4, 5].every((day) => days.has(day))) {
    return "weekday";
  }
  return listWords(ordered.map((day) => DAY_WORDS[day]));
};

const monthsWords = (months: ReadonlySet<number>): string => listWords(sortedSet(months).map((month) => MONTH_WORDS[month - 1] ?? String(month)));

/** The sentence's body before its zone, or `null` when the grammar has none. */
const bodyOf = (cron: Cron): string | null => {
  const allMonths = cron.months.size === 12;
  const anyDay = cron.anyDayOfMonth && cron.anyDayOfWeek && allMonths;
  const [minute] = cron.minutes;
  if (minute === undefined || cron.minutes.length !== 1) {
    return null;
  }
  // Within the day: every hour, or every few hours.
  if (cron.hours.length === 24) {
    return anyDay ? (minute === 0 ? "Every hour, on the hour" : `Every hour at :${two(minute)}`) : null;
  }
  const step = stepOf(cron.hours, 23);
  if (step !== null) {
    return anyDay ? `Every ${String(step)} hours at :${two(minute)}` : null;
  }
  if (cron.hours.length > TIMES_MAX) {
    return null;
  }
  const at = `at ${listWords(cron.hours.map((hour) => `${two(hour)}:${two(minute)}`))}`;
  const daysOfMonth = listWords(sortedSet(cron.daysOfMonth).map(ordinal));
  if (cron.anyDayOfMonth && cron.anyDayOfWeek) {
    return allMonths ? `Every day ${at}` : `Every day in ${monthsWords(cron.months)} ${at}`;
  }
  if (cron.anyDayOfMonth) {
    const days = daysOfWeekWords(cron.daysOfWeek);
    return allMonths ? `Every ${days} ${at}` : `Every ${days} in ${monthsWords(cron.months)} ${at}`;
  }
  if (cron.anyDayOfWeek) {
    return allMonths ? `On the ${daysOfMonth} of every month ${at}` : `On the ${daysOfMonth} of ${monthsWords(cron.months)} ${at}`;
  }
  // Both day fields restricted: either one matching is enough (cron's rule, said out loud).
  return allMonths ? `On the ${daysOfMonth} of every month and every ${daysOfWeekWords(cron.daysOfWeek)} ${at}` : null;
};

export type CronSentence = {
  /** The sentence with its zone: "Every Monday at 09:00, Amsterdam time". */
  readonly text: string;
  /** `false` when the grammar had no sentence and `text` is "At {cron}, {city} time". */
  readonly described: boolean;
};

/** A valid cron as a sentence in its zone, or `null` for one that doesn't parse. */
export const cronSentence = (source: string, timeZone: string): CronSentence | null => {
  const parsed = parseCron(source);
  if (!parsed.ok) {
    return null;
  }
  const body = bodyOf(parsed.cron);
  return body === null ? { text: `At ${parsed.cron.source}${zoneWords(timeZone)}`, described: false } : { text: `${body}${zoneWords(timeZone)}`, described: true };
};
