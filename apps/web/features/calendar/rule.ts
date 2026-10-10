/**
 * Recurrence rules (RFC 5545 `RRULE` values, `FREQ=WEEKLY;BYDAY=MO`) and the form that edits them.
 *
 * The API stores the rule as is, so this module only has to read what the editor can show and write
 * it back the same way: `buildRule(parseRule(rule))` gives back `rule`. A rule the editor cannot
 * show (an imported one, say, with `BYWEEKNO`) reads as `null`, and the screen says "custom rule"
 * rather than showing it wrong.
 *
 * Imports nothing, so Node's test runner runs it as is (`rule.test.ts`).
 */

export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";
export const WEEKDAYS: readonly Weekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const WORKDAYS: readonly Weekday[] = ["MO", "TU", "WE", "TH", "FR"];

export type Frequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

/** How a monthly rule picks its day: the start's day of the month, "the 2nd Thursday", or the last
 *  working day. */
export type MonthlyMode = { mode: "day" } | { mode: "nth"; nth: 1 | 2 | 3 | 4 | -1; day: Weekday } | { mode: "lastWorkday" };

export type RuleEnd = { kind: "never" } | { kind: "count"; count: number } | { kind: "until"; date: string };

export type RuleForm = {
  freq: Frequency;
  interval: number;
  /** The days of a weekly rule, Monday first. */
  days: Weekday[];
  monthly: MonthlyMode;
  end: RuleEnd;
};

/** The quick choices of the screen. */
export type Preset = "none" | "daily" | "workdays" | "weekly" | "monthly" | "yearly" | "custom";

const sameDays = (a: readonly Weekday[], b: readonly Weekday[]) => a.length === b.length && a.every((d, i) => d === b[i]);

function sortDays(days: Weekday[]): Weekday[] {
  return [...new Set(days)].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
}

/** Read a rule into the form, or `null` when the editor cannot show it faithfully. */
export function parseRule(rule: string): RuleForm | null {
  const parts = new Map<string, string>();
  for (const part of rule.split(";")) {
    const [key, value] = part.split("=");
    if (!key || value === undefined || parts.has(key)) return null;
    parts.set(key, value);
  }
  const known = new Set(["FREQ", "INTERVAL", "BYDAY", "BYSETPOS", "COUNT", "UNTIL"]);
  if ([...parts.keys()].some((k) => !known.has(k))) return null;
  const freq = parts.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return null;
  const interval = parts.has("INTERVAL") ? Number(parts.get("INTERVAL")) : 1;
  if (!Number.isInteger(interval) || interval < 1) return null;

  let end: RuleEnd = { kind: "never" };
  if (parts.has("COUNT") && parts.has("UNTIL")) return null;
  if (parts.has("COUNT")) {
    const count = Number(parts.get("COUNT"));
    if (!Number.isInteger(count) || count < 1) return null;
    end = { kind: "count", count };
  } else if (parts.has("UNTIL")) {
    const match = /^(\d{4})(\d{2})(\d{2})(T\d{6}Z?)?$/.exec(parts.get("UNTIL")!);
    if (!match) return null;
    end = { kind: "until", date: `${match[1]}-${match[2]}-${match[3]}` };
  }

  const byday = parts.get("BYDAY")?.split(",") ?? [];
  const setpos = parts.get("BYSETPOS");
  const form: RuleForm = { freq, interval, days: [], monthly: { mode: "day" }, end };
  if (freq === "WEEKLY") {
    if (setpos !== undefined || byday.length === 0) return null;
    if (!byday.every((d) => (WEEKDAYS as readonly string[]).includes(d))) return null;
    form.days = sortDays(byday as Weekday[]);
    if (!sameDays(form.days, byday as Weekday[])) return null;
    return form;
  }
  if (freq === "MONTHLY") {
    if (byday.length === 0 && setpos === undefined) return form;
    if (setpos === "-1" && sameDays(byday as Weekday[], WORKDAYS)) {
      form.monthly = { mode: "lastWorkday" };
      return form;
    }
    const nth = /^(-1|[1-4])(MO|TU|WE|TH|FR|SA|SU)$/.exec(byday[0] ?? "");
    if (setpos !== undefined || byday.length !== 1 || !nth) return null;
    form.monthly = { mode: "nth", nth: Number(nth[1]) as 1 | 2 | 3 | 4 | -1, day: nth[2] as Weekday };
    return form;
  }
  // Daily and yearly: nothing but the interval and the end.
  if (byday.length > 0 || setpos !== undefined) return null;
  return form;
}

/** Write the form as a rule. An end date is the end of that day: for a timed event the last second of
 *  it in the event's own zone, written in UTC by `endOfDay` as RFC 5545 asks; for an all-day one, the
 *  date itself. */
export function buildRule(form: RuleForm, allDay: boolean, endOfDay: (day: string) => string): string {
  const parts = [`FREQ=${form.freq}`];
  if (form.interval > 1) parts.push(`INTERVAL=${form.interval}`);
  if (form.freq === "WEEKLY") parts.push(`BYDAY=${sortDays(form.days).join(",")}`);
  if (form.freq === "MONTHLY") {
    if (form.monthly.mode === "nth") parts.push(`BYDAY=${form.monthly.nth}${form.monthly.day}`);
    if (form.monthly.mode === "lastWorkday") parts.push(`BYDAY=${WORKDAYS.join(",")}`, "BYSETPOS=-1");
  }
  if (form.end.kind === "count") parts.push(`COUNT=${form.end.count}`);
  if (form.end.kind === "until") {
    const date = form.end.date.replaceAll("-", "");
    parts.push(`UNTIL=${allDay ? date : endOfDay(form.end.date)}`);
  }
  return parts.join(";");
}

/** The weekday of a day (`YYYY-MM-DD`), as a rule writes it. */
export function weekdayCode(day: string): Weekday {
  const [y, m, d] = day.split("-").map(Number);
  return WEEKDAYS[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7];
}

/** The rule of a quick choice for an event starting on `start` (`null`: it does not repeat). */
export function presetRule(preset: Preset, start: string): string | null {
  switch (preset) {
    case "daily":
      return "FREQ=DAILY";
    case "workdays":
      return `FREQ=WEEKLY;BYDAY=${WORKDAYS.join(",")}`;
    case "weekly":
      return `FREQ=WEEKLY;BYDAY=${weekdayCode(start)}`;
    case "monthly":
      return "FREQ=MONTHLY";
    case "yearly":
      return "FREQ=YEARLY";
    default:
      return null;
  }
}

/** Which quick choice a rule is, for an event starting on `start`. */
export function presetOf(rule: string | null | undefined, start: string): Preset {
  if (!rule) return "none";
  for (const preset of ["daily", "workdays", "weekly", "monthly", "yearly"] as const) {
    if (presetRule(preset, start) === rule) return preset;
  }
  return "custom";
}

/** A fresh form for "custom", starting from what the event already does. */
export function formFor(rule: string | null | undefined, start: string): RuleForm {
  const read = rule ? parseRule(rule) : null;
  return read ?? { freq: "WEEKLY", interval: 1, days: [weekdayCode(start)], monthly: { mode: "day" }, end: { kind: "never" } };
}
