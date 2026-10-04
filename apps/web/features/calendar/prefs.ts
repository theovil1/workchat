/**
 * The viewer's own way of reading the calendar, chosen in the preferences and kept on the device
 * with the rest of them: the view it opens on, the first day of the week, the clock, the weekend
 * and week numbers, the working day, how long a new event lasts. Plus the day arithmetic those
 * choices need.
 *
 * Nothing here imports anything, so it runs as is under Node's test runner (`prefs.test.ts`).
 */

export type DesktopView = "month" | "week" | "day" | "list";
export type PhoneView = "list" | "day" | "month";
/** The first day of the week, as `Date.getUTCDay` counts: Sunday 0, Monday 1, Saturday 6. */
export type WeekStart = 0 | 1 | 6;
/** The clock: as the language writes it, or 24 or 12 hours whatever the language. */
export type ClockFormat = "auto" | "24" | "12";

export type CalendarPrefs = {
  viewDesktop: DesktopView;
  viewPhone: PhoneView;
  weekStart: WeekStart;
  clock: ClockFormat;
  /** Saturday and Sunday in the week view. */
  weekends: boolean;
  weekNumbers: boolean;
  /** The hour the grid opens scrolled to. */
  openAt: number;
  /** Whether the grid greys the hours outside the working day. Off by default. */
  workHours: boolean;
  /** Working hours, `[workStart, workEnd)`: the grid greys the others when `workHours` is on. */
  workStart: number;
  workEnd: number;
  /** A new event's length, in minutes. */
  duration: number;
};

export const DESKTOP_VIEWS: DesktopView[] = ["month", "week", "day", "list"];
export const PHONE_VIEWS: PhoneView[] = ["list", "day", "month"];
export const WEEK_STARTS: WeekStart[] = [1, 0, 6];
export const CLOCK_FORMATS: ClockFormat[] = ["auto", "24", "12"];
export const DURATIONS = [15, 30, 45, 60, 90, 120];

export const DEFAULT_CALENDAR_PREFS: CalendarPrefs = {
  viewDesktop: "week",
  viewPhone: "list",
  weekStart: 1,
  clock: "auto",
  weekends: true,
  weekNumbers: false,
  openAt: 8,
  workHours: false,
  workStart: 9,
  workEnd: 18,
  duration: 60,
};

function hour(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : null;
}

function pick<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Stored preferences read back: anything unknown or out of range takes its default. */
export function calendarPrefs(raw: unknown): CalendarPrefs {
  const d = DEFAULT_CALENDAR_PREFS;
  if (!raw || typeof raw !== "object") return { ...d };
  const r = raw as Record<string, unknown>;
  const workStart = hour(r.workStart, 23);
  const workEnd = hour(r.workEnd, 24);
  const work = workStart !== null && workEnd !== null && workStart < workEnd;
  return {
    viewDesktop: pick(r.viewDesktop, DESKTOP_VIEWS, d.viewDesktop),
    viewPhone: pick(r.viewPhone, PHONE_VIEWS, d.viewPhone),
    weekStart: pick(r.weekStart, WEEK_STARTS, d.weekStart),
    clock: pick(r.clock, CLOCK_FORMATS, d.clock),
    weekends: typeof r.weekends === "boolean" ? r.weekends : d.weekends,
    weekNumbers: typeof r.weekNumbers === "boolean" ? r.weekNumbers : d.weekNumbers,
    openAt: hour(r.openAt, 23) ?? d.openAt,
    workHours: typeof r.workHours === "boolean" ? r.workHours : d.workHours,
    workStart: work ? (workStart as number) : d.workStart,
    workEnd: work ? (workEnd as number) : d.workEnd,
    duration: pick(r.duration, DURATIONS, d.duration),
  };
}

function utc(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function plus(day: string, days: number): string {
  const at = utc(day);
  at.setUTCDate(at.getUTCDate() + days);
  return iso(at);
}

/** The first day of the week `day` is in. */
export function startOfWeek(day: string, weekStart: WeekStart): string {
  return plus(day, -((utc(day).getUTCDay() - weekStart + 7) % 7));
}

/** The days of the week view around `day`: seven, or Monday to Friday without the weekend. */
export function weekDays(day: string, weekStart: WeekStart, weekends: boolean): string[] {
  const first = startOfWeek(day, weekStart);
  const all = Array.from({ length: 7 }, (_, i) => plus(first, i));
  return weekends ? all : all.filter((d) => utc(d).getUTCDay() % 6 !== 0);
}

/** The ISO 8601 number of the week `day` is in (the week of its Thursday, Monday to Sunday). */
export function isoWeek(day: string): number {
  const at = utc(day);
  const thursday = new Date(at);
  thursday.setUTCDate(at.getUTCDate() + 3 - ((at.getUTCDay() + 6) % 7));
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 3 - ((firstThursday.getUTCDay() + 6) % 7));
  return 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
}

/** The week number of a line of seven days, whichever day it starts on: its Thursday's. */
export function rowWeek(first: string): number {
  const offset = (4 - utc(first).getUTCDay() + 7) % 7;
  return isoWeek(plus(first, offset));
}
