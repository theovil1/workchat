/**
 * A recurrence rule said in words, in the language of the interface: "Le 2e jeudi de chaque mois,
 * 10 fois". Shown under the repetition editor, so a rule can be checked at a glance, and on an
 * event's details.
 *
 * Each language writes whole sentences in its dictionary (`calendar.rule.*`), with the plurals
 * i18next picks by `count`: nothing is assembled word by word here, so a language whose grammar does
 * not follow French's (Polish cases, German word order) says it its own way. Lists of days and dates
 * come from `Intl`.
 *
 * Imports nothing at run time, so Node's test runner runs it as is (`rulePhrase.test.ts`).
 */

import type { RuleForm, Weekday } from "./rule";

/** The `t` of i18next, or anything that answers the same way. */
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

const DAY_KEYS: Record<Weekday, string> = {
  MO: "calendar.rule.mo",
  TU: "calendar.rule.tu",
  WE: "calendar.rule.we",
  TH: "calendar.rule.th",
  FR: "calendar.rule.fr",
  SA: "calendar.rule.sa",
  SU: "calendar.rule.su",
};

const NTH_KEYS = {
  1: "calendar.rule.nth1",
  2: "calendar.rule.nth2",
  3: "calendar.rule.nth3",
  4: "calendar.rule.nth4",
  [-1]: "calendar.rule.nthLast",
} as const;

function utcDate(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Say `form` for an event starting on `start` (`YYYY-MM-DD`). */
export function rulePhrase(form: RuleForm, start: string, locale: string, t: Translate): string {
  const count = form.interval;
  const dayName = (code: Weekday) => t(DAY_KEYS[code]);
  let rule: string;
  switch (form.freq) {
    case "DAILY":
      rule = t("calendar.rule.daily", { count });
      break;
    case "WEEKLY": {
      const workweek = form.days.join(",") === "MO,TU,WE,TH,FR";
      if (workweek && count === 1) {
        rule = t("calendar.rule.workdays");
        break;
      }
      const days = new Intl.ListFormat(locale, { type: "conjunction" }).format(
        form.days.map((code) => t("calendar.rule.onDay", { day: dayName(code) })),
      );
      rule = t("calendar.rule.weekly", { count, days });
      break;
    }
    case "MONTHLY": {
      const monthly = form.monthly;
      if (monthly.mode === "nth") {
        rule = t("calendar.rule.monthlyNth", { count, nth: t(NTH_KEYS[monthly.nth]), day: dayName(monthly.day) });
      } else if (monthly.mode === "lastWorkday") {
        rule = t("calendar.rule.lastWorkday", { count });
      } else {
        rule = t("calendar.rule.monthlyDay", { count, day: utcDate(start).getUTCDate() });
      }
      break;
    }
    case "YEARLY": {
      const date = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", timeZone: "UTC" }).format(utcDate(start));
      rule = t("calendar.rule.yearly", { count, date });
      break;
    }
  }
  const end = form.end;
  if (end.kind === "count") return t("calendar.rule.withEnd", { rule, end: t("calendar.rule.endCount", { count: end.count }) });
  if (end.kind === "until") {
    const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(utcDate(end.date));
    return t("calendar.rule.withEnd", { rule, end: t("calendar.rule.endUntil", { date }) });
  }
  return rule;
}
