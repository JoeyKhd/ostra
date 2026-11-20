// A schedule's cron expression (F-106, ADR 0056, Q211): five fields in an IANA time zone, evaluated
// by ostra's own code on `Intl`, with no dependency. Ranges, steps, lists and names; no seconds and
// no `L`, `W` or `#`. A local time the zone skips (the spring change) fires at the next valid
// minute, and a local time the zone repeats (the autumn change) fires once, at its first instant.
// Every function is pure: the clock is the caller's.

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** One field's bounds and its names. */
type FieldSpec = { readonly name: string; readonly min: number; readonly max: number; readonly names?: readonly string[] };

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

const FIELDS: readonly FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES },
  // 0 and 7 are both Sunday, as in every cron.
  { name: "day of week", min: 0, max: 7, names: DAY_NAMES },
];

/** A parsed expression: each field's allowed values, and whether the day fields were restricted. */
export type Cron = {
  readonly source: string;
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  /** 0 to 6, Sunday 0. */
  readonly daysOfWeek: ReadonlySet<number>;
  /** `*` in the day-of-month field. */
  readonly anyDayOfMonth: boolean;
  /** `*` in the day-of-week field. */
  readonly anyDayOfWeek: boolean;
};

export type CronParse = { readonly ok: true; readonly cron: Cron } | { readonly ok: false; readonly reason: string };

/** The longest expression ostra stores. */
export const CRON_MAX_CHARS = 200;

const parseValue = (text: string, spec: FieldSpec): number | null => {
  if (/^\d{1,2}$/.test(text)) {
    return Number(text);
  }
  const index = spec.names?.indexOf(text.toLowerCase()) ?? -1;
  if (index === -1) {
    return null;
  }
  return spec.name === "month" ? index + 1 : index;
};

const parseField = (text: string, spec: FieldSpec): { readonly values: ReadonlySet<number>; readonly any: boolean } | string => {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const [range = "", stepText, extra] = part.split("/");
    if (extra !== undefined || range === "") {
      return `the ${spec.name} field "${text}" isn't a valid list, range or step`;
    }
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d{1,2}$/.test(stepText) || Number(stepText) === 0) {
        return `the ${spec.name} field's step "${stepText}" isn't a whole number from 1`;
      }
      step = Number(stepText);
    }
    let start: number;
    let end: number;
    if (range === "*") {
      start = spec.min;
      end = spec.max === 7 ? 6 : spec.max;
    } else {
      const [fromText = "", toText, more] = range.split("-");
      if (more !== undefined) {
        return `the ${spec.name} field's range "${range}" has more than two ends`;
      }
      const from = parseValue(fromText, spec);
      const to = toText === undefined ? (stepText === undefined ? from : spec.max) : parseValue(toText, spec);
      if (from === null || to === null) {
        return `the ${spec.name} field's "${range}" isn't a number or a name it takes (L, W and # aren't supported)`;
      }
      if (from < spec.min || to > spec.max || from > to) {
        return `the ${spec.name} field's "${range}" is outside ${String(spec.min)} to ${String(spec.max)}`;
      }
      start = from;
      end = to;
    }
    for (let value = start; value <= end; value += step) {
      values.add(spec.max === 7 && value === 7 ? 0 : value);
    }
  }
  return { values, any: text === "*" };
};

const sorted = (values: ReadonlySet<number>): readonly number[] => [...values].sort((a, b) => a - b);

/** Parses a five-field expression. Its words name the field that's wrong, never more. */
export const parseCron = (source: string): CronParse => {
  const text = source.trim();
  if (text.length === 0 || text.length > CRON_MAX_CHARS) {
    return { ok: false, reason: `a schedule is one to ${String(CRON_MAX_CHARS)} characters` };
  }
  const parts = text.split(/\s+/);
  if (parts.length !== FIELDS.length) {
    return { ok: false, reason: "a schedule has five fields: minute, hour, day of month, month and day of week (no seconds)" };
  }
  const parsed: { readonly values: ReadonlySet<number>; readonly any: boolean }[] = [];
  for (const [index, spec] of FIELDS.entries()) {
    const field = parseField(parts[index] ?? "", spec);
    if (typeof field === "string") {
      return { ok: false, reason: field };
    }
    parsed.push(field);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parsed;
  if (minute === undefined || hour === undefined || dayOfMonth === undefined || month === undefined || dayOfWeek === undefined) {
    return { ok: false, reason: "a schedule has five fields" };
  }
  return {
    ok: true,
    cron: {
      source: text,
      minutes: sorted(minute.values),
      hours: sorted(hour.values),
      daysOfMonth: dayOfMonth.values,
      months: month.values,
      daysOfWeek: dayOfWeek.values,
      anyDayOfMonth: dayOfMonth.any,
      anyDayOfWeek: dayOfWeek.any,
    },
  };
};

/**
 * Whether a calendar day matches: its month, and its day of month or day of week. When both day
 * fields are restricted, either one matching is enough, as in every cron since Vixie's.
 */
export const dayMatches = (cron: Cron, year: number, month: number, day: number): boolean => {
  if (!cron.months.has(month)) {
    return false;
  }
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const byMonthDay = cron.daysOfMonth.has(day);
  const byWeekday = cron.daysOfWeek.has(weekday);
  if (cron.anyDayOfMonth || cron.anyDayOfWeek) {
    return byMonthDay && byWeekday;
  }
  return byMonthDay || byWeekday;
};

// ---------- the zone ----------

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  const known = formatters.get(timeZone);
  if (known !== undefined) {
    return known;
  }
  const made = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  });
  formatters.set(timeZone, made);
  return made;
};

/** Whether `Intl` knows the zone, as a schedule's `timeZone` must be. */
export const isTimeZone = (timeZone: string): boolean => {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
};

/** An instant's wall-clock time in the zone, as the UTC milliseconds of the same fields (seconds dropped). */
export const wallClockOf = (instant: number, timeZone: string): number => {
  const fields = { year: 0, month: 0, day: 0, hour: 0, minute: 0 };
  for (const part of formatterFor(timeZone).formatToParts(new Date(instant))) {
    if (part.type === "year" || part.type === "month" || part.type === "day" || part.type === "hour" || part.type === "minute") {
      fields[part.type] = Number(part.value);
    }
  }
  return Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute);
};

const QUARTER_MS = 15 * MINUTE_MS;
const offsets = new Map<string, number>();
const OFFSETS_KEPT = 200_000;

/**
 * The zone's offset at an instant, in ms (local minus UTC). Every zone changes its offset on a
 * quarter hour, so it's read once per quarter hour and kept.
 */
const offsetAt = (instant: number, timeZone: string): number => {
  const quarter = Math.floor(instant / QUARTER_MS) * QUARTER_MS;
  const key = `${timeZone}|${String(quarter)}`;
  const known = offsets.get(key);
  if (known !== undefined) {
    return known;
  }
  if (offsets.size >= OFFSETS_KEPT) {
    offsets.clear();
  }
  const offset = wallClockOf(quarter, timeZone) - quarter;
  offsets.set(key, offset);
  return offset;
};

/**
 * The instant a wall-clock minute happens in the zone: its first instant when the zone repeats it,
 * and the first valid minute after the gap when the zone skips it.
 */
export const instantOfWallClock = (wall: number, timeZone: string): number => {
  // The offsets around the time: a zone changes at most once in a day.
  const around = new Set([offsetAt(wall - DAY_MS / 2, timeZone), offsetAt(wall + DAY_MS / 2, timeZone)]);
  const exact = [...around].map((offset) => wall - offset).filter((instant) => wall === instant + offsetAt(instant, timeZone));
  if (exact.length > 0) {
    return Math.min(...exact);
  }
  // Skipped: the first minute whose wall clock is past it, found between the two readings.
  const candidates = [...around].map((offset) => wall - offset);
  let low = Math.min(...candidates);
  let high = Math.max(...candidates);
  while (high - low > MINUTE_MS) {
    const middle = low + Math.floor((high - low) / MINUTE_MS / 2) * MINUTE_MS;
    if (middle + offsetAt(middle, timeZone) > wall) {
      high = middle;
    } else {
      low = middle;
    }
  }
  return high;
};

// ---------- occurrences ----------

/** The most any zone moves its clock at once, with room to spare. */
const SHIFT_MAX_MS = 3 * 3_600_000;

/** How far ahead a search looks before it says the expression never fires (`0 0 30 2 *`). */
const SEARCH_YEARS = 8;

/**
 * The first occurrence strictly after `after`, in ms since the epoch, or `null` when the expression
 * never fires. The resolution is a minute.
 */
export const nextOccurrence = (cron: Cron, timeZone: string, after: number): number | null => {
  const startWall = wallClockOf(after, timeZone);
  // A few hours back on the wall clock, so a repeated hour's first instants and a gap's end are
  // seen from inside them: no zone moves its clock by more than that.
  const earliestWall = startWall - SHIFT_MAX_MS;
  const first = new Date(earliestWall);
  let year = first.getUTCFullYear();
  let month = first.getUTCMonth() + 1;
  let day = first.getUTCDate();
  const lastYear = year + SEARCH_YEARS;
  while (year <= lastYear) {
    if (dayMatches(cron, year, month, day)) {
      for (const hour of cron.hours) {
        for (const minute of cron.minutes) {
          const wall = Date.UTC(year, month - 1, day, hour, minute);
          if (wall < earliestWall) {
            continue;
          }
          const instant = instantOfWallClock(wall, timeZone);
          if (instant > after) {
            return instant;
          }
        }
      }
    }
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    year = next.getUTCFullYear();
    month = next.getUTCMonth() + 1;
    day = next.getUTCDate();
  }
  return null;
};

/** Every occurrence in `(from, to]`, oldest first, at most `limit` of them. */
export const occurrencesBetween = (cron: Cron, timeZone: string, from: number, to: number, limit = 10_000): readonly number[] => {
  const found: number[] = [];
  let cursor = from;
  while (found.length < limit) {
    const next = nextOccurrence(cron, timeZone, cursor);
    if (next === null || next > to) {
      break;
    }
    found.push(next);
    cursor = next;
  }
  return found;
};

/**
 * Whether consecutive occurrences are always at least `minutes` apart (`OSTRA_SCHEDULE_MIN_INTERVAL_MINUTES`),
 * on the wall clock: over a leap year and a month, which holds every pattern five fields can make.
 */
export const minimumIntervalOk = (cron: Cron, minutes: number): boolean => {
  // Two occurrences are always at least a minute apart: nothing to walk.
  if (minutes <= 1) {
    return true;
  }
  const from = Date.UTC(2028, 0, 1);
  const to = Date.UTC(2029, 1, 1);
  let previous: number | null = null;
  let cursor = from - MINUTE_MS;
  for (;;) {
    const next = nextOccurrence(cron, "UTC", cursor);
    if (next === null || next > to) {
      return true;
    }
    if (previous !== null && next - previous < minutes * MINUTE_MS) {
      return false;
    }
    previous = next;
    cursor = next;
  }
};

/** At most this many missed occurrences are named one by one; the rest are counted. */
export const MISSED_LISTED_MAX = 50;

/**
 * What a tick does with a schedule (ADR 0037, ADR 0056): the occurrences due in `(since, now]`. The
 * latest fires when it's under `missedHours` late (`OSTRA_SCHEDULE_MISSED_HOURS`); every older one,
 * and the latest when it's later than that, is missed: skipped and audited. `next` is the schedule's
 * next occurrence after `now`, for `nextOccurrenceAt`.
 */
export type OccurrencePlan = {
  readonly fire: number | null;
  readonly missed: readonly number[];
  readonly missedCount: number;
  readonly next: number | null;
};

export const planOccurrences = (input: {
  readonly cron: Cron;
  readonly timeZone: string;
  /** The last occurrence handled, or when the schedule was saved: nothing at or before it is due. */
  readonly since: number;
  readonly now: number;
  readonly missedHours: number;
}): OccurrencePlan => {
  const due: number[] = [];
  let missedCount = 0;
  let cursor = input.since;
  for (;;) {
    const next = nextOccurrence(input.cron, input.timeZone, cursor);
    if (next === null || next > input.now) {
      break;
    }
    due.push(next);
    if (due.length > MISSED_LISTED_MAX + 1) {
      due.shift();
      missedCount += 1;
    }
    cursor = next;
  }
  const latest = due.at(-1) ?? null;
  const fires = latest !== null && input.now - latest < input.missedHours * 3_600_000;
  const missed = fires ? due.slice(0, -1) : due;
  return {
    fire: fires ? latest : null,
    missed: missed.slice(-MISSED_LISTED_MAX),
    missedCount: missedCount + missed.length,
    next: nextOccurrence(input.cron, input.timeZone, input.now),
  };
};
