import type { CronSentence, CronWhen } from "@ostra/domain";

import { t } from "@/lib/messages";

// A schedule's sentence in words (F-106, F-083): the domain gives its shape and values
// ("weekly, Monday, 09:00, Amsterdam"), and this words it from the message file: "Every Monday at
// 09:00, Amsterdam time". Day and month names, lists and ordinals follow the panel's locale.

const LOCALE = "en-GB";

/** "A", "A and B", "A, B and C". */
const listText = (words: readonly string[]): string => new Intl.ListFormat(LOCALE, { style: "long", type: "conjunction" }).format(words);

/** A day of the week by its name: 0 Sunday to 6 Saturday. 2026-11-15 was a Sunday. */
const dayName = (day: number): string => new Intl.DateTimeFormat(LOCALE, { weekday: "long", timeZone: "UTC" }).format(Date.UTC(2026, 10, 15 + day));

/** A month by its name: 1 January to 12 December. */
const monthName = (month: number): string => new Intl.DateTimeFormat(LOCALE, { month: "long", timeZone: "UTC" }).format(Date.UTC(2026, month - 1, 15));

const ordinalRules = new Intl.PluralRules(LOCALE, { type: "ordinal" });

/** 1st, 2nd, 3rd, 4th, 11th, 21st, … */
export const ordinalText = (n: number): string => {
  const form = ordinalRules.select(n);
  switch (form) {
    case "one":
    case "two":
    case "few":
      return t(`automations.cron.ordinal.${form}`, { n });
    case "zero":
    case "many":
    case "other":
      return t("automations.cron.ordinal.other", { n });
    default:
      return form satisfies never;
  }
};

const daysText = (days: "weekdays" | readonly number[]): string => (days === "weekdays" ? t("automations.cron.weekday") : listText(days.map(dayName)));

const minuteText = (minute: number): string => String(minute).padStart(2, "0");

/** When a schedule runs, before its zone: "Every Monday at 09:00". */
const whenText = (when: CronWhen): string => {
  switch (when.kind) {
    case "hourly":
      return when.minute === 0 ? t("automations.cron.hourlyOnTheHour") : t("automations.cron.hourlyAt", { minute: minuteText(when.minute) });
    case "every-hours":
      return t("automations.cron.everyHours", { step: when.step, minute: minuteText(when.minute) });
    case "daily":
      return when.months === null
        ? t("automations.cron.daily", { times: listText(when.times) })
        : t("automations.cron.dailyIn", { months: listText(when.months.map(monthName)), times: listText(when.times) });
    case "weekly":
      return when.months === null
        ? t("automations.cron.weekly", { days: daysText(when.days), times: listText(when.times) })
        : t("automations.cron.weeklyIn", { days: daysText(when.days), months: listText(when.months.map(monthName)), times: listText(when.times) });
    case "monthly":
      return when.months === null
        ? t("automations.cron.monthly", { daysOfMonth: listText(when.daysOfMonth.map(ordinalText)), times: listText(when.times) })
        : t("automations.cron.monthlyIn", { daysOfMonth: listText(when.daysOfMonth.map(ordinalText)), months: listText(when.months.map(monthName)), times: listText(when.times) });
    case "monthly-or-weekly":
      return t("automations.cron.monthlyOrWeekly", { daysOfMonth: listText(when.daysOfMonth.map(ordinalText)), days: daysText(when.days), times: listText(when.times) });
    case "cron":
      return t("automations.cron.raw", { cron: when.source });
    default:
      return when satisfies never;
  }
};

/** A schedule's sentence with its zone: "Every Monday at 09:00, Amsterdam time". */
export const cronSentenceText = (sentence: CronSentence): string => {
  const when = whenText(sentence.when);
  switch (sentence.zone.kind) {
    case "utc":
      return t("automations.cron.inUtc", { when });
    case "city":
      return t("automations.cron.inCity", { when, city: sentence.zone.city });
    default:
      return sentence.zone satisfies never;
  }
};
